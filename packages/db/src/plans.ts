/**
 * Plans and their approval gate.
 *
 * The gate's state lives here rather than in the process, because the whole
 * point of stopping to be approved is that the process exits in between. A run
 * plans and ends; a human reads it later; `shura build --resume` picks it up.
 */

import type { Pool } from 'pg';
import type { PlanInput, PlanStatus, PlanSubmission, PlannedFile, Vendor } from '@shura/core';

export interface PlanSource {
  /** Where the work happens, as "owner/name" or a local path. */
  readonly repo: string;
  /** The request as the human wrote it, or the ticket's text. */
  readonly request: string;
  readonly source: 'instructions' | 'tracker';
  /** What to branch from, and what the pull request targets. */
  readonly base: string;
  /**
   * How to build and test this repository, as argv.
   *
   * Stored with the plan rather than read from configuration at build time.
   * A plan is for one repository; the configured check command belongs to
   * whichever repository the config happens to name, and using it to verify a
   * different one produces either a failure or a meaningless pass.
   */
  readonly checks: readonly string[];
}

export interface StoredPlan {
  readonly id: string;
  readonly workItemId: string;
  readonly workItemKey: string;
  readonly title: string;
  readonly taskId: string;
  readonly repo: string;
  readonly request: string;
  readonly source: 'instructions' | 'tracker';
  readonly base: string;
  readonly checks: readonly string[];
  readonly understanding: string;
  readonly approach: string;
  readonly files: readonly PlannedFile[];
  readonly outOfScope: readonly string[];
  readonly criteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly answers: readonly string[];
  readonly author: string;
  readonly vendor: Vendor;
  readonly model: string;
  readonly costUsd: number;
  readonly status: PlanStatus;
  readonly branch?: string;
  readonly changeRequest?: string;
  readonly createdAt: Date;
}

interface Row {
  id: string;
  work_item_id: string;
  key: string;
  title: string;
  task_id: string;
  repo: string;
  request: string;
  source: 'instructions' | 'tracker';
  base: string;
  checks: string[];
  understanding: string;
  approach: string;
  files: PlannedFile[];
  out_of_scope: string[];
  criteria: string[];
  open_questions: string[];
  answers: string[];
  author: string;
  vendor: Vendor;
  model: string;
  cost_usd: string;
  status: PlanStatus;
  branch: string | null;
  change_request: string | null;
  created_at: Date;
}

const SELECT = `
  SELECT p.id, p.work_item_id, w.key, w.title, p.task_id, p.repo, p.request, p.source,
         p.base, p.checks, p.understanding, p.approach, p.files, p.out_of_scope, p.criteria,
         p.open_questions, p.answers, p.author, p.vendor, p.model, p.cost_usd, p.status,
         p.branch, p.change_request, p.created_at
    FROM plans p JOIN work_items w ON w.id = p.work_item_id`;

function hydrate(r: Row): StoredPlan {
  return {
    id: r.id,
    workItemId: r.work_item_id,
    workItemKey: r.key,
    title: r.title,
    taskId: r.task_id,
    repo: r.repo,
    request: r.request,
    source: r.source,
    base: r.base,
    checks: r.checks,
    understanding: r.understanding,
    approach: r.approach,
    files: r.files,
    outOfScope: r.out_of_scope,
    criteria: r.criteria,
    openQuestions: r.open_questions,
    answers: r.answers,
    author: r.author,
    vendor: r.vendor,
    model: r.model,
    costUsd: Number(r.cost_usd),
    status: r.status,
    ...(r.branch === null ? {} : { branch: r.branch }),
    ...(r.change_request === null ? {} : { changeRequest: r.change_request }),
    createdAt: r.created_at,
  };
}

export class PgPlans {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(
    workItemId: string,
    taskId: string,
    src: PlanSource,
    plan: PlanSubmission,
  ): Promise<string> {
    const { rows } = await this.#pool.query<{ id: string }>(
      `INSERT INTO plans (work_item_id, task_id, repo, request, source, base, checks,
                          understanding, approach, files, out_of_scope, criteria, open_questions,
                          author, vendor, model, tokens_in, tokens_out, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,
               $14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        workItemId,
        taskId,
        src.repo,
        src.request,
        src.source,
        src.base,
        JSON.stringify(src.checks),
        plan.understanding,
        plan.approach,
        JSON.stringify(plan.files),
        JSON.stringify(plan.outOfScope),
        JSON.stringify(plan.criteria),
        JSON.stringify(plan.openQuestions),
        plan.author.agent,
        plan.author.vendor,
        plan.author.model,
        plan.cost.tokensIn,
        plan.cost.tokensOut,
        plan.cost.usd,
      ],
    );
    return rows[0]!.id;
  }

  async get(id: string): Promise<StoredPlan | undefined> {
    const { rows } = await this.#pool.query<Row>(`${SELECT} WHERE p.id = $1`, [id]);
    return rows[0] === undefined ? undefined : hydrate(rows[0]);
  }

  /** Matches a plan by id prefix, so an operator can type the first few characters. */
  async find(idOrPrefix: string): Promise<StoredPlan[]> {
    const { rows } = await this.#pool.query<Row>(
      `${SELECT} WHERE p.id::text LIKE $1 || '%' ORDER BY p.created_at DESC LIMIT 10`,
      [idOrPrefix],
    );
    return rows.map(hydrate);
  }

  async awaiting(): Promise<StoredPlan[]> {
    const { rows } = await this.#pool.query<Row>(
      `${SELECT} WHERE p.status = 'awaiting_approval' ORDER BY p.created_at`,
    );
    return rows.map(hydrate);
  }

  /** The most recent approved-but-unbuilt plan, which is what --resume wants. */
  async nextApproved(): Promise<StoredPlan | undefined> {
    const { rows } = await this.#pool.query<Row>(
      `${SELECT} WHERE p.status = 'approved' ORDER BY p.created_at LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : hydrate(rows[0]);
  }

