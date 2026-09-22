import { randomUUID } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { postStatementMovements, saveMovementMapping, type MovementMapping } from './movements.js';
import {
  holderKey,
  summarize,
  type StatementDocument,
  type StatementRecord,
  type Settlement,
} from './model.js';

export class LedgerError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
interface Row {
  id: string;
  document_json: string;
  revision: number;
  status: 'draft' | 'confirmed';
  source_name: string;
}
export function getStatement(household: string, id: string): StatementRecord {
  const row = sqlite
    .prepare('SELECT * FROM card_statements WHERE id = ? AND household_id = ?')
    .get(id, household) as Row | undefined;
  if (!row) throw new LedgerError('Resumen no encontrado.', 404);
  const settlements = sqlite
    .prepare(
      'SELECT id, holder, currency, amount_minor AS amountMinor, kind, date, note FROM card_settlements WHERE statement_id = ? ORDER BY date, created_at',
    )
    .all(id) as Settlement[];
  return {
    id,
    document: JSON.parse(row.document_json),
    status: row.status,
    revision: row.revision,
    sourceName: row.source_name,
    settlements,
  };
}
export function listStatements(household: string) {
  return (
    sqlite
      .prepare(
        'SELECT id FROM card_statements WHERE household_id = ? ORDER BY created_at DESC LIMIT 100',
      )
      .all(household) as { id: string }[]
  ).map((r) => {
    const v = getStatement(household, r.id);
    return {
      id: v.id,
      status: v.status,
      closeDate: v.document.closeDate,
      sourceName: v.sourceName,
      summary: summarize(v.document, v.settlements),
    };
  });
}
export function createDraft(
  household: string,
  hash: string,
  source: string,
  document: StatementDocument,
) {
  return sqlite
    .transaction(() => {
      const existing = sqlite
        .prepare('SELECT id FROM card_statements WHERE household_id = ? AND source_hash = ?')
        .get(household, hash) as { id: string } | undefined;
      if (existing) return { record: getStatement(household, existing.id), duplicate: true };
      const id = randomUUID();
      sqlite
        .prepare(
          `INSERT INTO card_statements (id, household_id, source_hash, source_name, status, document_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
        )
        .run(id, household, hash, source, JSON.stringify(document), Date.now(), Date.now());
      return { record: getStatement(household, id), duplicate: false };
    })
    .immediate();
}
export function saveStatement(
  household: string,
  id: string,
  revision: number,
  document: StatementDocument,
  confirm: boolean,
  actor: string | null = null,
) {
  return sqlite
    .transaction(() => {
      const old = getStatement(household, id);
      if (old.revision !== revision)
        throw new LedgerError('El resumen cambio en otra ventana. Recarga antes de guardar.', 409);
      if (old.status === 'confirmed')
        throw new LedgerError(
          'El resumen ya esta confirmado. Sus importes no se pueden reemplazar.',
          409,
        );
      if (document.accountId) {
        const account = sqlite
          .prepare(
            "SELECT id FROM accounts WHERE id = ? AND household_id = ? AND type = 'tarjeta' AND archived = 0",
          )
          .get(document.accountId, household);
        if (!account) throw new LedgerError('Selecciona una tarjeta activa de tu hogar.');
      }
      if (confirm) {
        const summary = summarize(document);
        if (summary.errors.length) throw new LedgerError(summary.errors.join(' '));
        if (summary.pending)
          throw new LedgerError(
            `Hay ${summary.pending} movimientos pendientes de asignar o excluir.`,
          );
        if (!document.reviewConfirmed)
          throw new LedgerError('Confirma la revision del resumen y de los cargos excluidos.');
        const duplicate = sqlite
          .prepare(
            "SELECT id FROM card_statements WHERE household_id = ? AND account_id = ? AND close_date = ? AND status = 'confirmed'",
          )
          .get(household, document.accountId, document.closeDate);
        if (duplicate)
          throw new LedgerError(
            'Esta tarjeta ya tiene un resumen confirmado con el mismo cierre.',
            409,
          );
      }
      sqlite
        .prepare(
          `UPDATE card_statements SET document_json = ?, account_id = ?, close_date = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(document),
          document.accountId || null,
          document.closeDate,
          confirm ? 'confirmed' : 'draft',
          Date.now(),
          id,
        );
      if (confirm) postStatementMovements(household, id, document, actor);
      return getStatement(household, id);
    })
    .immediate();
}
export function configureMovements(household: string, id: string, mappings: MovementMapping[], actor: string) {
  return sqlite.transaction(() => {
    const record = getStatement(household, id);
    saveMovementMapping(household, record.document, mappings);
    if (record.status !== 'confirmed') return { created: 0, linked: 0, deferred: true };
    return { ...postStatementMovements(household, id, record.document, actor), deferred: false };
  }).immediate();
}
export function addSettlement(household: string, id: string, entry: Settlement) {
  return sqlite
    .transaction(() => {
      const record = getStatement(household, id);
      if (record.status !== 'confirmed') throw new LedgerError('Primero confirma el resumen.');
      const existing = record.settlements.find((s) => s.id === entry.id);
      if (existing) {
        if (
          holderKey(existing.holder) !== holderKey(entry.holder) ||
          existing.currency !== entry.currency ||
          existing.amountMinor !== entry.amountMinor ||
          existing.kind !== entry.kind ||
          existing.date !== entry.date ||
          existing.note !== entry.note
        )
          throw new LedgerError('La operacion ya existe con otros datos.', 409);
        return record;
      }
      const row = summarize(record.document, record.settlements).rows.find(
        (r) => holderKey(r.holder) === holderKey(entry.holder) && r.currency === entry.currency,
      );
      if (!row || entry.amountMinor > row.remaining)
        throw new LedgerError('El importe supera el saldo pendiente de esa persona y moneda.');
      if (entry.date < record.document.closeDate)
        throw new LedgerError('La fecha no puede ser anterior al cierre.');
      if (sqlite.prepare('SELECT id FROM card_settlements WHERE id = ?').get(entry.id))
        throw new LedgerError('Identificador de operacion ya utilizado.', 409);
      sqlite
        .prepare('INSERT INTO card_settlements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          entry.id,
          id,
          row.holder,
          entry.currency,
          entry.amountMinor,
          entry.kind,
          entry.date,
          entry.note,
          Date.now(),
        );
      return getStatement(household, id);
    })
    .immediate();
}
export function removeSettlement(household: string, id: string, settlementId: string) {
  return sqlite
    .transaction(() => {
      getStatement(household, id);
      sqlite
        .prepare('DELETE FROM card_settlements WHERE statement_id = ? AND id = ?')
        .run(id, settlementId);
      return getStatement(household, id);
    })
    .immediate();
}
