import { Hono } from 'hono';
import type { AppEnv } from '../auth.js';
import { bestFullOffer, cartUrl as mlCartUrl, MlAuthError, MlError } from '../stores/ml.js';
import type { MlAccounts } from '../stores/ml-account.js';
import { cartUrl as veaCartUrl, VeaError, VEA_SETTINGS, type Offer as VeaOffer, type VeaClient } from '../stores/vea.js';
import { loadPendingRows, quoteInput, storeLimiter, storeLink, type PendingRow } from './store-rows.js';
import { quoteVea } from './vea.js';

export interface VeaSide { productName: string; available: boolean; unitMinor: number | null; subtotalMinor: number | null; reason: string | null }
export interface MlSide { productId: string; productName: string; itemId: string | null; unitMinor: number | null; subtotalMinor: number | null; qty: number; shippingMinor: number | null; freeShipping: boolean; eta: string | null; reason: string | null }
export interface CompareRow { itemId: string; name: string; qty: number; vea: VeaSide | null; ml: MlSide | null }
type Choice = 'vea' | 'ml' | null;

/**
 * Resúmenes de la comparación. Retiro en VEA cuesta $0 (decisión de David).
 * En ML solo hay ofertas Full: viajan en un paquete, así que el envío orientativo es UN
 * costo, el mayor informado entre los productos elegidos (0 si todos figuran gratis).
 * El total real, con Meli+ o promociones, lo muestra ML en su checkout.
 */
export function summarize(rows: CompareRow[]) {
  const vea = (r: CompareRow) => r.vea?.available ? r.vea.subtotalMinor! : null;
  const ml = (r: CompareRow) => r.ml?.subtotalMinor ?? null;
  const shippingOf = (list: CompareRow[]) => {
    if (!list.length) return 0;
    const costs = list.map(r => r.ml!.freeShipping ? 0 : r.ml!.shippingMinor);
    return costs.some(c => c === null) ? null : Math.max(...(costs as number[]));
  };
  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
  const veaRows = rows.filter(r => vea(r) !== null); const mlRows = rows.filter(r => ml(r) !== null);
  const choice = (r: CompareRow): Choice => {
    const v = vea(r), m = ml(r);
    if (v !== null && m !== null) return m < v ? 'ml' : 'vea';
    return v !== null ? 'vea' : m !== null ? 'ml' : null;
  };
  const choices = rows.map(r => ({ row: r, choice: choice(r) }));
  const mixedVea = choices.filter(c => c.choice === 'vea').map(c => c.row);
  const mixedMl = choices.filter(c => c.choice === 'ml').map(c => c.row);
  const mlShipping = shippingOf(mlRows); const mixedShipping = shippingOf(mixedMl);
  // Ahorro de productos que el mixto obtiene yendo a ML, contra su precio en VEA.
  const savings = sum(mixedMl.filter(r => vea(r) !== null).map(r => vea(r)! - ml(r)!));
  const total = (products: number, shipping: number | null) => shipping === null ? null : products + shipping;
  const allVea = sum(veaRows.map(r => vea(r)!)); const allMl = sum(mlRows.map(r => ml(r)!));
  const mixedProducts = sum(mixedVea.map(r => vea(r)!)) + sum(mixedMl.map(r => ml(r)!));
  return {
    choices: Object.fromEntries(choices.map(c => [c.row.itemId, c.choice])) as Record<string, Choice>,
    vea: { productsMinor: allVea, totalMinor: allVea, missing: rows.length - veaRows.length },
    ml: { productsMinor: allMl, shippingMinor: mlShipping, totalMinor: total(allMl, mlShipping), missing: rows.length - mlRows.length },
    mixed: { productsMinor: mixedProducts, shippingMinor: mixedShipping, totalMinor: total(mixedProducts, mixedShipping), veaCount: mixedVea.length, mlCount: mixedMl.length,
      missing: choices.filter(c => !c.choice).length, savingsMinor: savings,
      // Si el envío informado se come el ahorro, conviene mirar Todo VEA (salvo envío gratis en el checkout).
      shippingExceedsSavings: mixedShipping !== null && mixedMl.length > 0 && mixedShipping > savings && mixedMl.every(r => vea(r) !== null) },
    mixedVeaIds: mixedVea.map(r => r.itemId), mixedMlIds: mixedMl.map(r => r.itemId),
  };
}

