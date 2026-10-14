/**
 * The system prompt an agent runs under.
 *
 * Built from the role file plus the task context. Explicit and categorical
 * rather than exhortative: "report X, skip Y" beats "be careful", and a
 * confidence threshold in prose does nothing a schema cannot do better.
 */

import type { RunRequest } from '@forge/ports';

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

  if (context.repoRules !== undefined) parts.push(`Repository rules:\n${context.repoRules}`);

  if (context.lessons !== undefined && context.lessons.length > 0) {
    parts.push(`Lessons from previous work:\n${context.lessons.map((l) => `- ${l}`).join('\n')}`);
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
    `Artifact type: ${context.artifactType}`,
  ];
  if (context.diff !== undefined) parts.push(`Diff under review:\n${context.diff}`);
  if (context.checkResults !== undefined) {
    parts.push(`Check results:\n${JSON.stringify(context.checkResults, null, 2)}`);
  }
  return parts.join('\n\n');
}
