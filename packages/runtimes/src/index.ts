export * from './fake.js';
export * from './prompt.js';
// Named rather than star-exported: both CLI runtimes define DEFAULT_MODEL and
// mapEvent, which are internals their own tests import directly. The barrel
// carries the runtimes and the one constant a caller needs.
export { ClaudeCliRuntime, type ClaudeCliOptions } from './claude-cli.js';
export { CodexCliRuntime, type CodexCliOptions, type Sandbox } from './codex-cli.js';
export { DEFAULT_MODEL } from './claude-cli.js';
export { writeGuard, guardSource } from './guard.js';
