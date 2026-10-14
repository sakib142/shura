import { describe, expect, it } from 'vitest';
import { globsOverlap, overlappingGlobs } from './globs.js';

describe('obvious overlaps', () => {
  it.each([
    ['src/orders/**', 'src/orders/list.ts'],
    ['src/**', 'src/orders/list.ts'],
    ['src/orders/list.ts', 'src/orders/list.ts'],
    ['src/*.ts', 'src/a.ts'],
    ['**/*.test.ts', 'src/deep/a.test.ts'],
    ['src/**', 'src/**'],
    ['**', 'anything/at/all.ts'],
  ])('%s overlaps %s', (a, b) => {
    expect(globsOverlap(a, b)).toBe(true);
    expect(globsOverlap(b, a)).toBe(true);
  });
});

describe('genuinely separate paths', () => {
  it.each([
    ['src/orders/**', 'src/users/**'],
    ['src/orders/list.ts', 'src/orders/detail.ts'],
    ['src/a.ts', 'test/a.ts'],
    ['src/*.ts', 'test/*.ts'],
    ['src/orders/**', 'docs/**'],
  ])('%s does not overlap %s', (a, b) => {
    expect(globsOverlap(a, b)).toBe(false);
    expect(globsOverlap(b, a)).toBe(false);
  });
});

describe('when in doubt, say they overlap', () => {
  // A false "disjoint" lets two agents write the same file and lose one of
  // their work. A false "overlapping" costs a queue position. Only one of
  // those is recoverable, so ambiguity resolves to overlap.
  it('does not try to prove two wildcard patterns disjoint', () => {
    // Both match list.ts, which a naive comparison would miss.
    expect(globsOverlap('src/*.ts', 'src/list.*')).toBe(true);
  });

  it('treats a bare * as matching any single segment', () => {
    expect(globsOverlap('src/*/a.ts', 'src/orders/a.ts')).toBe(true);
  });

  it('is still willing to say no when the suffix settles it', () => {
    expect(globsOverlap('src/a.ts', 'src/*.js')).toBe(false);
  });
});

describe('** spans any number of segments, including none', () => {
  it.each([
    ['src/**', 'src'],
    ['src/**/a.ts', 'src/a.ts'],
    ['src/**/a.ts', 'src/x/y/a.ts'],
    ['**/a.ts', 'a.ts'],
  ])('%s overlaps %s', (a, b) => {
    expect(globsOverlap(a, b)).toBe(true);
  });
});

describe('leading ./ and stray separators do not change the answer', () => {
  it.each([
    ['./src/orders/**', 'src/orders/list.ts'],
    ['src//orders/**', 'src/orders/list.ts'],
  ])('%s overlaps %s', (a, b) => {
    expect(globsOverlap(a, b)).toBe(true);
  });
});

describe('reporting the clash', () => {
  it('names which pattern collided with which', () => {
    const clashes = overlappingGlobs(['src/orders/**', 'docs/**'], ['src/**', 'infra/**']);
    expect(clashes).toEqual([{ wanted: 'src/orders/**', held: 'src/**' }]);
  });

  it('is empty when nothing collides', () => {
    expect(overlappingGlobs(['docs/**'], ['src/**'])).toEqual([]);
  });
});
