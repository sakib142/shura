/**
 * `shura smoke` — does this machine have what a run needs?
 *
 * Shura drives the vendor CLIs under the user's own subscription, so the
 * question is no longer "is this API key valid" but "is the CLI installed, is
 * it logged in, and is it logged in as a subscription rather than an API key".
 *
 * The last one matters most and is the easiest to get silently wrong: a key in
 * the environment puts every run back on metered billing, which is the thing
 * this project reorganised itself to avoid. One real round-trip per CLI is the
 * only honest way to check, and on a subscription it costs nothing.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

interface Engine {
  readonly bin: string;
  readonly vendor: string;
  readonly role: string;
  /** Proves it answers, and reports how it is authenticated. */
  probe: () => Promise<{ ok: boolean; detail: string; metered?: boolean }>;
}

const ENGINES: readonly Engine[] = [
  {
    bin: 'claude',
    vendor: 'anthropic',
    role: 'builds and plans',
    probe: async () => {
      const { stdout } = await exec(
        'claude',
        [
          '-p',
          'Reply with exactly: ok',
          '--output-format',
          'json',
          '--model',
          'claude-haiku-4-5',
          '--allowedTools',
          '--strict-mcp-config',
          '--setting-sources',
          '',
        ],
        { env: { ...process.env, ANTHROPIC_API_KEY: '' }, timeout: 120_000, maxBuffer: 1 << 20 },
      );
      const parsed = JSON.parse(stdout) as {
        is_error?: boolean;
        result?: string;
        total_cost_usd?: number;
      };
      if (parsed.is_error === true) return { ok: false, detail: parsed.result ?? 'returned an error' };
      return {
        ok: true,
        detail: `answered "${(parsed.result ?? '').trim().slice(0, 20)}"`,
      };
    },
  },
  {
    bin: 'codex',
    vendor: 'openai',
    role: 'reviews',
    probe: async () => {
      const { stdout } = await exec(
        'codex',
        [
          'exec',
          '--json',
          '-s',
          'read-only',
          '--ignore-user-config',
          '--ephemeral',
          '--skip-git-repo-check',
          'Reply with exactly: ok',
        ],
        { env: { ...process.env, OPENAI_API_KEY: '' }, timeout: 120_000, maxBuffer: 1 << 20 },
      );
      for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const e = JSON.parse(line) as { type?: string; item?: { text?: string } };
          if (e.type === 'item.completed' && e.item?.text !== undefined) {
            return { ok: true, detail: `answered "${e.item.text.trim().slice(0, 20)}"` };
          }
        } catch {
          continue;
        }
      }
      return { ok: false, detail: 'produced no answer' };
    },
  },
];

const ok = (s: string): string => `  ok    ${s}`;
const no = (s: string): string => `  ----  ${s}`;

export async function smoke(only?: string): Promise<number> {
  const engines = only === undefined ? ENGINES : ENGINES.filter((e) => e.bin === only || e.vendor === only);
  if (engines.length === 0) {
    console.error(`unknown engine "${only}". Try: ${ENGINES.map((e) => e.bin).join(', ')}`);
    return 2;
  }

  const lines: string[] = [];
  let fatal = false;
  const working: string[] = [];

  for (const engine of engines) {
    // A key in the environment silently restores metered billing. Worth saying
    // before the round-trip, because the round-trip would not reveal it.
    const keyVar = engine.vendor === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if ((process.env[keyVar] ?? '') !== '') {
      lines.push(
        no(
          `${keyVar} is set. Shura blanks it per run so work stays on your subscription, ` +
            'but anything else you run will be billed per token.',
        ),
      );
    }

    try {
      await exec(engine.bin, ['--version'], { timeout: 15_000 });
    } catch {
      lines.push(no(`${engine.bin} is not installed — needed to run the agent that ${engine.role}`));
      fatal = true;
      continue;
    }

    try {
      const result = await engine.probe();
      if (result.ok) {
        lines.push(ok(`${engine.bin.padEnd(7)} ${result.detail}  (${engine.vendor}, ${engine.role})`));
        working.push(engine.vendor);
      } else {
        lines.push(no(`${engine.bin}: ${result.detail}`));
        fatal = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(
        no(
          `${engine.bin} did not answer: ${message.split('\n')[0]?.slice(0, 160)}\n` +
            `        If it is not logged in, run: ${engine.bin === 'claude' ? 'claude' : 'codex'} login`,
        ),
      );
      fatal = true;
    }
  }

  // Rule 1 needs two vendors. One working CLI is not half a platform, it is
  // none of one: no pair means no verification, and no verification is the one
  // thing Shura refuses to do.
  if (only === undefined) {
    const vendors = new Set(working);
    lines.push(
      vendors.size >= 2
        ? ok(`a reviewer can run on a different vendor from the builder (${[...vendors].join(' + ')})`)
        : no(
            'no cross-vendor pair. A verifier must run a different vendor from the producer, so ' +
              'both CLIs have to work — one on its own cannot review itself.',
          ),
    );
    if (vendors.size < 2) fatal = true;
  }

  console.log(lines.join('\n'));
  return fatal ? 1 : 0;
}
