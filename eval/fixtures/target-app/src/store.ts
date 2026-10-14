/** An in-memory order store. Deliberately small: the point is the pipeline. */

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly total: number;
  readonly status: 'pending' | 'shipped' | 'cancelled';
  readonly placedAt: string;
}

const ORDERS: Order[] = Array.from({ length: 57 }, (_, i) => ({
  id: `ord-${String(i + 1).padStart(3, '0')}`,
  customerId: i % 3 === 0 ? 'cust-1' : 'cust-2',
  total: Math.round((20 + i * 3.5) * 100) / 100,
  status: i % 7 === 0 ? 'cancelled' : i % 2 === 0 ? 'shipped' : 'pending',
  placedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
}));

export function allOrders(): readonly Order[] {
  return ORDERS;
}

export function findOrder(id: string): Order | undefined {
  return ORDERS.find((o) => o.id === id);
}
