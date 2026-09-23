import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { makeHousehold, makeSession, addTx, sqlite, type Fixture } from './harness.js';
import { installmentForecast } from '../src/analytics/installments.js';
import { analyticsRoutes } from '../src/routes/analytics.js';
import { createDraft, configureMovements, saveStatement } from '../src/statements/repository.js';
import type { StatementDocument, LedgerLine } from '../src/statements/model.js';

function line(id: string, overrides: Partial<LedgerLine> = {}): LedgerLine {
  return { id, kind: 'consumo', holder: 'UNO', date: '2025-01-10', description: `Compra ${id}`, coupon: id,
    amountMinor: 10001, currency: 'ARS', installment: { n: 2, of: 5 }, original: null, taxBaseMinor: null,
    treatment: 'allocate', reason: '', allocations: [{ holder: 'UNO', amountMinor: 10001 }], ...overrides };
}
function statement(f: Fixture, close: string, lines: LedgerLine[], confirm = true, incorporate = true) {
  sqlite.prepare("UPDATE accounts SET type='tarjeta' WHERE id=?").run(f.accountId);
  const holders = ['UNO', 'DOS', 'ADICIONAL'];
  const total = (currency: string, holder?: string) => lines.filter(l => l.currency === currency && (!holder || l.holder === holder)).reduce((s, l) => s + l.amountMinor, 0);
  const doc: StatementDocument = { accountId: f.accountId, closeDate: close, dueDate: close, accountTail: '',
    balanceArsMinor: total('ARS'), balanceUsdCents: total('USD'), previousArsMinor: 0, previousUsdCents: 0,
    dollarPayment: 'USD', reviewConfirmed: true, extractionWarnings: [], lines,
    holders: holders.map(holder => ({ holder, statedArsMinor: total('ARS', holder), statedUsdCents: total('USD', holder) })) };
  const { record } = createDraft(f.householdId, randomUUID(), 'synthetic.pdf', doc);
  configureMovements(f.householdId, record.id, holders.map((holder, i) => ({ holder, userId: incorporate ? [f.userId, f.otherUserId, null][i] : null })), f.userId);
  if (confirm) saveStatement(f.householdId, record.id, record.revision, doc, true);
  return record.id;
}

test('projects remaining installments in exact cents, crosses years and stops after last; reads never write', () => {
  const f = makeHousehold();
  statement(f, '2025-11-27', [line('a'), line('done', { installment: { n: 6, of: 6 } })]);
  const before = sqlite.prepare('SELECT * FROM transactions WHERE household_id=?').all(f.householdId);
  const result = installmentForecast(f.householdId, '2025-11', 5);
  assert.deepEqual(result.months.map(m => [m.period, m.arsMinor]), [
    ['2025-11', 0], ['2025-12', 10001], ['2026-01', 10001], ['2026-02', 10001], ['2026-03', 0],
  ]);
  assert.equal(result.months[3].items[0].n, 5);
  assert.equal(result.months[1].items[0].lastPeriod, '2026-02');
  assert.deepEqual(sqlite.prepare('SELECT * FROM transactions WHERE household_id=?').all(f.householdId), before);
});

test('only latest confirmed snapshot per card supplies forecasts; drafts cannot replace it', () => {
  const f = makeHousehold();
  statement(f, '2025-11-27', [line('a')]);
  statement(f, '2025-12-27', [line('new-id', { installment: { n: 3, of: 5 }, amountMinor: 10002, allocations: [{ holder: 'UNO', amountMinor: 10002 }] })]);
  statement(f, '2026-01-27', [line('draft')], false);
  const result = installmentForecast(f.householdId, '2025-12', 4);
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.months.map(m => m.arsMinor), [0, 10002, 10002, 0]);
  assert.equal(result.months[1].items.length, 1);
});

