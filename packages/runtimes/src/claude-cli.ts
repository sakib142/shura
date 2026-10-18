/**
 * The Anthropic half of a cross-vendor pair, driven as a subprocess.
 *
 * `claude -p` rather than the Messages API, for the reason that decides
 * adoption: it authenticates with the user's existing subscription. Metered
 * billing on top of a subscription someone already pays for is a second bill.
 *
 * It also ends a long detour. Shura hand-built a read tool, a search tool, a
 * whole-file write tool and an agent loop, and a single real run cost $5.47
 * and produced one file — most of it spent re-sending a transcript that grew
 * because nothing compacted it and nothing could patch a file in place. Claude
 * Code has all of that already.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RoleDefinition, Vendor } from '@shura/core';
import type { AgentEvent, AgentRuntime, RunRequest } from '@shura/ports';
import { systemPrompt, userPrompt } from './prompt.js';
import { writeGuard } from './guard.js';

/** "Whatever this subscription provides" — see codex-cli.ts for why. */
export const DEFAULT_MODEL = 'default';

export interface ClaudeCliOptions {
  readonly bin?: string;
  readonly spawnFn?: typeof spawn;
  /**
   * Settings JSON handed to the CLI, overriding the generated guard.
   *
   * Only for tests. A real run always gets the guard, because the rules it
   * restates are not optional — they are the ones the tool gateway enforces on
   * the API path, and a CLI agent bypasses that gateway entirely.
   */
  readonly settings?: string;
}

/**
 * What each Shura grant means in Claude Code's vocabulary.
 *
 * The role definition stays the authority. Deriving the allowlist from
 * `role.kind` alone was wrong and shipped briefly: `frontend-planner` is a
 * produce role that deliberately withholds `repo.write`, and keying off the
 * kind handed it Write, Edit and Bash anyway — a planner that could rewrite
 * the repository it was supposed to be reading.
 *
 * A grant with no entry here is not a CLI tool: `plan.submit` and
 * `verdict.submit` arrive as structured output, and the tracker and claims
 * tools are not reachable from a CLI agent at all.
 */
const GRANT_TO_CLI: Readonly<Record<string, readonly string[]>> = {
  'repo.read': ['Read'],
  'docs.read': ['Read'],
  'repo.search': ['Grep', 'Glob'],
  'repo.write': ['Write', 'Edit'],
  // The only way to run the suite. It is also a write tool wearing a different
  // hat, which is why it follows repo.write rather than being given freely.
  'test.run': ['Bash'],
};

/**
 * An allowlist rather than only a denylist: anything unlisted needs permission,
 * and in headless mode there is nobody to grant it, so the default is refusal
 * rather than whatever a future CLI release adds to its toolset.
 */
export function cliToolsFor(role: RoleDefinition): readonly string[] {
  const out = new Set<string>();
  for (const grant of role.tools) {
    for (const tool of GRANT_TO_CLI[grant] ?? []) out.add(tool);
  }
  // A shell without the means to change anything is a reading tool, and a
  // verify role must not have one regardless of what its grants imply.
  if (role.kind === 'verify') {
    out.delete('Bash');
    out.delete('Write');
    out.delete('Edit');
  }
  return [...out];
}

/** Named explicitly as well, so a verify role is refused twice over. */
const DENIED_FOR_VERIFY = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];

/** Tool calls that mean a file changed, and where the path lives in their input. */
const WRITES = new Set(['Write', 'Edit', 'NotebookEdit']);

interface ClaudeEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly model?: string;
  readonly apiKeySource?: string;
  readonly session_id?: string;
  readonly message?: {
    readonly content?: readonly {
      readonly type?: string;
      readonly text?: string;
      readonly thinking?: string;
      readonly name?: string;
      readonly input?: Record<string, unknown>;
      readonly is_error?: boolean;
      readonly content?: unknown;
    }[];
  };
  readonly is_error?: boolean;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
  readonly permission_denials?: readonly { readonly tool_name?: string }[];
}

export class ClaudeCliRuntime implements AgentRuntime {
  readonly vendor: Vendor = 'anthropic';
  readonly id = 'claude-cli';
  readonly #bin: string;
  readonly #spawn: typeof spawn;
  readonly #settings: string | undefined;

