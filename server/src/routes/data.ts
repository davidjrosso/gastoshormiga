import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth.js';
import { accountBalances } from '../analytics/savings.js';
import { db } from '../db/index.js';
import { accounts, categories, merchants, transactions } from '../db/schema.js';
import { normalizeMerchantName, parseAmountToMinor } from '../lib/money.js';

export const dataRoutes = new Hono<AppEnv>();
dataRoutes.use('*', requireAuth);

// --- Cuentas ---------------------------------------------------------------

dataRoutes.get('/accounts', (c) => {
  const user = c.get('user');
  return c.json(accountBalances(user.householdId));
});

dataRoutes.post('/accounts', async (c) => {
  const user = c.get('user');
  const parsed = z
    .object({
      name: z.string().min(1),
      type: z.enum(['efectivo', 'banco', 'tarjeta', 'ahorro', 'inversion']),
      currency: z.enum(['ARS', 'USD']).default('ARS'),
      openingBalance: z.union([z.string(), z.number()]).optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const row = db
    .insert(accounts)
    .values({
      householdId: user.householdId,
      name: parsed.data.name,
      type: parsed.data.type,
      currency: parsed.data.currency,
      openingBalanceMinor: parsed.data.openingBalance != null
        ? parseAmountToMinor(parsed.data.openingBalance)
        : 0,
    })
    .returning()
    .all()[0];

  return c.json(row, 201);
});

dataRoutes.patch('/accounts/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (body.name != null) updates.name = body.name;
  if (body.archived != null) updates.archived = Boolean(body.archived);
  if (body.openingBalance != null) {
    updates.openingBalanceMinor = parseAmountToMinor(body.openingBalance);
  }
  if (Object.keys(updates).length === 0) return c.json({ error: 'Nada para actualizar' }, 400);

  const row = db
    .update(accounts)
    .set(updates)
    .where(and(eq(accounts.id, c.req.param('id')), eq(accounts.householdId, user.householdId)))
    .returning()
    .all();
  if (row.length === 0) return c.json({ error: 'No encontrada' }, 404);
  return c.json(row[0]);
});

// --- Categorías ------------------------------------------------------------

dataRoutes.get('/categories', (c) => {
  const user = c.get('user');
  // Por defecto solo las activas: es lo que quiere la carga rápida.
  // La pantalla de administración pide ?includeArchived=1 para poder
  // mostrar —y revivir— las que se archivaron.
  const incluirArchivadas = c.req.query('includeArchived') === '1';

  const condiciones = [eq(categories.householdId, user.householdId)];
  if (!incluirArchivadas) condiciones.push(eq(categories.archived, false));

  return c.json(db.select().from(categories).where(and(...condiciones)).all());
});

dataRoutes.post('/categories', async (c) => {
  const user = c.get('user');
  const parsed = z
    .object({
      name: z.string().min(1),
      kind: z.enum(['gasto', 'ingreso']).default('gasto'),
      isFixed: z.boolean().default(false),
      color: z.string().default('#64748b'),
      icon: z.string().default('•'),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const row = db
    .insert(categories)
    .values({ householdId: user.householdId, ...parsed.data })
    .returning()
    .all()[0];
  return c.json(row, 201);
});

dataRoutes.patch('/categories/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  for (const key of ['name', 'color', 'icon'] as const) {
    if (body[key] != null) updates[key] = body[key];
  }
  if (body.isFixed != null) updates.isFixed = Boolean(body.isFixed);
  if (body.archived != null) updates.archived = Boolean(body.archived);
  if (Object.keys(updates).length === 0) return c.json({ error: 'Nada para actualizar' }, 400);

  const row = db
    .update(categories)
    .set(updates)
    .where(and(eq(categories.id, c.req.param('id')), eq(categories.householdId, user.householdId)))
    .returning()
    .all();
  if (row.length === 0) return c.json({ error: 'No encontrada' }, 404);
  return c.json(row[0]);
});

/**
 * Borrar una categoría.
 *
 * Si tiene movimientos asociados NO se borra: se archiva. Borrarla de verdad
 * dejaría esos gastos huérfanos y el historial mostraría "Sin categoría" en
 * meses ya cerrados, que es una forma silenciosa de corromper el pasado.
 * Archivada desaparece de la carga rápida pero sigue nombrando lo viejo.
 *
 * Si no tiene ningún movimiento, se borra de verdad: es una categoría que
 * creaste por error y no hay nada que preservar.
 */
dataRoutes.delete('/categories/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const existing = db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.householdId, user.householdId)))
    .limit(1)
    .all();
  if (existing.length === 0) return c.json({ error: 'No encontrada' }, 404);

  const enUso = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.categoryId, id), eq(transactions.householdId, user.householdId)))
    .limit(1)
    .all();

  if (enUso.length > 0) {
    db.update(categories).set({ archived: true }).where(eq(categories.id, id)).run();
    return c.json({ accion: 'archivada' });
  }

  db.delete(categories).where(eq(categories.id, id)).run();
  return c.json({ accion: 'borrada' });
});

// --- Comercios -------------------------------------------------------------

dataRoutes.get('/merchants', (c) => {
  const user = c.get('user');
  return c.json(
    db.select().from(merchants).where(eq(merchants.householdId, user.householdId)).all(),
  );
});

/**
 * Fusiona dos comercios. Sirve cuando el mismo lugar entró dos veces con
 * nombres distintos ("Coto" y "Coto Digital") y el análisis los ve separados.
 */
dataRoutes.post('/merchants/merge', async (c) => {
  const user = c.get('user');
  const parsed = z
    .object({ sourceId: z.string(), targetId: z.string() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Faltan los comercios a fusionar' }, 400);
  const { sourceId, targetId } = parsed.data;
  if (sourceId === targetId) return c.json({ error: 'Son el mismo comercio' }, 400);

  const both = db
    .select()
    .from(merchants)
    .where(eq(merchants.householdId, user.householdId))
    .all()
    .filter((m) => m.id === sourceId || m.id === targetId);
  if (both.length !== 2) return c.json({ error: 'Comercio inexistente' }, 404);

  db.transaction((tx) => {
    tx.update(transactions)
      .set({ merchantId: targetId })
      .where(
        and(
          eq(transactions.merchantId, sourceId),
          eq(transactions.householdId, user.householdId),
        ),
      )
      .run();
    tx.delete(merchants).where(eq(merchants.id, sourceId)).run();
  });

  return c.json({ ok: true });
});
