import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Cliente Mercado Libre para Compras (solo lectura).
 *
 * Verificado el 29/09/2026 con la cuenta de David:
 * - /sites/MLA/search responde 403 incluso con token: NO se usa.
 * - /products/search (catálogo), /products/{id}, /products/{id}/items (ofertas) y
 *   /items/{id}/shipping_options funcionan con token de usuario.
 * - /items/{id} responde 403: NO se usa.
 * - El carrito se arma con /gz/checkout/cart/buy, enlace NO documentado por ML: si deja
 *   de funcionar, la comparación sigue siendo útil y el usuario arma el carrito a mano.
 *
 * Solo se consideran ofertas Full (logistic_type=fulfillment) y nuevas: la decisión de
 * David es que todo lo de ML llegue junto, en un mismo envío.
 */
export const ML_SITE = 'MLA';
export const ML_API = 'https://api.mercadolibre.com';
export const ML_AUTH = 'https://auth.mercadolibre.com.ar/authorization';
export const ML_CART = 'https://www.mercadolibre.com.ar/gz/checkout/cart/buy';
export const MAX_QTY = 99;
export class MlError extends Error {}
export class MlAuthError extends MlError {}

export interface MlConfig { clientId: string; clientSecret: string; redirectUri: string; postalCode: string; returnUrl: string | null }
export function loadMlConfig(env: NodeJS.ProcessEnv = process.env): MlConfig | null {
  const { ML_CLIENT_ID: clientId, ML_CLIENT_SECRET: clientSecret, ML_REDIRECT_URI: redirectUri } = env;
  if (!clientId || !/^\d{1,30}$/.test(clientId) || !clientSecret || !redirectUri) return null;
  try { if (new URL(redirectUri).protocol !== 'https:') return null; } catch { return null; }
  let returnUrl: string | null = null;
  try { if (env.ML_RETURN_URL && new URL(env.ML_RETURN_URL).protocol === 'https:') returnUrl = env.ML_RETURN_URL; } catch { /* ignored */ }
  return { clientId, clientSecret, redirectUri, postalCode: env.ML_POSTAL_CODE && /^\d{4}$/.test(env.ML_POSTAL_CODE) ? env.ML_POSTAL_CODE : '5850', returnUrl };
}

const b64url = (buf: Buffer) => buf.toString('base64url');
export function newPkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), state: b64url(randomBytes(24)) };
}
export function authUrl(config: MlConfig, state: string, challenge: string): string {
  const url = new URL(ML_AUTH);
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state }).toString();
  return url.toString();
}
/** Extrae code/state de la URL de vuelta pegada por el usuario. Solo acepta el redirect configurado. */
export function parseReturnUrl(raw: string, config: MlConfig): { code: string; state: string } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new MlError('Pegá la dirección completa, empezando por https://'); }
  const expected = new URL(config.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new MlError('La dirección no corresponde a la vuelta de Mercado Libre configurada.');
  const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
  if (!code || !state || code.length > 200 || state.length > 100) throw new MlError('La dirección no trae el código de Mercado Libre. Volvé a conectar.');
  return { code, state };
}

export function toMinor(price: number): number {
  const minor = Math.round(price * 100);
  if (!Number.isFinite(price) || price < 0 || !Number.isSafeInteger(minor)) throw new MlError('Mercado Libre devolvió un precio inválido.');
  return minor;
}

const productId = z.string().regex(/^MLA\d{1,15}$/);
const itemId = z.string().regex(/^MLA\d{1,15}$/);
const tokenSchema = z.object({ access_token: z.string().min(10), refresh_token: z.string().min(10), expires_in: z.number().int().positive(), scope: z.string().default(''), user_id: z.number().int().positive() });
export type MlTokens = { accessToken: string; refreshToken: string; expiresAt: number; scope: string; externalUserId: string };
export function parseTokens(data: unknown, now = Date.now()): MlTokens {
  const t = tokenSchema.parse(data);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + t.expires_in * 1000, scope: t.scope, externalUserId: String(t.user_id) };
}

