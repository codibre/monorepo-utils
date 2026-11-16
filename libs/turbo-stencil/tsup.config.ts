import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
});
