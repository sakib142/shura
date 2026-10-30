/**
 * The system prompt an agent runs under.
 *
 * Built from the role file plus the task context. Explicit and categorical
 * rather than exhortative: "report X, skip Y" beats "be careful", and a
 * confidence threshold in prose does nothing a schema cannot do better.
 */

import type { RunRequest } from '@shura/ports';

export function systemPrompt(req: RunRequest): string {
  const { role, context } = req;
  const parts: string[] = [role.instructions];

  parts.push(
    [
      'Operating rules:',
      '- Every tool call is checked before it runs. A denial tells you why and whether retrying can help.',
      '- A denial marked retryable means the arguments were wrong: fix them and call again.',
      '- A denial marked non-retryable means your role may not do this. Do not try another route to it.',
      '- Work only from what the tools return. Do not assume a file exists or a test passes without checking.',
    ].join('\n'),
  );

  if (role.kind === 'verify') {
    parts.push(
      [
        'You are verifying work produced by a different agent on a different vendor model.',
        'You cannot edit anything; your only write is the verdict.',
        'Judge against the acceptance criteria and the evidence, never against the producer account of its own work.',
        'Address every criterion. A criterion you cannot judge is not met.',
      ].join('\n'),
    );
  }

  if (context.acceptanceCriteria.length > 0) {
    parts.push(
      'Acceptance criteria (referenced by index):\n' +
        context.acceptanceCriteria.map((c, i) => `  [${i}] ${c}`).join('\n'),
    );
  }

  if (context.plan !== undefined) {
    const plan = context.plan;
    const block = [
      'An approved plan already exists for this task. A human read it and agreed to it, so it',
      'is the agreement you are carrying out — not a suggestion. Follow it. If you find while',
      'working that it cannot be followed, say so in a tracker comment and stop; do not quietly',
      'substitute a different approach, because the criteria were approved against this one.',
      '',
      `What the task is: ${plan.understanding}`,
      '',
      `Approach: ${plan.approach}`,
    ];
    if (plan.files.length > 0) {
      block.push(
        '',
        'Files the plan expects to touch. Touching a file that is not listed is allowed when the',
        'work genuinely needs it; leaving a listed one untouched means the plan was wrong about',
        'something, which is worth a note:',
        ...plan.files.map((f) => `  ${f.path} — ${f.reason}`),
      );
    }
    if (plan.outOfScope.length > 0) {
      block.push('', 'Explicitly out of scope. Do not do these:', ...plan.outOfScope.map((o) => `  - ${o}`));
    }
    if (plan.answeredQuestions !== undefined && plan.answeredQuestions.length > 0) {
      block.push(
        '',
        'The plan raised questions and the approver answered them. These answers are decisions:',
        ...plan.answeredQuestions.map((q) => `  Q: ${q.question}\n  A: ${q.answer}`),
      );
    }
    parts.push(block.join('\n'));
  }

  if (context.repoRules !== undefined) parts.push(`Repository rules:\n${context.repoRules}`);

  if (context.lessons !== undefined && context.lessons.length > 0) {
    parts.push(`Lessons from previous work:\n${context.lessons.map((l) => `- ${l}`).join('\n')}`);
  }

  if (context.buildFailure !== undefined) {
    parts.push(
      'The previous attempt left the build failing, so it was not published. This is the output.\n' +
        'Fix the cause rather than the symptom, and run the checks yourself before you finish:\n' +
        context.buildFailure,
    );
  }

  if (context.priorFindings !== undefined && context.priorFindings.length > 0) {
    parts.push(
      `This is attempt ${context.attempt}. The previous attempt was sent back with these findings; ` +
        `address each one:\n${JSON.stringify(context.priorFindings, null, 2)}`,
    );
  }

  return parts.join('\n\n');
}

export function userPrompt(req: RunRequest): string {
  const { context } = req;
  const parts = [
    `Work item: ${context.workItemKey}`,
    ...(context.title === undefined ? [] : [`Title: ${context.title}`]),
    `Artifact type: ${context.artifactType}`,
  ];
  if (context.request !== undefined) {
    parts.push(
      'The request, as the person who filed it wrote it. It is free-form and may be incomplete;\n' +
        'that is expected, and what it leaves unsettled is what open questions are for:\n\n' +
        context.request,
    );
  }
  if (context.diff !== undefined) parts.push(`Diff under review:\n${context.diff}`);
  if (context.checkResults !== undefined) {
    parts.push(`Check results:\n${JSON.stringify(context.checkResults, null, 2)}`);
  }
  return parts.join('\n\n');
}