// Mounted inside shoppingRoutes, after its session + household/user middleware.
export function createCompareRoutes(vea: VeaClient, accounts: MlAccounts) {
  const routes = new Hono<AppEnv>();
  routes.use('*', storeLimiter('las tiendas', 20, 1));
  routes.post('/', async c => {
    const parsed = quoteInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Compará hasta 30 productos, con cantidades enteras de 1 a 99.' }, 400);
    const household = c.get('user').householdId;
    const loaded = loadPendingRows(household, parsed.data.items);
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const [veaResult, mlResult] = await Promise.all([compareVea(vea, household, loaded.rows), compareMl(accounts, household, loaded.rows)]);
    const rows: CompareRow[] = loaded.rows.map(r => ({ itemId: r.itemId, name: r.name, qty: r.qty, vea: veaResult.sides.get(r.itemId) ?? null, ml: mlResult.sides.get(r.itemId) ?? null }));
    const summary = summarize(rows);
    const veaCart = (ids: string[]) => veaCartUrl(ids.map(id => veaResult.offers.get(id)).filter((o): o is VeaOffer => !!o), VEA_SETTINGS);
    const mlCart = (ids: string[]) => mlCartUrl(ids.map(id => rows.find(r => r.itemId === id)!.ml!).map(m => ({ itemId: m.itemId!, qty: m.qty })));
    const quotedAt = Date.now();
    return c.json({ rows, summary, quotedAt, expiresAt: quotedAt + 120_000,
      veaError: veaResult.error, mlError: mlResult.error, mlReconnect: mlResult.reconnect,
      carts: {
        vea: veaCart(rows.filter(r => r.vea?.available).map(r => r.itemId)), ml: mlCart(rows.filter(r => r.ml?.subtotalMinor != null).map(r => r.itemId)),
        mixedVea: veaCart(summary.mixedVeaIds), mixedMl: mlCart(summary.mixedMlIds),
      } });
  });
  return routes;
}

async function compareVea(client: VeaClient, household: string, pending: PendingRow[]) {
  const sides = new Map<string, VeaSide>(); const offers = new Map<string, VeaOffer>();
  try {
    const quote = await quoteVea(client, household, pending);
    for (const row of quote.rows) {
      if (!row.link) continue;
      const offer = quote.offers.find(o => o.sku === row.link!.sku);
      if (offer?.available) offers.set(row.itemId, { ...offer, qty: row.qty * row.link.packQty, subtotalMinor: offer.unitMinor! * row.qty * row.link.packQty });
      const sub = offer?.available ? offer.unitMinor! * row.qty * row.link.packQty : null;
      sides.set(row.itemId, { productName: row.link.productName, available: !!offer?.available, unitMinor: offer?.unitMinor ?? null, subtotalMinor: sub, reason: offer?.available ? null : offer?.reason ?? 'VEA no confirmó este producto.' });
    }
    return { sides, offers, error: null as string | null };
  } catch (e) { return { sides, offers, error: e instanceof VeaError ? e.message : 'No se pudo consultar VEA.' }; }
}

async function compareMl(accounts: MlAccounts, household: string, pending: PendingRow[]) {
  const sides = new Map<string, MlSide>();
  const linked = pending.map(r => ({ row: r, link: storeLink(household, 'ml', r.itemKey) })).filter(x => x.link);
  if (!linked.length) return { sides, error: null as string | null, reconnect: false };
  try {
    const token = await accounts.accessToken(household);
    const client = accounts.client;
    for (const { row, link } of linked) {
      const qty = row.qty * link!.packQty;
      const base = { productId: link!.sku, productName: link!.productName, qty };
      if (qty > 99) { sides.set(row.itemId, { ...base, itemId: null, unitMinor: null, subtotalMinor: null, shippingMinor: null, freeShipping: false, eta: null, reason: 'La cantidad total supera 99 unidades.' }); continue; }
      const offer = bestFullOffer(await client.offers(link!.sku, token));
      if (!offer) { sides.set(row.itemId, { ...base, itemId: null, unitMinor: null, subtotalMinor: null, shippingMinor: null, freeShipping: false, eta: null, reason: 'Sin ofertas Full en este momento.' }); continue; }
      const shipping = offer.freeShipping ? null : await client.shipping(offer.itemId, token, household);
      const subtotal = offer.unitMinor * qty;
      if (!Number.isSafeInteger(subtotal)) throw new MlError('El total recibido no es válido.');
      sides.set(row.itemId, { ...base, itemId: offer.itemId, unitMinor: offer.unitMinor, subtotalMinor: subtotal, freeShipping: offer.freeShipping,
        shippingMinor: offer.freeShipping ? 0 : shipping?.costMinor ?? null, eta: shipping?.eta ?? null, reason: null });
    }
    return { sides, error: null as string | null, reconnect: false };
  } catch (e) {
    return { sides: new Map<string, MlSide>(), error: e instanceof MlError ? e.message : 'No se pudo consultar Mercado Libre.', reconnect: e instanceof MlAuthError };
  }
}
