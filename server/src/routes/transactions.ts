import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth.js';
import { db, sqlite } from '../db/index.js';
import { accounts, categories, merchants, transactions } from '../db/schema.js';
import { getRateForDate, householdRateType } from '../fx/rates.js';
import { normalizeMerchantName, parseAmountToMinor, periodRange, todayISO } from '../lib/money.js';
import { assignEvent, EventError, installmentEventKeys, setTransactionEvent, validateEvent } from '../events.js';

export const transactionRoutes = new Hono<AppEnv>();
transactionRoutes.use('*', requireAuth);

/** Busca el comercio por nombre normalizado, o lo crea. */
function resolveMerchant(householdId: string, name: string | undefined | null): string | null {
  if (!name || !name.trim()) return null;
  const normalized = normalizeMerchantName(name);
  if (!normalized) return null;

  const found = db
    .select()
    .from(merchants)
    .where(and(eq(merchants.householdId, householdId), eq(merchants.normalizedName, normalized)))
    .limit(1)
    .all();
  if (found.length > 0) return found[0].id;

  return db
    .insert(merchants)
    .values({ householdId, name: name.trim(), normalizedName: normalized })
    .returning()
    .all()[0].id;
}

const createSchema = z.object({
  type: z.enum(['gasto', 'ingreso', 'transferencia']),
  amount: z.union([z.string(), z.number()]),
  currency: z.enum(['ARS', 'USD']).default('ARS'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountId: z.string(),
  categoryId: z.string().nullable().optional(),
  eventId: z.string().min(1).nullable().optional(),
  merchantName: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  paidByUserId: z.string().nullable().optional(),
  // Solo transferencias
  toAccountId: z.string().nullable().optional(),
  amountTo: z.union([z.string(), z.number()]).nullable().optional(),
  currencyTo: z.enum(['ARS', 'USD']).nullable().optional(),
});

transactionRoutes.post('/', async (c) => {
  const user = c.get('user');
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;

  if (d.eventId && d.type !== 'gasto') return c.json({ error: 'Los eventos se asignan a gastos.' }, 400);
  try { validateEvent(user.householdId, d.eventId ?? null); }
  catch (error) { if (error instanceof EventError) return c.json({ error: error.message }, 400); throw error; }

  let amountMinor: number;
  try {
    amountMinor = Math.abs(parseAmountToMinor(d.amount));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  if (amountMinor === 0) return c.json({ error: 'El monto no puede ser cero' }, 400);

  // La cuenta tiene que ser de este hogar. Sin esto, alguien con sesión válida
  // podría escribir movimientos en el hogar de otro pasando un id ajeno.
  const account = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, d.accountId), eq(accounts.householdId, user.householdId)))
    .limit(1)
    .all();
  if (account.length === 0) return c.json({ error: 'Cuenta inexistente' }, 400);

  const date = d.date ?? todayISO();

  let toAccountId: string | null = null;
  let amountToMinor: number | null = null;
  let currencyTo: string | null = null;

  if (d.type === 'transferencia') {
    if (!d.toAccountId) return c.json({ error: 'Falta la cuenta de destino' }, 400);
    if (d.toAccountId === d.accountId) {
      return c.json({ error: 'El origen y el destino no pueden ser la misma cuenta' }, 400);
    }
    const dest = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, d.toAccountId), eq(accounts.householdId, user.householdId)))
      .limit(1)
      .all();
    if (dest.length === 0) return c.json({ error: 'Cuenta de destino inexistente' }, 400);

    toAccountId = d.toAccountId;
    currencyTo = d.currencyTo ?? dest[0].currency;
    // Si no aclaran cuánto llega, asumimos misma moneda y mismo monto.
    amountToMinor = d.amountTo != null
      ? Math.abs(parseAmountToMinor(d.amountTo))
      : amountMinor;

    if (currencyTo !== d.currency && d.amountTo == null) {
      return c.json(
        { error: 'En un cambio de moneda hay que indicar cuánto llega a destino' },
        400,
      );
    }
  }

  const rateType = householdRateType(user.householdId);
  const usdRateMinor = getRateForDate(rateType, date);

  const row = sqlite.transaction(() => {
  const created = db
    .insert(transactions)
    .values({
      householdId: user.householdId,
      type: d.type,
      date,
      accountId: d.accountId,
      amountMinor,
      currency: d.currency,
      toAccountId,
      amountToMinor,
      currencyTo,
      categoryId: d.type === 'transferencia' ? null : d.categoryId ?? null,
      merchantId: resolveMerchant(user.householdId, d.merchantName),
      note: d.note ?? null,
      paidByUserId: d.paidByUserId ?? user.id,
      createdByUserId: user.id,
      usdRateMinor,
    })
    .returning()
    .all()[0];
  if (d.eventId) setTransactionEvent(created.id, d.eventId);
  return created;
  }).immediate();

  return c.json(row, 201);
});

