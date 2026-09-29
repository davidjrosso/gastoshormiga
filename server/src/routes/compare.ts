import { Hono } from 'hono';
import type { AppEnv } from '../auth.js';
import { bestFullOffer, cartUrl as mlCartUrl, MlAuthError, MlError } from '../stores/ml.js';
import type { MlAccounts } from '../stores/ml-account.js';
import { cartUrl as veaCartUrl, VeaError, VEA_SETTINGS, type Offer as VeaOffer, type VeaClient } from '../stores/vea.js';
import { loadPendingRows, quoteInput, storeLimiter, storeLink, type PendingRow } from './store-rows.js';
import { quoteVea } from './vea.js';

export interface VeaSide { productName: string; available: boolean; unitMinor: number | null; subtotalMinor: number | null; reason: string | null }
export interface MlSide { productId: string; productName: string; itemId: string | null; unitMinor: number | null; subtotalMinor: number | null; qty: number; shippingMinor: number | null; freeShipping: boolean; eta: string | null; reason: string | null; availableQty?: number | null }
export interface CompareRow { itemId: string; name: string; qty: number; vea: VeaSide | null; ml: MlSide | null }
type Choice = 'vea' | 'ml' | null;

/** Selección por subtotal. ML confirma el envío conjunto y el stock en checkout. */
export function summarize(rows: CompareRow[]) {
  const vea = (r: CompareRow) => r.vea?.available ? r.vea.subtotalMinor! : null;
  const ml = (r: CompareRow) => r.ml?.subtotalMinor ?? null;
  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
  const veaRows = rows.filter(r => vea(r) !== null), mlRows = rows.filter(r => ml(r) !== null);
  const choice = (r: CompareRow): Choice => {
    const v = vea(r), m = ml(r);
    if (v !== null && m !== null) return m < v ? 'ml' : 'vea';
    return v !== null ? 'vea' : m !== null ? 'ml' : null;
  };
  const choices = rows.map(row => ({ row, choice: choice(row) }));
  const mixedVea = choices.filter(c => c.choice === 'vea').map(c => c.row);
  const mixedMl = choices.filter(c => c.choice === 'ml').map(c => c.row);
  const allVea = sum(veaRows.map(r => vea(r)!)), allMl = sum(mlRows.map(r => ml(r)!));
  const mixedProducts = sum(mixedVea.map(r => vea(r)!)) + sum(mixedMl.map(r => ml(r)!));
  return {
    choices: Object.fromEntries(choices.map(c => [c.row.itemId, c.choice])) as Record<string, Choice>,
    vea: { productsMinor: allVea, totalMinor: allVea, missing: rows.length - veaRows.length },
    ml: { productsMinor: allMl, shippingMinor: mlRows.length ? null : 0, totalMinor: mlRows.length ? null : 0, missing: rows.length - mlRows.length },
    mixed: { productsMinor: mixedProducts, shippingMinor: mixedMl.length ? null : 0, totalMinor: mixedMl.length ? null : mixedProducts,
      veaCount: mixedVea.length, mlCount: mixedMl.length, missing: choices.filter(c => !c.choice).length },
    mixedVeaIds: mixedVea.map(r => r.itemId), mixedMlIds: mixedMl.map(r => r.itemId),
  };
}

export function createCompareRoutes(vea: VeaClient, accounts: MlAccounts, budgetMs = 20_000) {
  const routes = new Hono<AppEnv>();
  routes.use('*', storeLimiter('las tiendas', 20, 1));
  routes.post('/', async c => {
    const parsed = quoteInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Compará hasta 30 productos, con cantidades enteras de 1 a 99.' }, 400);
    const household = c.get('user').householdId;
    const loaded = loadPendingRows(household, parsed.data.items);
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const [veaResult, mlResult] = await Promise.all([compareVea(vea, household, loaded.rows), compareMl(accounts, household, loaded.rows, budgetMs)]);
    const rows: CompareRow[] = loaded.rows.map(r => ({ itemId: r.itemId, name: r.name, qty: r.qty, vea: veaResult.sides.get(r.itemId) ?? null, ml: mlResult.sides.get(r.itemId) ?? null }));
    const summary = summarize(rows);
    const mixedPending = loaded.rows.filter(r => summary.mixedVeaIds.includes(r.itemId));
    // Un descuento del carrito completo puede desaparecer al quitar productos.
    const mixedVea = summary.mixedMlIds.length && mixedPending.length ? await compareVea(vea, household, mixedPending) : veaResult;
    const mixedError = mixedPending.length && (mixedVea.error || mixedPending.some(r => !mixedVea.sides.get(r.itemId)?.available))
      ? 'VEA no confirmó la parte mixta. Actualizá la comparación.' : null;
    const mixedVeaTotal = mixedPending.reduce((n, r) => n + (mixedVea.sides.get(r.itemId)?.subtotalMinor ?? 0), 0);
    const mixedMlTotal = rows.filter(r => summary.mixedMlIds.includes(r.itemId)).reduce((n, r) => n + r.ml!.subtotalMinor!, 0);
    const mixedProducts = mixedError ? null : mixedVeaTotal + mixedMlTotal;
    const veaCart = (result: typeof veaResult, ids: string[]) => veaCartUrl(ids.map(id => result.offers.get(id)).filter((o): o is VeaOffer => !!o), VEA_SETTINGS);
    const mlCart = (ids: string[]) => mlCartUrl(ids.map(id => rows.find(r => r.itemId === id)!.ml!).map(m => ({ itemId: m.itemId!, qty: m.qty })));
    const quotedAt = Math.min(veaResult.quotedAt, mlResult.quotedAt, mixedVea.quotedAt);
    const expiresAt = Math.min(veaResult.expiresAt, mlResult.expiresAt, mixedVea.expiresAt);
    return c.json({ rows, summary: { ...summary, mixed: { ...summary.mixed, productsMinor: mixedProducts, totalMinor: summary.mixedMlIds.length ? null : mixedProducts } },
      quotedAt, expiresAt, mixedError, veaError: veaResult.error, mlError: mlResult.error, mlReconnect: mlResult.reconnect,
      carts: {
        vea: veaCart(veaResult, rows.filter(r => r.vea?.available).map(r => r.itemId)), ml: mlCart(rows.filter(r => r.ml?.subtotalMinor != null).map(r => r.itemId)),
        mixedVea: mixedError ? null : veaCart(mixedVea, summary.mixedVeaIds), mixedMl: mixedError ? null : mlCart(summary.mixedMlIds),
      } });
  });
  return routes;
}

