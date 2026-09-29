import { z } from 'zod';

export const VEA_SETTINGS = Object.freeze({ store: 'vea', salesChannel: '34', sellerId: 'jumboargentinav690riotercerocentro', label: 'Vea Río Tercero (retiro)', postalCode: '5850' });
export type StoreSettings = typeof VEA_SETTINGS;
export const MAX_QTY = 99;
export class VeaError extends Error {}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const skuSchema = z.string().regex(/^\d{1,20}$/);
const catalog = z.array(z.object({ productName: z.string(), items: z.array(z.object({
  itemId: skuSchema, name: z.string(), ean: z.string().default(''),
  measurementUnit: z.string().default('un'), unitMultiplier: z.number().default(1),
})) }));
const simulation = z.object({
  items: z.array(z.object({ id: z.string(), requestIndex: z.number().int().nonnegative(), seller: z.string(), quantity: integer,
    availability: z.string(), sellingPrice: integer.nullable().optional(),
    measurementUnit: z.string().optional(), unitMultiplier: z.number().optional(),
    priceDefinition: z.object({ total: integer }).nullable().optional(),
  })),
  logisticsInfo: z.array(z.object({ itemIndex: integer, slas: z.array(z.object({
    id: z.string(), name: z.string().optional(), deliveryChannel: z.string().optional(),
  })) })).default([]),
  storePreferencesData: z.object({ currencyCode: z.string() }).nullable().optional(),
});
export interface Product { sku: string; ean: string; productName: string; supported: boolean }
export interface QuoteInput { sku: string; qty: number }
export interface Offer extends QuoteInput { available: boolean; unitMinor: number | null; subtotalMinor: number | null; pickup: string | null; reason: string | null }
export interface SimulationResult { offers: Offer[]; quotedAt: number; expiresAt: number }

export function parseCatalog(data: unknown): Product[] {
  return catalog.parse(data).flatMap(p => p.items.map(i => ({ sku: i.itemId, ean: i.ean,
    productName: p.items.length === 1 ? p.productName : `${p.productName} · ${i.name}`,
    supported: i.measurementUnit === 'un' && i.unitMultiplier === 1,
  }))).filter((p, i, all) => all.findIndex(v => v.sku === p.sku) === i).slice(0, 10);
}
export function groupItems(items: QuoteInput[]): QuoteInput[] {
  const grouped = new Map<string, number>();
  for (const i of items) {
    if (!skuSchema.safeParse(i.sku).success || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > MAX_QTY) throw new VeaError('La cantidad debe ser de 1 a 99 unidades.');
    const qty = (grouped.get(i.sku) ?? 0) + i.qty;
    if (qty > MAX_QTY) throw new VeaError('Los productos repetidos suman más de 99 unidades. Ajustá las cantidades.');
    grouped.set(i.sku, qty);
  }
  return [...grouped].map(([sku, qty]) => ({ sku, qty }));
}
export function parseSimulation(data: unknown, items: QuoteInput[], settings: StoreSettings): Offer[] {
  const parsed = simulation.parse(data);
  if (parsed.storePreferencesData && parsed.storePreferencesData.currencyCode !== 'ARS') throw new VeaError('VEA devolvió una moneda distinta de pesos. No se puede cotizar.');
  return items.map((requested, index) => {
    const matches = parsed.items.filter(i => i.requestIndex === index && i.id === requested.sku && i.seller === settings.sellerId);
    const item = matches.length === 1 ? matches[0] : undefined;
    const slas = parsed.logisticsInfo.find(l => l.itemIndex === index)?.slas ?? [];
    // This branch advertises pickup as delivery, with this exact branch name.
    const pickup = slas.find(s => /Retiro en Tienda.*R[ií]o Tercero.*Modesto Acu[nñ]a 58/i.test(s.name ?? s.id));
    const supported = item?.measurementUnit === 'un' && item.unitMultiplier === 1;
    const price = item?.sellingPrice ?? null;
    const subtotal = item?.priceDefinition?.total ?? (price === null ? null : price * requested.qty);
    const stock = item?.availability === 'available' && item.quantity === requested.qty;
    const available = !!(stock && supported && pickup && price !== null && subtotal !== null && Number.isSafeInteger(subtotal));
    return { ...requested, available, unitMinor: available ? price : null, subtotalMinor: available ? subtotal : null,
      pickup: pickup?.name ?? pickup?.id ?? null,
      reason: available ? null : !item ? 'VEA no confirmó este producto.' : !supported ? 'Presentación por peso o fraccionada: revisala en VEA.' : !stock ? 'Sin stock para esta cantidad en la sucursal.' : !pickup ? 'Retiro en esta sucursal no confirmado.' : 'Precio no disponible.',
    };
  });
}
export function cartUrl(offers: Offer[], settings: StoreSettings): string | null {
  const items = groupItems(offers.filter(i => i.available).map(i => ({ sku: i.sku, qty: i.qty })));
  if (!items.length) return null;
  const url = new URL('https://www.vea.com.ar/checkout/cart/add');
  url.searchParams.set('sc', settings.salesChannel);
  for (const i of items) { url.searchParams.append('sku', i.sku); url.searchParams.append('qty', String(i.qty)); url.searchParams.append('seller', settings.sellerId); }
  return url.toString();
}

