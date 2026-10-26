// Bundles the non-Next entrypoints (supervisor, companion, worker, CLIs) to dist/.
// npm packages stay external and are installed in the image.
import { build } from 'esbuild';
import fs from 'node:fs';

const cli = fs.readdirSync('src/cli').filter((f) => f.endsWith('.ts')).map((f) => `src/cli/${f}`);
await build({
  entryPoints: ['src/processes/supervisor.ts', 'src/processes/companion.ts', 'src/processes/worker.ts', ...cli],
  outdir: 'dist',
  outbase: 'src',
  entryNames: '[dir]/[name]',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
// Flatten processes/* to dist/*.js for the supervisor paths.
for (const n of ['supervisor', 'companion', 'worker']) {
  fs.renameSync(`dist/processes/${n}.js`, `dist/${n}.js`);
  fs.renameSync(`dist/processes/${n}.js.map`, `dist/${n}.js.map`);
}
fs.rmSync('dist/processes', { recursive: true, force: true });
