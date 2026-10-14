/**
 * The seeded-fault corpus.
 *
 * Every case must satisfy two conditions, and the probe refuses to score one
 * that does not:
 *
 *   1. The test suite passes. A fault CI catches proves nothing about a
 *      reviewer — the reviewer's job is precisely what the tests miss.
 *   2. It is genuinely wrong against a stated acceptance criterion.
 *
 * The known-good control matters as much as the faults. A reviewer that
 * rejects everything scores a perfect catch rate, and only the control tells
 * it apart from one that works.
 *
 * Two earlier faults were discarded for failing condition 1 — the agent's own
 * test suite caught them, which is a good sign about the suite and a useless
 * probe of the reviewer.
 */
export interface Case {
    readonly id: string;
    readonly title: string;
    /** What a competent reviewer ought to say. */
    readonly expectation: string;
    readonly faulty: boolean;
    /** Full replacement contents, applied over the merged tree. */
    readonly files: Readonly<Record<string, string>>;
}
export declare const CASES: readonly Case[];
//# sourceMappingURL=corpus.d.ts.map