export class VeaClient {
  private cache = new Map<string, { expires: number; value: unknown }>();
  constructor(private transport: typeof fetch = fetch, private timeoutMs = 8000) {}
  private async cached<T>(key: string, ttl: number, get: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
    const existing = this.cache.get(key);
    if (existing) return existing.value as T;
    const value = await get();
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: now + ttl, value });
    return value;
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await this.transport(`https://www.vea.com.ar${path}`, { method: body ? 'POST' : 'GET',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
      if (!response.ok) throw new Error('upstream');
      return await response.json();
    } catch { throw new VeaError('VEA no responde en este momento. Probá nuevamente; tu lista sigue guardada.'); }
  }
  async search(term: string, settings: StoreSettings): Promise<Product[]> {
    return this.cached(`search:${settings.salesChannel}:${term}`, 600_000, async () => {
      const data = await this.request(`/api/catalog_system/pub/products/search/${encodeURIComponent(term)}?${new URLSearchParams({ sc: settings.salesChannel, _from: '0', _to: '9' })}`);
      try { return parseCatalog(data); } catch { throw new VeaError('VEA cambió la respuesta del catálogo. Reintentá más tarde.'); }
    });
  }
  async product(sku: string, settings: StoreSettings): Promise<Product | undefined> {
    return this.cached(`sku:${settings.salesChannel}:${sku}`, 600_000, async () => {
      const data = await this.request(`/api/catalog_system/pub/products/search?${new URLSearchParams({ fq: `skuId:${sku}`, sc: settings.salesChannel })}`);
      try { return parseCatalog(data).find(p => p.sku === sku); } catch { throw new VeaError('No se pudo verificar el producto en VEA.'); }
    });
  }
  async quote(input: QuoteInput[], settings: StoreSettings, household: string): Promise<SimulationResult> {
    const items = groupItems(input);
    return this.cached(`quote:${household}:${JSON.stringify(settings)}:${JSON.stringify(items)}`, 120_000, async () => {
      const quotedAt = Date.now();
      if (!items.length) return { offers: [], quotedAt, expiresAt: quotedAt + 120_000 };
      const data = await this.request(`/api/checkout/pub/orderForms/simulation?sc=${encodeURIComponent(settings.salesChannel)}`, {
        items: items.map(i => ({ id: i.sku, quantity: i.qty, seller: settings.sellerId })), country: 'ARG', postalCode: settings.postalCode,
      });
      try { return { offers: parseSimulation(data, items, settings), quotedAt, expiresAt: quotedAt + 120_000 }; }
      catch (e) { if (e instanceof VeaError) throw e; throw new VeaError('No se pudo interpretar la cotización de VEA. No se armó el carrito.'); }
    });
  }
}
