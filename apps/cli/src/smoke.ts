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

import { spawn } from 'node:child_process';

/**
 * Run a CLI and collect its stdout, with **stdin closed**.
 *
 * `promisify(execFile)` hands the child an stdin pipe that nothing ever ends,
 * and `codex exec` reads stdin when it is not a TTY. Against codex 0.161.0 the
 * probe sat on "Reading additional input from stdin..." until the timeout, then
 * read empty output and reported that codex had produced no answer — while
 * codex answered the same prompt fine from a terminal. A green claude and a red
 * codex also reads as "no cross-vendor pair", which is the one finding that
 * stops a run outright, so the false alarm was the expensive kind.
 *
 * The runtime that does the real work never had this bug: it spawns with
 * `stdio: ['ignore', ...]` (see codex-cli.ts). A probe wired differently from a
 * run is not probing the run, so this is the same wiring.
 *
 * A timeout rejects here rather than resolving empty, because "it did not
 * answer within 120s" and "it answered nothing" are different findings and the
 * caller reports them differently.
 */
function exec(
  bin: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; timeout: number; maxBuffer?: number },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      ...(opts.env === undefined ? {} : { env: opts.env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const cap = opts.maxBuffer ?? 1 << 20;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (err === undefined) resolve({ stdout });
      else reject(err);
    };

    const timer = setTimeout(() => {
      finish(new Error(`no answer within ${Math.round(opts.timeout / 1000)}s`));
    }, opts.timeout);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > cap) finish(new Error(`more than ${cap} bytes of output`));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      finish(err);
    });
    child.on('close', (code) => {
      if (code === 0) finish(undefined);
      else finish(new Error(stderr.trim().split('\n')[0] ?? `exited ${code ?? 'on a signal'}`));
    });
  });
}

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
