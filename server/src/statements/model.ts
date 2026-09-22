import type { ParsedStatement, StatementLine } from '../import/types.js';

export type Currency = 'ARS' | 'USD';
export interface Allocation {
  holder: string;
  amountMinor: number;
}
export interface LedgerLine extends StatementLine {
  id: string;
  treatment: 'allocate' | 'pending' | 'excluded';
  reason: string;
  allocations: Allocation[];
}
export interface StatementDocument {
  accountId: string;
  closeDate: string;
  dueDate: string;
  accountTail: string;
  balanceArsMinor: number;
  balanceUsdCents: number;
  previousArsMinor: number;
  previousUsdCents: number;
  dollarPayment: 'USD' | 'ARS';
  holders: ParsedStatement['holders'];
  lines: LedgerLine[];
  extractionWarnings: string[];
  reviewConfirmed: boolean;
}
export interface Settlement {
  id: string;
  holder: string;
  currency: Currency;
  amountMinor: number;
  kind: 'payment' | 'assumed';
  date: string;
  note: string;
}
export interface StatementRecord {
  id: string;
  revision: number;
  status: 'draft' | 'confirmed';
  document: StatementDocument;
  settlements: Settlement[];
  sourceName: string;
}
export const holderKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-AR');
export function proportionalAllocation(
  amount: number,
  weights: { holder: string; weight: number }[],
): Allocation[] {
  const positive = weights.filter((w) => Number.isSafeInteger(w.weight) && w.weight > 0);
  if (!positive.length || !Number.isSafeInteger(amount)) return [];
  const total = positive.reduce((s, w) => s + BigInt(w.weight), 0n);
  const magnitude = BigInt(Math.abs(amount));
  const parts = positive.map((w, i) => ({
    holder: w.holder,
    index: i,
    amount: (magnitude * BigInt(w.weight)) / total,
    remainder: (magnitude * BigInt(w.weight)) % total,
  }));
  let left = magnitude - parts.reduce((s, p) => s + p.amount, 0n);
  const order = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const p of order) {
    if (!left) break;
    p.amount++;
    left--;
  }
  return parts.map((p) => ({
    holder: p.holder,
    amountMinor: Number(p.amount) * Math.sign(amount),
  }));
}
export function validDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
}
export function fromParsed(p: ParsedStatement, warnings: string[] = []): StatementDocument {
  const holders = p.holders.map((h) => ({ ...h, holder: holderKey(h.holder) }));
  return {
    accountId: '',
    closeDate: p.closeDate,
    dueDate: p.dueDate,
    accountTail: p.accountTail ?? '',
    balanceArsMinor: p.balanceArsMinor,
    balanceUsdCents: p.balanceUsdCents,
    previousArsMinor: p.previousArsMinor,
    previousUsdCents: p.previousUsdCents,
    dollarPayment: 'USD',
    holders,
    extractionWarnings: [...warnings, ...p.warnings].slice(0, 100),
    reviewConfirmed: false,
    lines: p.lines.map((l, i) => ({
      ...l,
      id: `line-${i}`,
      holder: l.holder ? holderKey(l.holder) : null,
      treatment:
        l.kind === 'pago' || l.kind === 'credito_percepcion'
          ? 'excluded'
          : l.holder
            ? 'allocate'
            : 'pending',
      reason:
        l.kind === 'pago'
          ? 'Pago bancario del saldo anterior'
          : l.kind === 'credito_percepcion'
            ? 'Credito bancario de otro periodo; revisar destinatario'
            : '',
      allocations: l.holder ? [{ holder: holderKey(l.holder), amountMinor: l.amountMinor }] : [],
    })),
  };
}

