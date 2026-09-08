import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Library + CLI: externals stay as dependencies.
    entry: { index: 'src/index.ts', cli: 'src/cli/index.ts' },
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    dts: { entry: { index: 'src/index.ts' } },
    sourcemap: true,
    clean: true,
    banner: ({ format }) => (format === 'cjs' ? {} : {}),
  },
  {
    // GitHub Action: single self-contained bundle (no node_modules at runtime).
    entry: { 'action/index': 'src/action/index.ts' },
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    noExternal: [/.*/],
    sourcemap: false,
    minify: false,
    clean: false,
  },
]);
