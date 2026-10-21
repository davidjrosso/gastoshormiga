import { z } from 'zod';
import { sqlite } from './db/index.js';
import { installmentEventKeys, purchaseKey, habitualExpenseSql } from './events.js';
import { normalizeMerchantName, periodRange } from './lib/money.js';
import type { LedgerLine, StatementDocument } from './statements/model.js';

const label = z.string().trim().max(160);
const itemSchema = z.object({
  concept: label, recipient: label, categoryId: z.string().nullable(),
  quantity: z.number().finite().positive().max(1e9).nullable().default(null),
  unit: z.string().trim().max(30).default(''),
}).strict();
export const expenseSchema = itemSchema.extend({
  reviewed: z.boolean(),
  parts: z.array(itemSchema.extend({ amountMinor: z.number().int().safe().positive() })).max(50).default([]),
}).strict();
export type ExpenseDetails = z.infer<typeof expenseSchema>;
export class ExpenseError extends Error {}

export function categoryUsedByExpenses(household: string, categoryId: string) {
  const rows = sqlite.prepare(`SELECT d.data_json FROM expense_details d JOIN transactions t ON t.id=d.transaction_id WHERE t.household_id=?
    UNION ALL SELECT data_json FROM card_concept_rules WHERE household_id=?`).all(household,household) as {data_json:string}[];
  return rows.some(r=>{const d=JSON.parse(r.data_json) as ExpenseDetails;return d.categoryId===categoryId||d.parts.some(p=>p.categoryId===categoryId);});
}

// This is a suggestion only: historical categories and descriptions stay untouched.
export function legacyRecipient(name: string | null) {
  return name?.match(/^Hij[oa]\s+(.+)$/i)?.[1] ?? (/\bFlor$/i.test(name ?? '') ? 'Flor' : '');
}
export function expenseDetails(id: string, categoryId: string | null, categoryName: string | null, merchant: string | null): ExpenseDetails {
  const stored = sqlite.prepare('SELECT data_json FROM expense_details WHERE transaction_id=?').get(id) as { data_json: string } | undefined;
  if (stored) return JSON.parse(stored.data_json);
  const recipient = legacyRecipient(categoryName);
  return { concept: merchant ?? '', recipient, categoryId: recipient ? null : categoryId,
    quantity: null, unit: '', reviewed: false, parts: [] };
}
export function validateExpense(household: string, details: ExpenseDetails, amountMinor: number) {
  if (details.reviewed && !details.concept) throw new ExpenseError('Indicá qué compraste o pagaste.');
  for (const item of [details, ...details.parts]) {
    if (item.categoryId && !sqlite.prepare("SELECT 1 FROM categories WHERE id=? AND household_id=? AND kind='gasto'").get(item.categoryId, household))
      throw new ExpenseError('La categoría debe pertenecer a tu hogar.');
  }
  if (details.parts.length) {
    if (details.parts.length < 2 || details.parts.some(p => !p.concept)) throw new ExpenseError('El desglose necesita al menos dos conceptos.');
    const total = details.parts.reduce((sum, p) => sum + BigInt(p.amountMinor), 0n);
    if (total !== BigInt(amountMinor)) throw new ExpenseError('Los importes del desglose deben sumar exactamente el total del gasto.');
  }
}
function writeDetails(id: string, details: ExpenseDetails) {
  sqlite.prepare(`INSERT INTO expense_details VALUES (?,?,?) ON CONFLICT(transaction_id)
    DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at`).run(id, JSON.stringify(details), Date.now());
}
// Caller owns the transaction; rules never copy billed amounts or a split to other installments.
export function saveExpense(household: string, id: string, details: ExpenseDetails, allInstallments = false) {
  const tx = sqlite.prepare("SELECT amount_minor FROM transactions WHERE id=? AND household_id=? AND type='gasto'").get(id, household) as { amount_minor: number } | undefined;
  if (!tx) throw new ExpenseError('Seleccioná un gasto de tu hogar.');
  validateExpense(household, details, tx.amount_minor);
  writeDetails(id, details);
  if (allInstallments) {
    if (details.parts.length || details.quantity !== null) throw new ExpenseError('Aplicá a otras cuotas solo concepto, categoría y destinatario, sin cantidades ni desglose.');
    const keys = installmentEventKeys(household), key = keys.get(id);
    if (!key) throw new ExpenseError('No se puede identificar esta compra en cuotas con certeza.');
    for (const [other, otherKey] of keys) if (otherKey === key) writeDetails(other, details);
    sqlite.prepare(`INSERT INTO card_concept_rules VALUES (?,?,?) ON CONFLICT(household_id,purchase_key)
      DO UPDATE SET data_json=excluded.data_json`).run(household, key, JSON.stringify(details));
  }
}
export function inheritedConcept(household: string, doc: StatementDocument, line: LedgerLine, holder: string): ExpenseDetails | null {
  const key = purchaseKey(doc, line, holder);
  if (!key) return null;
  const row = sqlite.prepare('SELECT data_json FROM card_concept_rules WHERE household_id=? AND purchase_key=?').get(household, key) as { data_json: string } | undefined;
  return row ? JSON.parse(row.data_json) : null;
}

