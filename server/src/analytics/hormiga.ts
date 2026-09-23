import { sqlite } from '../db/index.js';
import { periodRange, shiftPeriod, toUsdCents } from '../lib/money.js';
import { habitualExpenseSql } from '../events.js';

/**
 * Motor de análisis.
 *
 * Decisión de diseño que atraviesa todo el archivo: NO hay umbrales fijos en
 * pesos. Escribir "es gasto hormiga si es menor a $3.000" es garantizar que el
 * detector quede inservible en seis meses. Todos los umbrales son relativos al
 * propio hogar (porcentaje del ingreso, mediana de sus gastos), así que se
 * recalibran solos a medida que los números crecen.
 */

export interface HormigaItem {
  merchantId: string | null;
  merchantName: string;
  categoryName: string | null;
  count: number;
  totalMinor: number;
  avgMinor: number;
  monthlyAvgMinor: number;
  annualizedMinor: number;
  annualizedUsdCents: number | null;
  timesPerMonth: number;
  firstDate: string;
  lastDate: string;
}

export interface SubscriptionItem {
  merchantId: string | null;
  merchantName: string;
  amountMinor: number;
  currency: string;
  cadence: 'mensual' | 'anual';
  occurrences: number;
  lastDate: string;
  nextExpectedDate: string;
  monthlyEquivalentMinor: number;
  annualMinor: number;
  /** Variación % entre el primer cargo y el último. Delata aumentos silenciosos. */
  priceChangePct: number | null;
  /** Días desde el último cargo. Si supera mucho la cadencia, quizás ya se dio de baja. */
  daysSinceLast: number;
  /**
   * Si ya existe una regla de gasto fijo que genere este cargo.
   *
   * A propósito NO mira `category.isFixed`: que una categoría esté marcada como
   * fija es una clasificación floja y heredada del seed, mientras que crear una
   * regla recurrente es un acto explícito del usuario diciendo "esto ya lo sé,
   * lo tengo contemplado". Solo lo segundo significa algo.
   *
   * Lo que queda sin declarar es la lista de trabajo: cargos que se repiten
   * todos los meses y que el hogar todavía no incorporó a su presupuesto.
   */
  isDeclaredFixed: boolean;
}

interface TxRow {
  id: string;
  date: string;
  amount_minor: number;
  currency: string;
  usd_rate_minor: number | null;
  merchant_id: string | null;
  merchant_name: string | null;
  category_name: string | null;
  is_fixed?: number;
  recurring_rule_id?: string | null;
}

