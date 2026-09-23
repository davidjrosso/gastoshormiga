import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { makeHousehold, makeSession, addTx, makeMerchant, daysAgo, sqlite, type Fixture } from './harness.js';
import { eventRoutes } from '../src/routes/events.js';
import { transactionRoutes } from '../src/routes/transactions.js';
import { runMigrations } from '../src/db/migrate.js';
import { assignEvent, setTransactionEvent } from '../src/events.js';
import { monthlySummary, categoryTrends, detectHormiga, detectSubscriptions } from '../src/analytics/hormiga.js';
import { accountBalances } from '../src/analytics/savings.js';
import { installmentForecast } from '../src/analytics/installments.js';
import { createDraft, configureMovements, saveStatement } from '../src/statements/repository.js';
import type { StatementDocument, LedgerLine } from '../src/statements/model.js';

const app = new Hono().route('/events', eventRoutes).route('/transactions', transactionRoutes);
function headers(f: Fixture) { return { cookie: `hormiga_session=${makeSession(f.userId)}`, 'Content-Type': 'application/json' }; }
function event(f: Fixture, extraordinary = true) {
  const id = randomUUID();
  sqlite.prepare('INSERT INTO events VALUES (?,?,?,?,0,?)').run(id, f.householdId, 'Vacaciones', Number(extraordinary), Date.now());
  return id;
}
function expense(f: Fixture, date = '2026-08-10', amountMinor = 10000) { return addTx(f, { date, amountMinor, paidByUserId: f.userId }); }
function eventOf(id: string) { return (sqlite.prepare('SELECT event_id FROM event_transactions WHERE transaction_id=?').get(id) as { event_id: string } | undefined)?.event_id ?? null; }
function statement(f: Fixture, closeDate: string, n: number, coupon: string | null = '1234', duplicate = false) {
  sqlite.prepare("UPDATE accounts SET type='tarjeta' WHERE id=?").run(f.accountId);
  const line: LedgerLine = { id: randomUUID(), kind: 'consumo', holder: 'UNO', date: '2026-01-10', description: 'Compra en cuotas', coupon,
    currency: 'ARS', amountMinor: 12001, installment: { n, of: 6 }, original: null, taxBaseMinor: null,
    treatment: 'allocate', reason: '', allocations: [{ holder: 'UNO', amountMinor: 12001 }] };
  const lines = duplicate ? [line, { ...line, id: randomUUID() }] : [line];
  const doc: StatementDocument = { accountId: f.accountId, closeDate, dueDate: closeDate, accountTail: '', balanceArsMinor: lines.length*12001,
    balanceUsdCents: 0, previousArsMinor: 0, previousUsdCents: 0, dollarPayment: 'USD', reviewConfirmed: true,
    extractionWarnings: [], holders: [{ holder: 'UNO', statedArsMinor: lines.length*12001, statedUsdCents: 0 }], lines };
  const { record } = createDraft(f.householdId, randomUUID(), 'synthetic.pdf', doc);
  configureMovements(f.householdId, record.id, [{ holder: 'UNO', userId: f.userId }], f.userId);
  saveStatement(f.householdId, record.id, record.revision, doc, true);
  return (sqlite.prepare('SELECT transaction_id FROM card_movement_links WHERE statement_id=?').all(record.id) as { transaction_id: string }[]).map(r => r.transaction_id);
}

