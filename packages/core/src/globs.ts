/**
 * Do two sets of file globs overlap?
 *
 * This is what stops two agents editing the same files. It is deliberately
 * **conservative**: when it cannot prove two patterns are disjoint it says they
 * overlap, and the second claim is refused.
 *
 * That asymmetry is the whole point. A false "they overlap" costs a task a
 * queue position. A false "they are disjoint" lets two agents write the same
 * file and silently lose one of their work. One of those is recoverable.
 */

/** A segment with no wildcard. */
function isLiteral(segment: string): boolean {
  return !segment.includes('*') && !segment.includes('?');
}

function toRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/**
 * Can one path segment satisfy both patterns?
 *
 * Both sides wildcarded is the case we do not try to decide. Proving two
 * patterns disjoint is cheap to get wrong — `*.ts` and `list.*` look unrelated
 * and both match `list.ts` — so that answer is always "yes, they might".
 */
function segmentsOverlap(a: string, b: string): boolean {
  if (a === '*' || b === '*') return true;
  if (isLiteral(a) && isLiteral(b)) return a === b;
  if (isLiteral(a)) return toRegExp(b).test(a);
  if (isLiteral(b)) return toRegExp(a).test(b);
  return true;
}

/** `**` matches any number of segments, including none. */
function walk(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0) return b.every((s) => s === '**');
  if (b.length === 0) return a.every((s) => s === '**');

  const [ah, ...at] = a;
  const [bh, ...bt] = b;

  // Every branch shortens one side or the other, so this terminates.
  if (ah === '**') return walk(at, b) || walk(a, bt) || walk(at, bt);
  if (bh === '**') return walk(a, bt) || walk(at, b) || walk(at, bt);

  if (!segmentsOverlap(ah!, bh!)) return false;
  return walk(at, bt);
}

export function globsOverlap(a: string, b: string): boolean {
  return walk(normalise(a), normalise(b));
}

function normalise(glob: string): string[] {
  return glob
    .replace(/^\.\//, '')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
}

/** Which patterns in `wanted` collide with anything in `held`. */
export function overlappingGlobs(
  wanted: readonly string[],
  held: readonly string[],
): { readonly wanted: string; readonly held: string }[] {
  const clashes: { wanted: string; held: string }[] = [];
  for (const w of wanted) {
    for (const h of held) {
      if (globsOverlap(w, h)) clashes.push({ wanted: w, held: h });
    }
  }
  return clashes;
}
