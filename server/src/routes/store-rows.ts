import { z } from 'zod';
import { sqlite } from '../db/index.js';

export const productKey = (item: { name: string; brand: string }) => `${item.name.trim()}|${item.brand.trim()}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
export type StoreItem = { name: string; brand: string; status: string; batchId: string };
export type StoreLink = { sku: string; productName: string; packQty: number };
export interface PendingRow { itemId: string; qty: number; itemKey: string; name: string }
export const quoteInput = z.object({ items: z.array(z.object({ itemId: z.string().uuid(), qty: z.number().int().min(1).max(99) }).strict()).min(1).max(30) }).strict();
export type QuoteRequest = z.infer<typeof quoteInput>['items'][number];

/** Pendientes del hogar para cotizar: rechaza ítems ajenos, comprados o archivados. */
export function loadPendingRows(household: string, requests: QuoteRequest[]): { rows: PendingRow[] } | { error: string; status: 400 | 404 | 409 } {
  if (new Set(requests.map(i => i.itemId)).size !== requests.length) return { error: 'La lista contiene ítems repetidos.', status: 400 };
  const rows: PendingRow[] = [];
  for (const request of requests) {
    const row = sqlite.prepare('SELECT data_json FROM shopping_items WHERE household_id=? AND id=?').get(household, request.itemId) as { data_json: string } | undefined;
    if (!row) return { error: 'Un producto no pertenece a esta lista. Actualizá Compras.', status: 404 };
    const item = JSON.parse(row.data_json) as StoreItem;
    if (item.batchId || item.status === 'bought') return { error: 'La lista cambió: un producto ya está comprado o archivado. Actualizá Compras.', status: 409 };
    rows.push({ ...request, itemKey: productKey(item), name: item.name });
  }
  return { rows };
}

export function storeLink(household: string, store: 'vea' | 'ml', itemKey: string): StoreLink | null {
  const link = sqlite.prepare('SELECT sku, product_name, pack_qty FROM store_product_links WHERE household_id=? AND store=? AND item_key=?').get(household, store, itemKey) as { sku: string; product_name: string; pack_qty: number } | undefined;
  return link ? { sku: link.sku, productName: link.product_name, packQty: link.pack_qty } : null;
}

/** Límite por hogar para consultas a tiendas externas (por minuto y simultáneas). */
export function storeLimiter(label: string, perMinute = 30, concurrent = 2) {
  const limits = new Map<string, { start: number; count: number; active: number }>();
  return async (c: { get(k: 'user'): { householdId: string }; header(k: string, v: string): void; json(body: unknown, status: 429): Response }, next: () => Promise<void>) => {
    const now = Date.now();
    for (const [key, v] of limits) if (!v.active && now - v.start >= 60_000) limits.delete(key);
    const household = c.get('user').householdId;
    let limit = limits.get(household);
    if (!limit) { limit = { start: now, count: 0, active: 0 }; limits.set(household, limit); }
    if (limit.count >= perMinute || limit.active >= concurrent || limits.size > 5000) { c.header('Retry-After', '60'); return c.json({ error: `Demasiadas consultas a ${label}. Esperá un minuto y reintentá.` }, 429); }
    limit.count++; limit.active++;
    try { await next(); } finally { limit.active--; }
  };
}
