/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      // Every source file is measured, not just the ones a test happens to
      // import: Vitest 4 counts an untested file only when `include` is set,
      // so without it a never-imported component is invisible to the total.
      // Vitest 4 also replaces (rather than merges) the default excludes,
      // hence the explicit type-only entries. Barrel index.ts files stay measured:
      // a pure re-export costs nothing, and src/stores/index.ts, src/api/index.ts
      // and the gantt barrels carry real logic. This list is fixed:
      // never add a file to it to get past a floor — write the test instead.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/**/*.d.ts',
        'src/types/**',
      ],
      // `text` is what the CI log shows; `lcov` feeds the diff-coverage gate
      // on changed lines and `json-summary` the job summary and the README
      // badge (.github/workflows/frontend.yml). diff-cover reads an `SF:`
      // path as absolute or relative to the git root, so the LCOV report is
      // rooted at the repository, not at frontend/ — otherwise no changed
      // line ever matches and the gate passes vacuously.
      reporter: [
        'text',
        ['lcov', { projectRoot: path.resolve(__dirname, '..') }],
        'json-summary',
      ],
      // Floors just under the measured totals, raised in any PR that lifts
      // the number and never lowered. `vitest run --coverage` fails below
      // them. Set from the CI totals (Node 24, 2026-10-16: lines 88.4,
      // statements 87.16, functions 87.8, branches 76.59), not a local run.
      thresholds: {
        lines: 87.9,
        statements: 86.6,
        functions: 87.3,
        branches: 76.0,
      },
    },
  },
});
