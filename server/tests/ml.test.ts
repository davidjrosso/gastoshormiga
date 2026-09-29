import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { makeHousehold, makeSession, sqlite, type Fixture } from './harness.js';
import { createShoppingRoutes } from '../src/routes/shopping.js';
import { createMlCallbackRoutes } from '../src/routes/ml.js';
import { productKey } from '../src/routes/store-rows.js';
import { summarize, type CompareRow } from '../src/routes/compare.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadKey, open, seal, SecretBoxError } from '../src/lib/secret-box.js';
import { bestFullOffer, cartUrl, loadMlConfig, MlClient, MlError, parseOffers, parseReturnUrl, parseShipping, toMinor, type MlConfig } from '../src/stores/ml.js';
import { MlAccounts } from '../src/stores/ml-account.js';
import { VeaClient, VEA_SETTINGS } from '../src/stores/vea.js';

const key = randomBytes(32);
const config: MlConfig = { clientId: '5742415625862442', clientSecret: 'secreto-de-prueba', redirectUri: 'https://1-2-3-4.sslip.io/hormiga/api/ml/callback', postalCode: '5850', returnUrl: 'https://1.2.3.4/hormiga/ajustes' };

// Shapes recorded from the real API on 2026-09-29 (values are fixture data).
const offersFixture: Record<string, unknown> = {
  MLA100: { results: [
    { item_id: 'MLA9001', price: 4554.3, currency_id: 'ARS', seller_id: 1, condition: 'new', shipping: { logistic_type: 'fulfillment', free_shipping: false } },
    { item_id: 'MLA9002', price: 3999, currency_id: 'ARS', seller_id: 2, condition: 'new', shipping: { logistic_type: 'cross_docking', free_shipping: false } },
  ] },
  MLA200: { results: [{ item_id: 'MLA9003', price: 7700, currency_id: 'ARS', seller_id: 3, condition: 'new', shipping: { logistic_type: 'fulfillment', free_shipping: false } }] },
  MLA300: { results: [{ item_id: 'MLA9004', price: 100, currency_id: 'ARS', seller_id: 4, condition: 'new', shipping: { logistic_type: 'xd_drop_off' } }] },
};
const shippingFixture: Record<string, number> = { MLA9001: 4999, MLA9003: 6499 };
let tokenCalls: string[] = []; let refreshFails = false; let accessSeq = 0;
const mlTransport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === '/oauth/token') {
    const form = new URLSearchParams(String(init?.body));
    tokenCalls.push(form.get('grant_type')!);
    assert.equal(form.get('client_secret'), config.clientSecret);
    if (form.get('grant_type') === 'authorization_code') { assert.ok(form.get('code_verifier')); assert.equal(form.get('redirect_uri'), config.redirectUri); if (form.get('code') === 'malo') return new Response('{"error":"invalid_grant"}', { status: 400 }); }
    if (form.get('grant_type') === 'refresh_token' && refreshFails) return new Response('{"error":"invalid_grant"}', { status: 400 });
    await new Promise(r => setTimeout(r, 10));
    return Response.json({ access_token: `APP_USR-access-${++accessSeq}`, refresh_token: `TG-refresh-${accessSeq}`, expires_in: 21600, scope: 'read offline_access', user_id: 144797182 });
  }
  assert.match(String((init?.headers as Record<string, string>).Authorization), /^Bearer APP_USR-access-/);
  if (url.pathname === '/products/search') return Response.json({ results: [{ id: 'MLA100', name: 'Yerba Playadito 1 kg' }, { id: 'no-valido', name: 'x' }] });
  const items = url.pathname.match(/^\/products\/(MLA\d+)\/items$/);
  if (items) return offersFixture[items[1]] ? Response.json(offersFixture[items[1]]) : new Response('{}', { status: 404 });
  const product = url.pathname.match(/^\/products\/(MLA\d+)$/);
  if (product) return Response.json({ id: product[1], name: `Producto ${product[1]}`, attributes: [{ id: 'GTIN', value_name: '7790000000001' }] });
  const ship = url.pathname.match(/^\/items\/(MLA\d+)\/shipping_options$/);
  if (ship) { assert.equal(url.searchParams.get('zip_code'), '5850'); return Response.json({ options: [{ cost: shippingFixture[ship[1]] ?? 0, list_cost: shippingFixture[ship[1]] ?? 0, currency_id: 'ARS', estimated_delivery_time: { date: '2026-10-01T00:00:00-03:00' } }] }); }
  return new Response('{}', { status: 404 });
};
const seller: string = VEA_SETTINGS.sellerId;
const veaPrices: Record<string, number> = { '111': 500000, '222': 700000 };
const veaTransport: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init!.body));
  return Response.json({ items: body.items.map((i: { id: string; quantity: number }, index: number) => ({ id: i.id, requestIndex: index, quantity: i.quantity, seller, availability: veaPrices[i.id] ? 'available' : 'withoutStock', sellingPrice: veaPrices[i.id] ?? 0, priceDefinition: { total: (veaPrices[i.id] ?? 0) * i.quantity }, measurementUnit: 'un', unitMultiplier: 1 })),
    logisticsInfo: body.items.map((_: unknown, index: number) => ({ itemIndex: index, slas: [{ id: 'Retiro en Tienda - Vea Río Tercero Modesto Acuña 58' }] })) });
};
const newAccounts = () => new MlAccounts(new MlClient(config, mlTransport), key);
const headers = (f: Fixture) => ({ cookie: `hormiga_session=${makeSession(f.userId)}`, 'Content-Type': 'application/json', 'X-Hormiga-Household': f.householdId, 'X-Hormiga-User': f.userId });
function createApp(accounts = newAccounts()) {
  return { app: new Hono().route('/shopping', createShoppingRoutes(new VeaClient(veaTransport), accounts)).route('/api/ml', createMlCallbackRoutes(accounts)), accounts };
}
// Test responses are asserted field by field; untyped JSON keeps them readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const call = (app: Hono, f: Fixture, path: string, method = 'GET', body?: unknown) => app.request('/shopping' + path, { method, headers: headers(f), body: body === undefined ? undefined : JSON.stringify(body) });
function addItem(f: Fixture, name: string) {
  const id = randomUUID();
  sqlite.prepare('INSERT INTO shopping_items VALUES(?,?,?,?,?)').run(f.householdId, id, JSON.stringify({ name, brand: '', quantity: '', unit: '', note: '', section: 'Otros', urgent: false, status: 'pending', batchId: '' }), 1, Date.now());
  return id;
}
function link(f: Fixture, store: 'vea' | 'ml', name: string, sku: string) {
  sqlite.prepare('INSERT INTO store_product_links VALUES(?,?,?,?,?,?,?,?,?)').run(f.householdId, store, productKey({ name, brand: '' }), sku, '', `${store} ${name}`, 1, f.userId, Date.now());
}
async function connect(app: Hono, f: Fixture) {
  const res = await call(app, f, '/stores/ml/connect', 'POST');
  assert.equal(res.status, 200);
  const auth = new URL((await res.json() as Json).authUrl);
  return auth.searchParams.get('state')!;
}

