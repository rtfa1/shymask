import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const tscResult = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json')], {
  cwd: root,
  stdio: 'inherit',
});
if (tscResult.status !== 0) {
  process.exit(tscResult.status ?? 1);
}

await esbuild({
  entryPoints: [path.join(root, 'src', 'renderer', 'renderer.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  sourcemap: false,
  logLevel: 'info',
  outfile: path.join(root, 'dist', 'renderer', 'renderer.js'),
});

mkdirSync(path.join(root, 'dist', 'renderer'), { recursive: true });
for (const asset of ['index.html', 'styles.css']) {
  copyFileSync(path.join(root, 'src', 'renderer', asset), path.join(root, 'dist', 'renderer', asset));
}

console.log('build ok: dist/src/main/main.js + dist/renderer/renderer.js');