async function compareVea(client: VeaClient, household: string, pending: PendingRow[]) {
  const sides = new Map<string, VeaSide>(), offers = new Map<string, VeaOffer>();
  const now = Date.now();
  try {
    const quote = await quoteVea(client, household, pending);
    // Reparto acumulado entero: las filas del mismo SKU conservan exactamente el subtotal.
    const allocated = new Map<string, { qty: number; minor: number }>();
    for (const row of quote.rows) {
      if (!row.link) continue;
      const offer = quote.offers.find(o => o.sku === row.link!.sku);
      let sub: number | null = null;
      if (offer?.available) {
        const qty = row.qty * row.link.packQty, prev = allocated.get(offer.sku) ?? { qty: 0, minor: 0 };
        const cumulative = Number(BigInt(offer.subtotalMinor!) * BigInt(prev.qty + qty) / BigInt(offer.qty));
        sub = cumulative - prev.minor;
        allocated.set(offer.sku, { qty: prev.qty + qty, minor: cumulative });
        offers.set(row.itemId, { ...offer, qty, subtotalMinor: sub });
      }
      sides.set(row.itemId, { productName: row.link.productName, available: !!offer?.available, unitMinor: offer?.unitMinor ?? null, subtotalMinor: sub, reason: offer?.available ? null : offer?.reason ?? 'VEA no confirmó este producto.' });
    }
    return { sides, offers, quotedAt: quote.quotedAt, expiresAt: quote.expiresAt, error: null as string | null };
  } catch (e) { return { sides, offers, quotedAt: now, expiresAt: now + 120_000, error: e instanceof VeaError ? e.message : 'No se pudo consultar VEA.' }; }
}

async function compareMl(accounts: MlAccounts, household: string, pending: PendingRow[], budgetMs: number) {
  const sides = new Map<string, MlSide>();
  let quotedAt = Date.now(), expiresAt = quotedAt + 120_000, error: string | null = null, reconnect = false;
  const linked = pending.map(row => ({ row, link: storeLink(household, 'ml', row.itemKey) })).filter(x => x.link);
  const result = () => ({ sides, quotedAt, expiresAt, error, reconnect });
  if (!linked.length) return result();
  try {
    const token = await accounts.accessToken(household);
    const signal = AbortSignal.timeout(budgetMs);
    // Cuatro trabajadores y un plazo compartido: listas grandes no bloquean VEA indefinidamente.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, linked.length) }, async () => {
      while (cursor < linked.length) {
        const { row, link } = linked[cursor++];
        const qty = row.qty * link!.packQty;
        const base: MlSide = { productId: link!.sku, productName: link!.productName, qty, itemId: null, unitMinor: null, subtotalMinor: null, shippingMinor: null, freeShipping: false, eta: null, reason: null };
        try {
          if (signal.aborted) throw new MlError('La consulta tardó demasiado. Volvé a comparar.');
          if (qty > 99) throw new MlError('La cantidad total supera 99 unidades.');
          const snapshot = await accounts.client.offerSnapshot(link!.sku, token, signal);
          const offer = bestFullOffer(snapshot.offers, qty);
          if (!offer) { sides.set(row.itemId, { ...base, reason: 'Sin ofertas Full para esta cantidad.' }); continue; }
          quotedAt = Math.min(quotedAt, snapshot.quotedAt); expiresAt = Math.min(expiresAt, snapshot.expiresAt);
          const subtotal = offer.unitMinor * qty;
          if (!Number.isSafeInteger(subtotal)) throw new MlError('El total recibido no es válido.');
          sides.set(row.itemId, { ...base, itemId: offer.itemId, unitMinor: offer.unitMinor, subtotalMinor: subtotal, freeShipping: offer.freeShipping, availableQty: offer.availableQty });
        } catch (e) {
          const reason = e instanceof MlError ? e.message : 'No se pudo consultar este producto.';
          sides.set(row.itemId, { ...base, reason }); error = 'Algunos productos de Mercado Libre no pudieron cotizarse.';
          reconnect ||= e instanceof MlAuthError;
        }
      }
    }));
    const grouped = new Map<string, MlSide[]>();
    for (const side of sides.values()) if (side.itemId) grouped.set(side.itemId, [...(grouped.get(side.itemId) ?? []), side]);
    for (const group of grouped.values()) {
      const qty = group.reduce((n, s) => n + s.qty, 0);
      const stock = Math.min(...group.map(s => s.availableQty ?? Infinity));
      if (qty > 99 || qty > stock) for (const side of group) {
        side.reason = qty > 99 ? 'Los productos vinculados suman más de 99 unidades.' : 'Sin stock informado para la cantidad total vinculada.';
        side.itemId = null; side.subtotalMinor = null;
      }
    }
    return result();
  } catch (e) { error = e instanceof MlError ? e.message : 'No se pudo consultar Mercado Libre.'; reconnect = e instanceof MlAuthError; return result(); }
}