test('v8 migration only adds store account tables, keeps v7 data and rejects downgrade', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db); db.exec('DROP TABLE store_oauth_pending; DROP TABLE store_accounts; PRAGMA user_version=7');
    db.exec("INSERT INTO households(id,name) VALUES('h','Casa'); INSERT INTO shopping_items VALUES('h','i','{}',1,1)");
    const before = db.prepare('SELECT * FROM shopping_items').all();
    assert.deepEqual(runMigrations(db), { from: 7, to: 8 });
    assert.deepEqual(db.prepare('SELECT * FROM shopping_items').all(), before);
    assert.deepEqual(runMigrations(db), { from: 8, to: 8 });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.pragma('user_version=9'); assert.throws(() => runMigrations(db), /más viejo/);
  } finally { db.close(); }
});

test('secret box authenticates context and rejects tampering or invalid keys', () => {
  const sealed = seal('APP_USR-abc', key, 'ml:h1:access');
  assert.ok(!sealed.includes('APP_USR'));
  assert.equal(open(sealed, key, 'ml:h1:access'), 'APP_USR-abc');
  assert.throws(() => open(sealed, key, 'ml:h2:access'), SecretBoxError);
  assert.throws(() => open(sealed, randomBytes(32), 'ml:h1:access'), SecretBoxError);
  const parts = sealed.split('.'); parts[3] = Buffer.from('otro').toString('base64url');
  assert.throws(() => open(parts.join('.'), key, 'ml:h1:access'), SecretBoxError);
  assert.equal(loadKey(undefined), null); assert.equal(loadKey(Buffer.alloc(16).toString('base64')), null);
  assert.equal(loadKey(key.toString('base64'))?.length, 32);
});