test('v4 to v5 only adds metadata tables, preserves transactions, and is repeatable', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE card_event_rules; DROP TABLE event_transactions; DROP TABLE events; PRAGMA user_version=4;');
    db.exec("INSERT INTO households(id,name) VALUES('h','Test'); INSERT INTO accounts(id,household_id,name,type) VALUES('a','h','Cash','efectivo'); INSERT INTO transactions(id,household_id,type,date,account_id,amount_minor) VALUES('t','h','gasto','2026-08-01','a',12345);");
    const before = db.prepare('SELECT * FROM transactions').all();
    assert.deepEqual(runMigrations(db), { from: 4, to: 5 });
    assert.deepEqual(db.prepare('SELECT * FROM transactions').all(), before);
    assert.deepEqual(runMigrations(db), { from: 5, to: 5 });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('event CRUD requires auth, validates input, isolates households, and keeps ARS/USD and credits', async () => {
  const f = makeHousehold(); const h = headers(f);
  assert.equal((await app.request('/events')).status, 401);
  assert.equal((await app.request('/events', { method: 'POST', headers: h, body: JSON.stringify({ name: ' ' }) })).status, 400);
  const created = await app.request('/events', { method: 'POST', headers: h, body: JSON.stringify({ name: ' Viaje ' }) });
  assert.equal(created.status, 201);
  const e = await created.json() as { id: string; name: string; extraordinary: boolean };
  assert.equal(e.name, 'Viaje'); assert.equal(e.extraordinary, true);
  const txs = [expense(f), expense(f, '2026-08-12', -1000), expense(f, '2026-09-01', 1234)];
  sqlite.prepare("UPDATE transactions SET currency='USD' WHERE id=?").run(txs[2]);
  assignEvent(f.householdId, txs, e.id);
  const list = await app.request('/events', { headers: h });
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const rows = await list.json() as { arsMinor: number; usdCents: number; expenseCount: number }[];
  assert.equal(rows[0].arsMinor, 9000); assert.equal(rows[0].usdCents, 1234); assert.equal(rows[0].expenseCount, 3);
  const other = headers(makeHousehold());
  assert.deepEqual(await (await app.request('/events', { headers: other })).json(), []);
  assert.equal((await app.request(`/events/${e.id}`, { method: 'PATCH', headers: other, body: JSON.stringify({ name: 'Ajeno' }) })).status, 404);
  assert.equal((await app.request(`/events/${e.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ archived: true }) })).status, 200);
  assert.equal(eventOf(txs[0]), e.id);
});

test('batch assignment and removal are atomic and never modify financial fields', async () => {
  const f = makeHousehold(); const h = headers(f); const id = event(f);
  const ids = [expense(f), expense(f)];
  const before = sqlite.prepare('SELECT * FROM transactions WHERE household_id=? ORDER BY id').all(f.householdId);
  const assign = (transactionIds: string[], eventId: string | null) => app.request('/events/assign', { method: 'POST', headers: h, body: JSON.stringify({ transactionIds, eventId }) });
  assert.equal((await assign([...ids, expense(makeHousehold())], id)).status, 400);
  assert.equal(eventOf(ids[0]), null);
  assert.equal((await assign(ids, event(makeHousehold()))).status, 400);
  const income = addTx(f, { type: 'ingreso', date: '2026-08-01', amountMinor: 100 });
  assert.equal((await assign([...ids, income], id)).status, 400);
  assert.equal((await assign(ids, id)).status, 200);
  assert.equal(eventOf(ids[0]), id);
  const after = sqlite.prepare('SELECT * FROM transactions WHERE household_id=? AND type=\'gasto\' ORDER BY id').all(f.householdId);
  assert.deepEqual(after, before);
  assert.equal((await assign(ids, null)).status, 200);
  assert.equal(eventOf(ids[0]), null);
  sqlite.prepare('UPDATE events SET archived=1 WHERE id=?').run(id);
  assert.equal((await assign(ids, id)).status, 400);
});

test('manual creation/edit/filter/delete integrate with events and reject foreign or income labels', async () => {
  const f = makeHousehold(); const h = headers(f); const id = event(f);
  const data = { type: 'gasto', amount: '100', accountId: f.accountId, eventId: id, date: '2026-08-10' };
  assert.equal((await app.request('/transactions', { method: 'POST', headers: h, body: JSON.stringify({ ...data, eventId: event(makeHousehold()) }) })).status, 400);
  assert.equal((await app.request('/transactions', { method: 'POST', headers: h, body: JSON.stringify({ ...data, type: 'ingreso' }) })).status, 400);
  const created = await app.request('/transactions', { method: 'POST', headers: h, body: JSON.stringify(data) });
  assert.equal(created.status, 201); const tx = await created.json() as { id: string };
  assert.equal(eventOf(tx.id), id);
  expense(f);
  const listed = await (await app.request(`/transactions?eventId=${id}`, { headers: h })).json() as { id: string; eventName: string }[];
  assert.equal(listed.length, 1); assert.equal(listed[0].eventName, 'Vacaciones');
  assert.equal((await (await app.request('/transactions?eventId=', { headers: h })).json() as unknown[]).length, 1);
  assert.equal((await app.request(`/transactions/${tx.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ eventId: null }) })).status, 200);
  assert.equal(eventOf(tx.id), null);
  setTransactionEvent(tx.id, id);
  assert.equal((await app.request(`/transactions/${tx.id}`, { method: 'DELETE', headers: h })).status, 200);
  assert.equal(eventOf(tx.id), null);
  assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
});

