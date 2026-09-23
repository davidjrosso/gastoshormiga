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
  configureMovements,
} from '../src/statements/repository.js';
import { statementRoutes } from '../src/routes/statements.js';
import { transactionRoutes } from '../src/routes/transactions.js';

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
test('mapped holders post exactly once with correct user, currency and closing date', async () => {
  const f = ready();
  const mapping = f.doc.holders.map((h, i) => ({ holder: h.holder, userId: i === 0 ? f.userId : f.otherUserId }));
  assert.equal(configureMovements(f.householdId, f.record.id, mapping, f.userId).deferred, true);
  const rows = () => sqlite.prepare('SELECT * FROM transactions WHERE household_id=?').all(f.householdId) as {id:string;paid_by_user_id:string;date:string;currency:string;amount_minor:number}[];
  assert.equal(rows().length, 0);
  saveStatement(f.householdId, f.record.id, 1, f.doc, true);
  const expected = f.doc.lines.filter(l => l.treatment === 'allocate' && ['consumo','impuesto','interes','percepcion_recuperable'].includes(l.kind))
    .flatMap(l => l.allocations.filter(a => a.amountMinor !== 0).map(a => ({
      user: mapping.find(m => m.holder === a.holder)!.userId, amount: a.amountMinor, currency:l.currency,
    })));
  assert.equal(rows().length, expected.length);
  assert.deepEqual(rows().map(r => ({user:r.paid_by_user_id,amount:r.amount_minor,currency:r.currency})), expected);
  assert.ok(rows().every(r => r.date === f.doc.closeDate));
  assert.equal(configureMovements(f.householdId, f.record.id, mapping, f.userId).created, 0);
  const app = new Hono().route('/api/transactions', transactionRoutes);
  const headers = {cookie:`hormiga_session=${makeSession(f.userId)}`, 'Content-Type':'application/json'};
  const filtered = await (await app.request(`/api/transactions?period=${f.doc.closeDate.slice(0,7)}&paidBy=${f.otherUserId}`, {headers})).json() as {paidByUserId:string;statementId:string}[];
  assert.ok(filtered.length > 0 && filtered.every(r => r.paidByUserId === f.otherUserId && r.statementId === f.record.id));
  assert.equal((await app.request(`/api/transactions/${rows()[0].id}`, {method:'PATCH', headers,body:JSON.stringify({amount:'1,00'})})).status,409);
  assert.equal((await app.request(`/api/transactions/${rows()[0].id}`, {method:'DELETE',headers})).status,409);
  assert.equal((await app.request(`/api/transactions/${rows()[0].id}`, {method:'PATCH',headers,body:JSON.stringify({categoryId:f.categoryId})})).status,200);
  assert.equal(configureMovements(f.householdId, f.record.id, mapping, f.userId).created, 0);
});

test('existing confirmed statements can be incorporated; external holders stay outside household expenses', () => {
  const f = ready();
  saveStatement(f.householdId, f.record.id, 1, f.doc, true);
  const mapping = f.doc.holders.map((h, i) => ({holder:h.holder,userId:i === 0 ? f.userId : null}));
  const result = configureMovements(f.householdId, f.record.id, mapping, f.userId);
  assert.ok(result.created > 0);
  const rows = sqlite.prepare('SELECT paid_by_user_id,amount_minor FROM transactions WHERE household_id=?').all(f.householdId) as {paid_by_user_id:string}[];
  assert.ok(rows.every(r => r.paid_by_user_id === f.userId));
  assert.throws(() => configureMovements(f.householdId, f.record.id, mapping.map(m => ({...m,userId:null})), f.userId), /vinculados/);
  assert.equal(configureMovements(f.householdId, f.record.id, mapping, f.userId).created,0);
});

test('invalid ownership and possible manual duplicates roll back the entire posting', () => {
  const f = ready(); const other = ready();
  const mapping = f.doc.holders.map(h => ({holder:h.holder,userId:f.userId}));
  assert.throws(() => configureMovements(f.householdId, f.record.id, mapping.map(m => ({...m,userId:other.userId})),f.userId), /hogar/);
  assert.throws(() => configureMovements(other.householdId,f.record.id,mapping,other.userId), /encontrado/);
  configureMovements(f.householdId,f.record.id,mapping,f.userId);
  const last = f.doc.lines.filter(l => l.kind === 'consumo').at(-1)!;
  sqlite.prepare(`INSERT INTO transactions (id, household_id,type,date,account_id,amount_minor,currency,note) VALUES (?,?,'gasto',?,?,?,?,?)`)
    .run(randomUUID(),f.householdId,f.doc.closeDate,f.accountId,last.amountMinor,last.currency,last.description);
  assert.throws(() => saveStatement(f.householdId,f.record.id,1,f.doc,true), /duplicado/);
  assert.equal(getStatement(f.householdId,f.record.id).status,'draft');
  assert.equal(getStatement(f.householdId,f.record.id).revision,1);
  assert.equal((sqlite.prepare('SELECT count(*) n FROM transactions WHERE household_id=?').get(f.householdId) as {n:number}).n,1);
  assert.equal((sqlite.prepare('SELECT count(*) n FROM card_movement_links WHERE statement_id=?').get(f.record.id) as {n:number}).n,0);
});

