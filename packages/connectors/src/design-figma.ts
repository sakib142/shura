/**
 * Design sources.
 *
 * FigmaApiSource talks to the REST API. FigmaExtractSource reads an extract
 * from disk. Both satisfy the same port, so the rest of the pipeline cannot
 * tell them apart — which matters because the API route is frequently not
 * available: an organisation's files may be reachable through a session but
 * not a personal token, and an air-gapped client has no route to figma.com at
 * all.
 */

import { readFileSync } from 'node:fs';
import type { DesignExtract, DesignSource } from '@forge/ports';

export class DesignUnavailable extends Error {
  constructor(
    readonly fileKey: string,
    readonly status: number,
    hint: string,
  ) {
    super(`Figma returned ${status} for file ${fileKey}. ${hint}`);
    this.name = 'DesignUnavailable';
  }
}

export interface FigmaApiOptions {
  readonly fileKey: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export class FigmaApiSource implements DesignSource {
  readonly #o: FigmaApiOptions;
  readonly #fetch: typeof fetch;

  constructor(options: FigmaApiOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async get(nodeId: string): Promise<DesignExtract> {
    const id = nodeId.replace('-', ':');
    const res = await this.#fetch(
      `https://api.figma.com/v1/files/${this.#o.fileKey}/nodes?ids=${encodeURIComponent(id)}`,
      { headers: { 'X-Figma-Token': this.#o.token } },
    );
    if (!res.ok) {
      // 404 here usually means the token is valid but cannot see this file,
      // not that the file is missing — worth saying, because the obvious
      // reading sends people hunting for a typo in the key.
      throw new DesignUnavailable(
        this.#o.fileKey,
        res.status,
        res.status === 404
          ? 'The token authenticates but cannot reach this file. Organisation files are often ' +
            'unreachable by a personal token even when the account can open them in a browser. ' +
            'Use a committed extract instead: design.type: extract.'
          : (await res.text()).slice(0, 200),
      );
    }

    const body = (await res.json()) as {
      name: string;
      nodes: Record<string, { document: FigmaNode }>;
    };
    const root = body.nodes[id]?.document;
    if (root === undefined) throw new DesignUnavailable(this.#o.fileKey, 200, `node ${id} not found`);

    return {
      source: 'figma',
      fileKey: this.#o.fileKey,
      fileName: body.name,
      nodeId: id,
      nodeName: root.name,
      extractedAt: new Date().toISOString(),
      ...summarise(root),
      tokens: {},
    };
  }
}

interface FigmaNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly characters?: string;
  readonly absoluteBoundingBox?: { width: number; height: number };
  readonly children?: readonly FigmaNode[];
}

function summarise(root: FigmaNode): Pick<DesignExtract, 'frames' | 'components' | 'text'> {
  const frames: DesignExtract['frames'][number][] = [];
  const counts = new Map<string, number>();
  const text: { name: string; characters: string }[] = [];

  const walk = (n: FigmaNode): void => {
    if (n.type === 'FRAME' && (n.absoluteBoundingBox?.width ?? 0) >= 200) {
      frames.push({
        id: n.id,
        name: n.name,
        type: n.type,
        ...(n.absoluteBoundingBox === undefined
          ? {}
          : { width: Math.round(n.absoluteBoundingBox.width), height: Math.round(n.absoluteBoundingBox.height) }),
      });
    }
    if (n.type === 'INSTANCE') counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
    if (n.type === 'TEXT' && typeof n.characters === 'string' && n.characters.trim() !== '') {
      text.push({ name: n.name, characters: n.characters });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);

  return {
    frames,
    components: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    text,
  };
}

/**
 * A design extract committed alongside the code.
 *
 * Not a lesser option: it is reproducible, it is reviewable in a pull request,
 * it works without network access, and it pins exactly which version of a
 * design a backlog was written from.
 */
export class FigmaExtractSource implements DesignSource {
  constructor(private readonly path: string) {}

  async get(nodeId?: string): Promise<DesignExtract> {
    const extract = JSON.parse(readFileSync(this.path, 'utf8')) as DesignExtract;
    if (nodeId !== undefined && nodeId !== '' && extract.nodeId !== nodeId.replace('-', ':')) {
      throw new Error(
        `${this.path} is an extract of node ${extract.nodeId}, but ${nodeId} was requested.`,
      );
    }
    return extract;
  }
}

/** What an agent is shown. Deliberately compact: a brief is written from
 *  structure, and a dump of 4,000 vector nodes buries it. */
export function renderExtract(e: DesignExtract): string {
  const lines = [
    `Design: ${e.fileName}`,
    `Section: ${e.nodeName} (${e.nodeId})`,
    `Extracted: ${e.extractedAt}`,
    '',
    'FRAMES',
    ...e.frames.map((f) => `  ${f.name}${f.width ? ` — ${f.width}x${f.height}` : ''}`),
    '',
    'COMPONENTS USED (repetition means it is reusable)',
    ...e.components.map((c) => `  ${c.count} x ${c.name}`),
    '',
    'TEXT CONTENT',
    ...e.text.map((t) => `  ${t.name}: ${JSON.stringify(t.characters)}`),
    '',
    'DESIGN TOKENS',
    ...Object.entries(e.tokens).map(([k, v]) => `  ${k} = ${v}`),
  ];
  return lines.join('\n');
}