  /**
   * Records the human's decision and, on approval, makes the plan's criteria
   * the work item's.
   *
   * Both in one transaction on purpose. A plan approved without its criteria
   * landing would leave the builder and the reviewer judging against the empty
   * list the work item was created with, and the reviewer would pass anything.
   */
  async decide(
    planId: string,
    decision: 'approved' | 'rejected',
    approver: string,
    answers: readonly string[],
    note?: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ work_item_id: string; criteria: string[] }>(
        `UPDATE plans SET status = $2, answers = $3::jsonb
          WHERE id = $1 AND status = 'awaiting_approval'
          RETURNING work_item_id, criteria`,
        [planId, decision, JSON.stringify(answers)],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`plan ${planId} is not awaiting approval`);
      }
      if (decision === 'approved') {
        await client.query(
          `UPDATE work_items SET acceptance_criteria = $2::jsonb WHERE id = $1`,
          [row.work_item_id, JSON.stringify(row.criteria)],
        );
      }
      await client.query(
        `INSERT INTO approvals (gate, subject_type, subject_id, approver, decision, note)
         VALUES ('plan', 'plan', $1, $2, $3, $4)`,
        [planId, approver, decision, note ?? null],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Replaces the plan body with a revision, keeping the old one.
   *
   * Called at the approval gate when the approver answered open questions, so
   * the criteria the reviewer will judge against are the ones that follow from
   * those answers rather than the ones written before they were given. The
   * previous body is appended to `revisions` first — the gate may rewrite the
   * contract, but not quietly.
   *
   * Spend accumulates rather than replaces: the plan cost what it cost to
   * write plus what it cost to revise, and reporting only the second would
   * make a revised plan look cheaper than an unrevised one.
   *
   * Guarded on `awaiting_approval` for the same reason `decide` is: a plan
   * already approved has a contract downstream depends on, and a built one has
   * a branch judged against it.
   */
  async revise(
    planId: string,
    revised: PlanInput,
    spend: { readonly tokensIn: number; readonly tokensOut: number; readonly usd: number },
    revisedBy: string,
  ): Promise<void> {
    const { rowCount } = await this.#pool.query(
      `UPDATE plans SET
         revisions = revisions || jsonb_build_object(
           'at', to_jsonb(now()),
           'by', $7::text,
           'understanding', to_jsonb(understanding),
           'approach', to_jsonb(approach),
           'files', files,
           'out_of_scope', out_of_scope,
           'criteria', criteria,
           'open_questions', open_questions
         ),
         understanding  = $2,
         approach       = $3,
         files          = $4::jsonb,
         out_of_scope   = $5::jsonb,
         criteria       = $6::jsonb,
         open_questions = $8::jsonb,
         tokens_in      = tokens_in  + $9,
         tokens_out     = tokens_out + $10,
         cost_usd       = cost_usd   + $11
       WHERE id = $1 AND status = 'awaiting_approval'`,
      [
        planId,
        revised.understanding,
        revised.approach,
        JSON.stringify(revised.files),
        JSON.stringify(revised.outOfScope),
        JSON.stringify(revised.criteria),
        revisedBy,
        JSON.stringify(revised.openQuestions),
        spend.tokensIn,
        spend.tokensOut,
        spend.usd,
      ],
    );
    if (rowCount === 0) {
      throw new Error(`plan ${planId} is not awaiting approval, so it cannot be revised`);
    }
  }

  /** Marks an approved plan as carried out, with where the result landed. */
  async built(planId: string, branch: string, changeRequest?: string): Promise<void> {
    await this.#pool.query(
      `UPDATE plans SET status = 'built', branch = $2, change_request = $3 WHERE id = $1`,
      [planId, branch, changeRequest ?? null],
    );
  }

  /**
   * Records a pull request opened for a plan that did not pass.
   *
   * Distinct from `built` on purpose. `built` means the loop carried the plan
   * out; this means it gave up and left a person a pull request to read. The
   * status stays `approved`, because the work the plan describes has not been
   * done to the standard the plan set — and a row that claimed otherwise would
   * make an escalation indistinguishable from a success in every report built
   * on this table.
   */
  async parked(planId: string, branch: string, changeRequest?: string): Promise<void> {
    await this.#pool.query(
      `UPDATE plans SET branch = $2, change_request = $3 WHERE id = $1`,
      [planId, branch, changeRequest ?? null],
    );
  }

  /** Records the branch as soon as it exists, before the outcome is known. */
  async building(planId: string, branch: string): Promise<void> {
    await this.#pool.query('UPDATE plans SET branch = $2 WHERE id = $1', [planId, branch]);
  }
}
