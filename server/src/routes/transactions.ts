import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth.js';
import { db } from '../db/index.js';
import { accounts, categories, merchants, transactions } from '../db/schema.js';
import { getRateForDate, householdRateType } from '../fx/rates.js';
import { normalizeMerchantName, parseAmountToMinor, periodRange, todayISO } from '../lib/money.js';

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

  const row = db
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

  return c.json(row, 201);
});

transactionRoutes.get('/', (c) => {
  const user = c.get('user');
  const period = c.req.query('period');
  const type = c.req.query('type');
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000);

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

  const rows = db
    .select({
      tx: transactions,
      categoryName: categories.name,
      categoryColor: categories.color,
      categoryIcon: categories.icon,
      merchantName: merchants.name,
      accountName: accounts.name,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
    .leftJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(...conditions))
    .orderBy(desc(transactions.date), desc(transactions.createdAt))
    .limit(limit)
    .all();

  return c.json(
    rows.map((r) => ({
      ...r.tx,
      categoryName: r.categoryName,
      categoryColor: r.categoryColor,
      categoryIcon: r.categoryIcon,
      merchantName: r.merchantName,
      accountName: r.accountName,
    })),
  );
});

transactionRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const existing = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.householdId, user.householdId)))
    .limit(1)
    .all();
  if (existing.length === 0) return c.json({ error: 'No encontrado' }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.amount != null) updates.amountMinor = Math.abs(parseAmountToMinor(body.amount));
  if (body.date) updates.date = body.date;
  if (body.categoryId !== undefined) updates.categoryId = body.categoryId;
  if (body.note !== undefined) updates.note = body.note;
  if (body.merchantName !== undefined) {
    updates.merchantId = resolveMerchant(user.householdId, body.merchantName);
  }

  const row = db.update(transactions).set(updates).where(eq(transactions.id, id)).returning().all()[0];
  return c.json(row);
});

transactionRoutes.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const deleted = db
    .delete(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.householdId, user.householdId)))
    .returning()
    .all();
  if (deleted.length === 0) return c.json({ error: 'No encontrado' }, 404);
  return c.json({ ok: true });
});