test('ML parsing keeps only new ARS offers in integer cents, picks the cheapest Full and builds a validated cart', () => {
  assert.equal(toMinor(26577.65), 2657765); assert.throws(() => toMinor(-1), MlError); assert.throws(() => toMinor(Number.NaN), MlError);
  const offers = parseOffers({ results: [...(offersFixture.MLA100 as { results: object[] }).results,
    { item_id: 'MLA9009', price: 1, currency_id: 'USD', seller_id: 9, condition: 'new', shipping: { logistic_type: 'fulfillment' } },
    { item_id: 'MLA9010', price: 1, currency_id: 'ARS', seller_id: 9, condition: 'used', shipping: { logistic_type: 'fulfillment' } }] });
  assert.deepEqual(offers.map(o => o.itemId), ['MLA9001', 'MLA9002']);
  assert.equal(bestFullOffer(offers)?.itemId, 'MLA9001', 'the cheaper non-Full offer is ignored');
  assert.equal(bestFullOffer(parseOffers(offersFixture.MLA300)), null);
  assert.deepEqual(parseShipping({ options: [{ cost: 8499, list_cost: 8499, currency_id: 'ARS' }, { cost: 0, list_cost: 4999, currency_id: 'ARS' }] }), { costMinor: 0, listMinor: 499900, eta: null });
  assert.equal(parseShipping({ options: [] }), null);
  assert.equal(cartUrl([{ itemId: 'MLA1', qty: 1 }, { itemId: 'MLA2', qty: 2 }, { itemId: 'MLA1', qty: 1 }]), 'https://www.mercadolibre.com.ar/gz/checkout/cart/buy?site_id=MLA&items=MLA1-Q2,MLA2-Q2');
  assert.equal(cartUrl([]), null);
  assert.throws(() => cartUrl([{ itemId: 'MLA1&x=1', qty: 1 }]), MlError);
  assert.throws(() => cartUrl([{ itemId: 'MLA1', qty: 60 }, { itemId: 'MLA1', qty: 40 }]), MlError);
});

test('ML config requires https redirect and return URLs only accept the configured callback', () => {
  assert.equal(loadMlConfig({ ML_CLIENT_ID: '1', ML_CLIENT_SECRET: 's', ML_REDIRECT_URI: 'http://x/cb' }), null);
  assert.equal(loadMlConfig({ ML_CLIENT_ID: 'abc', ML_CLIENT_SECRET: 's', ML_REDIRECT_URI: 'https://x/cb' }), null);
  assert.equal(loadMlConfig({ ML_CLIENT_ID: '1', ML_CLIENT_SECRET: 's', ML_REDIRECT_URI: 'https://x/cb' })?.postalCode, '5850');
  assert.deepEqual(parseReturnUrl(`${config.redirectUri}?code=TG-1&state=abc`, config), { code: 'TG-1', state: 'abc' });
  assert.throws(() => parseReturnUrl('https://evil.example/hormiga/api/ml/callback?code=a&state=b', config), MlError);
  assert.throws(() => parseReturnUrl(`${config.redirectUri}?state=b`, config), MlError);
  assert.throws(() => parseReturnUrl('no es url', config), MlError);
});

