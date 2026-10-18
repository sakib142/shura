/**
 * Repo-relative paths, shared by every schema that names a file.
 *
 * Its own module because both the tool catalog and the plan contract need it,
 * and the catalog already imports the verdict contract — putting this in either
 * of those would make the import graph a cycle.
 *
 * Anthropic's SWE-bench write-up found models made mistakes with ambiguous file
 * paths until the rule was made unambiguous; ours is repo-relative with no
 * escape, which doubles as a sandbox control and holds unchanged when the
 * worktree driver becomes a container.
 */

import { z } from 'zod';

/**
 * Files an agent may not read, however the repository feels about them.
 *
 * A repository that commits its .env is a repository with a problem, but it is
 * a common problem, and "the repo should not have done that" is no comfort once
 * the contents have been sent to two model vendors. This happened on a real
 * run: the target committed a .env, did not ignore it, and the agent read it
 * while exploring.
 *
 * So the refusal lives here rather than relying on the repository. Example and
 * template files are explicitly allowed — they exist to be read, and an agent
 * that cannot see .env.example cannot learn what configuration a project
 * expects.
 */
export const SECRET_FILE =
  /(^|\/)(\.env(\.[^/]*)?|\.netrc|\.npmrc|\.pgpass|id_[rd]sa|id_ecdsa|id_ed25519|credentials|secrets?\.(ya?ml|json|txt))$|\.(pem|key|p12|pfx|keystore|jks)$/i;

/** .env.example and friends are documentation, not credentials. */
export const SECRET_EXCEPTION = /(^|\/)\.env\.(example|sample|template|dist|defaults?)$/i;

/**
 * The same two patterns, as text.
 *
 * A CLI-driven agent uses its own file tools, which never reach Shura's
 * gateway — the refusal has to be re-stated in a hook the CLI runs instead.
 * Serialising the patterns keeps one source of truth: a path added here is
 * refused on both paths, rather than in whichever one someone remembered.
 */
export const SECRET_PATTERNS = {
  file: SECRET_FILE.source,
  exception: SECRET_EXCEPTION.source,
} as const;

export function isSecretPath(path: string): boolean {
  if (SECRET_EXCEPTION.test(path)) return false;
  return SECRET_FILE.test(path);
}

export const RepoPath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9._\-/]+$/, 'may contain only letters, digits, dot, underscore, hyphen, slash')
  .refine((p) => !p.startsWith('/'), { message: 'must be repo-relative, not absolute' })
  .refine((p) => !p.split('/').includes('..'), { message: 'may not contain a ".." segment' })
  .refine((p) => !p.includes('//'), { message: 'may not contain an empty path segment' })
  .refine((p) => !p.startsWith('.git/'), { message: 'may not touch the git directory' })
  .refine((p) => !isSecretPath(p), {
    message:
      'this file holds credentials and is not readable. If you need to know what configuration ' +
      'the project expects, read its example file (.env.example) instead',
  });
