import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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

const rendererDist = path.join(root, 'dist', 'renderer');
mkdirSync(rendererDist, { recursive: true });
for (const asset of ['index.html', 'styles.css']) {
  copyFileSync(path.join(root, 'src', 'renderer', asset), path.join(rendererDist, asset));
}

// Stage the pinned Face Landmarker model and the MediaPipe WASM fileset. The
// model is downloaded into the gitignored cache by `npm run fetch:tracker`; a
// missing model is not a build failure, because the app must be able to show
// the actionable hidden-output error instead of silently starting without
// tracking. The WASM files come from the exact npm version in package.json.
const trackerDist = path.join(rendererDist, 'tracker');
mkdirSync(trackerDist, { recursive: true });
const mediapipeWasmDir = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmAssets = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];
for (const asset of wasmAssets) {
  const source = path.join(mediapipeWasmDir, asset);
  if (!existsSync(source)) {
    console.error(`build error: missing MediaPipe asset ${source}. Run "npm install" first.`);
    process.exit(1);
  }
  copyFileSync(source, path.join(trackerDist, asset));
}
const modelPath = path.join(root, '.cache', 'tracker', 'face_landmarker.task');
if (existsSync(modelPath)) {
  copyFileSync(modelPath, path.join(trackerDist, 'face_landmarker.task'));
} else {
  console.warn(
    'build warning: face_landmarker.task is not cached; run "npm run fetch:tracker". ' +
      'The app will show an actionable hidden-output error until the model is staged.',
  );
}

console.log('build ok: dist/src/main/main.js + dist/renderer/renderer.js + dist/renderer/tracker/');