test('movement configuration API requires authentication and rejects foreign users', async () => {
  const f=ready(), other=ready();
  const app=new Hono().route('/api/statements',statementRoutes);
  assert.equal((await app.request('/api/statements/movement-settings')).status,401);
  const headers={cookie:`hormiga_session=${makeSession(f.userId)}`, 'Content-Type':'application/json'};
  const response=await app.request('/api/statements/movement-settings',{headers});
  assert.equal(response.status,200); assert.equal(response.headers.get('Cache-Control'),'no-store');
  const mappings=f.doc.holders.map(h=>({holder:h.holder,userId:other.userId}));
  assert.equal((await app.request(`/api/statements/${f.record.id}/movements`,{method:'POST',headers,body:JSON.stringify(mappings)})).status,409);
});

test('a consumption refund reduces expense without turning into income or an extra collection', () => {
  const f=ready();
  const original=f.doc.lines.find(l=>l.kind==='consumo' && l.currency==='ARS')!;
  const refund={...original,id:'refund',description:'Refund QA',amountMinor:-100,allocations:[{holder:original.holder!,amountMinor:-100}]};
  f.doc.lines.push(refund);
  f.doc.balanceArsMinor-=100;
  f.doc.holders.find(h=>h.holder===original.holder)!.statedArsMinor-=100;
  configureMovements(f.householdId,f.record.id,f.doc.holders.map(h=>({holder:h.holder,userId:f.userId})),f.userId);
  saveStatement(f.householdId,f.record.id,1,f.doc,true);
  const tx=sqlite.prepare(`SELECT t.type,t.amount_minor FROM transactions t JOIN card_movement_links l ON t.id=l.transaction_id
    WHERE l.statement_id=? AND l.line_id='refund'`).get(f.record.id);
  assert.deepEqual(tx,{type:'gasto',amount_minor:-100});
});

test('future closing remembers selected users without reposting previous closing', () => {
  const f=ready();
  const mappings=f.doc.holders.map((h,i)=>({holder:h.holder,userId:i===0?f.userId:null}));
  configureMovements(f.householdId,f.record.id,mappings,f.userId);
  saveStatement(f.householdId,f.record.id,1,f.doc,true);
  const next={...f.doc,closeDate:'2026-09-29',dueDate:'2026-10-10'};
  const record=createDraft(f.householdId,randomUUID(),'next.pdf',next).record;
  saveStatement(f.householdId,record.id,1,next,true);
  const oldCount=(sqlite.prepare('SELECT count(*) n FROM card_movement_links WHERE statement_id=?').get(f.record.id) as {n:number}).n;
  const newCount=(sqlite.prepare('SELECT count(*) n FROM card_movement_links WHERE statement_id=?').get(record.id) as {n:number}).n;
  assert.ok(oldCount>0); assert.equal(newCount,oldCount);
  assert.equal(configureMovements(f.householdId,record.id,mappings,f.userId).created,0);
});

test('migration v3 to v5 leaves existing confirmed documents and collections untouched', () => {
  const db=new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE card_event_rules; DROP TABLE event_transactions; DROP TABLE events; DROP TABLE card_movement_links; DROP TABLE card_movement_users; PRAGMA user_version=3;');
    db.exec("INSERT INTO households(id,name) VALUES('h','Existing'); INSERT INTO card_statements VALUES('s','h','hash','s.pdf',null,'2026-08-27','confirmed',4,'{}',1,2); INSERT INTO card_settlements VALUES('p','s','Person','ARS',123,'payment','2026-09-01','Existing',1);");
    const before=db.prepare('SELECT * FROM card_statements').all();
    const payments=db.prepare('SELECT * FROM card_settlements').all();
    assert.deepEqual(runMigrations(db),{from:3,to:5});
    assert.deepEqual(db.prepare('SELECT * FROM card_statements').all(),before);
    assert.deepEqual(db.prepare('SELECT * FROM card_settlements').all(),payments);
  } finally {db.close();}
});

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
test('migration v2 to v5 preserves previous data and is repeatable', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE card_event_rules; DROP TABLE event_transactions; DROP TABLE events; DROP TABLE card_movement_links; DROP TABLE card_movement_users; DROP TABLE card_settlements; DROP TABLE card_statements; PRAGMA user_version=2;');
    db.prepare('INSERT INTO households (id,name) VALUES (?,?)').run('test', 'Existing household');
    db.prepare(
      "INSERT INTO accounts (id,household_id,name,type) VALUES ('a','test','Card','tarjeta')",
    ).run();
    db.prepare(
      "INSERT INTO transactions (id,household_id,type,date,account_id,amount_minor) VALUES ('t','test','gasto','2026-01-02','a',12345)",
    ).run();
    const before = db.prepare('SELECT * FROM transactions').all();
    assert.deepEqual(runMigrations(db), { from: 2, to: 5 });
    assert.deepEqual(db.prepare('SELECT * FROM transactions').all(), before);
    assert.deepEqual(runMigrations(db), { from: 5, to: 5 });
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
