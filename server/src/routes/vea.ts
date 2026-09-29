import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth.js';
import { sqlite } from '../db/index.js';
import { cartUrl, VeaClient, VeaError, VEA_SETTINGS } from '../stores/vea.js';

export const productKey = (item: { name: string; brand: string }) => `${item.name.trim()}|${item.brand.trim()}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
type Item = { name: string; brand: string; status: string; batchId: string };
type Link = { sku: string; ean: string; product_name: string; pack_qty: number };
const input = z.object({ items: z.array(z.object({ itemId: z.string().uuid(), qty: z.number().int().min(1).max(99) }).strict()).min(1).max(30) }).strict();

// Mounted inside shoppingRoutes, after its session + household/user middleware.
export function createVeaRoutes(client = new VeaClient()) {
  const routes = new Hono<AppEnv>();
  const limits = new Map<string, { start: number; count: number; active: number }>();
  routes.use('*', async (c, next) => {
    const now = Date.now();
    for (const [key, v] of limits) if (!v.active && now - v.start >= 60_000) limits.delete(key);
    const household = c.get('user').householdId;
    let limit = limits.get(household);
    if (!limit) { limit = { start: now, count: 0, active: 0 }; limits.set(household, limit); }
    if (limit.count >= 30 || limit.active >= 2 || limits.size > 5000) { c.header('Retry-After', '60'); return c.json({ error: 'Demasiadas consultas a VEA. Esperá un minuto y reintentá.' }, 429); }
    limit.count++; limit.active++;
    try { await next(); } finally { limit.active--; }
  });
  routes.onError((e, c) => e instanceof VeaError ? c.json({ error: e.message }, 502) : c.json({ error: 'No se pudo completar la consulta a VEA. Tu lista sigue guardada.' }, 503));
  routes.get('/settings', c => c.json({ ...VEA_SETTINGS, saved: !!sqlite.prepare("SELECT 1 FROM store_settings WHERE household_id=? AND store='vea'").get(c.get('user').householdId) }));
  routes.put('/settings', async c => {
    const parsed = z.object({ salesChannel: z.literal(VEA_SETTINGS.salesChannel), sellerId: z.literal(VEA_SETTINGS.sellerId) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Elegí la sucursal disponible de VEA.' }, 400);
    sqlite.prepare(`INSERT INTO store_settings VALUES(?,?,?,?,?,?) ON CONFLICT(household_id,store) DO UPDATE SET sales_channel=excluded.sales_channel,seller_id=excluded.seller_id,label=excluded.label,updated_at=excluded.updated_at`)
      .run(c.get('user').householdId, 'vea', VEA_SETTINGS.salesChannel, VEA_SETTINGS.sellerId, VEA_SETTINGS.label, Date.now());
    return c.json({ ...VEA_SETTINGS, saved: true });
  });
  routes.get('/search', async c => {
    const term = z.string().trim().min(2).max(120).safeParse(c.req.query('q'));
    if (!term.success) return c.json({ error: 'Escribí entre 2 y 120 caracteres.' }, 400);
    const products = await client.search(term.data, VEA_SETTINGS);
    const quote = await client.quote(products.filter(p => p.supported).map(p => ({ sku: p.sku, qty: 1 })), VEA_SETTINGS, c.get('user').householdId);
    return c.json({ products: products.map(p => ({ ...p, offer: quote.offers.find(i => i.sku === p.sku) ?? null })), quotedAt: quote.quotedAt });
  });
  routes.put('/links/:itemKey', async c => {
    const parsed = z.object({ itemId: z.string().uuid(), sku: z.string().regex(/^\d{1,20}$/), packQty: z.number().int().min(1).max(99).default(1) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Revisá el producto elegido.' }, 400);
    const user = c.get('user');
    const getItem = () => sqlite.prepare('SELECT data_json FROM shopping_items WHERE household_id=? AND id=?').get(user.householdId, parsed.data.itemId) as { data_json: string } | undefined;
    const row = getItem();
    if (!row) return c.json({ error: 'Producto no disponible en este hogar.' }, 404);
    const key = productKey(JSON.parse(row.data_json) as Item);
    if (key !== c.req.param('itemKey')) return c.json({ error: 'El nombre cambió. Actualizá la lista.' }, 409);
    const product = await client.product(parsed.data.sku, VEA_SETTINGS);
    if (!product?.supported) return c.json({ error: 'Elegí una presentación por unidad del catálogo.' }, 400);
    const current = getItem();
    if (!current || productKey(JSON.parse(current.data_json) as Item) !== key) return c.json({ error: 'El producto cambió mientras consultábamos VEA. Actualizá la lista.' }, 409);
    sqlite.prepare(`INSERT INTO store_product_links VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(household_id,store,item_key) DO UPDATE SET sku=excluded.sku,ean=excluded.ean,product_name=excluded.product_name,pack_qty=excluded.pack_qty,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(user.householdId, 'vea', key, product.sku, product.ean, product.productName, parsed.data.packQty, user.id, Date.now());
    return c.json({ ok: true });
  });
  routes.delete('/links/:itemKey', c => {
    sqlite.prepare("DELETE FROM store_product_links WHERE household_id=? AND store='vea' AND item_key=?").run(c.get('user').householdId, c.req.param('itemKey'));
    return c.json({ ok: true });
  });
  routes.post('/quote', async c => {
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Cotizá hasta 30 productos, con cantidades enteras de 1 a 99.' }, 400);
    if (new Set(parsed.data.items.map(i => i.itemId)).size !== parsed.data.items.length) return c.json({ error: 'La lista contiene ítems repetidos.' }, 400);
    const household = c.get('user').householdId;
    const rows = [];
    for (const request of parsed.data.items) {
      const row = sqlite.prepare('SELECT data_json FROM shopping_items WHERE household_id=? AND id=?').get(household, request.itemId) as { data_json: string } | undefined;
      if (!row) return c.json({ error: 'Un producto no pertenece a esta lista. Actualizá Compras.' }, 404);
      const item = JSON.parse(row.data_json) as Item;
      if (item.batchId || item.status === 'bought') return c.json({ error: 'La lista cambió: un producto ya está comprado o archivado. Actualizá Compras.' }, 409);
      const key = productKey(item);
      const link = sqlite.prepare("SELECT * FROM store_product_links WHERE household_id=? AND store='vea' AND item_key=?").get(household, key) as Link | undefined;
      if (link && request.qty * link.pack_qty > 99) return c.json({ error: 'La cantidad total de una presentación supera 99 unidades.' }, 400);
      rows.push({ ...request, itemKey: key, name: item.name, link: link ? { sku: link.sku, productName: link.product_name, packQty: link.pack_qty } : null });
    }
    const result = await client.quote(rows.filter(r => r.link).map(r => ({ sku: r.link!.sku, qty: r.qty * r.link!.packQty })), VEA_SETTINGS, household);
    const totalMinor = result.offers.reduce((n, i) => n + (i.available ? i.subtotalMinor! : 0), 0);
    if (!Number.isSafeInteger(totalMinor)) throw new VeaError('El total recibido no es válido.');
    return c.json({ rows, ...result, totalMinor, cartUrl: cartUrl(result.offers, VEA_SETTINGS), settings: VEA_SETTINGS });
  });
  return routes;
}