test('OAuth: state is single use, bound to the starting session and tokens are stored encrypted', async () => {
  const f = makeHousehold(); const other = makeHousehold();
  const { app } = createApp();
  assert.deepEqual(await (await call(app, f, '/stores/ml/status')).json() as Json, { configured: true, connected: false, connectedBy: null, connectedAt: null });
  const state = await connect(app, f);
  const back = `${config.redirectUri}?code=TG-ok&state=${state}`;
  assert.equal((await call(app, other, '/stores/ml/complete', 'POST', { url: back })).status, 401, 'another household cannot use the state');
  // The failed attempt consumed the state: start again.
  const state2 = await connect(app, f);
  const done = await call(app, f, '/stores/ml/complete', 'POST', { url: `${config.redirectUri}?code=TG-ok&state=${state2}` });
  assert.equal(done.status, 200);
  const status = await done.json() as Json;
  assert.equal(status.connected, true); assert.equal(status.connectedBy, 'Uno'); assert.ok(!JSON.stringify(status).includes('APP_USR'));
  const row = sqlite.prepare("SELECT * FROM store_accounts WHERE household_id=? AND store='ml'").get(f.householdId) as Record<string, string>;
  assert.ok(!JSON.stringify(row).includes('APP_USR') && !JSON.stringify(row).includes('TG-refresh'));
  assert.equal(row.external_user_id, '144797182');
  assert.equal((await call(app, f, '/stores/ml/complete', 'POST', { url: `${config.redirectUri}?code=TG-ok&state=${state2}` })).status, 401, 'reuse rejected');
  assert.equal((sqlite.prepare('SELECT COUNT(*) n FROM store_oauth_pending WHERE household_id=?').get(f.householdId) as { n: number }).n, 0);
  assert.equal((await call(app, other, '/stores/ml/status')).status, 200);
  assert.equal((await (await call(app, other, '/stores/ml/status')).json() as Json).connected, false, 'connection is per household');
  assert.equal((await (await call(app, f, '/stores/ml/connection', 'DELETE')).json() as Json).connected, false);
});

test('public callback completes by state only, redirects home and rejects expired or bad codes', async () => {
  const f = makeHousehold();
  const { app } = createApp();
  const state = await connect(app, f);
  const ok = await app.request(`/api/ml/callback?code=TG-ok&state=${state}`);
  assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), 'https://1.2.3.4/hormiga/ajustes?ml=conectado');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await app.request(`/api/ml/callback?code=TG-ok&state=${state}`)).status, 400);
  const expired = await connect(app, f);
  sqlite.prepare('UPDATE store_oauth_pending SET created_at=0 WHERE state=?').run(expired);
  assert.equal((await app.request(`/api/ml/callback?code=TG-ok&state=${expired}`)).status, 400);
  const bad = await connect(app, f);
  const res = await app.request(`/api/ml/callback?code=malo&state=${bad}`);
  assert.equal(res.status, 400); assert.match(await res.text(), /no aceptó/);
  assert.equal((await app.request('/api/ml/callback')).status, 400);
});

test('unconfigured server keeps ML disabled without crashing', async () => {
  const f = makeHousehold();
  const app = new Hono().route('/shopping', createShoppingRoutes(new VeaClient(veaTransport), new MlAccounts(new MlClient(null, mlTransport), null)));
  assert.equal((await (await call(app, f, '/stores/ml/status')).json() as Json).configured, false);
  assert.equal((await call(app, f, '/stores/ml/connect', 'POST')).status, 503);
});