export interface MlProduct { productId: string; productName: string; gtin: string }
const catalogSchema = z.object({ results: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()).default([]) });
export function parseCatalog(data: unknown): MlProduct[] {
  return catalogSchema.parse(data).results.filter(r => productId.safeParse(r.id).success)
    .map(r => ({ productId: r.id, productName: r.name, gtin: '' })).slice(0, 10);
}
const productSchema = z.object({ id: productId, name: z.string(), attributes: z.array(z.object({ id: z.string(), value_name: z.string().nullable().optional() })).default([]) });
export function parseProduct(data: unknown): MlProduct {
  const p = productSchema.parse(data);
  const gtin = p.attributes.find(a => a.id === 'GTIN')?.value_name ?? '';
  return { productId: p.id, productName: p.name, gtin: /^\d{8,14}$/.test(gtin) ? gtin : '' };
}

export interface MlOffer { itemId: string; unitMinor: number; sellerId: string; full: boolean; freeShipping: boolean }
const offersSchema = z.object({ results: z.array(z.object({
  item_id: z.string(), price: z.number(), currency_id: z.string(), seller_id: z.number().int(), condition: z.string().optional(),
  shipping: z.object({ logistic_type: z.string().nullable().optional(), free_shipping: z.boolean().optional() }).passthrough().optional(),
}).passthrough()).default([]) });
export function parseOffers(data: unknown): MlOffer[] {
  return offersSchema.parse(data).results
    .filter(o => itemId.safeParse(o.item_id).success && o.currency_id === 'ARS' && (o.condition ?? 'new') === 'new')
    .map(o => ({ itemId: o.item_id, unitMinor: toMinor(o.price), sellerId: String(o.seller_id), full: o.shipping?.logistic_type === 'fulfillment', freeShipping: !!o.shipping?.free_shipping }));
}
/** Solo Full: todo llega junto. Entre las Full, la más barata. */
export function bestFullOffer(offers: MlOffer[]): MlOffer | null {
  return offers.filter(o => o.full).sort((a, b) => a.unitMinor - b.unitMinor || a.itemId.localeCompare(b.itemId))[0] ?? null;
}

export interface MlShipping { costMinor: number; listMinor: number | null; eta: string | null }
const shippingSchema = z.object({ options: z.array(z.object({ cost: z.number().nullable().optional(), list_cost: z.number().nullable().optional(), currency_id: z.string().optional(),
  estimated_delivery_time: z.object({ date: z.string().nullable().optional() }).passthrough().nullable().optional() }).passthrough()).default([]) });
/** Costo que informa ML para ese ítem suelto (el menor entre las opciones). Orientativo: el checkout decide. */
export function parseShipping(data: unknown): MlShipping | null {
  const options = shippingSchema.parse(data).options.filter(o => (o.currency_id ?? 'ARS') === 'ARS' && typeof (o.cost ?? o.list_cost) === 'number');
  if (!options.length) return null;
  const best = options.map(o => ({ costMinor: toMinor((o.cost ?? o.list_cost)!), listMinor: typeof o.list_cost === 'number' ? toMinor(o.list_cost) : null, eta: o.estimated_delivery_time?.date?.slice(0, 10) ?? null }))
    .sort((a, b) => a.costMinor - b.costMinor)[0];
  return best;
}

export function cartUrl(items: Array<{ itemId: string; qty: number }>): string | null {
  const grouped = new Map<string, number>();
  for (const i of items) {
    if (!itemId.safeParse(i.itemId).success || !Number.isInteger(i.qty) || i.qty < 1) throw new MlError('Producto de Mercado Libre inválido.');
    grouped.set(i.itemId, (grouped.get(i.itemId) ?? 0) + i.qty);
  }
  if (!grouped.size) return null;
  if ([...grouped.values()].some(q => q > MAX_QTY)) throw new MlError('Un producto supera 99 unidades.');
  // IDs y cantidades validados arriba: la coma separadora va literal, como la usa ML.
  return `${ML_CART}?site_id=${ML_SITE}&items=${[...grouped].map(([id, q]) => `${id}-Q${q}`).join(',')}`;
}

