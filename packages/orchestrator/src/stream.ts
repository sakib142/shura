/**
 * What a run reports while it happens.
 *
 * Every event is both streamed to whoever is watching and persisted, because a
 * run that only prints to a terminal leaves nothing to look at afterwards and
 * nothing for anything else to watch while it works.
 */

import type { Pool } from 'pg';
import type { ArtifactState } from '@shura/core';
import type { AgentEvent } from '@shura/ports';

export type StreamEvent =
  | { readonly kind: 'phase'; readonly state: ArtifactState; readonly detail: string }
  | { readonly kind: 'agent'; readonly actor: string; readonly event: AgentEvent }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'verdict'; readonly decision: string; readonly detail: string };

/** A short, groupable name for the stream. */
export function eventType(e: StreamEvent): string {
  if (e.kind === 'agent') return `agent.${e.event.t}`;
  return e.kind;
}

/**
 * Streams an event and records it, never failing the run for the recording.
 * A work item key that does not match simply records nothing.
 */
/**
 * Streams events and records them, with a way to know when recording is done.
 *
 * `flush` exists because the writes are deliberately fire-and-forget — a run
 * must not stall on its own audit log — which leaves no moment at which the
 * events are known to be on disk. A process that exits straight after the last
 * event loses it, and a test that truncates between cases truncates another
 * case's rows out from under it.
 */
export type Emit = ((e: StreamEvent) => void) & { flush: () => Promise<void> };

export function recorder(
  pool: Pool,
  workItemKey: string,
  consume: (e: StreamEvent) => void,
): Emit {
  // One insert in flight at a time.
  //
  // The chain trigger takes an advisory lock so two appends cannot read the
  // same predecessor — but `bigserial` allocates the id BEFORE that lock. Two
  // concurrent inserts can take ids 2 and 3 and then run the trigger in the
  // opposite order, leaving row 3 chained to row 1. The verifier walks by id
  // and reports exactly that, which is how this was found: two emits back to
  // back in the planner broke the chain on a real run.
  //
  // Awaiting the previous insert costs the caller nothing — this returns
  // immediately either way — and makes the ids and the chain agree.
  let tail: Promise<unknown> = Promise.resolve();

  const emit = ((e: StreamEvent) => {
    consume(e);
    tail = tail
      .then(() =>
        pool.query(
          `INSERT INTO events (work_item_id, type, payload)
           SELECT id, $2, $3::jsonb FROM work_items WHERE key = $1`,
          [workItemKey, eventType(e), JSON.stringify(e)],
        ),
      )
      // Recording must never break a run that is otherwise working, and a
      // failure must not stall every event behind it either.
      .catch(() => undefined);
  }) as Emit;

  emit.flush = async (): Promise<void> => {
    await tail;
  };
  return emit;
}
