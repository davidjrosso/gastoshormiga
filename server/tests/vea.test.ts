import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { makeHousehold, makeSession, addTx, sqlite, type Fixture } from './harness.js';
import { createShoppingRoutes } from '../src/routes/shopping.js';
import { productKey } from '../src/routes/vea.js';
import { VeaClient, VeaError, VEA_SETTINGS, cartUrl, groupItems, parseSimulation } from '../src/stores/vea.js';
import { runMigrations } from '../src/db/migrate.js';

const seller: string = VEA_SETTINGS.sellerId;
// Minimal shape recorded from public VEA simulation on 2026-09-29, with
// postalCode 5850. Prices are fixture data, not current offers.
function simulated(items = [{ sku: '392453', qty: 1 }]) {
  return { items: items.map((i, index) => ({ id: i.sku, requestIndex: index, quantity: i.qty, seller,
    availability: 'available', sellingPrice: 219000, priceDefinition: { total: i.qty * 219000 }, measurementUnit: 'un', unitMultiplier: 1 })),
    logisticsInfo: items.map((_, index) => ({ itemIndex: index, slas: [{ id: 'Retiro en Tienda - Vea Río Tercero Modesto Acuña 58', deliveryChannel: 'delivery' }] })),
  };
}
const catalog = [{ productName: 'Leche de prueba 1 L', items: [{ itemId: '392453', name: '1 L', ean: '7790000000001', measurementUnit: 'un', unitMultiplier: 1 }] }];
let calls = 0;
const transport: typeof fetch = async (_url, init) => {
  calls++;
  if (init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    assert.equal(body.postalCode, '5850'); assert.equal(body.country, 'ARG');
    return new Response(JSON.stringify(simulated(body.items.map((i: { id: string; quantity: number; seller: string }) => { assert.equal(i.seller, seller); return { sku: i.id, qty: i.quantity }; }))));
  }
  return new Response(JSON.stringify(catalog), { status: 206 });
};
const headers = (f: Fixture) => ({ cookie: `hormiga_session=${makeSession(f.userId)}`, 'Content-Type': 'application/json', 'X-Hormiga-Household': f.householdId, 'X-Hormiga-User': f.userId });
function createApp() { return new Hono().route('/shopping', createShoppingRoutes(new VeaClient(transport))); }
function request(app: Hono, f: Fixture, path: string, method = 'GET', body?: unknown) { return app.request('/shopping/stores/vea'+path, { method, headers: headers(f), body: body === undefined ? undefined : JSON.stringify(body) }); }
function addItem(f: Fixture, name = 'Leche', brand = '') {
  const id = randomUUID();
  sqlite.prepare('INSERT INTO shopping_items VALUES(?,?,?,?,?)').run(f.householdId, id, JSON.stringify({ name, brand, quantity: '1 kg', unit: '', note: '', section: 'Otros', urgent: false, status: 'pending', batchId: '' }), 1, Date.now());
  return id;
}