/** Ingreso mensual promedio del hogar en la ventana. Base para los umbrales relativos. */
function avgMonthlyIncomeMinor(householdId: string, startDate: string, endDate: string, months: number): number {
  const row = sqlite
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total
         FROM transactions
        WHERE household_id = ?
          AND type = 'ingreso'
          AND date BETWEEN ? AND ?`,
    )
    .get(householdId, startDate, endDate) as { total: number };
  return months > 0 ? Math.round(row.total / months) : 0;
}

/** Mediana de los gastos del hogar. Red de seguridad si todavía no cargó ingresos. */
function medianExpenseMinor(householdId: string, startDate: string, endDate: string): number {
  const rows = sqlite
    .prepare(
      `SELECT amount_minor FROM transactions t
        WHERE household_id = ? AND type = 'gasto' AND date BETWEEN ? AND ? AND ${habitualExpenseSql}
        ORDER BY amount_minor`,
    )
    .all(householdId, startDate, endDate) as Array<{ amount_minor: number }>;
  if (rows.length === 0) return 0;
  return rows[Math.floor(rows.length / 2)].amount_minor;
}

/**
 * Detecta el gasto hormiga: compras chicas y frecuentes que individualmente
 * no duelen y sumadas son un alquiler.
 *
 * Un gasto entra si cumple las dos condiciones a la vez:
 *   1. Es FRECUENTE — al menos ~1 vez por mes en la ventana analizada.
 *   2. Es CHICO — el ticket promedio está por debajo del umbral relativo
 *      del hogar (1,5% del ingreso mensual, o la mediana de gastos si no
 *      hay ingresos cargados).
 *
 * Un gasto grande y repetido no es hormiga, es un gasto fijo: ya lo ves.
 * Un gasto chico y único tampoco: no hay nada que cortar. El daño está en
 * la intersección, que es justo lo que ningún resumen bancario te muestra.
 */
export function detectHormiga(householdId: string, months = 3): HormigaItem[] {
  const today = new Date().toISOString().slice(0, 10);
  const currentPeriod = today.slice(0, 7);
  const startPeriod = shiftPeriod(currentPeriod, months - 1);
  const startDate = periodRange(startPeriod).start;
  const endDate = today;

  const rows = sqlite
    .prepare(
      `SELECT t.id, t.date, t.amount_minor, t.currency, t.usd_rate_minor,
              t.merchant_id, m.name AS merchant_name, c.name AS category_name
         FROM transactions t
         LEFT JOIN merchants  m ON m.id = t.merchant_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ?
          AND t.type = 'gasto'
          AND ${habitualExpenseSql}
          AND t.date BETWEEN ? AND ?`,
    )
    .all(householdId, startDate, endDate) as TxRow[];

  if (rows.length === 0) return [];

  const income = avgMonthlyIncomeMinor(householdId, startDate, endDate, months);
  const median = medianExpenseMinor(householdId, startDate, endDate);

  // El corte: 0,5% del ingreso mensual, aplicado a DOS lados.
  //
  // La definición de gasto hormiga que hace falta capturar es exactamente ésta:
  // cada compra suelta está por debajo del umbral en que uno se fijaría, pero
  // la suma del mes lo supera. Es decir, el agregado cruza una línea que cada
  // compra individual nunca cruza. Con un solo lado no alcanza: el lado "chico"
  // solo deja pasar ruido irrelevante, y el lado "frecuente" solo marca cosas
  // que ya se ven. El daño está donde se cruzan.
  const threshold = income > 0 ? Math.round(income * 0.005) : median;

  // Agrupamos por comercio. Sin comercio, la categoría es el mejor proxy.
  const groups = new Map<string, TxRow[]>();
  for (const r of rows) {
    const key = r.merchant_id ?? `cat:${r.category_name ?? 'sin-categoria'}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: HormigaItem[] = [];

  for (const [, txs] of groups) {
    const count = txs.length;
    const totalMinor = txs.reduce((s, t) => s + t.amount_minor, 0);
    const avgMinor = Math.round(totalMinor / count);
    const timesPerMonth = count / months;

    const monthlyAvgMinor = Math.round(totalMinor / months);

    const isFrequent = timesPerMonth >= 1;
    const isSmall = threshold > 0 && avgMinor <= threshold;
    // El agregado mensual tiene que superar el mismo umbral que cada compra
    // individual no alcanza. Sin esto entra cualquier cosa barata y repetida
    // que en total no mueve la aguja, y el informe se llena de ruido.
    const isMaterial = threshold > 0 && monthlyAvgMinor >= threshold;
    if (!isFrequent || !isSmall || !isMaterial) continue;

    const dates = txs.map((t) => t.date).sort();
    const annualizedMinor = monthlyAvgMinor * 12;

    // Valuamos en USD con la cotización congelada de cada transacción,
    // no con la de hoy: así el total anualizado no miente cuando el peso
    // se movió durante la ventana analizada.
    let usdSum = 0;
    let usdKnown = 0;
    for (const t of txs) {
      const cents = toUsdCents(t.amount_minor, t.currency, t.usd_rate_minor);
      if (cents !== null) {
        usdSum += cents;
        usdKnown++;
      }
    }
    const annualizedUsdCents =
      usdKnown > 0 ? Math.round((usdSum / usdKnown) * count * (12 / months)) : null;

    out.push({
      merchantId: txs[0].merchant_id,
      merchantName: txs[0].merchant_name ?? txs[0].category_name ?? 'Sin identificar',
      categoryName: txs[0].category_name,
      count,
      totalMinor,
      avgMinor,
      monthlyAvgMinor,
      annualizedMinor,
      annualizedUsdCents,
      timesPerMonth: Math.round(timesPerMonth * 10) / 10,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
    });
  }

  // Ordenado por lo que realmente importa: cuánto recuperás en un año si lo cortás.
  return out.sort((a, b) => b.annualizedMinor - a.annualizedMinor);
}

