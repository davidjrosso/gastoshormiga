import { sqlite } from '../db/index.js';
import { periodRange } from '../lib/money.js';
import { getRateForDate, type RateType } from '../fx/rates.js';

/**
 * Ahorro. En Argentina "cuánto ahorramos" no se responde en pesos, se responde
 * en dólares: el peso es medio de pago, el dólar es unidad de cuenta.
 * Todo este módulo existe para poder contestar eso sin autoengaño.
 */

export interface AccountBalance {
  accountId: string;
  name: string;
  type: string;
  currency: string;
  balanceMinor: number;
}

/**
 * Saldo de cada cuenta = saldo inicial + ingresos - gastos
 *                        - transferencias salientes + transferencias entrantes.
 *
 * Las transferencias suman y restan en la misma consulta porque una cuenta
 * puede ser origen de unas y destino de otras.
 */
export function accountBalances(householdId: string): AccountBalance[] {
  const accounts = sqlite
    .prepare(
      `SELECT id, name, type, currency, opening_balance_minor
         FROM accounts WHERE household_id = ? AND archived = 0
        ORDER BY sort_order, name`,
    )
    .all(householdId) as Array<{
      id: string; name: string; type: string; currency: string; opening_balance_minor: number;
    }>;

  const movements = sqlite.prepare(
    `SELECT
        COALESCE(SUM(CASE WHEN type = 'ingreso'        AND account_id    = ? THEN amount_minor    END), 0) AS income,
        COALESCE(SUM(CASE WHEN type = 'gasto'          AND account_id    = ? THEN amount_minor    END), 0) AS expense,
        COALESCE(SUM(CASE WHEN type = 'transferencia'  AND account_id    = ? THEN amount_minor    END), 0) AS out,
        COALESCE(SUM(CASE WHEN type = 'transferencia'  AND to_account_id = ? THEN amount_to_minor END), 0) AS incoming
       FROM transactions WHERE household_id = ?`,
  );

  return accounts.map((a) => {
    const m = movements.get(a.id, a.id, a.id, a.id, householdId) as {
      income: number; expense: number; out: number; incoming: number;
    };
    return {
      accountId: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      balanceMinor: a.opening_balance_minor + m.income - m.expense - m.out + m.incoming,
    };
  });
}

export interface SavingsSummary {
  /** Dólares en mano, en cents. */
  usdHeldCents: number;
  /** Pesos líquidos (todo lo que no es cuenta en USD ni inversión). */
  arsLiquidMinor: number;
  /** Pesos totales gastados históricamente en comprar esos dólares. */
  arsSpentBuyingUsdMinor: number;
  /** Cotización promedio ponderada a la que compraron (centavos ARS por USD). */
  avgPurchaseRateMinor: number | null;
  /** Cotización de hoy según el tipo elegido por el hogar. */
  currentRateMinor: number | null;
  /** Valor actual de la tenencia en pesos. */
  usdValueInArsMinor: number | null;
  /** Diferencia contra lo que pagaron. No es "ganancia": el peso se depreció. */
  unrealizedArsMinor: number | null;
  unrealizedPct: number | null;
  /** Patrimonio total valuado en pesos y en dólares. */
  netWorthArsMinor: number | null;
  netWorthUsdCents: number | null;
}

export function savingsSummary(householdId: string, rateType: RateType = 'blue'): SavingsSummary {
  const balances = accountBalances(householdId);

  const usdHeldCents = balances
    .filter((b) => b.currency === 'USD')
    .reduce((s, b) => s + b.balanceMinor, 0);

  const arsLiquidMinor = balances
    .filter((b) => b.currency === 'ARS' && b.type !== 'inversion')
    .reduce((s, b) => s + b.balanceMinor, 0);

  // Compras de dólares = transferencias de una cuenta ARS a una cuenta USD.
  const purchases = sqlite
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0)    AS ars,
              COALESCE(SUM(amount_to_minor), 0) AS usd
         FROM transactions
        WHERE household_id = ?
          AND type = 'transferencia'
          AND currency = 'ARS'
          AND currency_to = 'USD'`,
    )
    .get(householdId) as { ars: number; usd: number };

  // Promedio ponderado: total de pesos pagados dividido total de dólares comprados.
  // Ponderado y no simple, porque comprar USD 500 a 1000 y USD 50 a 1400 no
  // promedia 1200: promedia mucho más cerca de 1000.
  const avgPurchaseRateMinor =
    purchases.usd > 0 ? Math.round((purchases.ars / purchases.usd) * 100) : null;

  const today = new Date().toISOString().slice(0, 10);
  const currentRateMinor = getRateForDate(rateType, today);

  const usdValueInArsMinor =
    currentRateMinor !== null ? Math.round((usdHeldCents / 100) * currentRateMinor) : null;

  let unrealizedArsMinor: number | null = null;
  let unrealizedPct: number | null = null;
  if (usdValueInArsMinor !== null && purchases.ars > 0 && purchases.usd > 0) {
    // Comparamos contra el costo de los dólares que todavía tenemos,
    // no contra todo lo comprado alguna vez.
    const costOfHeld = Math.round((usdHeldCents / purchases.usd) * purchases.ars);
    unrealizedArsMinor = usdValueInArsMinor - costOfHeld;
    unrealizedPct = costOfHeld > 0
      ? Math.round((unrealizedArsMinor / costOfHeld) * 1000) / 10
      : null;
  }

  const netWorthArsMinor =
    usdValueInArsMinor !== null ? arsLiquidMinor + usdValueInArsMinor : null;
  const netWorthUsdCents =
    currentRateMinor !== null && currentRateMinor > 0
      ? usdHeldCents + Math.round((arsLiquidMinor / currentRateMinor) * 100)
      : null;

  return {
    usdHeldCents,
    arsLiquidMinor,
    arsSpentBuyingUsdMinor: purchases.ars,
    avgPurchaseRateMinor,
    currentRateMinor,
    usdValueInArsMinor,
    unrealizedArsMinor,
    unrealizedPct,
    netWorthArsMinor,
    netWorthUsdCents,
  };
}

/**
 * Cuántos dólares compraron en un mes dado. Es la métrica de ahorro real:
 * el "sobrante" en pesos a fin de mes se lo come la inflación, los dólares no.
 */
export function usdBoughtInPeriod(householdId: string, period: string): { usdCents: number; arsMinor: number } {
  const { start, end } = periodRange(period);
  const row = sqlite
    .prepare(
      `SELECT COALESCE(SUM(amount_to_minor), 0) AS usd,
              COALESCE(SUM(amount_minor), 0)    AS ars
         FROM transactions
        WHERE household_id = ?
          AND type = 'transferencia'
          AND currency = 'ARS' AND currency_to = 'USD'
          AND date BETWEEN ? AND ?`,
    )
    .get(householdId, start, end) as { usd: number; ars: number };
  return { usdCents: row.usd, arsMinor: row.ars };
}
