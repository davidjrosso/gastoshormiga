import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { makeHousehold, makeSession, sqlite } from './harness.js';
import { parseBbvaVisa, parseFecha } from '../src/import/bbva-visa.js';
import {
  fromParsed,
  summarize,
  proportionalAllocation,
  type Settlement,
} from '../src/statements/model.js';
import { runMigrations } from '../src/db/migrate.js';
import Database from 'better-sqlite3';
import {
  createDraft,
  saveStatement,
  getStatement,
  addSettlement,
  removeSettlement,
} from '../src/statements/repository.js';
import { statementRoutes } from '../src/routes/statements.js';

const source = readFileSync(new URL('./fixtures/bbva-visa.txt', import.meta.url), 'utf8');
function fixture() {
  const f = makeHousehold();
  sqlite.prepare("UPDATE accounts SET type = 'tarjeta' WHERE id = ?").run(f.accountId);
  const doc = fromParsed(parseBbvaVisa(source));
  doc.accountId = f.accountId;
  const result = createDraft(f.householdId, randomUUID(), 'synthetic.pdf', doc);
  return { ...f, doc, record: result.record };
}
function ready() {
  const f = fixture();
  for (const line of f.doc.lines)
    if (line.treatment === 'pending') {
      line.treatment = 'allocate';
      line.allocations = [{ holder: f.doc.holders[0].holder, amountMinor: line.amountMinor }];
    }
  f.doc.reviewConfirmed = true;
  return f;
}
test('blank input and impossible dates are not valid statements', () => {
  assert.equal(parseBbvaVisa('').check.ok, false);
  assert.equal(parseBbvaVisa('Otro documento').check.ok, false);
  assert.equal(parseFecha('31-Feb-26'), null);
  assert.equal(parseFecha('29-Feb-24'), '2024-02-29');
  assert.equal(parseFecha('00-Ago-26'), null);
});

