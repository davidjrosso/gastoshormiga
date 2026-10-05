import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHousehold, addTx } from './harness.js';
import { categoryTrends } from '../src/analytics/hormiga.js';

test('category comparison uses one loaded month without inventing two zero months', () => {
  const f = makeHousehold();
  addTx(f, { date: '2026-09-10', amountMinor: 90000 });
  addTx(f, { date: '2026-10-05', amountMinor: 60000 });
  const [r] = categoryTrends(f.householdId, '2026-10');
  assert.deepEqual(r.baselinePeriods, ['2026-09']);
  assert.equal(r.baselineMinor, 90000); assert.equal(r.changePct, -33.3);
});

test('uses last three loaded months across gaps and counts zero in a category when household has expenses', () => {
  const f = makeHousehold(), other = makeHousehold();
  addTx(f, { date: '2025-12-02', amountMinor: 900000 }); // fourth oldest excluded
  addTx(f, { date: '2026-02-02', amountMinor: 30000 });
  addTx(f, { date: '2026-05-02', amountMinor: 30000 });
  addTx(f, { date: '2026-09-02', amountMinor: 40000, categoryId: null });
  addTx(f, { date: '2026-08-02', amountMinor: 90000, type: 'ingreso' }); // income alone is not a loaded spending month
  addTx(other, { date: '2026-07-02', amountMinor: 90000 });
  addTx(f, { date: '2026-10-02', amountMinor: 30000 });
  addTx(f, { date: '2026-11-02', amountMinor: 90000 });
  const [r] = categoryTrends(f.householdId, '2026-10');
  assert.deepEqual(r.baselinePeriods, ['2026-09', '2026-05', '2026-02']);
  assert.equal(r.baselineMinor, 20000); assert.equal(r.changePct, 50);
});

test('two loaded months average their expenses and income over the same periods', () => {
  const f = makeHousehold();
  for (const date of ['2026-08-02', '2026-09-02']) {
    addTx(f, { date, amountMinor: 30000 }); addTx(f, { date, amountMinor: 100000, type: 'ingreso' });
  }
  addTx(f, { date: '2026-07-02', amountMinor: 900000, type: 'ingreso' });
  addTx(f, { date: '2026-10-02', amountMinor: 45000 });
  const [r] = categoryTrends(f.householdId, '2026-10');
  assert.equal(r.baselinePeriods.length, 2); assert.equal(r.baselineMinor, 30000);
  assert.equal(r.changePct, 50); assert.equal(r.baselineShareOfIncomePct, 30);
});

test('no history or zero category baseline does not invent a percentage', () => {
  const f = makeHousehold(); addTx(f, { date: '2026-10-02', amountMinor: 10000 });
  let r = categoryTrends(f.householdId, '2026-10')[0];
  assert.deepEqual(r.baselinePeriods, []); assert.equal(r.changePct, null); assert.equal(r.baselineShareOfIncomePct, null);
  addTx(f, { date: '2026-09-02', amountMinor: 5000, categoryId: null });
  r = categoryTrends(f.householdId, '2026-10')[0];
  assert.equal(r.baselineMinor, 0); assert.equal(r.changePct, null);
});