test('keeps currencies and holders separate, excludes liquidations, credits and non-installments', () => {
  const f = makeHousehold();
  statement(f, '2025-11-27', [line('a'),
    line('usd', { holder: 'DOS', currency: 'USD', amountMinor: 255, allocations: [{ holder: 'DOS', amountMinor: 255 }] }),
    line('third', { holder: 'ADICIONAL', allocations: [{ holder: 'ADICIONAL', amountMinor: 10001 }] }),
    line('credit', { amountMinor: -10001, allocations: [{ holder: 'UNO', amountMinor: -10001 }] }),
    line('cash', { installment: null }),
    line('excluded', { treatment: 'excluded', reason: 'No corresponde al hogar' }),
  ]);
  const all = installmentForecast(f.householdId, '2025-12', 1).months[0];
  assert.equal(all.arsMinor, 10001);
  assert.equal(all.usdCents, 255);
  assert.equal(all.items.length, 2);
  const person = installmentForecast(f.householdId, '2025-12', 1, f.otherUserId).months[0];
  assert.equal(person.arsMinor, 0);
  assert.equal(person.usdCents, 255);
  assert.equal(person.items.length, 1);
  assert.equal(installmentForecast(makeHousehold().householdId, '2025-12', 1).sources.length, 0);
});

test('latest unincorporated statement does not silently reuse obsolete household projections', () => {
  const f = makeHousehold();
  statement(f, '2025-11-27', [line('a')]);
  statement(f, '2025-12-27', [line('b')], true, false);
  const result = installmentForecast(f.householdId, '2026-01', 1);
  assert.equal(result.sources[0].hasHouseholdMovements, false);
  assert.equal(result.months[0].arsMinor, 0);
});

test('uses recent completed ARS income as labeled reference; excludes future income and other households', () => {
  const f = makeHousehold();
  statement(f, '2025-11-27', [line('a')]);
  addTx(f, { type: 'ingreso', date: '2025-11-05', amountMinor: 100010, paidByUserId: f.userId });
  addTx(f, { type: 'ingreso', date: '2025-12-05', amountMinor: 900000 });
  const result = installmentForecast(f.householdId, '2025-12', 1);
  assert.deepEqual(result.incomeReference, { period: '2025-11', amountMinor: 100010 });
  assert.equal(result.months[0].shareOfIncomePct, 10);
  assert.equal(installmentForecast(f.householdId, '2026-05', 1).incomeReference, null);
});

test('cards are independent even when purchases have identical descriptions', () => {
  const f = makeHousehold();
  statement(f, '2025-11-27', [line('a')]);
  const second = randomUUID();
  sqlite.prepare("INSERT INTO accounts(id,household_id,name,type,currency) VALUES (?,?,'Otra','tarjeta','ARS')").run(second, f.householdId);
  statement({ ...f, accountId: second }, '2025-12-27', [line('a')]);
  assert.equal(installmentForecast(f.householdId, '2026-01', 1).months[0].arsMinor, 20002);
});

test('forecast endpoint requires auth, scopes households and rejects invalid period/horizon', async () => {
  const f = makeHousehold();
  statement(f, '2025-11-27', [line('a')]);
  const app = new Hono().route('/api/analytics', analyticsRoutes);
  const path = '/api/analytics/installments';
  assert.equal((await app.request(path)).status, 401);
  const headers = { cookie: `hormiga_session=${makeSession(f.userId)}` };
  for (const query of ['period=2026-13', 'period=bad', 'months=NaN', 'months=0', 'months=25', 'months=1.5'])
    assert.equal((await app.request(`${path}?${query}`, { headers })).status, 400);
  const response = await app.request(`${path}?period=2025-12&months=1`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json() as ReturnType<typeof installmentForecast>).months[0].arsMinor, 10001);
  const other = makeHousehold();
  const isolated = await app.request(`${path}?period=2025-12`, { headers: { cookie: `hormiga_session=${makeSession(other.userId)}` } });
  assert.deepEqual((await isolated.json() as ReturnType<typeof installmentForecast>).sources, []);
});
