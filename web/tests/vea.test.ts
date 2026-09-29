import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialVeaQuantity } from '../src/lib/vea-quantity.ts';
test('VEA quantities only infer positive whole package counts, flag free text and limits', () => {
  for (const value of ['', '1 kg', '0', '-2', '1.5', '2e1', '100', '9999999999999999999']) {
    assert.deepEqual(initialVeaQuantity(value), { qty: 1, assumed: true });
  }
  assert.deepEqual(initialVeaQuantity(' 2 '), { qty: 2, assumed: false });
  assert.deepEqual(initialVeaQuantity('99'), { qty: 99, assumed: false });
});