test('expired access token refreshes once for concurrent requests; invalid refresh disconnects', async () => {
  const f = makeHousehold();
  const { app, accounts } = createApp();
  const state = await connect(app, f);
  await call(app, f, '/stores/ml/complete', 'POST', { url: `${config.redirectUri}?code=TG-ok&state=${state}` });
  sqlite.prepare("UPDATE store_accounts SET expires_at=0 WHERE household_id=?").run(f.householdId);
  tokenCalls = [];
  const tokens = await Promise.all([accounts.accessToken(f.householdId), accounts.accessToken(f.householdId), accounts.accessToken(f.householdId)]);
  assert.deepEqual(tokenCalls, ['refresh_token']); assert.equal(new Set(tokens).size, 1);
  assert.ok((sqlite.prepare("SELECT expires_at FROM store_accounts WHERE household_id=?").get(f.householdId) as { expires_at: number }).expires_at > Date.now());
  sqlite.prepare("UPDATE store_accounts SET expires_at=0 WHERE household_id=?").run(f.householdId);
  refreshFails = true;
  try {
    const res = await call(app, f, '/stores/ml/search?q=yerba');
    assert.equal(res.status, 401); assert.equal((await res.json() as Json).reconnect, true);
    assert.equal((await (await call(app, f, '/stores/ml/status')).json() as Json).connected, false);
  } finally { refreshFails = false; }
});

test('search returns catalog products with their cheapest Full offer; links are per household', async () => {
  const f = makeHousehold(); const other = makeHousehold();
  const { app } = createApp();
  await call(app, f, '/stores/ml/complete', 'POST', { url: `${config.redirectUri}?code=TG-ok&state=${await connect(app, f)}` });
  const found = await (await call(app, f, '/stores/ml/search?q=yerba')).json() as Json;
  assert.deepEqual(found.products.map((p: { productId: string }) => p.productId), ['MLA100']);
  assert.deepEqual(found.products[0].offer, { itemId: 'MLA9001', unitMinor: 455430, freeShipping: false, shippingMinor: 499900, eta: '2026-10-01' });
  const item = addItem(f, 'Yerba');
  const key = encodeURIComponent(productKey({ name: 'Yerba', brand: '' }));
  assert.equal((await call(app, f, `/stores/ml/links/${key}`, 'PUT', { itemId: item, productId: 'MLA100' })).status, 200);
  const saved = sqlite.prepare("SELECT sku, ean FROM store_product_links WHERE household_id=? AND store='ml'").get(f.householdId);
  assert.deepEqual(saved, { sku: 'MLA100', ean: '7790000000001' });
  assert.equal((await call(app, other, `/stores/ml/links/${key}`, 'PUT', { itemId: item, productId: 'MLA100' })).status, 404, 'foreign item');
  assert.equal((await call(app, f, `/stores/ml/links/${key}`, 'PUT', { itemId: item, productId: 'MLA1&x' })).status, 400);
});

