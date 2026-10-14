/**
 * A design, in the only form an agent can actually use.
 *
 * Agents do not see pixels. What they can work from is structure: which frames
 * exist, which components repeat, what the text says, and which tokens are
 * defined. So that is what a design source produces, and the design-analyst
 * prompt is written against exactly this shape.
 *
 * Two implementations are needed, not one. The REST API works for files a
 * token can read — but a token often cannot: an organisation's files may be
 * reachable through a session and not through a personal token, and an
 * air-gapped client has no route to figma.com at all. So an extract produced
 * elsewhere and committed alongside the code is a first-class source, not a
 * fallback.
 */

export interface DesignNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly width?: number;
  readonly height?: number;
}

export interface DesignText {
  readonly name: string;
  readonly characters: string;
}

export interface DesignExtract {
  readonly source: 'figma';
  readonly fileKey: string;
  readonly fileName: string;
  readonly nodeId: string;
  readonly nodeName: string;
  /** When this was taken. A design moves; a brief written from a stale extract
   *  describes something that no longer exists. */
  readonly extractedAt: string;
  readonly frames: readonly DesignNode[];
  /** Component instances and how often each appears. Repetition is the signal
   *  that something is a reusable piece rather than a one-off. */
  readonly components: readonly { readonly name: string; readonly count: number }[];
  readonly text: readonly DesignText[];
  /** Named design tokens: colours, typography, spacing. */
  readonly tokens: Readonly<Record<string, string>>;
  readonly screenshotPath?: string;
}

export interface DesignSource {
  get(nodeId: string): Promise<DesignExtract>;
}