test('v7 migration preserves all existing data and rejects downgrade', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db); db.exec('DROP TABLE store_oauth_pending; DROP TABLE store_accounts; DROP TABLE store_product_links; DROP TABLE store_settings; PRAGMA user_version=6');
    db.exec("INSERT INTO households(id,name) VALUES('h','House'); INSERT INTO shopping_items VALUES('h','i','{}',1,1)");
    const before = db.prepare('SELECT * FROM shopping_items').all();
    assert.deepEqual(runMigrations(db), { from: 6, to: 8 });
    assert.deepEqual(db.prepare('SELECT * FROM shopping_items').all(), before);
    assert.deepEqual(runMigrations(db), { from: 8, to: 8 });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.pragma('user_version=9'); assert.throws(() => runMigrations(db), /más viejo/);
  } finally { db.close(); }
});
test('simulation maps by requestIndex, keeps integer totals and requires exact seller, quantity and branch pickup', () => {
  const input = [{ sku: '392453', qty: 2 }, { sku: '392452', qty: 1 }];
  const data = simulated(input); data.items.reverse();
  const valid = parseSimulation(data, input, VEA_SETTINGS);
  assert.equal(valid[0].subtotalMinor, 438000); assert.equal(valid[0].available, true);
  data.items[1].quantity = 1;
  assert.equal(parseSimulation(data, input, VEA_SETTINGS)[0].available, false);
  data.items[1].quantity = 2; data.items[1].seller = 'other';
  assert.equal(parseSimulation(data, input, VEA_SETTINGS)[0].available, false);
  data.items[1].seller = seller; data.logisticsInfo[0].slas = [];
  assert.match(parseSimulation(data, input, VEA_SETTINGS)[0].reason!, /Retiro/);
  data.items[0].availability = 'withoutStock';
  assert.equal(parseSimulation(data, input, VEA_SETTINGS)[1].subtotalMinor, null);
  assert.throws(() => parseSimulation({ ...data, storePreferencesData: { currencyCode: 'USD' } }, input, VEA_SETTINGS), VeaError);
});
test('aggregates repeated SKU and excludes unavailable rows from a fixed-domain encoded cart URL', () => {
  assert.deepEqual(groupItems([{ sku: '1', qty: 2 }, { sku: '1', qty: 3 }]), [{ sku: '1', qty: 5 }]);
  assert.throws(() => groupItems([{ sku: '1', qty: 99 }, { sku: '1', qty: 1 }]), VeaError);
  for (const qty of [0, -1, 1.5, 100]) assert.throws(() => groupItems([{ sku: '1', qty }]), VeaError);
  const offers = parseSimulation(simulated([{ sku: '1', qty: 2 }, { sku: '2', qty: 1 }]), [{ sku: '1', qty: 2 }, { sku: '2', qty: 1 }], VEA_SETTINGS);
  const url = new URL(cartUrl(offers, VEA_SETTINGS)!);
  assert.equal(url.origin, 'https://www.vea.com.ar'); assert.deepEqual(url.searchParams.getAll('sku'), ['1','2']);
  assert.deepEqual(url.searchParams.getAll('seller'), [seller,seller]);
  offers[1].available = false; assert.deepEqual(new URL(cartUrl(offers, VEA_SETTINGS)!).searchParams.getAll('qty'), ['2']);
  offers[0].available = false; assert.equal(cartUrl(offers, VEA_SETTINGS), null);
});
test('client caches in memory, isolates quotation cache and handles upstream errors/malformed data/timeouts', async () => {
  calls = 0; const client = new VeaClient(transport);
  await client.search('leche', VEA_SETTINGS); await client.search('leche', VEA_SETTINGS); assert.equal(calls, 1);
  const first = await client.quote([{ sku: '392453', qty: 1 }], VEA_SETTINGS, 'a');
  const second = await client.quote([{ sku: '392453', qty: 1 }], VEA_SETTINGS, 'a');
  assert.deepEqual(first, second); assert.equal(calls, 2);
  await client.quote([{ sku: '392453', qty: 1 }], VEA_SETTINGS, 'b'); assert.equal(calls, 3);
  const failed = new VeaClient(async () => new Response('', { status: 503 }));
  await assert.rejects(failed.search('leche', VEA_SETTINGS), /VEA no responde/);
  const malformed = new VeaClient(async () => new Response('{}'));
  await assert.rejects(malformed.search('leche', VEA_SETTINGS), /catálogo/);
  const timeout = new VeaClient((_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('test deadline')), 100);
    init?.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('timeout')); }, { once: true });
  }), 5);
  await assert.rejects(timeout.search('leche', VEA_SETTINGS), /VEA no responde/);
});
test('store routes require shopping session/scope and isolate settings and links without financial/shopping effects', async () => {
  const app = createApp(); const f = makeHousehold(); const other = makeHousehold();
  addTx(f, { amountMinor: 12345, date: '2026-09-29' }); const id = addItem(f); const id2 = addItem(f, 'Otra leche');
  const beforeShopping = sqlite.prepare('SELECT * FROM shopping_items WHERE household_id=?').all(f.householdId);
  const beforeFinancial = sqlite.prepare('SELECT * FROM transactions WHERE household_id=?').all(f.householdId);
  assert.equal((await app.request('/shopping/stores/vea/settings')).status, 401);
  assert.equal((await app.request('/shopping/stores/vea/settings', { headers: { ...headers(f), 'X-Hormiga-User': other.userId } })).status, 403);
  assert.equal((await request(app, f, '/settings', 'PUT', { salesChannel: '34', sellerId: seller })).status, 200);
  assert.equal((await (await request(app, other, '/settings')).json() as { saved: boolean }).saved, false);
  const key = encodeURIComponent(productKey({ name: 'Leche', brand: '' }));
  assert.equal((await request(app, other, '/links/'+key, 'PUT', { itemId: id, sku: '392453' })).status, 404);
  assert.equal((await request(app, f, '/links/'+key, 'PUT', { itemId: id, sku: '392453' })).status, 200);
  assert.equal((await request(app, f, '/links/'+encodeURIComponent('otra leche|'), 'PUT', { itemId: id2, sku: '392453' })).status, 200);
  await request(app, other, '/links/'+key, 'DELETE');
  const quote = await request(app, f, '/quote', 'POST', { items: [{ itemId: id, qty: 2 }, { itemId: id2, qty: 1 }] });
  assert.equal(quote.status, 200); assert.equal(quote.headers.get('Cache-Control'), 'no-store');
  const body = await quote.json() as { offers: Array<{ qty: number }>; totalMinor: number }; assert.equal(body.offers.length, 1); assert.equal(body.offers[0].qty, 3); assert.equal(body.totalMinor, 657000);
  assert.deepEqual(sqlite.prepare('SELECT * FROM shopping_items WHERE household_id=?').all(f.householdId), beforeShopping);
  assert.deepEqual(sqlite.prepare('SELECT * FROM transactions WHERE household_id=?').all(f.householdId), beforeFinancial);
  assert.equal((await request(app, other, '/quote', 'POST', { items: [{ itemId: id, qty: 1 }] })).status, 404);
  await request(app, f, '/links/'+key, 'DELETE');
  const unlinked = await (await request(app, f, '/quote', 'POST', { items: [{ itemId: id, qty: 1 }] })).json(); assert.equal((unlinked as { cartUrl: string | null }).cartUrl, null);
});
test('routes reject invalid quantities, stale names, bought items and enforce bounded rate limits', async () => {
  const app = createApp(); const f = makeHousehold(); const id = addItem(f);
  assert.equal((await request(app, f, '/quote', 'POST', { items: [{ itemId: id, qty: 0 }] })).status, 400);
  assert.equal((await request(app, f, '/links/wrong', 'PUT', { itemId: id, sku: '392453' })).status, 409);
  sqlite.prepare("UPDATE shopping_items SET data_json=json_set(data_json,'$.status','bought') WHERE id=?").run(id);
  assert.equal((await request(app, f, '/quote', 'POST', { items: [{ itemId: id, qty: 1 }] })).status, 409);
  let response = await request(app, f, '/settings');
  for (let i = 0; i < 30; i++) response = await request(app, f, '/settings');
  assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '60');
});