/**
 * Detecta suscripciones: cargos del mismo comercio, por un monto casi idéntico,
 * separados por intervalos regulares.
 *
 * Lo verdaderamente útil acá no es "tenés Netflix" (eso ya lo sabés) sino
 * `priceChangePct`: los servicios atados al dólar te aumentan de a poco y
 * nadie revisa el resumen de la tarjeta línea por línea.
 */
export function detectSubscriptions(householdId: string, months = 6): SubscriptionItem[] {
  const today = new Date().toISOString().slice(0, 10);
  const startPeriod = shiftPeriod(today.slice(0, 7), months - 1);
  const startDate = periodRange(startPeriod).start;

  const rows = sqlite
    .prepare(
      `SELECT t.id, t.date, t.amount_minor, t.currency, t.usd_rate_minor,
              t.merchant_id, t.recurring_rule_id,
              m.name AS merchant_name, c.name AS category_name,
              COALESCE(c.is_fixed, 0) AS is_fixed
         FROM transactions t
         LEFT JOIN merchants  m ON m.id = t.merchant_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ?
          AND t.type = 'gasto'
          AND ${habitualExpenseSql}
          AND t.date >= ?
        ORDER BY t.date`,
    )
    .all(householdId, startDate) as TxRow[];

  const groups = new Map<string, TxRow[]>();
  for (const r of rows) {
    if (!r.merchant_id) continue; // sin comercio no hay forma de afirmar recurrencia
    const list = groups.get(r.merchant_id);
    if (list) list.push(r);
    else groups.set(r.merchant_id, [r]);
  }

  const out: SubscriptionItem[] = [];

  for (const [merchantId, txs] of groups) {
    if (txs.length < 2) continue;

    const intervals: number[] = [];
    for (let i = 1; i < txs.length; i++) {
      const prev = Date.parse(`${txs[i - 1].date}T00:00:00Z`);
      const cur = Date.parse(`${txs[i].date}T00:00:00Z`);
      intervals.push(Math.round((cur - prev) / 86_400_000));
    }

    const medianInterval = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
    const cadence: 'mensual' | 'anual' | null =
      medianInterval >= 25 && medianInterval <= 35
        ? 'mensual'
        : medianInterval >= 350 && medianInterval <= 380
          ? 'anual'
          : null;
    if (!cadence) continue;

    // Los montos tienen que ser estables. Si varían mucho es consumo
    // variable en el mismo comercio (el súper), no una suscripción.
    const amounts = txs.map((t) => t.amount_minor);
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const maxDeviation = Math.max(...amounts.map((a) => Math.abs(a - avg) / avg));
    // 35% tolera los aumentos de precio acumulados en la ventana sin
    // dejar entrar compras genuinamente variables.
    if (maxDeviation > 0.35) continue;

    const first = amounts[0];
    const last = amounts[amounts.length - 1];
    const priceChangePct = first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : null;

    const lastDate = txs[txs.length - 1].date;
    const lastMs = Date.parse(`${lastDate}T00:00:00Z`);
    const daysSinceLast = Math.round((Date.parse(`${today}T00:00:00Z`) - lastMs) / 86_400_000);
    const nextExpectedDate = new Date(lastMs + medianInterval * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const monthlyEquivalentMinor = cadence === 'mensual' ? last : Math.round(last / 12);

    out.push({
      merchantId,
      merchantName: txs[0].merchant_name ?? 'Sin identificar',
      amountMinor: last,
      currency: txs[0].currency,
      cadence,
      occurrences: txs.length,
      lastDate,
      nextExpectedDate,
      monthlyEquivalentMinor,
      annualMinor: monthlyEquivalentMinor * 12,
      priceChangePct,
      daysSinceLast,
      isDeclaredFixed: txs.some((t) => t.recurring_rule_id != null),
    });
  }

  // Lo no declarado primero: es lo único sobre lo que hay algo para hacer.
  // Dentro de cada grupo, lo más caro al año arriba.
  return out.sort((a, b) => {
    if (a.isDeclaredFixed !== b.isDeclaredFixed) return a.isDeclaredFixed ? 1 : -1;
    return b.annualMinor - a.annualMinor;
  });
}

export interface MonthlySummary {
  habitualExpenseMinor: number;
  habitualExpenseUsdCents: number | null;
  period: string;
  incomeMinor: number;
  expenseMinor: number;
  fixedExpenseMinor: number;
  variableExpenseMinor: number;
  balanceMinor: number;
  savingsRatePct: number | null;
  incomeUsdCents: number | null;
  expenseUsdCents: number | null;
  txCount: number;
}

/**
 * Resumen del mes. Las transferencias quedan fuera de ingresos y gastos:
 * mover plata de la caja de ahorro al colchón no es ninguna de las dos cosas.
 */
export function monthlySummary(householdId: string, period: string): MonthlySummary {
  const { start, end } = periodRange(period);

  const rows = sqlite
    .prepare(
      `SELECT t.type, t.amount_minor, t.currency, t.usd_rate_minor, ${habitualExpenseSql} AS habitual,
              COALESCE(c.is_fixed, 0) AS is_fixed
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ?
          AND t.date BETWEEN ? AND ?
          AND t.type IN ('gasto', 'ingreso')`,
    )
    .all(householdId, start, end) as Array<{
      type: string;
      habitual: number;
      amount_minor: number;
      currency: string;
      usd_rate_minor: number | null;
      is_fixed: number;
    }>;

  let incomeMinor = 0;
  let expenseMinor = 0;
  let fixedExpenseMinor = 0;
  let incomeUsd = 0;
  let expenseUsd = 0;
  let incomeUsdKnown = false;
  let expenseUsdKnown = false;
  let habitualExpenseMinor = 0;
  let habitualExpenseUsd = 0;
  let habitualUsdKnown = false;

  for (const r of rows) {
    const usd = toUsdCents(r.amount_minor, r.currency, r.usd_rate_minor);
    if (r.type === 'ingreso') {
      incomeMinor += r.amount_minor;
      if (usd !== null) {
        incomeUsd += usd;
        incomeUsdKnown = true;
      }
    } else {
      if (r.habitual) {
        habitualExpenseMinor += r.amount_minor;
        if (usd !== null) { habitualExpenseUsd += usd; habitualUsdKnown = true; }
      }
      expenseMinor += r.amount_minor;
      if (r.is_fixed) fixedExpenseMinor += r.amount_minor;
      if (usd !== null) {
        expenseUsd += usd;
        expenseUsdKnown = true;
      }
    }
  }

  const balanceMinor = incomeMinor - expenseMinor;

  return {
    period,
    incomeMinor,
    expenseMinor,
    fixedExpenseMinor,
    variableExpenseMinor: expenseMinor - fixedExpenseMinor,
    balanceMinor,
    savingsRatePct:
      incomeMinor > 0 ? Math.round((balanceMinor / incomeMinor) * 1000) / 10 : null,
    incomeUsdCents: incomeUsdKnown ? incomeUsd : null,
    expenseUsdCents: expenseUsdKnown ? expenseUsd : null,
    habitualExpenseMinor,
    habitualExpenseUsdCents: habitualUsdKnown ? habitualExpenseUsd : null,
    txCount: rows.length,
  };
}

export interface MemberSpend {
  userId: string | null;
  expenseMinor: number;
  incomeMinor: number;
  txCount: number;
}

/**
 * Cuánto puso cada integrante del hogar en el mes.
 *
 * Agrupa por `paid_by_user_id`, o sea por quién PAGÓ, no por quién cargó el
 * dato en la app. Son cosas distintas: uno puede anotar a la noche la compra
 * que hizo el otro a la mañana, y para la plata lo que importa es quién la puso.
 *
 * `userId` puede venir null en movimientos viejos cargados antes de que
 * existiera el campo; el front los agrupa como "sin asignar".
 */
export function spendByMember(householdId: string, period: string): MemberSpend[] {
  const { start, end } = periodRange(period);
  const rows = sqlite
    .prepare(
      `SELECT paid_by_user_id AS user_id,
              COALESCE(SUM(CASE WHEN type = 'gasto'   THEN amount_minor END), 0) AS expense,
              COALESCE(SUM(CASE WHEN type = 'ingreso' THEN amount_minor END), 0) AS income,
              COUNT(*) AS n
         FROM transactions
        WHERE household_id = ?
          AND date BETWEEN ? AND ?
          AND type IN ('gasto', 'ingreso')
        GROUP BY paid_by_user_id`,
    )
    .all(householdId, start, end) as Array<{
      user_id: string | null; expense: number; income: number; n: number;
    }>;

  return rows
    .map((r) => ({
      userId: r.user_id,
      expenseMinor: r.expense,
      incomeMinor: r.income,
      txCount: r.n,
    }))
    .sort((a, b) => b.expenseMinor - a.expenseMinor);
}

export interface CategoryTrend {
  habitualMinor: number;
  categoryId: string | null;
  categoryName: string;
  color: string;
  currentMinor: number;
  baselineMinor: number;
  changePct: number | null;
  /** Porcentaje del ingreso del mes. La métrica que la inflación no distorsiona. */
  shareOfIncomePct: number | null;
  baselineShareOfIncomePct: number | null;
}

/**
 * Compara cada categoría del mes contra su promedio de los meses previos.
 *
 * Reporta el cambio en pesos (intuitivo) y también como porcentaje del
 * ingreso (honesto). Con 100%+ de inflación anual, "gastaste 40% más que en
 * marzo" puede significar que gastaste menos en términos reales; lo que no
 * miente es qué proporción de lo que entró se fue en cada cosa.
 */
export function categoryTrends(householdId: string, period: string, monthsBack = 3): CategoryTrend[] {
  const { start, end } = periodRange(period);
  const baselineStartPeriod = shiftPeriod(period, monthsBack);
  const baselineStart = periodRange(baselineStartPeriod).start;
  const baselineEnd = periodRange(shiftPeriod(period, 1)).end;

  const current = sqlite
    .prepare(
      `SELECT t.category_id,
              COALESCE(c.name, 'Sin categoría') AS name,
              COALESCE(c.color, '#64748b')      AS color,
              SUM(t.amount_minor)               AS total,
              SUM(CASE WHEN ${habitualExpenseSql} THEN t.amount_minor ELSE 0 END) AS habitual
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ? AND t.type = 'gasto' AND t.date BETWEEN ? AND ?
        GROUP BY t.category_id`,
    )
    .all(householdId, start, end) as Array<{
      category_id: string | null; name: string; color: string; total: number; habitual: number;
    }>;

  const baseline = sqlite
    .prepare(
      `SELECT t.category_id, SUM(t.amount_minor) AS total
         FROM transactions t
        WHERE t.household_id = ? AND t.type = 'gasto' AND t.date BETWEEN ? AND ? AND ${habitualExpenseSql}
        GROUP BY t.category_id`,
    )
    .all(householdId, baselineStart, baselineEnd) as Array<{
      category_id: string | null; total: number;
    }>;

  const baselineMap = new Map<string, number>();
  for (const b of baseline) {
    baselineMap.set(b.category_id ?? 'null', Math.round(b.total / monthsBack));
  }

  const summary = monthlySummary(householdId, period);
  const baselineIncome = (() => {
    const row = sqlite
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM transactions
          WHERE household_id = ? AND type = 'ingreso' AND date BETWEEN ? AND ?`,
      )
      .get(householdId, baselineStart, baselineEnd) as { total: number };
    return Math.round(row.total / monthsBack);
  })();

  return current
    .map((c) => {
      const baselineMinor = baselineMap.get(c.category_id ?? 'null') ?? 0;
      return {
        categoryId: c.category_id,
        categoryName: c.name,
        color: c.color,
        currentMinor: c.total,
        habitualMinor: c.habitual,
        baselineMinor,
        changePct:
          baselineMinor > 0
            ? Math.round(((c.habitual - baselineMinor) / baselineMinor) * 1000) / 10
            : null,
        shareOfIncomePct:
          summary.incomeMinor > 0
            ? Math.round((c.total / summary.incomeMinor) * 1000) / 10
            : null,
        baselineShareOfIncomePct:
          baselineIncome > 0
            ? Math.round((baselineMinor / baselineIncome) * 1000) / 10
            : null,
      };
    })
    .sort((a, b) => b.currentMinor - a.currentMinor);
}
