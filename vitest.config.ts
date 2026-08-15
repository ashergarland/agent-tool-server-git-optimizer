import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/mcp/stdio.ts'],
      thresholds: { lines: 88, functions: 88, statements: 88, branches: 78 },
    },
  },
});
