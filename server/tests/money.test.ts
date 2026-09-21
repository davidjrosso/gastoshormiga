/**
 * Plata y fechas. Son funciones puras y sin embargo es el archivo donde un
 * error hace más daño: todo lo que el usuario escribe pasa por acá antes de
 * convertirse en un entero que después nadie vuelve a mirar.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  daysBetween,
  normalizeMerchantName,
  parseAmountToMinor,
  periodRange,
  shiftPeriod,
  toUsdCents,
} from '../src/lib/money.js';

describe('parseAmountToMinor', () => {
  it('lee los montos como los tipea un argentino', () => {
    assert.equal(parseAmountToMinor('1.234,56'), 123456);
    assert.equal(parseAmountToMinor('1234,56'), 123456);
    assert.equal(parseAmountToMinor('1234'), 123400);
    assert.equal(parseAmountToMinor('$ 1.234'), 123400);
  });

  it('resuelve "1.234" como miles y no como decimal', () => {
    // La ambigüedad real del formato es ésta. En es-AR el punto separa miles,
    // así que son mil doscientos treinta y cuatro pesos, no $1,23.
    assert.equal(parseAmountToMinor('1.234'), 123400);
  });

  it('acepta el punto decimal del teclado numérico', () => {
    assert.equal(parseAmountToMinor('1234.56'), 123456);
  });

  it('no pierde precisión en los centavos', () => {
    // El motivo por el que todo el esquema usa enteros: con floats,
    // 0.1 + 0.2 !== 0.3, y en plata eso es inaceptable.
    assert.equal(parseAmountToMinor(0.1) + parseAmountToMinor(0.2), parseAmountToMinor(0.3));
  });

  it('rechaza lo que no es un monto', () => {
    assert.throws(() => parseAmountToMinor(''));
    assert.throws(() => parseAmountToMinor('abc'));
    assert.throws(() => parseAmountToMinor(Number.NaN));
  });
});

describe('normalizeMerchantName', () => {
  it('unifica mayúsculas, acentos y espacios de más', () => {
    // Si esto falla, el detector de gasto hormiga deja de ver el goteo:
    // cuenta tres comercios distintos donde hay uno solo.
    const esperado = 'cafe martinez';
    assert.equal(normalizeMerchantName('Café Martínez'), esperado);
    assert.equal(normalizeMerchantName('CAFE MARTINEZ'), esperado);
    assert.equal(normalizeMerchantName('  cafe   martinez  '), esperado);
  });

  it('saca la puntuación', () => {
    assert.equal(normalizeMerchantName('Día%'), 'dia');
  });
});

describe('toUsdCents', () => {
  it('convierte pesos con la cotización congelada', () => {
    // $14.500 a $1.450 por dólar = USD 10.
    assert.equal(toUsdCents(1_450_000, 'ARS', 145_000), 1000);
  });

  it('deja los dólares como están', () => {
    assert.equal(toUsdCents(1000, 'USD', 145_000), 1000);
  });

  it('devuelve null si no hay cotización, en vez de inventar un número', () => {
    assert.equal(toUsdCents(1_450_000, 'ARS', null), null);
    assert.equal(toUsdCents(1_450_000, 'ARS', 0), null);
  });
});

describe('períodos', () => {
  it('calcula el último día de cada mes', () => {
    assert.deepEqual(periodRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
    assert.deepEqual(periodRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
    assert.deepEqual(periodRange('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
  });

  it('cruza el año hacia atrás', () => {
    assert.equal(shiftPeriod('2026-01', 1), '2025-12');
    assert.equal(shiftPeriod('2026-01', 13), '2024-12');
  });

  it('cuenta días entre fechas', () => {
    assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
    assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  });
});