test('extraordinary events leave monthly totals and balances intact but clean both sides of category comparisons', () => {
  const f = makeHousehold(); const id = event(f);
  expense(f, '2026-08-02', 10000); expense(f, '2026-09-02', 15000);
  const unusual = [expense(f, '2026-08-03', 90000), expense(f, '2026-09-03', 80000)];
  const balance = accountBalances(f.householdId);
  assignEvent(f.householdId, unusual, id);
  const summary = monthlySummary(f.householdId, '2026-09');
  assert.equal(summary.expenseMinor, 95000); assert.equal(summary.habitualExpenseMinor, 15000);
  assert.equal(summary.balanceMinor, -95000); assert.deepEqual(accountBalances(f.householdId), balance);
  const trend = categoryTrends(f.householdId, '2026-09', 1)[0];
  assert.equal(trend.currentMinor, 95000); assert.equal(trend.habitualMinor, 15000); assert.equal(trend.baselineMinor, 10000); assert.equal(trend.changePct, 50);
  sqlite.prepare('UPDATE events SET archived=1 WHERE id=?').run(id);
  assert.equal(monthlySummary(f.householdId, '2026-09').habitualExpenseMinor, 15000);
  sqlite.prepare('UPDATE events SET extraordinary=0 WHERE id=?').run(id);
  assert.equal(monthlySummary(f.householdId, '2026-09').habitualExpenseMinor, 95000);
});

test('habit detectors ignore extraordinary purchases and include ordinary events', () => {
  const f = makeHousehold(); const merchantId = makeMerchant(f.householdId, 'Cafecito'); const id = event(f);
  const ids = [1, 2, 3, 4, 5, 6].map(n => addTx(f, { date: daysAgo(n), amountMinor: 100, merchantId }));
  addTx(f, { type: 'ingreso', date: daysAgo(1), amountMinor: 100000 });
  assert.ok(detectHormiga(f.householdId, 1).length > 0);
  assignEvent(f.householdId, ids, id);
  assert.equal(detectHormiga(f.householdId, 1).length, 0);
  const recurringMerchant = makeMerchant(f.householdId, 'Abono de viaje');
  const repeats = [2,32,62].map(n => addTx(f, { date: daysAgo(n), amountMinor: 5000, merchantId: recurringMerchant }));
  assert.ok(detectSubscriptions(f.householdId).some(s => s.merchantId === recurringMerchant));
  assignEvent(f.householdId, repeats, id);
  assert.ok(!detectSubscriptions(f.householdId).some(s => s.merchantId === recurringMerchant));
  sqlite.prepare('UPDATE events SET extraordinary=0 WHERE id=?').run(id);
  assert.ok(detectSubscriptions(f.householdId).some(s => s.merchantId === recurringMerchant));
});

