import { readFileSync } from 'node:fs';
import { build, context } from 'esbuild';

const { version } = JSON.parse(readFileSync('plugin/manifest.json', 'utf8'));

const options = {
  entryPoints: ['src/main.ts'],
  outfile: 'plugin/js/plugin.js',
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'iife',
  external: ['electron'],
  define: { __PLUGIN_VERSION__: JSON.stringify(version) },
  sourcemap: false,
  logLevel: 'info'
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