export function summarize(doc: StatementDocument, settlements: Settlement[] = []) {
  const errors: string[] = [];
  const sum = (currency: Currency) =>
    doc.lines.filter((l) => l.currency === currency).reduce((s, l) => s + l.amountMinor, 0);
  const diffArs = doc.previousArsMinor + sum('ARS') - doc.balanceArsMinor;
  const diffUsd = doc.previousUsdCents + sum('USD') - doc.balanceUsdCents;
  if (!validDate(doc.closeDate) || !validDate(doc.dueDate) || doc.dueDate < doc.closeDate)
    errors.push('Revisa cierre y vencimiento.');
  if (!doc.accountId) errors.push('Selecciona una cuenta de tarjeta.');
  if (diffArs || diffUsd) errors.push('Los movimientos no coinciden con el saldo del banco.');
  const names = new Set(doc.holders.map((h) => holderKey(h.holder)));
  if (!names.size || names.size !== doc.holders.length)
    errors.push('Revisa las personas: faltan nombres o estan repetidos.');
  const rows = doc.holders.flatMap((h) =>
    (['ARS', 'USD'] as const).map((currency) => ({
      holder: h.holder,
      currency,
      consumption: 0,
      charges: 0,
      advances: 0,
      adjustments: 0,
      total: 0,
      paid: 0,
      assumed: 0,
      remaining: 0,
    })),
  );
  for (const h of doc.holders) {
    const own = doc.lines.filter(
      (l) => l.kind === 'consumo' && l.holder && holderKey(l.holder) === holderKey(h.holder),
    );
    if (
      own.filter((l) => l.currency === 'ARS').reduce((s, l) => s + l.amountMinor, 0) !==
        h.statedArsMinor ||
      own.filter((l) => l.currency === 'USD').reduce((s, l) => s + l.amountMinor, 0) !==
        h.statedUsdCents
    )
      errors.push(`No coincide el subtotal de ${h.holder}.`);
  }
  let pending = 0;
  for (const l of doc.lines) {
    if (!validDate(l.date) || l.date > doc.closeDate || !l.description.trim())
      errors.push(`Revisa fecha/detalle: ${l.description || l.id}.`);
    if (l.kind === 'desconocido') errors.push(`Clasifica el movimiento: ${l.description}.`);
    if (l.kind === 'consumo' && (!l.holder || !names.has(holderKey(l.holder))))
      errors.push(`Falta titular del consumo: ${l.description}.`);
    if (l.treatment === 'pending') {
      pending++;
      continue;
    }
    if (l.treatment === 'excluded') {
      if (!l.reason.trim()) errors.push(`Falta motivo de exclusion: ${l.description}.`);
      continue;
    }
    if (l.kind === 'pago') {
      errors.push('Los pagos bancarios no se cobran como consumos nuevos.');
      continue;
    }
    if (
      !l.allocations.length ||
      l.allocations.reduce((s, a) => s + a.amountMinor, 0) !== l.amountMinor
    )
      errors.push(`El reparto no suma el importe: ${l.description}.`);
    const allocated = new Set<string>();
    for (const a of l.allocations) {
      const key = holderKey(a.holder);
      if (
        allocated.has(key) ||
        !names.has(key) ||
        (a.amountMinor && Math.sign(a.amountMinor) !== Math.sign(l.amountMinor))
      )
        errors.push(`Reparto invalido: ${l.description}.`);
      allocated.add(key);
      const row = rows.find((r) => holderKey(r.holder) === key && r.currency === l.currency);
      if (!row) continue;
      row.total += a.amountMinor;
      if (l.kind === 'consumo') row.consumption += a.amountMinor;
      else if (l.kind === 'adelanto') row.advances += a.amountMinor;
      else if (a.amountMinor < 0) row.adjustments += a.amountMinor;
      else row.charges += a.amountMinor;
    }
  }
  for (const s of settlements) {
    const row = rows.find(
      (r) => holderKey(r.holder) === holderKey(s.holder) && r.currency === s.currency,
    );
    if (row) {
      if (s.kind === 'payment') row.paid += s.amountMinor;
      else row.assumed += s.amountMinor;
    }
  }
  for (const row of rows) row.remaining = row.total - row.paid - row.assumed;
  return { rows, errors: [...new Set(errors)], diffArs, diffUsd, pending };
}
