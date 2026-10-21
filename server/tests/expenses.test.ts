import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { makeHousehold,makeSession,addTx,makeMerchant,sqlite,type Fixture } from './harness.js';
import { expenseDetails,expenseOverview,expenseOptions,saveExpense,type ExpenseDetails } from '../src/expenses.js';
import { transactionRoutes } from '../src/routes/transactions.js';
import { analyticsRoutes } from '../src/routes/analytics.js';
import { dataRoutes } from '../src/routes/data.js';
import { runMigrations } from '../src/db/migrate.js';
import { createDraft,configureMovements,saveStatement } from '../src/statements/repository.js';
import { installmentForecast } from '../src/analytics/installments.js';
import type { StatementDocument,LedgerLine } from '../src/statements/model.js';

const app=new Hono().route('/transactions',transactionRoutes).route('/analytics',analyticsRoutes).route('/',dataRoutes);
const headers=(f:Fixture)=>({cookie:`hormiga_session=${makeSession(f.userId)}`,'Content-Type':'application/json'});
const details=(f:Fixture,extra:Partial<ExpenseDetails>={}):ExpenseDetails=>({concept:'Carne',recipient:'Hogar',categoryId:f.categoryId,quantity:null,unit:'',reviewed:true,parts:[],...extra});
const tx=(f:Fixture,n=10000)=>addTx(f,{date:'2026-10-03',amountMinor:n,paidByUserId:f.userId});
const read=(id:string)=>sqlite.prepare('SELECT * FROM transactions WHERE id=?').get(id);
const patch=(id:string,body:object,h:ReturnType<typeof headers>)=>app.request('/transactions/'+id,{method:'PATCH',headers:h,body:JSON.stringify(body)});

function statement(f:Fixture,closeDate:string,n:number|null,coupon='1234') {
 sqlite.prepare("UPDATE accounts SET type='tarjeta' WHERE id=?").run(f.accountId);
 const line:LedgerLine={id:randomUUID(),kind:'consumo',holder:'UNO',date:'2026-09-10',description:'TIENDA',coupon,currency:'ARS',amountMinor:10000,
   installment:n===null?null:{n,of:6},original:null,taxBaseMinor:null,treatment:'allocate',reason:'',allocations:[{holder:'UNO',amountMinor:10000}]};
 const doc:StatementDocument={accountId:f.accountId,closeDate,dueDate:closeDate,accountTail:'',balanceArsMinor:10000,balanceUsdCents:0,previousArsMinor:0,previousUsdCents:0,dollarPayment:'USD',reviewConfirmed:true,extractionWarnings:[],holders:[{holder:'UNO',statedArsMinor:10000,statedUsdCents:0}],lines:[line]};
 const {record}=createDraft(f.householdId,randomUUID(),'synthetic.pdf',doc);
 configureMovements(f.householdId,record.id,[{holder:'UNO',userId:f.userId}],f.userId);
 saveStatement(f.householdId,record.id,record.revision,doc,true);
 return (sqlite.prepare('SELECT transaction_id AS id FROM card_movement_links WHERE statement_id=?').get(record.id) as {id:string}).id;
}

