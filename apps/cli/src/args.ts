/**
 * Flag parsing, shared by the commands.
 *
 * `--name value` and `--name=value` both work, because both get typed and
 * refusing one of them teaches nothing.
 */

export function flag(args: readonly string[], name: string): string | undefined {
  const exact = args.find((a) => a.startsWith(`--${name}=`));
  if (exact !== undefined) return exact.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Every occurrence, in order. For flags that are naturally repeated. */
export function flags(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith(`--${name}=`)) out.push(a.split('=').slice(1).join('='));
    else if (a === `--${name}` && args[i + 1] !== undefined) out.push(args[++i]!);
  }
  return out;
}

/** True when `value` is the argument to a preceding --flag. */
export function isFlagValue(args: readonly string[], value: string): boolean {
  const i = args.indexOf(value);
  return i > 0 && (args[i - 1]?.startsWith('--') ?? false) && !args[i - 1]!.includes('=');
}

/** The first bare word, which is how every command takes its subject. */
export function positional(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith('--') && !isFlagValue(args, a));
}

/**
 * Asks before spending.
 *
 * Every real run costs money at two vendors, so a command that is about to
 * spend says what and waits — unless --yes, or unless nothing is attached to
 * answer, in which case refusing is more useful than silently proceeding.
 */
export async function confirm(question: string, args: readonly string[]): Promise<boolean> {
  if (args.includes('--yes') || args.includes('-y')) return true;
  if (!process.stdin.isTTY) {
    console.error(`${question}\n\nNothing is attached to answer. Re-run with --yes to go ahead.`);
    return false;
  }
  process.stdout.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(chunk.toString('utf8').trim().toLowerCase());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
  return answer === 'y' || answer === 'yes';
}
