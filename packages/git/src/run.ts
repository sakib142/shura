/**
 * Running git.
 *
 * Identity is passed per command through the environment, never read from the
 * machine's git config. Two reasons: an agent commit authored by whoever owns
 * the laptop makes the audit trail worthless — section 9 of the architecture
 * requires every commit to say which agent wrote it — and a sandbox should not
 * inherit ambient configuration it did not ask for.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGit } from './resolve.js';

const exec = promisify(execFile);

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Strips anything credential-shaped out of text that is about to be shown,
 * logged, persisted or handed to a model.
 *
 * This lives here, in the error, rather than at the call sites that happen to
 * pass a credential. A remote URL carries its token in the argv, and GitError
 * echoes the argv — so every caller that clones or pushes over HTTPS would have
 * to remember to redact, and the one that forgot printed a live GitHub PAT to
 * the terminal and into the event log.
 *
 * Redacting at the single point where git failures become text means no caller
 * has to remember.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // https://user:token@host and https://token@host
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
      // Bare tokens, in case one reaches an argument or a message directly.
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[redacted]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_[redacted]')
      .replace(/\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20,}/g, 'sk-[redacted]')
      .replace(/\bAIza[A-Za-z0-9_-]{30,}/g, 'AIza[redacted]')
  );
}

export class GitError extends Error {
  /** Redacted, so even reading `err.args` cannot recover a credential. */
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], readonly code: number, stderr: string) {
    const safeArgs = args.map(redactSecrets);
    const safeStderr = redactSecrets(stderr);
    super(`git ${safeArgs.join(' ')} failed (${code}): ${safeStderr.trim()}`);
    this.name = 'GitError';
    this.args = safeArgs;
    this.stderr = safeStderr;
  }
}

export class Git {
  readonly #cwd: string;
  readonly #identity: GitIdentity | undefined;

  constructor(cwd: string, identity?: GitIdentity) {
    this.#cwd = cwd;
    this.#identity = identity;
  }

  withIdentity(identity: GitIdentity): Git {
    return new Git(this.#cwd, identity);
  }

  at(cwd: string): Git {
    return this.#identity === undefined ? new Git(cwd) : new Git(cwd, this.#identity);
  }

  async run(...args: string[]): Promise<GitResult> {
    const git = resolveGit();
    try {
      const { stdout, stderr } = await exec(git.path, args, {
        cwd: this.#cwd,
        env: this.#env(),
        maxBuffer: 32 * 1024 * 1024,
      });
      return { stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      throw new GitError(args, e.code ?? -1, e.stderr ?? String(err));
    }
  }

  /** Runs without throwing, for commands whose failure is information. */
  async tryRun(...args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    try {
      const r = await this.run(...args);
      return { ok: true, ...r };
    } catch (err) {
      return {
        ok: false,
        stdout: '',
        stderr: err instanceof GitError ? err.stderr : redactSecrets(String(err)),
      };
    }
  }

  #env(): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      // Never let a machine-level config decide who an agent is.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
    if (this.#identity === undefined) return base;
    return {
      ...base,
      GIT_AUTHOR_NAME: this.#identity.name,
      GIT_AUTHOR_EMAIL: this.#identity.email,
      GIT_COMMITTER_NAME: this.#identity.name,
      GIT_COMMITTER_EMAIL: this.#identity.email,
    };
  }
}

/** The identity an agent commits under, so a commit names its author. */
export function agentIdentity(agentName: string, role: string, model: string): GitIdentity {
  return { name: `${agentName} (${role})`, email: `${agentName}+${model}@agents.shura.local` };
}
