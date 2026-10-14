/**
 * Hashing used for audit arguments and idempotency keys.
 *
 * Deterministic by construction: object key order never changes the result, so
 * the same call made twice produces the same key however the arguments were
 * assembled.
 */

import { createHash } from 'node:crypto';

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short digest for embedding in an idempotency key. */
export function digest(input: string): string {
  return sha256(input).slice(0, 16);
}

export function hashArgs(args: unknown): string {
  return `sha256:${sha256(stableStringify(args)).slice(0, 16)}`;
}