export class MlClient {
  private cache = new Map<string, { expires: number; value: unknown }>();
  constructor(readonly config: MlConfig | null = loadMlConfig(), private transport: typeof fetch = fetch, private timeoutMs = 8000) {}
  private async cached<T>(key: string, ttl: number, get: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
    const existing = this.cache.get(key);
    if (existing) return existing.value as T;
    const value = await get();
    if (this.cache.size >= 300) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: now + ttl, value });
    return value;
  }
  private requireConfig(): MlConfig {
    if (!this.config) throw new MlError('Mercado Libre no está configurado en el servidor.');
    return this.config;
  }
  private async call(path: string, init: { token?: string; form?: Record<string, string> } = {}): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.transport(`${ML_API}${path}`, {
        method: init.form ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: init.form ? new URLSearchParams(init.form).toString() : undefined,
      });
    } catch { throw new MlError('Mercado Libre no responde en este momento. Probá nuevamente; tu lista sigue guardada.'); }
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }
  private async get(path: string, token: string, allow404 = false): Promise<unknown> {
    const { status, body } = await this.call(path, { token });
    if (status === 401) throw new MlAuthError('La conexión con Mercado Libre venció. Volvé a conectarla en Ajustes.');
    if (allow404 && status === 404) return null;
    if (status !== 200) throw new MlError('Mercado Libre rechazó la consulta. Probá más tarde.');
    return body;
  }
  private async token(form: Record<string, string>): Promise<MlTokens> {
    const config = this.requireConfig();
    const { status, body } = await this.call('/oauth/token', { form: { ...form, client_id: config.clientId, client_secret: config.clientSecret } });
    if (status === 400 || status === 401 || status === 403) throw new MlAuthError('Mercado Libre no aceptó la autorización. Volvé a conectar la cuenta.');
    if (status !== 200) throw new MlError('Mercado Libre no pudo completar la autorización. Probá más tarde.');
    try { return parseTokens(body); } catch { throw new MlError('Mercado Libre devolvió una autorización inesperada.'); }
  }
  exchangeCode(code: string, verifier: string) {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.requireConfig().redirectUri, code_verifier: verifier });
  }
  refresh(refreshToken: string) { return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
  searchCatalog(term: string, token: string): Promise<MlProduct[]> {
    return this.cached(`search:${term}`, 600_000, async () => {
      const data = await this.get(`/products/search?${new URLSearchParams({ status: 'active', site_id: ML_SITE, q: term, limit: '10' })}`, token);
      try { return parseCatalog(data); } catch { throw new MlError('Mercado Libre cambió la respuesta del catálogo.'); }
    });
  }
  product(id: string, token: string): Promise<MlProduct | null> {
    if (!productId.safeParse(id).success) return Promise.resolve(null);
    return this.cached(`product:${id}`, 600_000, async () => {
      const data = await this.get(`/products/${id}`, token, true);
      if (data === null) return null;
      try { return parseProduct(data); } catch { throw new MlError('No se pudo verificar el producto en Mercado Libre.'); }
    });
  }
  offers(id: string, token: string): Promise<MlOffer[]> {
    if (!productId.safeParse(id).success) return Promise.resolve([]);
    return this.cached(`offers:${id}`, 120_000, async () => {
      const data = await this.get(`/products/${id}/items?limit=20`, token, true);
      if (data === null) return [];
      try { return parseOffers(data); } catch { throw new MlError('No se pudieron leer las ofertas de Mercado Libre.'); }
    });
  }
  /** `scope` separa la caché por hogar: con Meli+ el costo puede depender de la cuenta. */
  shipping(item: string, token: string, scope: string): Promise<MlShipping | null> {
    const zip = this.requireConfig().postalCode;
    return this.cached(`ship:${scope}:${item}:${zip}`, 120_000, async () => {
      const data = await this.get(`/items/${item}/shipping_options?zip_code=${zip}`, token, true);
      if (data === null) return null;
      try { return parseShipping(data); } catch { return null; }
    });
  }
}
