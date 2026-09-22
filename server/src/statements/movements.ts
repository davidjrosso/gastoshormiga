import { randomUUID } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { getRateForDate, householdRateType } from '../fx/rates.js';
import { normalizeMerchantName } from '../lib/money.js';
import { holderKey, type StatementDocument } from './model.js';

export class MovementError extends Error {}
export type MovementMapping = { holder: string; userId: string | null };

export function movementSettings(household: string) {
  return {
    users: sqlite.prepare('SELECT id, display_name AS name FROM users WHERE household_id = ? ORDER BY display_name').all(household),
    mappings: sqlite.prepare('SELECT holder, user_id AS userId FROM card_movement_users WHERE household_id = ?').all(household) as MovementMapping[],
  };
}

export function saveMovementMapping(household: string, doc: StatementDocument, mappings: MovementMapping[]) {
  const holders = new Set(doc.holders.map(h => holderKey(h.holder)));
  if (mappings.length !== holders.size || new Set(mappings.map(m => holderKey(m.holder))).size !== holders.size)
    throw new MovementError('Selecciona el usuario o Solo liquidacion para cada persona del resumen.');
  for (const mapping of mappings) {
    if (!holders.has(holderKey(mapping.holder))) throw new MovementError('Persona ajena al resumen.');
    if (mapping.userId && !sqlite.prepare('SELECT id FROM users WHERE id = ? AND household_id = ?').get(mapping.userId, household))
      throw new MovementError('El usuario seleccionado no pertenece a tu hogar.');
    sqlite.prepare(`INSERT INTO card_movement_users VALUES (?, ?, ?)
      ON CONFLICT(household_id, holder) DO UPDATE SET user_id = excluded.user_id`)
      .run(household, holderKey(mapping.holder), mapping.userId);
  }
}

// Caller owns an IMMEDIATE transaction, including statement confirmation/settings.
export function postStatementMovements(household: string, statementId: string, doc: StatementDocument, actor: string | null = null) {
  const settings = movementSettings(household);
  const users = new Map(settings.mappings.map(m => [holderKey(m.holder), m.userId]));
  if (!sqlite.prepare("SELECT id FROM accounts WHERE id = ? AND household_id = ? AND type = 'tarjeta' AND archived = 0").get(doc.accountId, household))
    throw new MovementError('La tarjeta del resumen no esta activa en tu hogar.');
  const selected = doc.lines.flatMap(line => {
    if (line.treatment !== 'allocate' || !['consumo', 'impuesto', 'interes', 'percepcion_recuperable'].includes(line.kind)) return [];
    return line.allocations.filter(a => users.get(holderKey(a.holder)) && a.amountMinor !== 0)
      .map(a => ({ line, holder: holderKey(a.holder), amount: a.amountMinor, userId: users.get(holderKey(a.holder))! }));
  });
  const existing = sqlite.prepare(`SELECT l.line_id, l.holder, t.paid_by_user_id FROM card_movement_links l
    JOIN transactions t ON t.id = l.transaction_id WHERE l.statement_id = ?`).all(statementId) as
    { line_id: string; holder: string; paid_by_user_id: string }[];
  for (const link of existing) {
    const match = selected.find(s => s.line.id === link.line_id && s.holder === link.holder);
    if (!match || match.userId !== link.paid_by_user_id)
      throw new MovementError('Ya hay movimientos vinculados a esa persona. No se puede cambiar su usuario ni excluirla desde aqui.');
  }
  let created = 0;
  for (const { line, holder, amount, userId } of selected) {
    if (existing.some(l => l.line_id === line.id && l.holder === holder)) continue;
    // Recognize the billed installment in this closing period, not in the original purchase year.
    const date = doc.closeDate;
    const normalized = normalizeMerchantName(line.description);
    let merchant = sqlite.prepare('SELECT id, default_category_id FROM merchants WHERE household_id = ? AND normalized_name = ?')
      .get(household, normalized) as { id: string; default_category_id: string | null } | undefined;
    const possibleDuplicate = sqlite.prepare(`SELECT t.id FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
      WHERE t.type = 'gasto' AND t.household_id = ? AND t.account_id = ? AND t.currency = ? AND t.amount_minor = ?
      AND t.date IN (?, ?) AND (m.normalized_name = ? OR t.note = ?)
      AND NOT EXISTS (SELECT 1 FROM card_movement_links l WHERE l.transaction_id = t.id) LIMIT 1`)
      .get(household, doc.accountId, line.currency, amount, date, line.date, normalized, line.description);
    if (possibleDuplicate) throw new MovementError(`Posible movimiento manual duplicado: ${line.description}. Revisa Movimientos antes de incorporar el resumen; no se incorporo ninguna fila nueva.`);
    if (!merchant) {
      merchant = { id: randomUUID(), default_category_id: null };
      sqlite.prepare('INSERT INTO merchants (id, household_id, name, normalized_name, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(merchant.id, household, line.description, normalized, Date.now());
    }
    const id = randomUUID();
    const note = `Resumen ${doc.closeDate} | ${holder} | Compra ${line.date}` +
      (line.installment ? ` | Cuota ${line.installment.n}/${line.installment.of}` : '');
    const category = merchant.default_category_id && sqlite.prepare('SELECT id FROM categories WHERE id = ? AND household_id = ?').get(merchant.default_category_id, household)
      ? merchant.default_category_id : null;
    sqlite.prepare(`INSERT INTO transactions (id, household_id, type, date, account_id, amount_minor, currency,
      category_id, merchant_id, note, paid_by_user_id, created_by_user_id, usd_rate_minor, created_at, updated_at)
      VALUES (?, ?, 'gasto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, household, date, doc.accountId, amount, line.currency, category, merchant.id, note, userId, actor,
        getRateForDate(householdRateType(household), date), Date.now(), Date.now());
    sqlite.prepare('INSERT INTO card_movement_links VALUES (?, ?, ?, ?)').run(statementId, line.id, holder, id);
    created++;
  }
  return { created, linked: existing.length + created };
}
