/**
 * Materialización de los gastos fijos.
 *
 * Los tres casos de acá son regresiones: los dos primeros son bugs que
 * estuvieron en producción, y el tercero es la garantía que los hacía
 * difíciles de ver. Que un fijo se genere "más o menos bien" no alcanza:
 * son la mitad del gasto del mes y nadie los revisa a mano.
 */
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeHousehold, setRate, sqlite, thisPeriod, type Fixture } from './harness.js';
import { generateRecurring } from '../src/routes/recurring.js';

const BLUE = 145_000;    // $1.450 por USD
const OFICIAL = 100_000; // $1.000 por USD

function addRule(f: Fixture, opts: { paidByUserId?: string | null } = {}): string {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO recurring_rules
         (id, household_id, description, amount_minor, currency, account_id, day_of_month, active, paid_by_user_id)
       VALUES (?, ?, 'Alquiler', 70000000, 'ARS', ?, 1, 1, ?)`,
    )
    .run(id, f.householdId, f.accountId, opts.paidByUserId ?? null);
  return id;
}

function generatedTx(householdId: string) {
  return sqlite
    .prepare(`SELECT * FROM transactions WHERE household_id = ? AND recurring_rule_id IS NOT NULL`)
    .all(householdId) as Array<{
      usd_rate_minor: number | null;
      paid_by_user_id: string | null;
      created_by_user_id: string | null;
      date: string;
    }>;
}

describe('generateRecurring', () => {
  it('congela la cotización que eligió el hogar, no siempre el blue', () => {
    // El bug: usaba 'blue' hardcodeado. Como los fijos son la mitad del gasto
    // del mes, un hogar configurado en "oficial" veía un total en dólares
    // calculado contra una cotización que nunca eligió.
    const f = makeHousehold('oficial');
    setRate(`${thisPeriod()}-01`, 'blue', BLUE);
    setRate(`${thisPeriod()}-01`, 'oficial', OFICIAL);
    addRule(f);

    generateRecurring(f.householdId, thisPeriod(), f.userId);

    const txs = generatedTx(f.householdId);
    assert.equal(txs.length, 1);
    assert.equal(txs[0].usd_rate_minor, OFICIAL);
  });

  it('sigue funcionando para un hogar en blue', () => {
    const f = makeHousehold('blue');
    setRate(`${thisPeriod()}-01`, 'blue', BLUE);
    addRule(f);

    generateRecurring(f.householdId, thisPeriod(), f.userId);
    assert.equal(generatedTx(f.householdId)[0].usd_rate_minor, BLUE);
  });

  it('atribuye el gasto a quien paga la regla, no a quien abrió la app', () => {
    // El bug: los fijos nacían sin paid_by_user_id, así que alquiler,
    // expensas y prepaga quedaban afuera de "Quién pagó qué".
    const f = makeHousehold();
    addRule(f, { paidByUserId: f.userId });

    // La generación la dispara el OTRO integrante al abrir la app.
    generateRecurring(f.householdId, thisPeriod(), f.otherUserId);

    const tx = generatedTx(f.householdId)[0];
    assert.equal(tx.paid_by_user_id, f.userId, 'paga quien dice la regla');
    assert.equal(tx.created_by_user_id, f.otherUserId, 'lo cargó quien abrió la app');
  });

  it('deja sin atribuir el fijo que sale de la cuenta conjunta', () => {
    // Nullable a propósito: inventar un dueño sería peor que no tenerlo.
    const f = makeHousehold();
    addRule(f, { paidByUserId: null });

    generateRecurring(f.householdId, thisPeriod(), f.userId);
    assert.equal(generatedTx(f.householdId)[0].paid_by_user_id, null);
  });

  it('es idempotente: se dispara al abrir la app, y la app se abre mucho', () => {
    const f = makeHousehold();
    addRule(f);

    assert.equal(generateRecurring(f.householdId, thisPeriod(), f.userId), 1);
    assert.equal(generateRecurring(f.householdId, thisPeriod(), f.userId), 0);
    assert.equal(generateRecurring(f.householdId, thisPeriod(), f.userId), 0);
    assert.equal(generatedTx(f.householdId).length, 1);
  });

  it('no adelanta meses futuros', () => {
    const f = makeHousehold();
    addRule(f);
    const [y, m] = thisPeriod().split('-').map(Number);
    const futuro = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;

    assert.equal(generateRecurring(f.householdId, futuro, f.userId), 0);
    assert.equal(generatedTx(f.householdId).length, 0);
  });

  it('ancla al último día del mes la regla que cae el 31', () => {
    const f = makeHousehold();
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO recurring_rules
           (id, household_id, description, amount_minor, currency, account_id, day_of_month, active)
         VALUES (?, ?, 'Fin de mes', 100000, 'ARS', ?, 31, 1)`,
      )
      .run(id, f.householdId, f.accountId);

    generateRecurring(f.householdId, thisPeriod(), f.userId);

    const { date } = generatedTx(f.householdId)[0];
    const [y, m] = thisPeriod().split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
    assert.equal(date, `${thisPeriod()}-${String(ultimoDia).padStart(2, '0')}`);
  });
});
