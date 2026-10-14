/**
 * Where work items live.
 *
 * Read work, write progress. Forge never creates or edits a story: the tracker
 * owns those fields and Forge owns status and commentary, so there is exactly
 * one writer per field and no two-way sync to reconcile.
 */

export interface TrackerItem {
  readonly key: string;
  readonly title: string;
  /** Given/When/Then lines. The reviewer judges against these. */
  readonly criteria: readonly string[];
  readonly state: string;
  readonly type: string;
}

/** Our states, mapped onto whatever the tracker calls them. */
export type TrackerState = 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';

export interface Tracker {
  get(key: string): Promise<TrackerItem | undefined>;
  comment(key: string, body: string): Promise<void>;
  /** Returns false when the tracker has no such transition available. */
  transition(key: string, state: TrackerState): Promise<boolean>;
}