test('v8 to v9 preserves all old rows, is repeatable and rejects newer schemas',()=>{
 const db=new Database(':memory:');try{
  runMigrations(db);db.exec('DROP TABLE card_concept_rules;DROP TABLE expense_details;PRAGMA user_version=8');
  db.exec("INSERT INTO households(id,name) VALUES('h','Test');INSERT INTO accounts(id,household_id,name,type) VALUES('a','h','Caja','efectivo');INSERT INTO transactions(id,household_id,type,date,account_id,amount_minor) VALUES('t','h','gasto','2026-10-01','a',12345)");
  const before=db.prepare('SELECT * FROM transactions').all();
  assert.deepEqual(runMigrations(db),{from:8,to:9});assert.deepEqual(db.prepare('SELECT * FROM transactions').all(),before);
  assert.deepEqual(runMigrations(db),{from:9,to:9});db.pragma('user_version=10');assert.throws(()=>runMigrations(db),/más viejo/);
 }finally{db.close();}
});
test('legacy concept and recipient are suggestions, never financial rewrites',()=>{
 const f=makeHousehold();sqlite.prepare("UPDATE categories SET name='Hija Amoy' WHERE id=?").run(f.categoryId);
 const id=addTx(f,{date:'2026-10-02',amountMinor:10000,merchantId:makeMerchant(f.householdId,'Remera')});const before=read(id);
 const [i]=expenseOverview(f.householdId,'2026-10','ARS','booked').items;
 assert.equal(i.recipient,'Amoy');assert.equal(i.categoryId,null);assert.equal(i.needsReview,true);assert.equal(i.originalCategory,'Hija Amoy');
 assert.deepEqual(read(id),before);assert.equal(sqlite.prepare('SELECT * FROM expense_details WHERE transaction_id=?').get(id),undefined);
});
test('split totals reconcile without duplicate expenses and wrong edits roll back atomically',async()=>{
 const f=makeHousehold(),id=tx(f),h=headers(f);const before=read(id);
 const d=details(f,{concept:'Supermercado',parts:[{...details(f),amountMinor:6000},{...details(f,{concept:'Limpieza',recipient:'Flor'}),amountMinor:4000}].map(({parts,reviewed,...p})=>p)});
 assert.equal((await patch(id,{expense:d},h)).status,200);
 const overview=expenseOverview(f.householdId,'2026-10','ARS','booked');
 assert.equal(overview.totalMinor,10000);assert.equal(overview.count,1);assert.equal(overview.items.length,2);
 assert.equal(overview.recipients.reduce((s,r)=>s+r.amountMinor,0),10000);
 const saved=read(id);assert.equal((saved as {amount_minor:number}).amount_minor,(before as {amount_minor:number}).amount_minor);
 assert.equal((await patch(id,{amount:'120',note:'must rollback'},h)).status,400);assert.deepEqual(read(id),saved);
 assert.equal((await patch(id,{expense:{...d,parts:[{...d.parts[0],amountMinor:999}]}},h)).status,400);
 assert.equal(expenseOverview(f.householdId,'2026-10','ARS','booked').totalMinor,10000);
});
test('household isolation applies to details, categories, options and overview; auth is required',async()=>{
 const a=makeHousehold(),b=makeHousehold(),id=tx(a),h=headers(a);
 assert.equal((await patch(id,{expense:details(a,{categoryId:b.categoryId})},h)).status,400);
 assert.equal((await patch(id,{expense:details(b)},headers(b))).status,404);
 assert.equal((await app.request('/analytics/expenses')).status,401);
 assert.equal((await app.request('/analytics/expenses?currency=EUR',{headers:h})).status,400);
 await patch(id,{expense:details(a,{concept:'Privado'}),conceptAllInstallments:false},h);
 assert.equal(expenseOverview(b.householdId,'2026-10','ARS','booked').count,0);
 assert.ok(!expenseOptions(b.householdId).concepts.some(c=>c.concept==='Privado'));
 const response=await app.request('/transactions?id='+id,{headers:headers(b)});assert.deepEqual(await response.json(),[]);
});
test('currencies stay separate; normalized concepts combine across merchants; extraordinary excluded from repeats',()=>{
 const f=makeHousehold();for(const concept of ['Café','cafe']){const id=tx(f);saveExpense(f.householdId,id,details(f,{concept}));}
 const usd=tx(f,500);sqlite.prepare("UPDATE transactions SET currency='USD' WHERE id=?").run(usd);
 saveExpense(f.householdId,usd,details(f,{concept:'Café'}));
 const ars=expenseOverview(f.householdId,'2026-10','ARS','booked');assert.equal(ars.concepts.length,1);assert.equal(ars.repeated[0].count,2);assert.equal(ars.totalMinor,20000);
 assert.equal(expenseOverview(f.householdId,'2026-10','USD','booked').totalMinor,500);
 const event=randomUUID();sqlite.prepare('INSERT INTO events VALUES (?,?,?,?,0,?)').run(event,f.householdId,'Viaje',1,Date.now());
 sqlite.prepare('INSERT INTO event_transactions VALUES (?,?)').run(ars.items[0].transactionId,event);
 assert.equal(expenseOverview(f.householdId,'2026-10','ARS','booked').repeated.length,0);
});
test('bank date view moves only non-installment consumption; quotas never become full purchase totals',()=>{
 const f=makeHousehold();statement(f,'2026-10-01',1);statement(f,'2026-10-02',null,'9999');
 assert.equal(expenseOverview(f.householdId,'2026-10','ARS','booked').totalMinor,20000);
 assert.equal(expenseOverview(f.householdId,'2026-09','ARS','consumed').totalMinor,10000);
 const october=expenseOverview(f.householdId,'2026-10','ARS','consumed');assert.equal(october.totalMinor,0);assert.equal(october.excludedInstallments,1);
});
test('exact installment rule propagates concepts, preserves financial rows and does not label other purchases',async()=>{
 const f=makeHousehold(),one=statement(f,'2026-10-01',1),h=headers(f),before=read(one);
 const two=statement(f,'2026-11-01',2);const other=statement(f,'2026-11-02',2,'other');
 assert.equal((await patch(one,{expense:details(f,{concept:'Heladera'}),conceptAllInstallments:true},h)).status,200);
 assert.equal(expenseDetails(two,null,null,null).concept,'Heladera');assert.equal(expenseDetails(other,null,null,null).concept,'');
 const three=statement(f,'2026-12-01',3);assert.equal(expenseDetails(three,null,null,null).concept,'Heladera');
 const after=read(one) as Record<string,unknown>;const original=before as Record<string,unknown>;delete after.updated_at;delete original.updated_at;assert.deepEqual(after,original);
 assert.equal(installmentForecast(f.householdId,'2027-01',1).months[0].items[0].description,'Heladera');
 assert.equal((await patch(one,{amount:'1'},h)).status,409);
});
test('creation and deletion preserve split lifecycle; no shopping effects',async()=>{
 const f=makeHousehold(),h=headers(f);const before=sqlite.prepare('SELECT count(*) AS n FROM shopping_items').get();
 const response=await app.request('/transactions',{method:'POST',headers:h,body:JSON.stringify({type:'gasto',amount:'25,50',accountId:f.accountId,expense:details(f)})});
 assert.equal(response.status,201);const {id}=await response.json() as {id:string};
 assert.equal(expenseDetails(id,null,null,null).concept,'Carne');
 assert.equal((await app.request('/transactions/'+id,{method:'DELETE',headers:h})).status,200);
 assert.equal(sqlite.prepare('SELECT * FROM expense_details WHERE transaction_id=?').get(id),undefined);
 assert.deepEqual(sqlite.prepare('SELECT count(*) AS n FROM shopping_items').get(),before);
});

test('category used only in a split is archived, preserving past classifications',async()=>{
 const f=makeHousehold(),id=tx(f),categoryId=randomUUID();
 sqlite.prepare("INSERT INTO categories(id,household_id,name,kind) VALUES(?,?,?,'gasto')").run(categoryId,f.householdId,'Limpieza');
 const d=details(f,{parts:[{concept:'Comida',recipient:'Hogar',categoryId:f.categoryId,quantity:null,unit:'',amountMinor:6000},
 {concept:'Jabón',recipient:'Hogar',categoryId,quantity:null,unit:'',amountMinor:4000}]});
 saveExpense(f.householdId,id,d);
 const response=await app.request('/categories/'+categoryId,{method:'DELETE',headers:headers(f)});
 assert.deepEqual(await response.json(),{accion:'archivada'});
 assert.ok(expenseOverview(f.householdId,'2026-10','ARS','booked').categories.some(c=>c.name==='Limpieza'));
});