transactionRoutes.get('/', (c) => {
  const user = c.get('user');
  const period = c.req.query('period');
  const type = c.req.query('type');
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000);
  const offset = Number(c.req.query('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return c.json({ error: 'Desplazamiento inválido' }, 400);
  }

  const conditions = [eq(transactions.householdId, user.householdId)];
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    const { start, end } = periodRange(period);
    conditions.push(gte(transactions.date, start), lte(transactions.date, end));
  }
  if (type && ['gasto', 'ingreso', 'transferencia'].includes(type)) {
    conditions.push(eq(transactions.type, type));
  }

  // Filtro por quién puso la plata. No valido que el id sea de un integrante
  // del hogar porque igual se cruza con household_id: un id ajeno simplemente
  // no devuelve nada.
  const paidBy = c.req.query('paidBy');
  if (paidBy) conditions.push(eq(transactions.paidByUserId, paidBy));
  const categoryId = c.req.query('categoryId');
  if (categoryId !== undefined) {
    conditions.push(categoryId === ''
      ? isNull(transactions.categoryId)
      : eq(transactions.categoryId, categoryId));
  }
  const eventId = c.req.query('eventId');
  if (eventId !== undefined) conditions.push(eventId === ''
    ? sql`NOT EXISTS (SELECT 1 FROM event_transactions WHERE transaction_id=${transactions.id})`
    : sql`EXISTS (SELECT 1 FROM event_transactions et JOIN events e ON e.id=et.event_id WHERE et.transaction_id=${transactions.id} AND e.id=${eventId} AND e.household_id=${user.householdId})`);

  const rows = db
    .select({
      tx: transactions,
      categoryName: categories.name,
      categoryColor: categories.color,
      categoryIcon: categories.icon,
      merchantName: merchants.name,
      accountName: accounts.name,
      statementId: sql<string | null>`(SELECT statement_id FROM card_movement_links WHERE transaction_id = ${transactions.id})`,
      eventId: sql<string | null>`(SELECT e.id FROM event_transactions et JOIN events e ON e.id=et.event_id WHERE et.transaction_id=${transactions.id} AND e.household_id=${user.householdId})`,
      eventName: sql<string | null>`(SELECT e.name FROM event_transactions et JOIN events e ON e.id=et.event_id WHERE et.transaction_id=${transactions.id} AND e.household_id=${user.householdId})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
    .leftJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(...conditions))
    .orderBy(desc(transactions.date), desc(transactions.createdAt), desc(transactions.id))
    .limit(limit)
    .offset(offset)
    .all();

  const keys = installmentEventKeys(user.householdId);
  return c.json(
    rows.map((r) => ({
      ...r.tx,
      categoryName: r.categoryName,
      categoryColor: r.categoryColor,
      categoryIcon: r.categoryIcon,
      merchantName: r.merchantName,
      accountName: r.accountName,
      statementId: r.statementId,
      eventId: r.eventId,
      eventName: r.eventName,
      canApplyEventToPurchase: !!keys.get(r.tx.id),
    })),
  );
});

/**
 * Campos editables de un movimiento.
 *
 * A propósito NO se puede cambiar el `type` ni la cuenta: pasar un gasto a
 * transferencia implica validar cuenta destino, monto recibido y moneda, y
 * media edición mal hecha deja una transferencia sin destino, que rompe los
 * saldos en silencio. Para eso está borrar y volver a cargar.
 */
const updateSchema = z.object({
  eventId: z.string().min(1).nullable().optional(),
  eventAllInstallments: z.boolean().optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida').optional(),
  categoryId: z.string().nullable().optional(),
  merchantName: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  paidByUserId: z.string().nullable().optional(),
});

transactionRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;

  const existing = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.householdId, user.householdId)))
    .limit(1)
    .all();
  if (existing.length === 0) return c.json({ error: 'No encontrado' }, 404);
  if (d.eventAllInstallments && d.eventId === undefined) return c.json({ error: 'Falta el evento a aplicar a las cuotas.' }, 400);
  if (d.eventId !== undefined) {
    if (existing[0].type !== 'gasto') return c.json({ error: 'Los eventos se asignan a gastos.' }, 400);
    const current = sqlite.prepare('SELECT event_id FROM event_transactions WHERE transaction_id=?').get(id) as { event_id: string } | undefined;
    try { validateEvent(user.householdId, d.eventId, current?.event_id); }
    catch (error) { if (error instanceof EventError) return c.json({ error: error.message }, 400); throw error; }
  }
  const linked = sqlite.prepare('SELECT 1 FROM card_movement_links WHERE transaction_id = ?').get(id);
  if (linked && (d.amount !== undefined || d.date !== undefined || d.paidByUserId !== undefined))
    return c.json({ error: 'El importe, la fecha y la persona estan vinculados al resumen de tarjeta. Solo puedes cambiar categoria, evento, comercio y nota.' }, 409);

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (d.amount != null) {
    let amountMinor: number;
    try {
      amountMinor = Math.abs(parseAmountToMinor(d.amount));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (amountMinor === 0) return c.json({ error: 'El monto no puede ser cero' }, 400);
    updates.amountMinor = amountMinor;
  }

  if (d.date && d.date !== existing[0].date) {
    updates.date = d.date;
    // Recongelamos la cotización al día corregido. Si no, un movimiento que se
    // cargó con fecha equivocada queda valuado en USD contra el dólar de otro
    // día, y toda la comparación entre meses —que es el punto de guardar la
    // cotización— pasa a apoyarse en un dato que sabemos falso.
    //
    // Pero solo si conseguimos una: sin internet la tabla de cotizaciones
    // puede estar vacía, y pisar con null una cotización que ya teníamos
    // deja el movimiento sin valuar a cambio de nada. Preferimos una
    // cotización de un día cercano antes que ninguna.
    const rate = getRateForDate(householdRateType(user.householdId), d.date);
    if (rate !== null) updates.usdRateMinor = rate;
  }

  if (d.categoryId !== undefined) updates.categoryId = d.categoryId;
  if (d.note !== undefined) updates.note = d.note;
  if (d.paidByUserId !== undefined) updates.paidByUserId = d.paidByUserId;

  try {
    const row = sqlite.transaction(() => {
      if (d.eventId !== undefined) {
        if (d.eventAllInstallments) assignEvent(user.householdId, [id], d.eventId, true);
        else setTransactionEvent(id, d.eventId);
      }
      if (d.merchantName !== undefined) updates.merchantId = resolveMerchant(user.householdId, d.merchantName);
      return db.update(transactions).set(updates).where(eq(transactions.id, id)).returning().all()[0];
    }).immediate();
    return c.json(row);
  } catch (error) { if (error instanceof EventError) return c.json({ error: error.message }, 400); throw error; }
});

transactionRoutes.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (sqlite.prepare(`SELECT 1 FROM card_movement_links l JOIN transactions t ON t.id = l.transaction_id
    WHERE t.id = ? AND t.household_id = ?`).get(id, user.householdId))
    return c.json({ error: 'Este movimiento esta vinculado a un resumen confirmado y no se puede borrar por separado.' }, 409);
  const deleted = db
    .delete(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.householdId, user.householdId)))
    .returning()
    .all();
  if (deleted.length === 0) return c.json({ error: 'No encontrado' }, 404);
  return c.json({ ok: true });
});
