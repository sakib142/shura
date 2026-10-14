/**
 * The artifact lifecycle. One table, generic over artifact type — a story, an
 * API contract and a code change all walk the same states. If a new artifact
 * type ever needs a state added here, the abstraction is wrong.
 */

export const ARTIFACT_STATES = [
  'draft',
  'producing',
  'awaiting_verification',
  'verifying',
  'changes_requested',
  'awaiting_admission',
  'admitted',
  'escalated',
] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const LIFECYCLE_EVENTS = [
  'start_production',
  'production_complete',
  'verifier_scheduled',
  'verdict_pass',
  'verdict_changes',
  'verdict_blocked',
  'rework_start',
  'loop_cap_hit',
  'admission_succeeded',
  'admission_failed',
  'budget_exhausted',
  'human_requested',
  'human_resumed',
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

const TRANSITIONS: Readonly<Record<ArtifactState, Partial<Record<LifecycleEvent, ArtifactState>>>> = {
  draft: {
    start_production: 'producing',
  },
  producing: {
    production_complete: 'awaiting_verification',
    budget_exhausted: 'escalated',
    human_requested: 'escalated',
  },
  awaiting_verification: {
    verifier_scheduled: 'verifying',
    human_requested: 'escalated',
  },
  verifying: {
    verdict_pass: 'awaiting_admission',
    verdict_changes: 'changes_requested',
    // A verifier that cannot verify escalates. It never admits and never rejects.
    verdict_blocked: 'escalated',
    budget_exhausted: 'escalated',
    human_requested: 'escalated',
  },
  changes_requested: {
    rework_start: 'producing',
    loop_cap_hit: 'escalated',
    human_requested: 'escalated',
  },
  awaiting_admission: {
    admission_succeeded: 'admitted',
    // Rebase or re-run failed against the latest main: back to the producer with
    // the failure attached. This is the protection a directly-merging reviewer
    // would give up.
    admission_failed: 'changes_requested',
    human_requested: 'escalated',
  },
  admitted: {},
  escalated: {
    human_resumed: 'producing',
  },
};

export const TERMINAL_STATES: readonly ArtifactState[] = ['admitted'];

export class IllegalTransition extends Error {
  constructor(
    readonly from: ArtifactState,
    readonly event: LifecycleEvent,
  ) {
    super(`no transition from "${from}" on "${event}"`);
    this.name = 'IllegalTransition';
  }
}

export function canTransition(from: ArtifactState, event: LifecycleEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function transition(from: ArtifactState, event: LifecycleEvent): ArtifactState {
  const next = TRANSITIONS[from][event];
  if (next === undefined) throw new IllegalTransition(from, event);
  return next;
}

export function allowedEvents(from: ArtifactState): readonly LifecycleEvent[] {
  return Object.keys(TRANSITIONS[from]) as LifecycleEvent[];
}

/**
 * Where a verdict sends the artifact, and whether the attempt budget is spent.
 * `attempt` is the attempt just completed; `cap` is the configured loop cap.
 */
export function afterVerdict(
  decision: 'PASS' | 'CHANGES_REQUESTED' | 'BLOCKED',
  attempt: number,
  cap: number,
): { event: LifecycleEvent; next: ArtifactState } {
  if (decision === 'PASS') {
    return { event: 'verdict_pass', next: transition('verifying', 'verdict_pass') };
  }
  if (decision === 'BLOCKED') {
    return { event: 'verdict_blocked', next: transition('verifying', 'verdict_blocked') };
  }
  const changes = transition('verifying', 'verdict_changes');
  if (attempt >= cap) {
    return { event: 'loop_cap_hit', next: transition(changes, 'loop_cap_hit') };
  }
  return { event: 'verdict_changes', next: changes };
}