export function expenseOptions(household: string) {
  const rows = sqlite.prepare(`SELECT d.data_json FROM expense_details d JOIN transactions t ON t.id=d.transaction_id
    WHERE t.household_id=? ORDER BY d.updated_at DESC`).all(household) as { data_json: string }[];
  const concepts = new Map<string, { concept: string; categoryId: string | null }>();
  const recipients = new Set<string>(['Hogar']);
  for (const r of sqlite.prepare('SELECT display_name AS name FROM users WHERE household_id=?').all(household) as { name: string }[]) recipients.add(r.name);
  for (const r of sqlite.prepare('SELECT name FROM categories WHERE household_id=?').all(household) as { name: string }[]) {
    const name = legacyRecipient(r.name); if (name) recipients.add(name);
  }
  for (const row of rows) {
    const d = JSON.parse(row.data_json) as ExpenseDetails;
    for (const p of [d, ...d.parts]) {
      if (p.recipient) recipients.add(p.recipient);
      const key = normalizeMerchantName(p.concept);
      if (d.reviewed && key && !concepts.has(key)) concepts.set(key, { concept: p.concept, categoryId: p.categoryId });
    }
  }
  return { concepts: [...concepts.values()].sort((a,b) => a.concept.localeCompare(b.concept, 'es')),
    recipients: [...recipients].sort((a,b) => a.localeCompare(b,'es')) };
}