test('compare: VEA pickup vs ML Full only, one ML shipment, mixed choice, carts and no financial writes', async () => {
  const f = makeHousehold();
  const { app } = createApp();
  await call(app, f, '/stores/ml/complete', 'POST', { url: `${config.redirectUri}?code=TG-ok&state=${await connect(app, f)}` });
  const yerba = addItem(f, 'Yerba'); const aceite = addItem(f, 'Aceite'); const leche = addItem(f, 'Leche'); const nada = addItem(f, 'Nada');
  link(f, 'vea', 'Yerba', '111'); link(f, 'ml', 'Yerba', 'MLA100');   // VEA 5000 vs ML Full 4554.30
  link(f, 'vea', 'Aceite', '222'); link(f, 'ml', 'Aceite', 'MLA200'); // VEA 7000 vs ML 7700
  link(f, 'ml', 'Leche', 'MLA300');                                   // ML only non-Full → excluded
  const txBefore = (sqlite.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n;
  const res = await call(app, f, '/compare', 'POST', { items: [{ itemId: yerba, qty: 2 }, { itemId: aceite, qty: 1 }, { itemId: leche, qty: 1 }, { itemId: nada, qty: 1 }] });
  assert.equal(res.status, 200);
  const data = await res.json() as Json;
  assert.equal(data.veaError, null); assert.equal(data.mlError, null);
  const row = (id: string) => data.rows.find((r: { itemId: string }) => r.itemId === id);
  assert.equal(row(yerba).vea.subtotalMinor, 1000000); assert.equal(row(yerba).ml.subtotalMinor, 910860); assert.equal(row(yerba).ml.itemId, 'MLA9001');
  assert.equal(row(leche).ml.subtotalMinor, null); assert.match(row(leche).ml.reason, /Full/);
  assert.equal(row(nada).vea, null); assert.equal(row(nada).ml, null);
  const s = data.summary;
  assert.deepEqual(s.vea, { productsMinor: 1700000, totalMinor: 1700000, missing: 2 });
  assert.deepEqual(s.ml, { productsMinor: 1680860, shippingMinor: 649900, totalMinor: 2330760, missing: 2 }, 'one Full package: the highest informed cost');
  assert.deepEqual(s.choices, { [yerba]: 'ml', [aceite]: 'vea', [leche]: null, [nada]: null });
  assert.equal(s.mixed.productsMinor, 910860 + 700000); assert.equal(s.mixed.shippingMinor, 499900);
  assert.equal(s.mixed.savingsMinor, 89140); assert.equal(s.mixed.shippingExceedsSavings, true);
  assert.equal(new URL(data.carts.mixedVea).searchParams.getAll('sku').join(), '222');
  assert.equal(data.carts.mixedMl, 'https://www.mercadolibre.com.ar/gz/checkout/cart/buy?site_id=MLA&items=MLA9001-Q2');
  assert.equal(data.carts.ml, 'https://www.mercadolibre.com.ar/gz/checkout/cart/buy?site_id=MLA&items=MLA9001-Q2,MLA9003-Q1');
  assert.deepEqual(new URL(data.carts.vea).searchParams.getAll('qty'), ['2', '1']);
  assert.equal((sqlite.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n, txBefore);
  const items = sqlite.prepare('SELECT data_json FROM shopping_items WHERE household_id=?').all(f.householdId) as { data_json: string }[];
  assert.ok(items.every(i => JSON.parse(i.data_json).status === 'pending'), 'comparing does not touch the list');
});

test('compare still answers VEA when ML is not connected, and rejects foreign items', async () => {
  const f = makeHousehold(); const other = makeHousehold();
  const { app } = createApp();
  const yerba = addItem(f, 'Yerba'); link(f, 'vea', 'Yerba', '111'); link(f, 'ml', 'Yerba', 'MLA100');
  const data = await (await call(app, f, '/compare', 'POST', { items: [{ itemId: yerba, qty: 1 }] })).json() as Json;
  assert.equal(data.rows[0].vea.subtotalMinor, 500000); assert.equal(data.rows[0].ml, null);
  assert.equal(data.mlReconnect, true); assert.match(data.mlError, /Conectá/);
  assert.equal((await call(app, other, '/compare', 'POST', { items: [{ itemId: yerba, qty: 1 }] })).status, 404);
  assert.equal((await call(app, f, '/compare', 'POST', { items: [{ itemId: yerba, qty: 0 }] })).status, 400);
});

test('summary: free Full shipping, unknown shipping and ties favour VEA', () => {
  const r = (id: string, v: number | null, m: number | null, ship: number | null, free = false): CompareRow => ({ itemId: id, name: id, qty: 1,
    vea: v === null ? null : { productName: id, available: true, unitMinor: v, subtotalMinor: v, reason: null },
    ml: m === null ? null : { productId: 'MLA1', productName: id, itemId: 'MLA2', unitMinor: m, subtotalMinor: m, qty: 1, shippingMinor: ship, freeShipping: free, eta: null, reason: null } });
  const free = summarize([r('a', 1000, 800, 0, true), r('b', 500, 500, 300)]);
  assert.equal(free.choices.b, 'vea', 'tie goes to VEA pickup'); assert.equal(free.mixed.shippingMinor, 0); assert.equal(free.mixed.shippingExceedsSavings, false);
  assert.equal(free.ml.shippingMinor, 300);
  const unknown = summarize([r('a', null, 800, null)]);
  assert.equal(unknown.ml.shippingMinor, null); assert.equal(unknown.ml.totalMinor, null); assert.equal(unknown.mixed.shippingExceedsSavings, false);
});
