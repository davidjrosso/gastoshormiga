import { sqlite } from './db/index.js';
import { normalizeMerchantName } from './lib/money.js';
import { holderKey, type LedgerLine, type StatementDocument } from './statements/model.js';

export class EventError extends Error {}

/** Exact bank identity only. Ambiguous lines or missing coupons require manual labels. */
export function purchaseKey(doc: StatementDocument, line: LedgerLine, allocationHolder: string): string | null {
  const identity = (l: LedgerLine) => JSON.stringify([doc.accountId, holderKey(l.holder ?? ''), l.date,
    l.coupon?.trim(), normalizeMerchantName(l.description), l.currency, l.installment?.of]);
  if (line.kind !== 'consumo' || !line.installment || !line.coupon?.trim() || !line.holder) return null;
  const key = identity(line);
  if (doc.lines.filter(l => l.kind === 'consumo' && l.installment && identity(l) === key).length !== 1) return null;
  return JSON.stringify([key, holderKey(allocationHolder)]);
}

export function installmentEventKeys(household: string) {
  const rows = sqlite.prepare(`SELECT l.transaction_id, l.line_id, l.holder, s.id, s.document_json
    FROM card_movement_links l JOIN card_statements s ON s.id=l.statement_id
    JOIN transactions t ON t.id=l.transaction_id
    WHERE s.household_id=? AND t.household_id=? AND s.status='confirmed'`).all(household, household) as
    { transaction_id: string; line_id: string; holder: string; id: string; document_json: string }[];
  const docs = new Map<string, StatementDocument>();
  return new Map(rows.map(r => {
    if (!docs.has(r.id)) docs.set(r.id, JSON.parse(r.document_json) as StatementDocument);
    const doc = docs.get(r.id)!;
    const line = doc.lines.find(l => l.id === r.line_id);
    return [r.transaction_id, line ? purchaseKey(doc, line, r.holder) : null];
  }));
}

export function inheritedEvent(household: string, doc: StatementDocument, line: LedgerLine, holder: string) {
  const key = purchaseKey(doc, line, holder);
  return key ? (sqlite.prepare(`SELECT r.event_id FROM card_event_rules r JOIN events e ON e.id=r.event_id
    WHERE r.household_id=? AND e.household_id=? AND r.purchase_key=?`).get(household, household, key) as
    { event_id: string } | undefined)?.event_id ?? null : null;
}

export function validateEvent(household: string, eventId: string | null, currentId?: string | null) {
  if (eventId === null) return;
  const event = sqlite.prepare('SELECT archived FROM events WHERE id=? AND household_id=?').get(eventId, household) as
    { archived: number } | undefined;
  if (!event || (event.archived && eventId !== currentId)) throw new EventError('Elegí un evento activo de tu hogar.');
}

export function setTransactionEvent(transactionId: string, eventId: string | null) {
  if (eventId === null) sqlite.prepare('DELETE FROM event_transactions WHERE transaction_id=?').run(transactionId);
  else sqlite.prepare(`INSERT INTO event_transactions(transaction_id,event_id) VALUES (?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET event_id=excluded.event_id`).run(transactionId, eventId);
}

/** Entire batch and any future-installment rule are committed together. */
export function assignEvent(household: string, ids: string[], eventId: string | null, allInstallments = false) {
  return sqlite.transaction(() => {
    validateEvent(household, eventId);
    const selected = new Set(ids);
    for (const id of selected) {
      if (!sqlite.prepare("SELECT 1 FROM transactions WHERE id=? AND household_id=? AND type='gasto'").get(id, household))
        throw new EventError('Seleccioná solamente gastos de tu hogar. No se cambió ningún movimiento.');
    }
    if (allInstallments) {
      const keys = installmentEventKeys(household);
      const selectedKeys = new Set<string>();
      for (const id of selected) {
        const key = keys.get(id);
        if (!key) throw new EventError('No se puede identificar con certeza esta compra en cuotas. Aplicá el evento solo a los movimientos seleccionados.');
        selectedKeys.add(key);
      }
      for (const [id, key] of keys) if (key && selectedKeys.has(key)) selected.add(id);
      for (const key of selectedKeys) {
        if (eventId === null) sqlite.prepare('DELETE FROM card_event_rules WHERE household_id=? AND purchase_key=?').run(household, key);
        else sqlite.prepare(`INSERT INTO card_event_rules VALUES (?,?,?)
          ON CONFLICT(household_id,purchase_key) DO UPDATE SET event_id=excluded.event_id`).run(household, key, eventId);
      }
    }
    for (const id of selected) setTransactionEvent(id, eventId);
    return { updated: selected.size };
  }).immediate();
}

/** Only habits/comparisons use this predicate. Balances and commitments never do. */
export const habitualExpenseSql = `NOT EXISTS (SELECT 1 FROM event_transactions et
  JOIN events e ON e.id=et.event_id WHERE et.transaction_id=t.id
  AND e.household_id=t.household_id AND e.extraordinary=1)`;
