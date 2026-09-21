/**
 * El detector de gasto hormiga.
 *
 * Es el motivo por el que esta app existe, así que lo que se prueba acá no es
 * que "devuelva algo" sino que las tres condiciones sean necesarias: cada test
 * saca exactamente una y verifica que el gasto deje de aparecer.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { addMonthlyIncome, addTx, daysAgo, makeHousehold, makeMerchant, type Fixture } from './harness.js';
import { detectHormiga, detectSubscriptions, monthlySummary } from '../src/analytics/hormiga.js';

// Ingreso de $1.000.000 por mes => umbral = 0,5% = $5.000 (500.000 en minor).
const INGRESO_MENSUAL = 100_000_000;
const UMBRAL = 500_000;

let f: Fixture;

before(() => {
  f = makeHousehold();
  addMonthlyIncome(f, INGRESO_MENSUAL);

  // CHICO + FRECUENTE + MATERIAL -> es hormiga.
  // 12 compras de $3.000 = $12.000 por mes, muy por encima del umbral.
  const cafe = makeMerchant(f.householdId, 'Café de la esquina');
  for (let i = 0; i < 12; i++) {
    addTx(f, { date: daysAgo(i * 7), amountMinor: 300_000, merchantId: cafe });
  }

  // CHICO + FRECUENTE pero NO material: $100 seis veces son $200 por mes.
  // Individualmente irrelevante y en total tampoco mueve la aguja.
  const chicle = makeMerchant(f.householdId, 'Chicles');
  for (let i = 0; i < 6; i++) {
    addTx(f, { date: daysAgo(i * 13), amountMinor: 10_000, merchantId: chicle });
  }

  // FRECUENTE + MATERIAL pero NO chico: el alquiler ya lo ves venir.
  const alquiler = makeMerchant(f.householdId, 'Alquiler');
  for (let i = 0; i < 3; i++) {
    addTx(f, { date: daysAgo(i * 30 + 2), amountMinor: 70_000_000, merchantId: alquiler });
  }

  // CHICO + MATERIAL pero NO frecuente: una sola vez no es un goteo.
  const regalo = makeMerchant(f.householdId, 'Regalo');
  addTx(f, { date: daysAgo(10), amountMinor: 490_000, merchantId: regalo });
});

describe('detectHormiga', () => {
  const nombres = () => detectHormiga(f.householdId, 3).map((h) => h.merchantName);

  it('marca el gasto chico, frecuente y que en total duele', () => {
    assert.ok(nombres().includes('Café de la esquina'));
  });

  it('ignora lo chico y frecuente que en total no mueve la aguja', () => {
    // Sin esta condición el informe se llena de ruido y deja de servir.
    assert.ok(!nombres().includes('Chicles'));
  });

  it('ignora lo frecuente y pesado: eso es un gasto fijo, no una hormiga', () => {
    assert.ok(!nombres().includes('Alquiler'));
  });

  it('ignora lo chico que pasó una sola vez', () => {
    assert.ok(!nombres().includes('Regalo'));
  });

  it('anualiza sobre el promedio mensual, no sobre el total de la ventana', () => {
    const cafe = detectHormiga(f.householdId, 3).find((h) => h.merchantName === 'Café de la esquina');
    assert.ok(cafe);
    assert.equal(cafe.count, 12);
    assert.equal(cafe.avgMinor, 300_000);
    assert.equal(cafe.monthlyAvgMinor, 12 * 300_000 / 3);
    assert.equal(cafe.annualizedMinor, cafe.monthlyAvgMinor * 12);
  });

  it('el umbral es relativo al ingreso, no un número fijo en pesos', () => {
    // Todo lo marcado tiene que tener ticket promedio por debajo del umbral
    // y agregado mensual por encima. Si alguien mete una constante en pesos
    // en el motor, esto se cae cuando los ingresos cambien de orden.
    for (const h of detectHormiga(f.householdId, 3)) {
      assert.ok(h.avgMinor <= UMBRAL, `${h.merchantName}: ticket ${h.avgMinor} > umbral`);
      assert.ok(h.monthlyAvgMinor >= UMBRAL, `${h.merchantName}: mensual ${h.monthlyAvgMinor} < umbral`);
    }
  });

  it('ordena por lo que recuperás en un año', () => {
    const items = detectHormiga(f.householdId, 3);
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i - 1].annualizedMinor >= items[i].annualizedMinor);
    }
  });
});

describe('detectSubscriptions', () => {
  it('detecta la cadencia mensual y delata el aumento', () => {
    const g = makeHousehold();
    const netflix = makeMerchant(g.householdId, 'Netflix');
    // Cuatro cargos mensuales que suben 20% en total.
    const montos = [1_000_000, 1_060_000, 1_130_000, 1_200_000];
    montos.forEach((monto, i) => {
      addTx(g, { date: daysAgo((montos.length - 1 - i) * 30), amountMinor: monto, merchantId: netflix });
    });

    const subs = detectSubscriptions(g.householdId, 6);
    const netflixSub = subs.find((s) => s.merchantName === 'Netflix');
    assert.ok(netflixSub);
    assert.equal(netflixSub.cadence, 'mensual');
    assert.equal(netflixSub.occurrences, 4);
    assert.equal(netflixSub.amountMinor, 1_200_000, 'reporta el último precio, no el primero');
    assert.equal(netflixSub.priceChangePct, 20);
    assert.equal(netflixSub.isDeclaredFixed, false);
  });

  it('no confunde el súper con una suscripción', () => {
    // Mismo comercio, misma frecuencia, montos que varían mucho.
    // Es consumo variable, no un cargo recurrente.
    const g = makeHousehold();
    const super_ = makeMerchant(g.householdId, 'Supermercado');
    [500_000, 2_400_000, 900_000, 3_100_000].forEach((monto, i) => {
      addTx(g, { date: daysAgo((3 - i) * 30), amountMinor: monto, merchantId: super_ });
    });

    assert.equal(detectSubscriptions(g.householdId, 6).length, 0);
  });
});

describe('monthlySummary', () => {
  it('deja las transferencias afuera de ingresos y gastos', () => {
    // Comprar dólares no es un gasto. Es el bug que arruina a estas apps:
    // te computan la compra de USD como gasto y el mes queda inservible.
    const g = makeHousehold();
    const period = new Date().toISOString().slice(0, 7);
    const hoy = daysAgo(0);

    addTx(g, { type: 'ingreso', date: hoy, amountMinor: 10_000_000, categoryId: null });
    addTx(g, { type: 'gasto', date: hoy, amountMinor: 2_000_000 });
    addTx(g, { type: 'transferencia', date: hoy, amountMinor: 5_000_000, categoryId: null });

    const s = monthlySummary(g.householdId, period);
    assert.equal(s.incomeMinor, 10_000_000);
    assert.equal(s.expenseMinor, 2_000_000);
    assert.equal(s.balanceMinor, 8_000_000);
  });
});