export function expenseOverview(household: string, period: string, currency: 'ARS' | 'USD', basis: 'booked' | 'consumed') {
  const { start, end } = periodRange(period);
  const rows = sqlite.prepare(`SELECT t.id,t.date,t.amount_minor AS amountMinor,t.category_id AS categoryId,
    c.name AS categoryName,m.name AS merchantName,t.paid_by_user_id AS paidByUserId,u.display_name AS paidByName,
    l.line_id,l.statement_id AS statementId,s.document_json,${habitualExpenseSql} AS habitual
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id AND c.household_id=t.household_id
    LEFT JOIN merchants m ON m.id=t.merchant_id AND m.household_id=t.household_id
    LEFT JOIN users u ON u.id=t.paid_by_user_id AND u.household_id=t.household_id
    LEFT JOIN card_movement_links l ON l.transaction_id=t.id
    LEFT JOIN card_statements s ON s.id=l.statement_id AND s.household_id=t.household_id
    WHERE t.household_id=? AND t.type='gasto' AND t.currency=? ORDER BY t.date DESC,t.id`).all(household, currency) as {
      id: string; date: string; amountMinor: number; categoryId: string | null; categoryName: string | null;
      merchantName: string | null; paidByUserId: string | null; paidByName: string | null;
      line_id: string | null; statementId: string | null; document_json: string | null; habitual: number;
    }[];
  const categories = new Map((sqlite.prepare('SELECT id,name FROM categories WHERE household_id=?').all(household) as { id: string; name: string }[]).map(c => [c.id,c.name]));
  const docs = new Map<string, StatementDocument>();
  let excludedInstallments = 0;
  const items = rows.flatMap(t => {
    let line: LedgerLine | undefined;
    if (t.statementId && t.document_json) {
      if (!docs.has(t.statementId)) docs.set(t.statementId, JSON.parse(t.document_json));
      line = docs.get(t.statementId)!.lines.find(l => l.id === t.line_id);
    }
    if (basis === 'consumed' && line?.installment) {
      if (t.date >= start && t.date <= end) excludedInstallments++;
      return [];
    }
    const date = basis === 'consumed' && line?.kind === 'consumo' ? line.date : t.date;
    if (date < start || date > end) return [];
    const d = expenseDetails(t.id, t.categoryId, t.categoryName, t.merchantName);
    const parts = d.parts.length ? d.parts : [{ ...d, amountMinor: t.amountMinor }];
    return parts.map(p => ({ transactionId: t.id, date, bookedDate: t.date, purchaseDate: line?.date ?? t.date,
      concept: p.concept || 'Sin identificar', recipient: p.recipient || 'Sin asignar', categoryId: p.categoryId,
      categoryName: categories.get(p.categoryId ?? '') ?? 'Sin categoría', amountMinor: p.amountMinor,
      quantity: p.quantity, unit: p.unit, reviewed: d.reviewed,
      needsReview: !d.reviewed || !p.concept || !p.categoryId || !p.recipient,
      statementId: t.statementId, originalDescription: line?.description ?? t.merchantName,
      originalCategory: t.categoryName, installment: line?.installment ?? null,
      paidBy: t.paidByName ?? 'Sin asignar', habitual: !!t.habitual }));
  });
  const group = (field: 'concept' | 'recipient' | 'categoryName' | 'paidBy', habitualOnly = false) => {
    const groups = new Map<string, { name: string; amountMinor: number; ids: Set<string> }>();
    for (const item of items) {
      if (habitualOnly && !item.habitual) continue;
      const name = item[field], key = normalizeMerchantName(name);
      const g = groups.get(key) ?? { name, amountMinor: 0, ids: new Set<string>() };
      g.amountMinor += item.amountMinor; g.ids.add(item.transactionId); groups.set(key,g);
    }
    return [...groups.values()].map(g => ({ name: g.name, amountMinor: g.amountMinor, count: g.ids.size }))
      .sort((a,b) => b.amountMinor-a.amountMinor || a.name.localeCompare(b.name,'es'));
  };
  const coverage = sqlite.prepare(`SELECT substr(t.date,1,7) AS period,
    SUM(CASE WHEN l.transaction_id IS NULL THEN 1 ELSE 0 END) AS manual,
    SUM(CASE WHEN l.transaction_id IS NOT NULL THEN 1 ELSE 0 END) AS card
    FROM transactions t LEFT JOIN card_movement_links l ON l.transaction_id=t.id
    WHERE t.household_id=? AND t.type='gasto' AND t.date<=? GROUP BY 1 ORDER BY 1 DESC LIMIT 4`).all(household,end);
  const balances = sqlite.prepare(`SELECT currency,
    SUM(CASE WHEN type='ingreso' THEN amount_minor ELSE 0 END) AS incomeMinor,
    SUM(CASE WHEN type='gasto' THEN amount_minor ELSE 0 END) AS expenseMinor
    FROM transactions WHERE household_id=? AND date BETWEEN ? AND ? AND type IN ('gasto','ingreso') GROUP BY currency`).all(household,start,end);
  return { period,currency,basis,items, totalMinor: items.reduce((s,i) => s+i.amountMinor,0),
    count: new Set(items.map(i => i.transactionId)).size,
    pending: new Set(items.filter(i => i.needsReview).map(i => i.transactionId)).size,
    categories: group('categoryName'), concepts: group('concept'), recipients: group('recipient'), payers: group('paidBy'),
    repeated: group('concept',true).filter(g => g.count > 1 && g.name !== 'Sin identificar'),
    excludedInstallments,coverage,balances };
}
