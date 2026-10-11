import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/main.ts'],
  outfile: 'plugin/js/plugin.js',
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'iife',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info'
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
