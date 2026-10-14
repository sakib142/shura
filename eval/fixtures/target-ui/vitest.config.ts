import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The automatic runtime, so components do not have to import React.
  esbuild: { jsx: 'automatic' },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.ts'] },
});