test('explicit purchase scope tags past and future billed installments without changing committed amounts', () => {
  const f = makeHousehold(); const id = event(f);
  const first = statement(f, '2026-07-27', 2)[0];
  const second = statement(f, '2026-08-27', 3)[0];
  const amount = installmentForecast(f.householdId, '2026-09', 1).months[0].arsMinor;
  assert.equal(assignEvent(f.householdId, [second], id, true).updated, 2);
  assert.equal(eventOf(first), id);
  const forecast = installmentForecast(f.householdId, '2026-09', 1).months[0];
  assert.equal(forecast.arsMinor, amount); assert.equal(forecast.items[0].eventName, 'Vacaciones');
  assert.equal(installmentForecast(f.householdId, '2026-09', 1, undefined, id).months[0].items.length, 1);
  assert.equal(installmentForecast(f.householdId, '2026-09', 1, undefined, null).months[0].items.length, 0);
  sqlite.prepare('UPDATE events SET archived=1 WHERE id=?').run(id);
  const third = statement(f, '2026-09-27', 4)[0];
  assert.equal(eventOf(third), id, 'Archived events retain existing purchase rules');
  assert.equal(assignEvent(f.householdId, [third], null, true).updated, 3);
  assert.equal(eventOf(first), null);
  assert.equal(eventOf(statement(f, '2026-10-27', 5)[0]), null);
});

test('single-installment labels do not silently change other installments or create rules', async () => {
  const f = makeHousehold(); const id = event(f); const h = headers(f);
  const first = statement(f, '2026-07-27', 2)[0];
  const before = sqlite.prepare('SELECT amount_minor,date,paid_by_user_id FROM transactions WHERE id=?').get(first);
  assert.equal((await app.request(`/transactions/${first}`, { method: 'PATCH', headers: h, body: JSON.stringify({ eventId: id }) })).status, 200);
  assert.equal(eventOf(first), id);
  assert.equal(installmentForecast(f.householdId, '2026-08', 1).months[0].items[0].eventId, null, 'Single billed quota must not label future estimates');
  const second = statement(f, '2026-08-27', 3)[0];
  assert.equal(eventOf(second), null);
  assert.deepEqual(sqlite.prepare('SELECT amount_minor,date,paid_by_user_id FROM transactions WHERE id=?').get(first), before);
  assert.equal((await app.request(`/transactions/${first}`, { method: 'PATCH', headers: h, body: JSON.stringify({ amount: '1', eventId: null }) })).status, 409);
  assert.equal(eventOf(first), id);
});

test('missing coupons and ambiguous bank identities never propagate an event', () => {
  const f = makeHousehold(); const id = event(f);
  const first = statement(f, '2026-07-27', 2, null)[0];
  assert.throws(() => assignEvent(f.householdId, [first], id, true), /certeza/);
  assert.equal(eventOf(first), null);
  assignEvent(f.householdId, [first], id);
  const second = statement(f, '2026-08-27', 3, 'same', true);
  assert.throws(() => assignEvent(f.householdId, [second[0]], id, true), /certeza/);
  assert.ok(second.every(tx => eventOf(tx) === null));
});

test('different purchases, accounts and households never inherit another purchase event', () => {
  const f = makeHousehold(); const id = event(f);
  const first = statement(f, '2026-07-27', 2)[0];
  assignEvent(f.householdId, [first], id, true);
  assert.equal(eventOf(statement(f, '2026-08-27', 3, 'other')[0]), null);
  assert.equal(eventOf(statement(makeHousehold(), '2026-08-27', 3)[0]), null);
  const accountId = randomUUID();
  sqlite.prepare("INSERT INTO accounts(id,household_id,name,type,currency) VALUES (?,?,'Other','tarjeta','ARS')").run(accountId, f.householdId);
  assert.equal(eventOf(statement({ ...f, accountId }, '2026-08-27', 3)[0]), null);
});
