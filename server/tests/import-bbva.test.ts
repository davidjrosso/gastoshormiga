/**
 * Parser del resumen de BBVA Visa.
 *
 * Corre sobre un resumen INVENTADO, no sobre uno real: este repo es público y
 * un resumen de tarjeta es el detalle de dónde vive, qué compra y cuándo viaja
 * una familia. El fixture reproduce el formato y las rarezas del banco, con
 * nombres, comercios e importes de fantasía que cierran por construcción.
 *
 * No importa la base de datos a propósito: el parser es una función pura y los
 * tests tienen que poder correr sin nada detrás.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseBbvaVisa, parseFecha } from '../src/import/bbva-visa.js';

const texto = readFileSync(new URL('./fixtures/bbva-visa.txt', import.meta.url), 'utf8');
const r = parseBbvaVisa(texto);
const linea = (desc: string) => r.lines.find((l) => l.description.includes(desc));

describe('parseFecha', () => {
  it('lee el formato del resumen', () => {
    assert.equal(parseFecha('27-Ago-26'), '2026-08-27');
    assert.equal(parseFecha('01-Ene-25'), '2025-01-01');
  });

  it('acepta las dos formas de setiembre que usa el banco', () => {
    assert.equal(parseFecha('07-Sep-26'), '2026-09-07');
    assert.equal(parseFecha('07-Set-26'), '2026-09-07');
  });

  it('rechaza lo que no es una fecha', () => {
    assert.equal(parseFecha('27/08/2026'), null);
    assert.equal(parseFecha('TOTAL'), null);
  });
});

describe('basura del PDF', () => {
  it('lee un renglón con glifos del código de barras pegados adelante', () => {
    // El PDF mete caracteres de su propio código de barras al principio de
    // algunos renglones ("ËijjggÌ27-Ago-26 INTERESES FINANCIACION"). Con la
    // fecha anclada al comienzo, ese renglón se perdía entero y en silencio;
    // la verificación aritmética lo delataba, pero recién al final.
    const l = r.lines.find((x) => x.description.includes('INTERESES FINANCIACION'));
    assert.ok(l, 'el renglón con basura adelante tiene que leerse igual');
    assert.equal(l.amountMinor, 100_000);
    assert.equal(l.kind, 'interes');
  });
});

describe('encabezado', () => {
  it('lee el encabezado, que el banco imprime como tabla de dos filas', () => {
    // Los rótulos van en una fila y los valores en la siguiente, alineados por
    // columna. Buscar el valor "pegado" a su rótulo no funciona: en el texto
    // extraído quedan todos los rótulos juntos y después todos los valores.
    assert.equal(r.card, 'Visa Signature');
    assert.equal(r.closeDate, '2026-08-27');
    assert.equal(r.dueDate, '2026-09-07');
    assert.equal(r.balanceArsMinor, 16_191_050);
    assert.equal(r.balanceUsdCents, 3_500);
    assert.equal(r.minimumArsMinor, 3_000_000);
    assert.equal(r.previousArsMinor, 5_000_000);
    assert.equal(r.previousUsdCents, 2_000);
  });

  it('guarda solo los últimos dígitos de la cuenta', () => {
    // El número completo no hace falta para nada y es un dato de más que
    // custodiar. Con los últimos cuatro alcanza para distinguir tarjetas.
    assert.equal(r.accountTail, '9999');
    assert.ok(!JSON.stringify(r).includes('9999999999'));
  });
});

describe('verificación aritmética', () => {
  it('cierra al centavo contra los totales del propio resumen', () => {
    // Es la defensa central del importador: un parser de PDF no explota
    // cuando falla, devuelve un número creíble. Si esto no da cero, no se
    // debe poder confirmar una importación.
    assert.equal(r.check.diffArsMinor, 0);
    assert.equal(r.check.diffUsdCents, 0);
    assert.equal(r.check.ok, true);
  });

  it('cierra también por titular', () => {
    for (const h of r.check.byHolder) {
      assert.equal(h.diffArsMinor, 0, `${h.holder} no cierra en pesos`);
      assert.equal(h.diffUsdCents, 0, `${h.holder} no cierra en dólares`);
    }
  });

  it('no deja renglones sin clasificar', () => {
    assert.deepEqual(r.lines.filter((l) => l.kind === 'desconocido'), []);
  });
});

describe('titulares', () => {
  it('no duplica los totales que la primera página repite', () => {
    // El resumen lista los totales por titular dos veces: en el cuadro de la
    // portada y al pie de cada sección de detalle. Contarlos dos veces
    // duplicaría lo que hay que cobrarle a cada adicional.
    assert.equal(r.holders.length, 2);
    assert.deepEqual(r.holders.map((h) => h.holder), ['JUAN PEREZ', 'ANA GOMEZ']);
  });

  it('atribuye cada consumo a quien lo hizo', () => {
    assert.equal(linea('LIBRERIA LA PLUMA')?.holder, 'Ana Gomez');
    assert.equal(linea('ALMACEN DON JOSE')?.holder, 'Juan Perez');
  });
});

describe('renglones de consumo', () => {
  it('lee una cuota', () => {
    const l = linea('FERRETERIA EL TORNILLO');
    assert.deepEqual(l?.installment, { n: 3, of: 6 });
    assert.equal(l?.amountMinor, 1_000_000);
    // La fecha de una cuota es la de la COMPRA, no la del cargo.
    assert.equal(l?.date, '2026-06-10');
  });

  it('lee el cupón, que es lo que después permite deduplicar', () => {
    assert.equal(linea('ALMACEN DON JOSE')?.coupon, '002222');
  });

  it('detecta USD aunque el código venga pegado a la descripción', () => {
    // Regresión: el PDF usa columnas de ancho fijo y cuando la descripción se
    // pasa de largo queda "STREAMING PLUS Ab3cdEfUSD  10,00". Exigiendo un
    // espacio antes de "USD", el renglón entraba como pesos: el importe salía
    // bien y la moneda mal, y el resumen cerraba con la diferencia exacta
    // entre las dos columnas.
    const l = linea('STREAMING PLUS');
    assert.equal(l?.currency, 'USD');
    assert.equal(l?.amountMinor, 1_000);
  });

  it('conserva la moneda original de una compra en el exterior', () => {
    // Sin el monto original no se puede auditar a qué cambio te liquidaron.
    const l = linea('CAFE MONTEVIDEO');
    assert.equal(l?.currency, 'USD');
    assert.equal(l?.amountMinor, 2_000);
    assert.deepEqual(l?.original, { code: 'UYU', amount: 400 });
  });

  it('no confunde un consumo en pesos con uno en dólares', () => {
    assert.equal(linea('ALMACEN DON JOSE')?.currency, 'ARS');
    assert.equal(linea('ALMACEN DON JOSE')?.original, null);
  });
});

describe('impuestos, cargos e intereses', () => {
  it('toma el impuesto y no la base imponible', () => {
    // Regresión: "DB IVA $ 21%  6.000,00  1.260,00" trae la base y después el
    // impuesto. Quedarse con el primer número cobraba 6.000 de IVA en vez de
    // 1.260, y el error pasaba desapercibido porque ambos son creíbles.
    const l = linea('DB IVA');
    assert.equal(l?.amountMinor, 126_000);
    assert.equal(l?.taxBaseMinor, 600_000);
  });

  it('lee la base que viene entre paréntesis', () => {
    const l = linea('IVA RG 4240');
    assert.equal(l?.amountMinor, 210_000);
    assert.equal(l?.taxBaseMinor, 1_000_000);
  });

  it('no confunde la alícuota con un importe', () => {
    // "IIBB PERCEP-CORD 3,00%( 10000,00) 300,00": el "3,00" tiene forma de
    // importe y no lo es.
    const l = linea('IIBB PERCEP-CORD');
    assert.equal(l?.amountMinor, 30_000);
    assert.equal(l?.taxBaseMinor, 1_000_000);
  });

  it('marca la percepción del 30% como recuperable y el resto no', () => {
    // La distinción que decide si el mes figura bien: la RG 5617 vuelve si
    // pagás el saldo en dólares, el IVA RG 4240 y el IIBB no.
    assert.equal(linea('DB.RG 5617')?.kind, 'percepcion_recuperable');
    assert.equal(linea('IVA RG 4240')?.kind, 'impuesto');
    assert.equal(linea('IIBB PERCEP-CORD')?.kind, 'impuesto');
    assert.equal(linea('IMPUESTO DE SELLOS')?.kind, 'impuesto');
  });

  it('reconoce la devolución de la percepción del mes anterior', () => {
    const l = linea('CR.RG 5617');
    assert.equal(l?.kind, 'credito_percepcion');
    assert.equal(l?.amountMinor, -900_000, 'es un crédito, va en negativo');
  });

  it('separa el adelanto de sus intereses', () => {
    // El adelanto no es gasto: es plata que sacaste de la tarjeta. Los
    // intereses sí lo son.
    assert.equal(linea('ADELANTO TRANSFERENCIA')?.kind, 'adelanto');
    assert.equal(linea('INTERES ADELANTO')?.kind, 'interes');
    assert.equal(linea('INTERESES FINANCIACION')?.kind, 'interes');
  });
});

describe('pagos', () => {
  it('los registra en negativo y no como gasto', () => {
    // Pagar la tarjeta cancela una deuda: no es un gasto nuevo. Contarlo como
    // gasto duplicaría todo el consumo del mes anterior.
    const pagos = r.lines.filter((l) => l.kind === 'pago');
    assert.equal(pagos.length, 2);
    assert.ok(pagos.every((p) => p.amountMinor < 0));
  });

  it('distingue el pago en dólares del pago en pesos', () => {
    assert.equal(r.lines.find((l) => l.description.includes('SU PAGO EN USD'))?.currency, 'USD');
    assert.equal(r.lines.find((l) => l.description.includes('SU PAGO EN PESOS'))?.currency, 'ARS');
  });
});
