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
      // statements 87.16, functions 87.8, branches 76.59). Raised with 1.13.0
      // from a local Node 25 run (lines 91.38, statements 90.27, functions
      // 91.84, branches 81.28), with room for Node 24 and the merged CI shards.
      // Raised with the date picker by its lift on the same local run (lines
      // 91.51, statements 90.4, functions 91.98, branches 81.55), then with
      // 1.14.0 to 0.3 under the local totals (lines 91.6, statements 90.48,
      // functions 91.97, branches 81.59), rounded down; with the admin
      // defaults likewise (lines 91.78, statements 90.67, functions 92.2,
      // branches 81.88); with the per-person booking rows of 1.17.0 (local
      // lines 92.2, statements 91.08, functions 92.44, branches 82.64);
      // with the project fields of 2.0.0, 0.3 under the local totals (lines
      // 92.7, statements 91.61, functions 93.32, branches 83.14).
      thresholds: {
        lines: 92.4,
        statements: 91.3,
        functions: 93.0,
        branches: 82.8,
      },
    },
  },
});