test('rejects another branch schema with the same migration number', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('user_version = 3');
    assert.throws(() => runMigrations(db), /otra rama/);
    assert.equal(db.pragma('user_version', { simple: true }), 3);
  } finally { db.close(); }
});
test('proportional allocations preserve cents, signs and deterministic ties', () => {
  const weights = [
    { holder: 'A', weight: 1 },
    { holder: 'B', weight: 1 },
    { holder: 'C', weight: 1 },
  ];
  assert.deepEqual(
    proportionalAllocation(100, weights).map((a) => a.amountMinor),
    [34, 33, 33],
  );
  assert.deepEqual(
    proportionalAllocation(-100, weights).map((a) => a.amountMinor),
    [-34, -33, -33],
  );
  assert.deepEqual(proportionalAllocation(100, [{ holder: 'A', weight: 0 }]), []);
});
test('migration v2 to v3 preserves previous data and is repeatable', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE card_settlements; DROP TABLE card_statements; PRAGMA user_version=2;');
    db.prepare('INSERT INTO households (id,name) VALUES (?,?)').run('test', 'Existing household');
    db.prepare(
      "INSERT INTO accounts (id,household_id,name,type) VALUES ('a','test','Card','tarjeta')",
    ).run();
    db.prepare(
      "INSERT INTO transactions (id,household_id,type,date,account_id,amount_minor) VALUES ('t','test','gasto','2026-01-02','a',12345)",
    ).run();
    const before = db.prepare('SELECT * FROM transactions').all();
    assert.deepEqual(runMigrations(db), { from: 2, to: 3 });
    assert.deepEqual(db.prepare('SELECT * FROM transactions').all(), before);
    assert.deepEqual(runMigrations(db), { from: 3, to: 3 });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
  }
});
test('supports a horizontal header and barcode preceding a dated charge', () => {
  const text = source
    .replace(
      /CIERRE ACTUAL\n27-Ago-26VENCIMIENTO ACTUAL\n07-Sep-26SALDO ACTUAL \$\n161.910,50SALDO ACTUAL U\$S\n35,00PAGO MÍNIMO \$\n30.000,00/,
      'CIERRE ACTUAL VENCIMIENTO ACTUAL SALDO ACTUAL $ SALDO ACTUAL U$S PAGO MINIMO $\n27-Ago-26 07-Sep-26 161.910,50 35,00 30.000,00',
    )
    .replace('27-Ago-26 INTERESES', 'Ëjj 27-Ago-26 INTERESES');
  assert.equal(parseBbvaVisa(text).check.ok, true);
});
test('keeps all holders, foreign currency, installments and unresolved taxes', () => {
  const f = fixture();
  const s = summarize(f.doc);
  assert.equal(s.diffArs, 0);
  assert.equal(s.diffUsd, 0);
  assert.ok(s.pending > 0);
  assert.equal(
    s.rows.find((r) => r.holder === 'ANA GOMEZ' && r.currency === 'ARS')?.remaining,
    800000,
  );
  assert.equal(
    s.rows.find((r) => r.holder === 'ANA GOMEZ' && r.currency === 'USD')?.remaining,
    500,
  );
  assert.ok(f.doc.lines.some((l) => l.date === '2026-06-10' && l.installment?.n === 3));
  assert.equal(f.doc.lines.find((l) => l.kind === 'percepcion_recuperable')?.treatment, 'pending');
  assert.equal(f.doc.lines.find((l) => l.kind === 'pago')?.treatment, 'excluded');
});
test('does not persist partial confirmations, wrong totals or an unresolved allocation', () => {
  const f = fixture();
  assert.throws(() => saveStatement(f.householdId, f.record.id, 1, f.doc, true), /pendientes/);
  assert.equal(getStatement(f.householdId, f.record.id).revision, 1);
  f.doc.lines[5].amountMinor++;
  assert.throws(() => saveStatement(f.householdId, f.record.id, 1, f.doc, true), /no coinciden/);
  assert.equal(
    (
      sqlite
        .prepare('SELECT count(*) as n FROM card_settlements WHERE statement_id = ?')
        .get(f.record.id) as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      sqlite
        .prepare('SELECT count(*) as n FROM transactions WHERE household_id = ?')
        .get(f.householdId) as { n: number }
    ).n,
    0,
  );
});
test('same document returns same draft; same card and closing cannot be imported twice', () => {
  const f = ready();
  const first = createDraft(f.householdId, 'same-hash', 'one.pdf', f.doc);
  const repeat = createDraft(f.householdId, 'same-hash', 'renamed.pdf', f.doc);
  assert.equal(repeat.duplicate, true);
  assert.equal(first.record.id, repeat.record.id);
  saveStatement(f.householdId, f.record.id, 1, f.doc, true);
  assert.throws(
    () => saveStatement(f.householdId, first.record.id, 1, f.doc, true),
    /mismo cierre/,
  );
  assert.equal(getStatement(f.householdId, first.record.id).status, 'draft');
});
test('optimistic locking and household ownership for drafts and accounts', () => {
  const f = ready();
  const other = ready();
  assert.throws(() => getStatement(other.householdId, f.record.id), /no encontrado/);
  assert.throws(
    () =>
      saveStatement(f.householdId, f.record.id, 1, { ...f.doc, accountId: other.accountId }, true),
    /tu hogar/,
  );
  saveStatement(f.householdId, f.record.id, 1, f.doc, false);
  assert.throws(() => saveStatement(f.householdId, f.record.id, 1, f.doc, true), /otra ventana/);
});
test('partial payments and assumed amounts are distinct and idempotent', () => {
  const f = ready();
  saveStatement(f.householdId, f.record.id, 1, f.doc, true);
  const payment: Settlement = {
    id: randomUUID(),
    holder: 'ANA GOMEZ',
    currency: 'ARS',
    amountMinor: 250000,
    kind: 'payment',
    date: '2026-09-01',
    note: 'Transferencia',
  };
  addSettlement(f.householdId, f.record.id, payment);
  addSettlement(f.householdId, f.record.id, payment);
  const r = addSettlement(f.householdId, f.record.id, {
    ...payment,
    id: randomUUID(),
    amountMinor: 100000,
    kind: 'assumed',
    note: 'Asumido',
  });
  const row = summarize(r.document, r.settlements).rows.find(
    (r) => r.holder === 'ANA GOMEZ' && r.currency === 'ARS',
  )!;
  assert.equal(row.total, 800000);
  assert.equal(row.paid, 250000);
  assert.equal(row.assumed, 100000);
  assert.equal(row.remaining, 450000);
  assert.equal(r.settlements.length, 2);
  assert.throws(
    () =>
      addSettlement(f.householdId, f.record.id, {
        ...payment,
        id: randomUUID(),
        amountMinor: 450001,
      }),
    /supera/,
  );
  assert.throws(
    () =>
      addSettlement(f.householdId, f.record.id, {
        ...payment,
        id: randomUUID(),
        currency: 'USD',
        amountMinor: 501,
      }),
    /supera/,
  );
  const undone = removeSettlement(f.householdId, f.record.id, payment.id);
  assert.equal(
    summarize(undone.document, undone.settlements).rows.find(
      (r) => r.holder === 'ANA GOMEZ' && r.currency === 'ARS',
    )?.remaining,
    700000,
  );
});
test('allocation must preserve every cent and exclusions require a reason', () => {
  const f = ready();
  const line = f.doc.lines.find((l) => l.kind === 'impuesto')!;
  line.allocations = [
    { holder: 'JUAN PEREZ', amountMinor: 1 },
    { holder: 'ANA GOMEZ', amountMinor: line.amountMinor - 1 },
  ];
  assert.equal(summarize(f.doc).errors.length, 0);
  line.allocations[1].amountMinor--;
  assert.ok(summarize(f.doc).errors.some((e) => e.includes('reparto no suma')));
  line.treatment = 'excluded';
  line.reason = '';
  assert.ok(summarize(f.doc).errors.some((e) => e.includes('motivo')));
});
test('API requires session, isolates households, validates settlement and disables caching', async () => {
  const app = new Hono().route('/api/statements', statementRoutes);
  const f = ready();
  const other = ready();
  assert.equal((await app.request('/api/statements')).status, 401);
  const headers = { cookie: `hormiga_session=${makeSession(other.userId)}` };
  assert.equal((await app.request(`/api/statements/${f.record.id}`, { headers })).status, 404);
  const own = {
    cookie: `hormiga_session=${makeSession(f.userId)}`,
    'Content-Type': 'application/json',
  };
  const response = await app.request(`/api/statements/${f.record.id}`, { headers: own });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(
    (
      await app.request(`/api/statements/${f.record.id}/settlements`, {
        method: 'POST',
        headers: own,
        body: JSON.stringify({ amountMinor: -1 }),
      })
    ).status,
    400,
  );
});
