import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { makeHousehold, makeSession, addTx, sqlite, type Fixture } from './harness.js';
import { shoppingRoutes } from '../src/routes/shopping.js';
import { runMigrations } from '../src/db/migrate.js';

const app = new Hono().route('/shopping', shoppingRoutes);
const headers = (f: Fixture, user = f.userId) => ({ cookie: `hormiga_session=${makeSession(user)}`, 'Content-Type': 'application/json', 'X-Hormiga-Household': f.householdId, 'X-Hormiga-User': user });
const values = (name = 'Leche') => ({ name, quantity: '2', unit: 'litros', brand: '', note: '', section: 'Lácteos', urgent: false, status: 'pending', batchId: '' });
const add = () => ({ id: randomUUID(), itemId: randomUUID(), kind: 'add', values: values() });
function send(f: Fixture, op: unknown, user = f.userId) { return app.request('/shopping/operations', { method: 'POST', headers: headers(f, user), body: JSON.stringify(op) }); }
const patch = (itemId: string, change: object, base: object) => ({ id: randomUUID(), itemId, kind: 'patch', values: change, base: { batchId: '', ...base } });

test('shopping v5 to v6 migration preserves every existing table and is repeatable', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE store_product_links; DROP TABLE store_settings; DROP TABLE shopping_operations; DROP TABLE shopping_items; PRAGMA user_version=5');
    db.exec("INSERT INTO households(id,name) VALUES('h','Existing'); INSERT INTO accounts(id,household_id,name,type) VALUES('a','h','Cash','efectivo'); INSERT INTO transactions(id,household_id,type,date,account_id,amount_minor) VALUES('t','h','gasto','2026-09-01','a',12345)");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(t => t.name);
    const before = tables.map(t => db.prepare(`SELECT * FROM "${t}"`).all());
    assert.deepEqual(runMigrations(db), { from: 5, to: 7 });
    assert.deepEqual(tables.map(t => db.prepare(`SELECT * FROM "${t}"`).all()), before);
    assert.deepEqual(runMigrations(db), { from: 7, to: 7 });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('shopping requires a session, isolates households and rejects stale account scope', async () => {
  const f = makeHousehold(); const other = makeHousehold(); const op = add();
  assert.equal((await app.request('/shopping')).status, 401);
  assert.equal((await send(f, op)).status, 200);
  const foreign = await app.request('/shopping', { headers: headers(other) });
  assert.equal(foreign.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual((await foreign.json() as { items: unknown[] }).items, []);
  assert.equal((await send(other, patch(op.itemId, { status: 'bought' }, { status: 'pending' }))).status, 404);
  const stale = await app.request('/shopping/operations', { method: 'POST', headers: { ...headers(other), 'X-Hormiga-Household': f.householdId }, body: JSON.stringify(add()) });
  assert.equal(stale.status, 403);
});

test('operation receipts make retries idempotent and reject reused IDs with changed data', async () => {
  const f = makeHousehold(); const op = add();
  const first = await (await send(f, op)).json();
  assert.deepEqual(await (await send(f, op)).json(), first);
  assert.equal((await send(f, { ...op, values: values('Pan') })).status, 409);
  assert.equal((sqlite.prepare('SELECT count(*) n FROM shopping_items WHERE household_id=?').get(f.householdId) as { n: number }).n, 1);
});

test('two members merge quantity and bought without losing either change', async () => {
  const f = makeHousehold(); const op = add(); await send(f, op);
  assert.equal((await send(f, patch(op.itemId, { quantity: '3' }, { quantity: '2' }), f.otherUserId)).status, 200);
  const res = await send(f, patch(op.itemId, { status: 'bought' }, { status: 'pending' }));
  const item = (await res.json() as { items: Array<{ quantity: string; status: string }> }).items[0];
  assert.equal(item.quantity, '3'); assert.equal(item.status, 'bought');
});

test('conflicting quantities are surfaced, not silently overwritten; an explicit resolution works', async () => {
  const f = makeHousehold(); const op = add(); await send(f, op);
  await send(f, patch(op.itemId, { quantity: '3' }, { quantity: '2' }));
  const conflict = await send(f, patch(op.itemId, { quantity: '4' }, { quantity: '2' }), f.otherUserId);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { snapshot: { items: Array<{ quantity: string }> } }).snapshot.items[0].quantity, '3');
  assert.equal((await send(f, patch(op.itemId, { quantity: '4' }, { quantity: '3' }), f.otherUserId)).status, 200);
});

test('bought, undo and history have no financial effects and stale offline edits cannot reopen history silently', async () => {
  const f = makeHousehold(); addTx(f, { date: '2026-09-01', amountMinor: 12345 });
  const before = sqlite.prepare('SELECT * FROM transactions WHERE household_id=?').all(f.householdId);
  const op = add(); await send(f, op);
  assert.equal((await send(f, patch(op.itemId, { batchId: 'trip' }, { batchId: '', status: 'pending' }))).status, 400);
  await send(f, patch(op.itemId, { status: 'bought' }, { status: 'pending' }));
  await send(f, patch(op.itemId, { status: 'pending' }, { status: 'bought' }));
  await send(f, patch(op.itemId, { status: 'unavailable' }, { status: 'pending' }));
  await send(f, patch(op.itemId, { status: 'bought' }, { status: 'unavailable' }));
  assert.equal((await send(f, patch(op.itemId, { batchId: 'trip' }, { status: 'bought' }))).status, 200);
  assert.equal((await send(f, patch(op.itemId, { note: 'Old edit' }, { note: '' }))).status, 409);
  assert.equal((await send(f, patch(op.itemId, { batchId: '' }, { batchId: 'trip' }))).status, 200);
  assert.deepEqual(sqlite.prepare('SELECT * FROM transactions WHERE household_id=?').all(f.householdId), before);
});

test('validates lengths, fields and preconditions before persisting any operation', async () => {
  const f = makeHousehold(); const op = add();
  for (const invalid of [ { ...op, values: { ...op.values, name: ' ' } }, { ...op, values: { ...op.values, price: 100 } }, { ...op, values: { ...op.values, status: 'paid' } } ]) {
    assert.equal((await send(f, invalid)).status, 400);
  }
  await send(f, op);
  assert.equal((await send(f, { id: randomUUID(), itemId: op.itemId, kind: 'patch', values: { quantity: '7' }, base: {} })).status, 400);
});
