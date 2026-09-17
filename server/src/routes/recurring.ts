import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth.js';
import { db } from '../db/index.js';
import { recurringRules, transactions } from '../db/schema.js';
import { getRateForDate, type RateType } from '../fx/rates.js';
import { parseAmountToMinor, todayISO } from '../lib/money.js';

export const recurringRoutes = new Hono<AppEnv>();
recurringRoutes.use('*', requireAuth);

/**
 * Materializa los gastos fijos del período.
 *
 * `lastGeneratedPeriod` es lo que hace esto idempotente: podés llamarlo diez
 * veces en el mismo mes y genera una sola transacción por regla. Importa
 * porque se dispara solo al abrir la app, y la app se abre muchas veces.
 */
export function generateRecurring(householdId: string, period: string, userId?: string): number {
  const rules = db
    .select()
    .from(recurringRules)
    .where(and(eq(recurringRules.householdId, householdId), eq(recurringRules.active, true)))
    .all();

  let created = 0;

  for (const rule of rules) {
    if (rule.lastGeneratedPeriod === period) continue;
    // No adelantamos meses futuros.
    if (period > todayISO().slice(0, 7)) continue;

    const [year, month] = period.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    // Si la regla cae el 31 y el mes tiene 30, se ancla al último día.
    const day = Math.min(rule.dayOfMonth, daysInMonth);
    const date = `${period}-${String(day).padStart(2, '0')}`;

    db.transaction((tx) => {
      tx.insert(transactions)
        .values({
          householdId,
          type: 'gasto',
          date,
          accountId: rule.accountId,
          amountMinor: rule.amountMinor,
          currency: rule.currency,
          categoryId: rule.categoryId,
          merchantId: rule.merchantId,
          note: rule.description,
          recurringRuleId: rule.id,
          createdByUserId: userId ?? null,
          usdRateMinor: getRateForDate('blue' as RateType, date),
        })
        .run();

      tx.update(recurringRules)
        .set({ lastGeneratedPeriod: period })
        .where(eq(recurringRules.id, rule.id))
        .run();
    });

    created++;
  }

  return created;
}

recurringRoutes.get('/', (c) => {
  const user = c.get('user');
  return c.json(
    db
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.householdId, user.householdId))
      .all(),
  );
});

recurringRoutes.post('/', async (c) => {
  const user = c.get('user');
  const parsed = z
    .object({
      description: z.string().min(1),
      amount: z.union([z.string(), z.number()]),
      currency: z.enum(['ARS', 'USD']).default('ARS'),
      accountId: z.string(),
      categoryId: z.string().nullable().optional(),
      dayOfMonth: z.number().int().min(1).max(31).default(1),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const row = db
    .insert(recurringRules)
    .values({
      householdId: user.householdId,
      description: parsed.data.description,
      amountMinor: Math.abs(parseAmountToMinor(parsed.data.amount)),
      currency: parsed.data.currency,
      accountId: parsed.data.accountId,
      categoryId: parsed.data.categoryId ?? null,
      dayOfMonth: parsed.data.dayOfMonth,
    })
    .returning()
    .all()[0];

  return c.json(row, 201);
});

recurringRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (body.description != null) updates.description = body.description;
  if (body.amount != null) updates.amountMinor = Math.abs(parseAmountToMinor(body.amount));
  if (body.dayOfMonth != null) updates.dayOfMonth = body.dayOfMonth;
  if (body.active != null) updates.active = Boolean(body.active);
  if (body.categoryId !== undefined) updates.categoryId = body.categoryId;
  if (Object.keys(updates).length === 0) return c.json({ error: 'Nada para actualizar' }, 400);

  const row = db
    .update(recurringRules)
    .set(updates)
    .where(
      and(
        eq(recurringRules.id, c.req.param('id')),
        eq(recurringRules.householdId, user.householdId),
      ),
    )
    .returning()
    .all();
  if (row.length === 0) return c.json({ error: 'No encontrada' }, 404);
  return c.json(row[0]);
});

recurringRoutes.delete('/:id', (c) => {
  const user = c.get('user');
  const deleted = db
    .delete(recurringRules)
    .where(
      and(
        eq(recurringRules.id, c.req.param('id')),
        eq(recurringRules.householdId, user.householdId),
      ),
    )
    .returning()
    .all();
  if (deleted.length === 0) return c.json({ error: 'No encontrada' }, 404);
  return c.json({ ok: true });
});

/** Fuerza la generación del mes actual. La app lo llama al abrir. */
recurringRoutes.post('/generate', (c) => {
  const user = c.get('user');
  const period = c.req.query('period') ?? todayISO().slice(0, 7);
  const created = generateRecurring(user.householdId, period, user.id);
  return c.json({ created, period });
});