  constructor(options: ClaudeCliOptions = {}) {
    this.#bin = options.bin ?? 'claude';
    this.#spawn = options.spawnFn ?? spawn;
    this.#settings = options.settings;
  }

  run(req: RunRequest): AsyncIterable<AgentEvent> {
    return this.#stream(req);
  }

  async *#stream(req: RunRequest): AsyncIterable<AgentEvent> {
    const model = req.role.model?.model;
    if (model === undefined) {
      yield { t: 'error', message: `role "${req.role.id}" declares no model` };
      return;
    }

    // The guard, generated for this run because it has to know this worktree.
    // Skipped only when a caller supplied settings of its own, which is a test.
    let scratch: string | undefined;
    let settings = this.#settings;
    if (settings === undefined && req.workdir !== undefined) {
      scratch = mkdtempSync(join(tmpdir(), 'shura-guard-'));
      settings = writeGuard({ workdir: req.workdir, dir: scratch }).settings;
    }

    const child = this.#spawn(this.#bin, argvFor(req, model, settings), {
      ...(req.workdir === undefined ? {} : { cwd: req.workdir }),
      // Blanked, not inherited. A key here would silently bill per token for
      // work the subscription already covers — the second bill this exists to
      // avoid — and `apiKeySource` in the stream is checked below to prove it.
      env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const abort = (): void => void child.kill('SIGTERM');
    req.signal.addEventListener('abort', abort, { once: true });

    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr = `${stderr}${c.toString('utf8')}`.slice(-8192);
    });

    let sawResult = false;
    try {
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.trim() === '') continue;
        let event: ClaudeEvent;
        try {
          event = JSON.parse(line) as ClaudeEvent;
        } catch {
          continue;
        }

        // The run must be on a subscription. If a key reached the process the
        // user is being billed per token without having asked to be, which is
        // worth stopping for rather than discovering on an invoice.
        if (event.subtype === 'init' && event.apiKeySource !== undefined) {
          if (event.apiKeySource !== 'none') {
            yield {
              t: 'error',
              message:
                `refusing to run: claude is authenticating with "${event.apiKeySource}", not a ` +
                'subscription, which would bill per token. Unset ANTHROPIC_API_KEY.',
            };
            child.kill('SIGTERM');
            return;
          }
        }

        for (const mapped of mapEvent(event, req.workdir)) {
          if (mapped.t === 'result' || mapped.t === 'error') sawResult = true;
          yield mapped;
        }
      }

      const code = await new Promise<number>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once('close', (c) => resolve(c ?? -1));
      });

      if (req.signal.aborted) {
        yield { t: 'error', message: `aborted: ${String(req.signal.reason ?? 'timeout')}` };
        return;
      }
      if (!sawResult) {
        yield {
          t: 'error',
          message:
            `claude exited ${code} without finishing` +
            (stderr.trim() === '' ? '' : `: ${lastLine(stderr)}`),
        };
      }
    } finally {
      req.signal.removeEventListener('abort', abort);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** The command line for one run. Exported so the tests can assert on it. */
export function argvFor(
  req: RunRequest,
  model: string,
  settings?: string,
): string[] {
  const kind: 'produce' | 'verify' = req.role.kind === 'verify' ? 'verify' : 'produce';
  const allowed = [
    ...cliToolsFor(req.role),
    // `--json-schema` makes the CLI answer through a StructuredOutput tool, so
    // asking for a schema and not allowing the tool denies the agent its own
    // output channel. A live planner hit exactly that: it composed the plan,
    // was refused, and only recovered because the final message happened to
    // carry the JSON as well.
    ...(req.outputSchema === undefined ? [] : ['StructuredOutput']),
  ];
  // Everything the role was not granted, named explicitly as well. Belt and
  // braces: the allowlist already excludes them, and a denylist survives a
  // future release that starts enabling something by default.
  const denied = [...new Set([...DENIED_FOR_VERIFY, ...Object.values(GRANT_TO_CLI).flat()])].filter(
    (t) => !allowed.includes(t),
  );
  return [
    '-p',
    userPrompt(req),
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    systemPrompt(req),
    ...(model === DEFAULT_MODEL ? [] : ['--model', model]),
    '--allowedTools',
    ...allowed,
    ...(denied.length === 0 ? [] : ['--disallowedTools', ...denied]),
    // Without this the agent inherits every MCP server the operator happens to
    // have configured — eleven of them on the machine this was written on —
    // none of which the role definition accounts for.
    '--strict-mcp-config',
    // Only what Shura passes, so a user's own CLAUDE.md and settings cannot
    // quietly change how a role behaves.
    '--setting-sources',
    '',
    ...(settings === undefined ? [] : ['--settings', settings]),
    // How a plan or a verdict comes back. A CLI agent cannot reach Shura's
    // tools, so the final answer carries the structure instead — and is still
    // put through acceptPlan/acceptVerdict on arrival.
    ...(req.outputSchema === undefined ? [] : ['--json-schema', JSON.stringify(req.outputSchema)]),
    ...(kind === 'produce' ? ['--permission-mode', 'acceptEdits'] : []),
  ];
}

/** One claude event to zero or more of ours. */
export function mapEvent(event: ClaudeEvent, workdir?: string): AgentEvent[] {
  if (event.type === 'assistant') {
    const out: AgentEvent[] = [];
    for (const block of event.message?.content ?? []) {
      if (block.type === 'thinking' && (block.thinking ?? '') !== '') {
        out.push({ t: 'reasoning', text: block.thinking! });
      } else if (block.type === 'tool_use' && block.name !== undefined) {
        out.push({ t: 'tool_call', tool: block.name, args: block.input ?? {} });
        const path = block.input?.['file_path'];
        if (WRITES.has(block.name) && typeof path === 'string') {
          // Repo-relative. The CLI reports an absolute path into a temporary
          // worktree, which is noise in the log and meaningless to anyone
          // reading it later — the worktree is gone by then.
          out.push({ t: 'file_change', path: relativeTo(workdir, path) });
        }
      }
    }
    return out;
  }

  if (event.type === 'user') {
    return (event.message?.content ?? [])
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ t: 'tool_result', ok: b.is_error !== true }));
  }

  if (event.type === 'result') {
    const u = event.usage ?? {};
    const out: AgentEvent[] = [
      {
        t: 'usage',
        tokensIn: u.input_tokens ?? 0,
        tokensOut: u.output_tokens ?? 0,
        // Reported even on a subscription, where it is what the work WOULD
        // have cost rather than what was charged. Kept because it is the only
        // comparable number across runtimes, and because a run that suddenly
        // reports a real charge is worth noticing.
        usd: event.total_cost_usd ?? 0,
        ...(u.cache_read_input_tokens === undefined
          ? {}
          : { cacheRead: u.cache_read_input_tokens }),
        ...(u.cache_creation_input_tokens === undefined
          ? {}
          : { cacheWrite: u.cache_creation_input_tokens }),
      },
    ];
    if (event.is_error === true || event.subtype === 'error') {
      out.push({ t: 'error', message: event.result ?? `claude failed (${event.subtype ?? '?'})` });
    } else {
      // Structured output arrives as a JSON string in the same field as prose.
      // Parsed here so the orchestrator receives an object and never has to
      // guess which it got.
      out.push({ t: 'result', output: parseMaybeJson(event.result ?? '') });
    }
    return out;
  }

  // system/* is session bookkeeping — init, thinking_tokens, hook lifecycle.
  // rate_limit_event carries nothing the orchestrator can act on today.
  return [];
}

/** An object when the text is one, the text otherwise. */
function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function relativeTo(workdir: string | undefined, path: string): string {
  if (workdir === undefined) return path;
  // Both sides canonicalised, not just the worktree.
  //
  // Resolving only one end was not enough: on macOS the worktree may be known
  // as /private/var while the CLI reports /var, and adding spellings of the
  // worktree still misses the case where the incoming path is the unresolved
  // one. The guard learned this the same way, and this is the same fix.
  const target = canonical(path);
  const base = canonical(workdir);
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : path;
}

/** A path with its existing ancestors resolved. The leaf may not exist yet. */
function canonical(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return realpathSync(cur) + p.slice(cur.length);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      cur = parent;
    }
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}
