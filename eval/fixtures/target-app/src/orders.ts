import { allOrders, type Order } from './store.ts';

export interface ListOptions {
  readonly customerId?: string;
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

/**
 * Lists orders for a customer, newest first.
 *
 * pageSize is clamped: an unbounded value would let one request pull the whole
 * table.
 */
export function listOrders(options: ListOptions = {}): Page<Order> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const requested = Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));

  const matching = allOrders()
    .filter((o) => options.customerId === undefined || o.customerId === options.customerId)
    .slice()
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));

  const start = (page - 1) * pageSize;
  return {
    items: matching.slice(start, start + pageSize),
    page,
    pageSize,
    total: matching.length,
  };
}
