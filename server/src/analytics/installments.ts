import { sqlite } from '../db/index.js';
import { shiftPeriod, todayISO } from '../lib/money.js';
import type { StatementDocument } from '../statements/model.js';

/** A confirmed statement is a complete snapshot of a card's billed plans.
 * Using only its latest snapshot avoids fuzzy purchase matching and duplicate
 * forecasts. Projections never become transactions or change account balances. */
export function installmentForecast(household: string, period: string, months = 6, paidBy?: string) {
  const rows = sqlite.prepare(`SELECT s.id, s.document_json, a.name AS accountName
    FROM card_statements s JOIN accounts a ON a.id = s.account_id AND a.household_id = s.household_id
    WHERE s.household_id = ? AND s.status = 'confirmed'
    AND NOT EXISTS (SELECT 1 FROM card_statements newer
      WHERE newer.household_id = s.household_id AND newer.account_id = s.account_id
      AND newer.status = 'confirmed' AND newer.close_date > s.close_date)
    ORDER BY a.name, s.id`).all(household) as { id: string; document_json: string; accountName: string }[];
  const links = sqlite.prepare(`SELECT l.statement_id, l.line_id, t.amount_minor, t.currency,
    t.paid_by_user_id AS userId, u.display_name AS userName
    FROM card_movement_links l JOIN transactions t ON t.id = l.transaction_id
    JOIN card_statements s ON s.id = l.statement_id
    LEFT JOIN users u ON u.id = t.paid_by_user_id AND u.household_id = t.household_id
    WHERE t.household_id = ? AND s.household_id = ?`).all(household, household) as {
      statement_id: string; line_id: string; amount_minor: number; currency: 'ARS' | 'USD'; userId: string; userName: string | null;
    }[];
  const sources = rows.map(row => {
    const doc = JSON.parse(row.document_json) as StatementDocument;
    return { ...row, doc, linked: links.filter(l => l.statement_id === row.id) };
  });
  // A recent completed month is an explicit reference, not a promised salary.
  const referenceBefore = period < todayISO().slice(0, 7) ? period : todayISO().slice(0, 7);
  const incomeReference = sqlite.prepare(`SELECT substr(date,1,7) AS period, SUM(amount_minor) AS amountMinor
    FROM transactions WHERE household_id = ? AND type = 'ingreso' AND currency = 'ARS'
    AND date >= ? AND date < ? AND (? IS NULL OR paid_by_user_id = ?)
    GROUP BY substr(date,1,7) HAVING SUM(amount_minor) > 0 ORDER BY period DESC LIMIT 1`)
    .get(household, `${shiftPeriod(referenceBefore, 3)}-01`, `${referenceBefore}-01`, paidBy ?? null, paidBy ?? null) as
      { period: string; amountMinor: number } | undefined;
  const forecast = Array.from({ length: months }, (_, index) => {
    const target = shiftPeriod(period, -index);
    const items = sources.flatMap(source => {
      const closePeriod = source.doc.closeDate.slice(0, 7);
      const [year, month] = target.split('-').map(Number);
      const [closeYear, closeMonth] = closePeriod.split('-').map(Number);
      const offset = (year - closeYear) * 12 + month - closeMonth;
      if (offset <= 0) return [];
      return source.doc.lines.flatMap(line => {
        const quota = line.installment;
        if (line.kind !== 'consumo' || line.treatment !== 'allocate' || !quota || quota.n + offset > quota.of) return [];
        return source.linked.filter(l => l.line_id === line.id && l.amount_minor > 0 && (!paidBy || l.userId === paidBy))
          .map(l => ({
            statementId: source.id, lineId: line.id, accountName: source.accountName,
            description: line.description, userId: l.userId, userName: l.userName,
            amountMinor: l.amount_minor, currency: l.currency,
            n: quota.n + offset, of: quota.of,
            lastPeriod: shiftPeriod(closePeriod, -(quota.of - quota.n)),
          }));
      });
    });
    const arsMinor = items.filter(i => i.currency === 'ARS').reduce((sum, i) => sum + i.amountMinor, 0);
    const usdCents = items.filter(i => i.currency === 'USD').reduce((sum, i) => sum + i.amountMinor, 0);
    return { period: target, arsMinor, usdCents, items,
      shareOfIncomePct: incomeReference ? Math.round(arsMinor / incomeReference.amountMinor * 1000) / 10 : null };
  });
  return {
    incomeReference: incomeReference ?? null,
    sources: sources.map(s => ({ statementId: s.id, accountName: s.accountName, closeDate: s.doc.closeDate,
      dueDate: s.doc.dueDate, hasHouseholdMovements: s.linked.length > 0 })),
    months: forecast,
  };
}
