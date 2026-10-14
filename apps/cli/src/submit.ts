/**
 * `forge submit` — define a work item.
 *
 * Acceptance criteria are the interface to this whole system: they are what
 * the reviewer judges against, so a vague criterion produces a vague verdict
 * and no model capability recovers it. This command therefore refuses a
 * criterion that is not in Given/When/Then form rather than accepting it and
 * disappointing you later.
 */

import { readFileSync } from 'node:fs';
import { createPool, isReachable } from '@forge/db';

export interface Submission {
  readonly key: string;
  readonly title: string;
  readonly criteria: string[];
}

export class SubmissionInvalid extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'SubmissionInvalid';
  }
}

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * A markdown file:
 *
 *   # ORD-42: Filter orders by status
 *   - Given a status filter, when orders are listed, then only ...
 *   - Given no filter, when orders are listed, then ...
 */
export function parseSubmission(text: string): Submission {
  const problems: string[] = [];
  const lines = text.split('\n');

  const heading = lines.find((l) => l.startsWith('# '))?.slice(2).trim() ?? '';
  const [rawKey, ...rest] = heading.split(':');
  const key = (rawKey ?? '').trim();
  const title = rest.join(':').trim();

  if (!KEY.test(key)) problems.push(`"${key}" is not a work item key. Expected something like ORD-42.`);
  if (title === '') problems.push('no title. Use "# ORD-42: What this does".');

  const criteria = lines
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l !== '');

  if (criteria.length === 0) {
    problems.push('no acceptance criteria. List them as "- Given ... when ... then ...".');
  }

  // The reviewer judges against these, so a criterion no test could check is a
  // criterion the verdict cannot mean anything about.
  criteria.forEach((c, i) => {
    const lower = c.toLowerCase();
    if (!lower.includes('given') || !lower.includes('when') || !lower.includes('then')) {
      problems.push(
        `criterion ${i} is not in Given/When/Then form: "${truncate(c)}". ` +
          'The reviewer judges against these, so each must name a condition, an action and an outcome.',
      );
    }
  });

  if (problems.length > 0) throw new SubmissionInvalid(problems);
  return { key, title, criteria };
}

function truncate(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

export async function submit(args: string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith('--'));
  if (file === undefined) {
    console.error('usage: forge submit <file.md>\n');
    console.error('  # ORD-42: Filter orders by status');
    console.error('  - Given a status filter, when orders are listed, then only those are returned');
    return 2;
  }

  let submission: Submission;
  try {
    submission = parseSubmission(readFileSync(file, 'utf8'));
  } catch (err) {
    if (!(err instanceof SubmissionInvalid)) throw err;
    console.error(`${file} cannot be submitted:\n`);
    for (const p of err.problems) console.error(`  - ${p}`);
    return 1;
  }

  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error('postgres unreachable — run: pnpm db:up && pnpm migrate');
    await pool.end();
    return 1;
  }

  await pool.query(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', $2, $3::jsonb, 'draft')
     ON CONFLICT (key) DO UPDATE
       SET title = EXCLUDED.title, acceptance_criteria = EXCLUDED.acceptance_criteria`,
    [submission.key, submission.title, JSON.stringify(submission.criteria)],
  );
  await pool.end();

  console.log(`${submission.key}  ${submission.title}`);
  for (const [i, c] of submission.criteria.entries()) console.log(`  [${i}] ${c}`);
  console.log(`\nsubmitted. Run it with:  forge run ${submission.key}`);
  return 0;
}
