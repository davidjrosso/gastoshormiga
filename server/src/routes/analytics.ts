import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../auth.js';
import { categoryTrends, detectHormiga, detectSubscriptions, monthlySummary, spendByMember } from '../analytics/hormiga.js';
import { accountBalances, savingsSummary, usdBoughtInPeriod } from '../analytics/savings.js';
import { db } from '../db/index.js';
import { households } from '../db/schema.js';
import { fetchRate, getLatestRates, upsertRate, type RateType } from '../fx/rates.js';
import { parseAmountToMinor, shiftPeriod, todayISO } from '../lib/money.js';

export const analyticsRoutes = new Hono<AppEnv>();
analyticsRoutes.use('*', requireAuth);

const currentPeriod = () => todayISO().slice(0, 7);

function periodParam(c: { req: { query: (k: string) => string | undefined } }): string {
  const p = c.req.query('period');
  return p && /^\d{4}-\d{2}$/.test(p) ? p : currentPeriod();
}

/** Todo lo que necesita la pantalla principal, en una sola llamada. */
analyticsRoutes.get('/dashboard', (c) => {
  const user = c.get('user');
  const period = periodParam(c);

  const household = db
    .select()
    .from(households)
    .where(eq(households.id, user.householdId))
    .limit(1)
    .all()[0];
  const rateType = (household?.fxRateType ?? 'blue') as RateType;

  const summary = monthlySummary(user.householdId, period);
  const previous = monthlySummary(user.householdId, shiftPeriod(period, 1));

  return c.json({
    period,
    summary,
    previous,
    trends: categoryTrends(user.householdId, period),
    byMember: spendByMember(user.householdId, period),
    savings: savingsSummary(user.householdId, rateType),
    usdBought: usdBoughtInPeriod(user.householdId, period),
    balances: accountBalances(user.householdId),
    rates: getLatestRates(),
  });
});

analyticsRoutes.get('/summary', (c) => {
  const user = c.get('user');
  return c.json(monthlySummary(user.householdId, periodParam(c)));
});

/**
 * Serie histórica para los gráficos. Devuelve los últimos N meses.
 * Incluye el equivalente en USD de cada mes, que es la serie que de verdad
 * sirve para ver si estás gastando más o si solo se movió el peso.
 */
analyticsRoutes.get('/history', (c) => {
  const user = c.get('user');
  const months = Math.min(Number(c.req.query('months') ?? 6), 24);
  const base = currentPeriod();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    out.push(monthlySummary(user.householdId, shiftPeriod(base, i)));
  }
  return c.json(out);
});

analyticsRoutes.get('/hormiga', (c) => {
  const user = c.get('user');
  const months = Math.min(Math.max(Number(c.req.query('months') ?? 3), 1), 12);
  return c.json(detectHormiga(user.householdId, months));
});

analyticsRoutes.get('/subscriptions', (c) => {
  const user = c.get('user');
  const months = Math.min(Math.max(Number(c.req.query('months') ?? 6), 2), 24);
  return c.json(detectSubscriptions(user.householdId, months));
});

analyticsRoutes.get('/trends', (c) => {
  const user = c.get('user');
  const monthsBack = Math.min(Math.max(Number(c.req.query('monthsBack') ?? 3), 1), 12);
  return c.json(categoryTrends(user.householdId, periodParam(c), monthsBack));
});

analyticsRoutes.get('/savings', (c) => {
  const user = c.get('user');
  const household = db
    .select()
    .from(households)
    .where(eq(households.id, user.householdId))
    .limit(1)
    .all()[0];
  return c.json(savingsSummary(user.householdId, (household?.fxRateType ?? 'blue') as RateType));
});

// --- Cotizaciones ----------------------------------------------------------

analyticsRoutes.get('/fx', (c) => c.json(getLatestRates()));

analyticsRoutes.post('/fx/refresh', async (c) => {
  const types: RateType[] = ['blue', 'oficial', 'mep'];
  await Promise.all(types.map((t) => fetchRate(t)));
  return c.json(getLatestRates());
});

/**
 * Carga manual de cotización. Existe porque la API pública se puede caer,
 * porque podés haber comprado a un precio distinto al de referencia, y
 * porque nadie quiere que su app de finanzas dependa de un tercero gratuito.
 */
analyticsRoutes.post('/fx/manual', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? body.date
    : todayISO();
  const type = (typeof body.type === 'string' ? body.type : 'blue') as RateType;
  if (!['blue', 'oficial', 'mep', 'cripto'].includes(type)) {
    return c.json({ error: 'Tipo de cotización inválido' }, 400);
  }
  if (body.sell == null) return c.json({ error: 'Falta el valor de venta' }, 400);

  const sellMinor = parseAmountToMinor(body.sell);
  const buyMinor = body.buy != null ? parseAmountToMinor(body.buy) : sellMinor;
  if (sellMinor <= 0) return c.json({ error: 'La cotización tiene que ser positiva' }, 400);

  upsertRate(date, type, buyMinor, sellMinor, 'manual');
  return c.json(getLatestRates());
});
