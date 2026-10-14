import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, listOrders } from '../src/orders.ts';

test('returns the first page by default', () => {
  const page = listOrders();
  assert.equal(page.page, 1);
  assert.equal(page.pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(page.items.length, DEFAULT_PAGE_SIZE);
});

test('filters by customer', () => {
  const page = listOrders({ customerId: 'cust-1' });
  assert.ok(page.items.every((o) => o.customerId === 'cust-1'));
  assert.ok(page.total < listOrders().total);
});

test('sorts newest first', () => {
  const [first, second] = listOrders().items;
  assert.ok(first !== undefined && second !== undefined);
  assert.ok(first.placedAt >= second.placedAt);
});

test('clamps pageSize so one request cannot pull the whole table', () => {
  const huge = listOrders({ pageSize: 10_000 });
  assert.equal(huge.pageSize, MAX_PAGE_SIZE);
  assert.ok(huge.items.length <= MAX_PAGE_SIZE);
  assert.equal(listOrders({ pageSize: 0 }).pageSize, 1);
});

test('pages without overlapping', () => {
  const a = listOrders({ pageSize: 5, page: 1 }).items.map((o) => o.id);
  const b = listOrders({ pageSize: 5, page: 2 }).items.map((o) => o.id);
  assert.equal(new Set([...a, ...b]).size, 10);
});
