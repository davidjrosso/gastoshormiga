import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth.js';
import { sqlite } from '../db/index.js';
import { bestFullOffer, catalogIdFromUrl, isListingUrl, listingSearchUrl, MlAuthError, MlClient, MlError, parseReturnUrl } from '../stores/ml.js';
import { MlAccounts } from '../stores/ml-account.js';
import { productKey, storeLimiter, type StoreItem } from './store-rows.js';

const mlErrors = (e: Error, c: { json(body: unknown, status: 401 | 502 | 503): Response }) =>
  e instanceof MlAuthError ? c.json({ error: e.message, reconnect: true }, 401)
    : e instanceof MlError ? c.json({ error: e.message }, 502)
      : c.json({ error: 'No se pudo completar la consulta a Mercado Libre. Tu lista sigue guardada.' }, 503);

// Mounted inside shoppingRoutes, after its session + household/user middleware.
export function createMlRoutes(accounts = new MlAccounts(new MlClient())) {
  const routes = new Hono<AppEnv>();
  const client = accounts.client;
  routes.onError(mlErrors);
  routes.get('/status', c => c.json(accounts.status(c.get('user').householdId)));
  routes.use('/connect', storeLimiter('la conexión con Mercado Libre', 10, 1));
  routes.use('/complete', storeLimiter('la conexión con Mercado Libre', 10, 1));
  routes.post('/connect', c => {
    if (!accounts.configured) return c.json({ error: 'Mercado Libre no está configurado en el servidor.' }, 503);
    const user = c.get('user');
    return c.json({ authUrl: accounts.startConnect(user.householdId, user.id) });
  });
  // Alternativa al callback: el usuario pega la dirección a la que volvió el navegador.
  routes.post('/complete', async c => {
    if (!client.config) return c.json({ error: 'Mercado Libre no está configurado en el servidor.' }, 503);
    const parsed = z.object({ url: z.string().min(10).max(2000) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Pegá la dirección completa a la que volviste.' }, 400);
    const user = c.get('user');
    const { code, state } = parseReturnUrl(parsed.data.url, client.config);
    await accounts.complete(state, code, { household: user.householdId, user: user.id });
    return c.json(accounts.status(user.householdId));
  });
  routes.delete('/connection', c => { accounts.disconnect(c.get('user').householdId); return c.json(accounts.status(c.get('user').householdId)); });

  routes.use('/search', storeLimiter('Mercado Libre'));
  routes.use('/links/*', storeLimiter('Mercado Libre'));
  routes.get('/search', async c => {
    const term = z.string().trim().min(2).max(300).safeParse(c.req.query('q'));
    if (!term.success) return c.json({ error: 'Escribí entre 2 y 120 caracteres.' }, 400);
    const household = c.get('user').householdId;
    const token = await accounts.accessToken(household);
    // Enlace pegado desde la app: una ficha de catálogo se usa directo.
    const pastedId = catalogIdFromUrl(term.data);
    if (!pastedId && isListingUrl(term.data)) return c.json({ products: [], scanned: 0, searchUrl: null,
      notice: 'Ese enlace es de una publicación suelta, no de una ficha de catálogo. Hormiga solo puede comparar fichas (enlaces con /p/MLA…). Buscá el producto por nombre.' });
    if (!pastedId && term.data.length > 120) return c.json({ error: 'Escribí entre 2 y 120 caracteres.' }, 400);
    const candidates = pastedId ? [await client.product(pastedId, token)].filter((p): p is NonNullable<typeof p> => !!p) : (await client.searchCatalog(term.data, token)).slice(0, 30);
    // Se revisan hasta 30 fichas (5 a la vez, con plazo) y se muestran primero las que tienen Full.
    const signal = AbortSignal.timeout(15_000);
    const evaluated: Array<{ p: (typeof candidates)[number]; offer: ReturnType<typeof bestFullOffer> | undefined }> = candidates.map(p => ({ p, offer: undefined }));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(5, evaluated.length) }, async () => {
      while (cursor < evaluated.length && !signal.aborted) {
        const slot = evaluated[cursor++];
        try { slot.offer = bestFullOffer((await client.offerSnapshot(slot.p.productId, token, signal)).offers); }
        catch (e) { if (e instanceof MlAuthError) throw e; slot.offer = undefined; }
        if (!pastedId && evaluated.filter(x => x.offer).length >= 8) return;
      }
    }));
    const withFull = evaluated.filter(x => x.offer).sort((a, b) => a.offer!.unitMinor - b.offer!.unitMinor).slice(0, 8);
    const withoutFull = evaluated.filter(x => x.offer === null).slice(0, withFull.length ? 2 : 4);
    const products = await Promise.all([...withFull, ...withoutFull].map(async ({ p, offer }) => {
      const shipping = offer && !offer.freeShipping ? await client.shipping(offer.itemId, token, household).catch(() => null) : null;
      return { ...p, offer: offer ? { itemId: offer.itemId, unitMinor: offer.unitMinor, freeShipping: offer.freeShipping, shippingMinor: offer.freeShipping ? 0 : shipping?.costMinor ?? null, eta: shipping?.eta ?? null } : null,
        reason: offer ? null : 'Esta ficha no tiene ofertas Full.' };
    }));
    const scanned = evaluated.filter(x => x.offer !== undefined).length;
    return c.json({ products, scanned, searchUrl: pastedId ? null : listingSearchUrl(term.data),
      notice: withFull.length ? null : pastedId ? 'Esa ficha no tiene ofertas Full en este momento.'
        : `Revisamos ${scanned} fichas del catálogo y ninguna tiene ofertas Full. En la app de ML pueden aparecer publicaciones que no están en el catálogo: si ves una Full con enlace /p/MLA…, pegalo acá.` });
  });
  routes.put('/links/:itemKey', async c => {
    const parsed = z.object({ itemId: z.string().uuid(), productId: z.string().regex(/^MLA\d{1,15}$/), packQty: z.number().int().min(1).max(99).default(1) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Revisá el producto elegido.' }, 400);
    const user = c.get('user');
    const getItem = () => sqlite.prepare('SELECT data_json FROM shopping_items WHERE household_id=? AND id=?').get(user.householdId, parsed.data.itemId) as { data_json: string } | undefined;
    const row = getItem();
    if (!row) return c.json({ error: 'Producto no disponible en este hogar.' }, 404);
    const key = productKey(JSON.parse(row.data_json) as StoreItem);
    if (key !== c.req.param('itemKey')) return c.json({ error: 'El nombre cambió. Actualizá la lista.' }, 409);
    const product = await client.product(parsed.data.productId, await accounts.accessToken(user.householdId));
    if (!product) return c.json({ error: 'Ese producto ya no está en el catálogo de Mercado Libre.' }, 404);
    const current = getItem();
    if (!current || productKey(JSON.parse(current.data_json) as StoreItem) !== key) return c.json({ error: 'El producto cambió mientras consultábamos Mercado Libre. Actualizá la lista.' }, 409);
    sqlite.prepare(`INSERT INTO store_product_links VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(household_id,store,item_key) DO UPDATE SET sku=excluded.sku,ean=excluded.ean,product_name=excluded.product_name,pack_qty=excluded.pack_qty,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(user.householdId, 'ml', key, product.productId, product.gtin, product.productName, parsed.data.packQty, user.id, Date.now());
    return c.json({ ok: true });
  });
  routes.delete('/links/:itemKey', c => {
    sqlite.prepare("DELETE FROM store_product_links WHERE household_id=? AND store='ml' AND item_key=?").run(c.get('user').householdId, c.req.param('itemKey'));
    return c.json({ ok: true });
  });
  return routes;
}

const page = (title: string, body: string) => `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;

/**
 * Vuelta pública de Mercado Libre (sin sesión: la cookie es de otro host). Solo el `state`
 * de un solo uso, guardado al iniciar la conexión, identifica al hogar.
 */
export function createMlCallbackRoutes(accounts: MlAccounts) {
  const routes = new Hono();
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); await next(); });
  routes.get('/callback', async c => {
    const code = c.req.query('code'); const state = c.req.query('state');
    if (!code || !state || code.length > 200 || state.length > 100) return c.html(page('No se pudo conectar', 'Falta el código de Mercado Libre. Volvé a Hormiga e iniciá la conexión otra vez.'), 400);
    if (!accounts.configured) return c.html(page('No se pudo conectar', 'Mercado Libre no está configurado en el servidor.'), 503);
    try { await accounts.complete(state, code); }
    catch (e) {
      const message = e instanceof MlError ? e.message : 'Mercado Libre no respondió. Volvé a intentar desde Ajustes.';
      return c.html(page('No se pudo conectar', message.replace(/[<>&"]/g, '')), e instanceof MlAuthError ? 400 : 502);
    }
    const target = accounts.client.config?.returnUrl;
    if (target) return c.redirect(`${target}${target.includes('?') ? '&' : '?'}ml=conectado`, 302);
    return c.html(page('Mercado Libre conectado', 'Ya podés cerrar esta pestaña y volver a Hormiga.'));
  });
  return routes;
}
