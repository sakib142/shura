export interface ChangeRequestRef {
  readonly id: string;
  readonly branch: string;
  readonly base: string;
}

export interface CheckRun {
  readonly ok: boolean;
  readonly summary: string;
  readonly output: string;
}

export interface Diff {
  readonly text: string;
  readonly files: readonly string[];
}

/**
 * Note what is absent: there is no merge().
 *
 * The capability is not on the port an agent's tools are built from, so no
 * prompt — and nothing injected through repository, ticket or design text —
 * can reach it. Merging lives on MergeQueue, under a separate credential.
 */
export interface Vcs {
  createBranch(from: string, name: string): Promise<void>;
  commit(branch: string, message: string, author: string): Promise<string>;
  openChangeRequest(input: {
    branch: string;
    base: string;
    title: string;
    body: string;
    /** Which agent produced it. Recorded locally; GitHub attributes to the token. */
    author?: string;
    workItemId?: string;
  }): Promise<ChangeRequestRef>;
  getDiff(ref: ChangeRequestRef): Promise<Diff>;
  runChecks(ref: ChangeRequestRef): Promise<CheckRun>;
  /**
   * Makes a branch's commits visible wherever change requests are opened.
   *
   * Free for a local repository, where a worktree already shares refs with the
   * repo it came from. A push for a remote one. The loop has to say this
   * explicitly, because otherwise the local case works and the remote case
   * opens a pull request with nothing in it.
   */
  publishBranch(branch: string): Promise<void>;
}

export type MergeOutcome =
  | { readonly status: 'merged'; readonly ref: ChangeRequestRef; readonly commit: string }
  | { readonly status: 'rejected'; readonly ref: ChangeRequestRef; readonly reason: string };

/**
 * Admission. Rebase on the current base, re-run the checks, merge only if still
 * green — which is the property a directly-merging reviewer would give up, since
 * two change requests can each be green alone and break the base together.
 */
export interface MergeQueue {
  enqueue(ref: ChangeRequestRef, verdictId: string): Promise<void>;
  tick(): Promise<readonly MergeOutcome[]>;
}
