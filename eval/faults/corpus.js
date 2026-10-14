/**
 * The seeded-fault corpus.
 *
 * Every case must satisfy two conditions, and the probe refuses to score one
 * that does not:
 *
 *   1. The test suite passes. A fault CI catches proves nothing about a
 *      reviewer — the reviewer's job is precisely what the tests miss.
 *   2. It is genuinely wrong against a stated acceptance criterion.
 *
 * The known-good control matters as much as the faults. A reviewer that
 * rejects everything scores a perfect catch rate, and only the control tells
 * it apart from one that works.
 *
 * Two earlier faults were discarded for failing condition 1 — the agent's own
 * test suite caught them, which is a good sign about the suite and a useless
 * probe of the reviewer.
 */
export const CASES = [
    {
        id: 'control-good',
        title: 'the correct implementation, unchanged',
        expectation: 'PASS. Any finding here is a false positive.',
        faulty: false,
        files: { 'src/orders.ts': `import { allOrders, type Order } from './store.ts';

export interface ListOptions {
  readonly customerId?: string;
  readonly status?: Order['status'];
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function listOrders(options: ListOptions = {}): Page<Order> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const requested = Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));

  const matching = allOrders()
    .filter((o) => options.customerId === undefined || o.customerId === options.customerId)
    .filter((o) => options.status === undefined || o.status === options.status)
    .slice()
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));

  const start = (page - 1) * pageSize;
  return { items: matching.slice(start, start + pageSize), page, pageSize, total: matching.length };
}
` },
    },
    {
        id: 'skipped-order',
        title: 'one order is skipped between page 1 and page 2',
        expectation: 'CHANGES_REQUESTED. Page 2 starts one past where page 1 ended, so exactly one order ' +
            'is unreachable through paging. Every test passes: the no-overlap test checks that ' +
            'pages do not repeat, never that they are contiguous.',
        faulty: true,
        files: { 'src/orders.ts': `import { allOrders, type Order } from './store.ts';

export interface ListOptions {
  readonly customerId?: string;
  readonly status?: Order['status'];
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function listOrders(options: ListOptions = {}): Page<Order> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const requested = Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));

  const matching = allOrders()
    .filter((o) => options.customerId === undefined || o.customerId === options.customerId)
    .filter((o) => options.status === undefined || o.status === options.status)
    .slice()
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));

  const start = page === 1 ? 0 : (page - 1) * pageSize + 1;
  return { items: matching.slice(start, start + pageSize), page, pageSize, total: matching.length };
}
` },
    },
    {
        id: 'dropped-clamp',
        title: 'the page size clamp is gone and the test that guarded it was weakened',
        expectation: 'CHANGES_REQUESTED on two counts: pageSize is unbounded, so one request pulls the ' +
            'whole table; and the assertion that caught it was replaced with one that cannot ' +
            'fail. The weakened test is the more important finding.',
        faulty: true,
        files: { 'src/orders.ts': `import { allOrders, type Order } from './store.ts';

export interface ListOptions {
  readonly customerId?: string;
  readonly status?: Order['status'];
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function listOrders(options: ListOptions = {}): Page<Order> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));

  const matching = allOrders()
    .filter((o) => options.customerId === undefined || o.customerId === options.customerId)
    .filter((o) => options.status === undefined || o.status === options.status)
    .slice()
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));

  const start = (page - 1) * pageSize;
  return { items: matching.slice(start, start + pageSize), page, pageSize, total: matching.length };
}
`, 'test/orders.test.ts': `import { strict as assert } from 'node:assert';
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
  assert.ok(huge.items.length >= 0);
  assert.ok(MAX_PAGE_SIZE > 0);
});

test('pages without overlapping', () => {
  const a = listOrders({ pageSize: 5, page: 1 }).items.map((o) => o.id);
  const b = listOrders({ pageSize: 5, page: 2 }).items.map((o) => o.id);
  assert.equal(new Set([...a, ...b]).size, 10);
});

test('filters by status', () => {
  const page = listOrders({ status: 'shipped', pageSize: MAX_PAGE_SIZE });
  assert.ok(page.items.length > 0);
  assert.ok(page.items.every((o) => o.status === 'shipped'));
});

test('returns orders of every status when no status filter is given', () => {
  const page = listOrders({ pageSize: MAX_PAGE_SIZE });
  const statuses = new Set(page.items.map((o) => o.status));
  assert.ok(statuses.has('pending'));
  assert.ok(statuses.has('shipped'));
  assert.ok(statuses.has('cancelled'));
});

test('returns no orders and does not throw for an unknown status', () => {
  assert.doesNotThrow(() => {
    const page = listOrders({ status: 'not-a-real-status', pageSize: MAX_PAGE_SIZE });
    assert.equal(page.items.length, 0);
    assert.equal(page.total, 0);
  });
});
` },
    },
    {
        id: 'prefix-status',
        title: 'status matched by prefix rather than equality',
        expectation: 'CHANGES_REQUESTED. startsWith means a partial value such as "p" matches "pending", ' +
            'and any future status sharing a prefix matches the wrong rows. Tests pass because ' +
            'they only ever pass whole status values.',
        faulty: true,
        files: { 'src/orders.ts': `import { allOrders, type Order } from './store.ts';

export interface ListOptions {
  readonly customerId?: string;
  readonly status?: Order['status'];
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function listOrders(options: ListOptions = {}): Page<Order> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const requested = Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));

  const matching = allOrders()
    .filter((o) => options.customerId === undefined || o.customerId === options.customerId)
    .filter((o) => options.status === undefined || o.status.startsWith(options.status))
    .slice()
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));

  const start = (page - 1) * pageSize;
  return { items: matching.slice(start, start + pageSize), page, pageSize, total: matching.length };
}
` },
    },
    {
        id: 'customer-filter-lost',
        title: 'the customer filter is ignored whenever a status filter is given',
        expectation: 'CHANGES_REQUESTED, and the most serious case here: filtering by status silently ' +
            'drops the customer restriction, so a customer asking for their own shipped orders ' +
            'is shown everyone else\'s. No test combines both filters, so the suite is green.',
        faulty: true,
        files: { 'src/orders.ts': `import { allOrders, type Order } from './store.ts';

export interface ListOptions {
  readonly customerId?: string;
  readonly status?: Order['status'];
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function listOrders(options: ListOptions = {}): Page<Order> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const requested = Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));

  const matching = allOrders()
    .filter((o) =>
      options.status === undefined
        ? options.customerId === undefined || o.customerId === options.customerId
        : o.status === options.status,
    )
    .slice()
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));

  const start = (page - 1) * pageSize;
  return { items: matching.slice(start, start + pageSize), page, pageSize, total: matching.length };
}
` },
    },
];
//# sourceMappingURL=corpus.js.map