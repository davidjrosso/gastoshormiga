/**
 * Conversión de un resumen en movimientos.
 *
 * Lo que se prueba acá no es que "importe": es que cada renglón entre como lo
 * que realmente es. Un resumen mal traducido no falla con un error, deja la
 * app mintiendo con números creíbles.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseBbvaVisa } from '../src/import/bbva-visa.js';
import { fingerprint, planImport, type PlanContext } from '../src/import/plan.js';

const st = parseBbvaVisa(readFileSync(new URL('./fixtures/bbva-visa.txt', import.meta.url), 'utf8'));

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  cardAccountId: 'acc-tarjeta',
  percepcionesAccountId: 'acc-percep',
  paymentAccountId: 'acc-banco',
  advanceAccountId: 'acc-banco',
  categoryIds: { impuestos: 'cat-imp', intereses: 'cat-int' },
  existing: new Set<string>(),
  merchantDefaults: new Map(),
  ...over,
});

const plan = planImport(st, ctx());
const porDesc = (d: string) => plan.movements.find((m) => m.line.description.includes(d));

describe('qué entra como gasto y qué no', () => {
  it('un consumo es gasto', () => {
    const m = porDesc('ALMACEN DON JOSE');
    assert.equal(m?.movement?.type, 'gasto');
    assert.equal(m?.movement?.amountMinor, 2_550_050);
    assert.equal(m?.movement?.accountId, 'acc-tarjeta');
  });

  it('pagar la tarjeta es transferencia, nunca gasto', () => {
    // Si el pago entrara como gasto, el consumo del mes anterior se contaría
    // dos veces: cuando se hizo y cuando se pagó.
    const m = porDesc('SU PAGO EN PESOS');
    assert.equal(m?.movement?.type, 'transferencia');
    assert.equal(m?.movement?.accountId, 'acc-banco');
    assert.equal(m?.movement?.toAccountId, 'acc-tarjeta');
    assert.ok(m!.movement!.amountMinor > 0, 'la transferencia va en positivo');
  });

  it('un adelanto es transferencia: sacaste plata, no la gastaste', () => {
    const m = porDesc('ADELANTO TRANSFERENCIA');
    assert.equal(m?.movement?.type, 'transferencia');
    assert.equal(m?.movement?.accountId, 'acc-tarjeta');
    assert.equal(m?.movement?.toAccountId, 'acc-banco');
  });

  it('los intereses del adelanto SÍ son gasto', () => {
    // La distinción fina: el adelanto no es gasto, lo que costó sí.
    const m = porDesc('INTERES ADELANTO');
    assert.equal(m?.movement?.type, 'gasto');
    assert.equal(m?.movement?.categoryId, 'cat-int');
  });

  it('los impuestos que no vuelven son gasto', () => {
    assert.equal(porDesc('IMPUESTO DE SELLOS')?.movement?.type, 'gasto');
    assert.equal(porDesc('IVA RG 4240')?.movement?.categoryId, 'cat-imp');
  });
});

describe('la percepción del 30% no es un gasto', () => {
  it('sale de la tarjeta hacia la cuenta de percepciones', () => {
    // Es plata tuya en manos de ARCA por 30 días. Cargarla como gasto haría
    // que el mes figure peor de lo que fue, y que al mes siguiente aparezca
    // un ingreso fantasma cuando la devuelven.
    const m = porDesc('DB.RG 5617');
    assert.equal(m?.movement?.type, 'transferencia');
    assert.equal(m?.movement?.accountId, 'acc-tarjeta');
    assert.equal(m?.movement?.toAccountId, 'acc-percep');
    assert.equal(m?.movement?.amountMinor, 1_575_000);
  });

  it('el crédito del mes siguiente hace el camino inverso', () => {
    const m = porDesc('CR.RG 5617');
    assert.equal(m?.movement?.type, 'transferencia');
    assert.equal(m?.movement?.accountId, 'acc-percep');
    assert.equal(m?.movement?.toAccountId, 'acc-tarjeta');
    assert.equal(m?.movement?.amountMinor, 900_000, 'en positivo, aunque el renglón sea negativo');
  });

  it('el resumen informa cuánto queda inmovilizado', () => {
    assert.equal(plan.summary.percepcionRecuperableMinor, 1_575_000);
  });

  it('no cuenta como gasto del período', () => {
    // La prueba que importa: el total de gasto nuevo NO incluye la percepción,
    // ni el pago, ni el adelanto.
    const sumaGastos = plan.movements
      .filter((m) => m.status === 'nuevo' && m.movement?.type === 'gasto' && m.movement.currency === 'ARS')
      .reduce((s, m) => s + m.movement!.amountMinor, 0);
    assert.equal(plan.summary.gastoNuevoMinor, sumaGastos);

    const incluyePercepcion = plan.summary.gastoNuevoMinor >= 1_575_000
      && plan.movements.some((m) => m.line.kind === 'percepcion_recuperable' && m.movement?.type === 'gasto');
    assert.equal(incluyePercepcion, false);
  });
});

describe('cuotas y titulares', () => {
  it('conserva la cuota, que evita un goteo falso', () => {
    // Sin esto el detector de hormiga ve seis compras del mismo comercio y
    // marca un goteo que en realidad es una compra sola en cuotas.
    const m = porDesc('FERRETERIA EL TORNILLO');
    assert.deepEqual(m?.movement?.installment, { n: 3, of: 6 });
    assert.match(m!.movement!.note, /Cuota 3\/6/);
  });

  it('conserva a quién hay que cobrarle', () => {
    assert.equal(porDesc('LIBRERIA LA PLUMA')?.movement?.holder, 'Ana Gomez');
  });

  it('conserva la moneda original de una compra del exterior', () => {
    assert.deepEqual(porDesc('CAFE MONTEVIDEO')?.movement?.original, { code: 'UYU', amount: 400 });
  });

  it('propone la categoría que ya usaste con ese comercio', () => {
    // Es lo que evita reclasificar ochenta renglones todos los meses.
    const conDefault = planImport(st, ctx({
      merchantDefaults: new Map([['almacen don jose', 'cat-super']]),
    }));
    const m = conDefault.movements.find((x) => x.line.description.includes('ALMACEN DON JOSE'));
    assert.equal(m?.movement?.categoryId, 'cat-super');
  });
});

describe('deduplicación', () => {
  it('la huella es estable entre corridas', () => {
    const a = planImport(st, ctx());
    const b = planImport(st, ctx());
    assert.deepEqual(a.movements.map((m) => m.fingerprint), b.movements.map((m) => m.fingerprint));
  });

  it('no hay dos renglones con la misma huella', () => {
    const fps = plan.movements.map((m) => m.fingerprint);
    assert.equal(new Set(fps).size, fps.length);
  });

  it('reimportar el mismo resumen no propone nada nuevo', () => {
    // El caso real: volvés a subir el mismo PDF por las dudas.
    const yaImportado = planImport(st, ctx({
      existing: new Set(plan.movements.map((m) => m.fingerprint)),
    }));
    assert.equal(yaImportado.summary.nuevos, 0);
    assert.equal(yaImportado.summary.yaImportados, plan.movements.length);
    assert.equal(yaImportado.summary.gastoNuevoMinor, 0);
  });

  it('distingue dos cuotas del mismo comercio por el cierre del resumen', () => {
    // Una cuota aparece varios meses seguidos con el mismo cupón e importe.
    // Son cargos distintos: si la huella no los separa, el importador se come
    // una cuota por mes.
    const linea = st.lines.find((l) => l.installment)!;
    const agosto = fingerprint('2026-08-27', 'acc-tarjeta', linea);
    const septiembre = fingerprint('2026-09-27', 'acc-tarjeta', linea);
    assert.notEqual(agosto, septiembre);
  });

  it('la misma tarjeta en otro hogar no colisiona', () => {
    const linea = st.lines[0];
    assert.notEqual(
      fingerprint(st.closeDate, 'acc-tarjeta', linea),
      fingerprint(st.closeDate, 'otra-cuenta', linea),
    );
  });
});

describe('nada se descarta en silencio', () => {
  it('sin cuenta de pago, el pago se ignora y se dice por qué', () => {
    const sinBanco = planImport(st, ctx({ paymentAccountId: null }));
    const m = sinBanco.movements.find((x) => x.line.description.includes('SU PAGO EN PESOS'));
    assert.equal(m?.status, 'ignorado');
    assert.match(m!.reason!, /de qué cuenta/i);
    assert.equal(m?.movement, null);
  });

  it('todo renglón ignorado trae un motivo', () => {
    const sinNada = planImport(st, ctx({ paymentAccountId: null, advanceAccountId: null }));
    for (const m of sinNada.movements.filter((x) => x.status === 'ignorado')) {
      assert.ok(m.reason && m.reason.length > 0, `${m.line.description} sin motivo`);
    }
  });

  it('cada renglón del resumen aparece en el plan', () => {
    // Ni uno se pierde por el camino: o se importa, o ya estaba, o se ignora
    // con motivo. Un renglón que desaparece es plata que no se ve.
    assert.equal(plan.movements.length, st.lines.length);
    assert.equal(
      plan.summary.nuevos + plan.summary.yaImportados + plan.summary.ignorados,
      st.lines.length,
    );
  });
});
