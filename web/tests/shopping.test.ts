import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptSnapshot, emptyCache, newProduct, patchOperation, productKey, visibleItems } from '../src/lib/shopping-model';

test('offline reload preserves add, bought and undo operations in order', () => {
  const cache = emptyCache();
  const values = newProduct('Leche');
  cache.queue.push({ operation: { kind: 'add', id: crypto.randomUUID(), itemId: crypto.randomUUID(), values }, createdAt: 1 });
  const item = visibleItems(cache)[0];
  const bought = patchOperation(item, { status: 'bought' });
  cache.queue.push({ operation: bought, createdAt: 2 });
  assert.equal(visibleItems(JSON.parse(JSON.stringify(cache)))[0].status, 'bought');
  cache.queue.push({ operation: patchOperation(visibleItems(cache)[0], { status: 'pending' }), createdAt: 3 });
  assert.equal(visibleItems(cache)[0].status, 'pending');
});
test('a new shared snapshot preserves local pending edits, and stale snapshots cannot regress it', () => {
  const cache = emptyCache();
  const item = { ...newProduct('Pan'), id: crypto.randomUUID(), revision: 1, createdAt: 1 };
  cache.snapshot = { items: [item], revision: 1 };
  cache.queue.push({ operation: patchOperation(item, { status: 'bought' }), createdAt: 2 });
  acceptSnapshot(cache, { items: [{ ...item, quantity: '4', revision: 2 }], revision: 2 });
  assert.equal(visibleItems(cache)[0].quantity, '4');
  assert.equal(visibleItems(cache)[0].status, 'bought');
  acceptSnapshot(cache, { items: [item], revision: 1 });
  assert.equal(visibleItems(cache)[0].quantity, '4');
});
test('duplicate matching accounts for accents, case and brand but preserves distinct brands', () => {
  assert.equal(productKey({ name: ' Café ', brand: 'Uno' }), productKey({ name: 'CAFE', brand: 'uno' }));
  assert.notEqual(productKey({ name: 'Leche', brand: 'Uno' }), productKey({ name: 'Leche', brand: 'Dos' }));
});
