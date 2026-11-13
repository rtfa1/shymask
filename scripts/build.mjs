import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// The required file list is owned by src/main/tracker.ts (compiled by the tsc
// step above) so launch validation and this staging step cannot drift.
const trackerDist = path.join(rendererDist, 'tracker');
mkdirSync(trackerDist, { recursive: true });
const trackerModule = await import(
  pathToFileURL(path.join(root, 'dist', 'src', 'main', 'tracker.js')).href
);
const requiredTrackerFiles = trackerModule.REQUIRED_TRACKER_FILES ?? trackerModule.default?.REQUIRED_TRACKER_FILES;
if (!Array.isArray(requiredTrackerFiles) || requiredTrackerFiles.length === 0) {
  console.error('build error: dist/src/main/tracker.js did not export REQUIRED_TRACKER_FILES.');
  process.exit(1);
}
const trackerMetadata = JSON.parse(readFileSync(path.join(root, 'tracker', 'face-landmarker-model.json'), 'utf8'));
const modelFileName = trackerMetadata.fileName;
const mediapipeWasmDir = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmAssets = requiredTrackerFiles.filter((fileName) => fileName !== modelFileName);
for (const asset of wasmAssets) {
  const source = path.join(mediapipeWasmDir, asset);
  if (!existsSync(source)) {
    console.error(`build error: missing MediaPipe asset ${source}. Run "npm install" first.`);
    process.exit(1);
  }
  copyFileSync(source, path.join(trackerDist, asset));
}
const modelPath = path.join(root, '.cache', 'tracker', modelFileName);
if (existsSync(modelPath)) {
  copyFileSync(modelPath, path.join(trackerDist, modelFileName));
} else {
  console.warn(
    `build warning: ${modelFileName} is not cached; run "npm run fetch:tracker". ` +
      'The app will show an actionable hidden-output error until the model is staged.',
  );
}

console.log('build ok: dist/src/main/main.js + dist/renderer/renderer.js + dist/renderer/tracker/');
