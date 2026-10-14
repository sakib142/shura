/**
 * Atlassian Document Format.
 *
 * Jira Cloud stores descriptions and comments as a node tree, not as text, so
 * anything that reads a description or writes a comment has to go through
 * here. Treating the field as a string gets you "[object Object]" in the
 * ticket, which is the kind of thing that only shows up in production.
 */

export interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly content?: readonly AdfNode[];
}

/**
 * Flattens an ADF tree to plain text, one line per block.
 *
 * List items keep their bullet, because acceptance criteria are written as
 * lists and the parser downstream looks for them.
 */
export function adfToText(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const lines: string[] = [];

  const walk = (n: AdfNode, inListItem: boolean): void => {
    if (n.type === 'text' && typeof n.text === 'string') {
      const last = lines.length - 1;
      if (last >= 0) lines[last] += n.text;
      else lines.push(n.text);
      return;
    }
    if (n.type === 'hardBreak') {
      lines.push('');
      return;
    }

    const startsBlock =
      n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' || n.type === 'codeBlock';
    if (startsBlock) lines.push(inListItem && n.type === 'paragraph' ? '' : '');

    const isItem = n.type === 'listItem';
    if (isItem) {
      lines[lines.length - 1] = '- ';
    }

    for (const child of n.content ?? []) walk(child, isItem || inListItem);
  };

  walk(node as AdfNode, false);
  return lines
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && l !== '-')
    .join('\n');
}

/** Builds an ADF document from plain text, one paragraph per line. */
export function textToAdf(text: string): AdfNode {
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    // An empty paragraph must have no content array at all; Jira rejects [].
    ...(line === '' ? {} : { content: [{ type: 'text', text: line }] }),
  }));
  return { type: 'doc', version: 1, content: paragraphs } as AdfNode & { version: number };
}
