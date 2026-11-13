#!/usr/bin/env node
/**
 * Public-workflow check for the Shymask development preview.
 *
 * Launches the real Electron app with Playwright, drives the visible controls,
 * captures the preview canvas to an evidence directory, and asserts observable
 * behavior:
 *   - startup, no-effect, manual pause and failure states show the opaque
 *     "Tracking paused" canvas and never the raw replay feed;
 *   - a color treatment visibly changes the canvas output and can be switched;
 *   - the replay loops for multiple cycles with strictly increasing processing
 *     timestamps and roughly real-time pacing;
 *   - a missing or corrupt fixture produces an actionable paused error and
 *     Start stays disabled.
 *
 * Timing numbers printed by this harness are replay-derived measurements of
 * this preview slice only. They do not establish the 720p/30 FPS / 100 ms
 * camera-to-output target, which requires later tracking and virtual-webcam
 * slices plus a physical camera.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(path.join(root, 'fixtures', 'webcam-loop.json'), 'utf8'));
const mediaPath = path.join(root, 'fixtures', 'cache', metadata.fileName);
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(root, 'evidence', `check-${runStamp}`);
const screenshotsDir = path.join(evidenceDir, 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });

const { ELECTRON_RUN_AS_NODE, ...baseEnv } = process.env;
const results = [];
const timing = {};

function log(message) {
  console.log(message);
}

function pass(name, detail = '') {
  results.push({ name, status: 'pass', detail });
  log(`PASS  ${name}${detail ? ` - ${detail}` : ''}`);
}

function fail(name, error) {
  results.push({ name, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
  log(`FAIL  ${name} - ${results[results.length - 1].detail}`);
}

async function waitFor(description, predicate, timeoutMs = 12000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}. Last value: ${JSON.stringify(lastValue)}`);
}

function parseKeyValues(text) {
  const values = {};
  for (const part of (text ?? '').trim().split(/\s+/)) {
    const index = part.indexOf('=');
    if (index > 0) values[part.slice(0, index)] = part.slice(index + 1);
  }
  return values;
}

async function readDiagnostic(page, id) {
  return (await page.locator(`#${id}`).textContent()) ?? '';
}

async function readRgb(page) {
  const values = parseKeyValues(await readDiagnostic(page, 'diag-rgb'));
  return {
    r: Number(values.r ?? 0),
    g: Number(values.g ?? 0),
    b: Number(values.b ?? 0),
  };
}

function rgbSum(rgb) {
  return rgb.r + rgb.g + rgb.b;
}

function rgbDistance(left, right) {
  return Math.abs(left.r - right.r) + Math.abs(left.g - right.g) + Math.abs(left.b - right.b);
}

async function readStatus(page) {
  return {
    title: ((await page.locator('[data-testid="status-title"]').textContent()) ?? '').trim(),
    explanation: ((await page.locator('[data-testid="status-explanation"]').textContent()) ?? '').trim(),
    action: ((await page.locator('[data-testid="status-action"]').textContent()) ?? '').trim(),
    mode: await page.evaluate(() => document.body.dataset.outputMode ?? ''),
  };
}

async function screenshotCanvas(page, name) {
  const file = path.join(screenshotsDir, name);
  await page.locator('[data-testid="output-canvas"]').screenshot({ path: file });
  return file;
}

async function launchApp(envOverrides = {}) {
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...baseEnv, ...envOverrides },
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 30000 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  await page.waitForLoadState('domcontentloaded');
  return { app, page, consoleErrors };
}

async function closeApp(app) {
  try {
    await app.close();
  } catch {
    // The app process may already have exited after a failed assertion.
  }
}

async function waitForStatusTitle(page, pattern) {
  return waitFor(`status title ${pattern}`, async () => {
    const status = await readStatus(page);
    return pattern.test(status.title) ? status : null;
  });
}

async function waitForLoops(page, minimum) {
  return waitFor(`loops >= ${minimum}`, async () => {
    const values = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
    const loops = Number(values.loops ?? 0);
    return loops >= minimum ? loops : null;
  }, 30000);
}

async function normalFixtureScenario() {
  log('\n== Scenario A: valid fixture, public controls, looping and treatments ==');
  const { app, page, consoleErrors } = await launchApp({ SHYMASK_EVIDENCE_DIR: evidenceDir });
  try {
    await waitFor('fixture diagnostics', async () => {
      const text = await readDiagnostic(page, 'diag-fixture');
      return text.includes(metadata.id) ? text : null;
    });
    const startup = await readStatus(page);
    assert.equal(startup.title, 'Tracking paused');
    assert.equal(startup.mode, 'paused');
    assert.match(startup.explanation, /has not started/i);
    assert.equal(await page.locator('[data-testid="start"]').isDisabled(), false);
    assert.equal(await page.locator('[data-testid="pause-toggle"]').isDisabled(), true);
    const startupRgb = await readRgb(page);
    assert.ok(rgbSum(startupRgb) < 120, `startup paused canvas should be dark, got ${JSON.stringify(startupRgb)}`);
    const startupShot = await screenshotCanvas(page, '01-startup-paused.png');
    pass('Startup shows the exact opaque paused output with no raw feed', startupShot);

    await page.locator('[data-testid="start"]').click();
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    await waitFor('warm output samples', async () => (rgbSum(await readRgb(page)) > 120 ? true : null));
    const warmRgb = await readRgb(page);
    assert.ok(rgbDistance(warmRgb, startupRgb) > 60, 'warm treatment must visibly differ from the paused screen');
    const warmShot = await screenshotCanvas(page, '02-warm-render.png');
    pass('Start renders the processed replay frame through the public controls', `${JSON.stringify(warmRgb)} ${warmShot}`);

    await page.waitForTimeout(900);
    const firstTimestamp = Number(parseKeyValues(await readDiagnostic(page, 'diag-timestamp')).processingMs ?? 0);
    await page.waitForTimeout(700);
    const secondTimestamp = Number(parseKeyValues(await readDiagnostic(page, 'diag-timestamp')).processingMs ?? 0);
    assert.ok(secondTimestamp > firstTimestamp, 'processing timestamp must increase while playing');
    pass('Processing timestamp increases while playing', `${firstTimestamp.toFixed(1)}ms -> ${secondTimestamp.toFixed(1)}ms`);

    await page.locator('[data-testid="effect-select"]').selectOption('cool');
    await waitForStatusTitle(page, /Effect active: Cool tint/);
    await page.waitForTimeout(700);
    const coolRgb = await readRgb(page);
    assert.ok(rgbDistance(coolRgb, warmRgb) > 40, 'cool treatment must visibly differ from warm');
    const coolShot = await screenshotCanvas(page, '03-cool-render.png');
    pass('Switching color treatment visibly changes the processed output', `${JSON.stringify(warmRgb)} -> ${JSON.stringify(coolRgb)} ${coolShot}`);

    await page.locator('[data-testid="effect-select"]').selectOption('mono');
    await waitForStatusTitle(page, /Effect active: Monochrome/);
    await page.waitForTimeout(700);
    const monoRgb = await readRgb(page);
    const monoShot = await screenshotCanvas(page, '04-monochrome-render.png');
    const monoSpread = Math.max(monoRgb.r, monoRgb.g, monoRgb.b) - Math.min(monoRgb.r, monoRgb.g, monoRgb.b);
    assert.ok(monoSpread <= 6, `monochrome output should be near-neutral, got ${JSON.stringify(monoRgb)}`);
    assert.ok(rgbDistance(monoRgb, coolRgb) > 20, 'monochrome must differ from cool');
    pass('Monochrome treatment produces near-neutral output', `${JSON.stringify(monoRgb)} ${monoShot}`);

    await page.locator('[data-testid="effect-select"]').selectOption('none');
    const noEffect = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(noEffect.explanation, /No effect is active/i);
    await page.waitForTimeout(400);
    const noEffectRgb = await readRgb(page);
    assert.ok(rgbSum(noEffectRgb) < 120, 'no-effect output must hide the feed behind the paused screen');
    const noEffectShot = await screenshotCanvas(page, '05-no-effect-paused.png');
    pass('No effect hides the feed behind the opaque paused screen', `${JSON.stringify(noEffectRgb)} ${noEffectShot}`);

    await page.locator('[data-testid="effect-select"]').selectOption('warm');
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    await waitFor('warm output after recovery', async () => (rgbSum(await readRgb(page)) > 120 ? true : null));
    pass('Selecting a treatment restores the processed preview automatically', await readDiagnostic(page, 'diag-rgb'));

    await page.locator('[data-testid="pause-toggle"]').click();
    const paused = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(paused.explanation, /paused manually/i);
    assert.equal(await page.locator('[data-testid="pause-toggle"]').textContent(), 'Resume');
    await page.waitForTimeout(400);
    const pausedTimestamp = Number(parseKeyValues(await readDiagnostic(page, 'diag-timestamp')).processingMs ?? 0);
    const pauseShot = await screenshotCanvas(page, '06-manual-pause.png');
    await page.waitForTimeout(1600);
    const stillPaused = await readStatus(page);
    const pausedTimestampLater = Number(parseKeyValues(await readDiagnostic(page, 'diag-timestamp')).processingMs ?? 0);
    assert.equal(stillPaused.title, 'Tracking paused');
    assert.equal(stillPaused.mode, 'paused');
    assert.equal(pausedTimestampLater, pausedTimestamp, 'manual pause must freeze processing until resumed');
    pass('Manual pause persists and hides the feed until resumed', `${pauseShot} timestamp=${pausedTimestamp}ms`);

    await page.locator('[data-testid="pause-toggle"]').click();
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    await page.waitForTimeout(500);
    const resumedTimestamp = Number(parseKeyValues(await readDiagnostic(page, 'diag-timestamp')).processingMs ?? 0);
    assert.ok(resumedTimestamp > pausedTimestamp, 'resume must continue processing timestamps');
    pass('Resume restores processed output', `${pausedTimestamp}ms -> ${resumedTimestamp}ms`);

    // Loop measurement: wait until at least three more loops have completed and
    // sample the public diagnostics throughout.
    const initialLoops = Number(parseKeyValues(await readDiagnostic(page, 'diag-loop')).loops ?? 0);
    const samples = [];
    const sampleStart = Date.now();
    let lastTimestamp = -1;
    let sawSeam = false;
    await waitFor(`three loops after loop ${initialLoops}`, async () => {
      const values = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
      const timestampValues = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
      const processingMs = Number(timestampValues.processingMs ?? 0);
      samples.push({
        atMs: Date.now() - sampleStart,
        processingMs,
        loops: Number(values.loops ?? 0),
        seams: Number(values.seams ?? 0),
        rgb: await readRgb(page),
      });
      if (processingMs <= lastTimestamp) {
        throw new Error(`processing timestamp regressed within the sample series: ${lastTimestamp} -> ${processingMs}`);
      }
      lastTimestamp = processingMs;
      if (Number(values.seams ?? 0) > 0) sawSeam = true;
      return Number(values.loops ?? 0) >= initialLoops + 3 ? Number(values.loops ?? 0) : null;
    }, 30000, 300);

    assert.ok(sawSeam, 'at least one loop seam must have been crossed');
    const finalLoopValues = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
    assert.equal(Number(finalLoopValues.seams ?? -1), Number(finalLoopValues.loops ?? -2), 'each completed loop must be reported as one deliberate seam');
    const loopShot = await screenshotCanvas(page, '07-multiple-loops.png');

    const firstSample = samples[0];
    const lastSample = samples[samples.length - 1];
    assert.ok(firstSample && lastSample);
    const wallSpanMs = lastSample.atMs - firstSample.atMs;
    const processingSpanMs = lastSample.processingMs - firstSample.processingMs;
    const pacingRatio = processingSpanMs / wallSpanMs;
    assert.ok(pacingRatio > 0.85 && pacingRatio < 1.15, `replay pacing should be near real time, got ${pacingRatio.toFixed(3)}`);
    const frameDelta = parseKeyValues(await readDiagnostic(page, 'diag-frame-delta'));
    const renderCost = parseKeyValues(await readDiagnostic(page, 'diag-render-cost'));
    timing.sourceFrameIntervalP95Ms = Number(frameDelta.p95Ms ?? 0);
    timing.renderCostP95Ms = Number(renderCost.p95Ms ?? 0);
    timing.loopsObserved = lastSample.loops - initialLoops;
    timing.loopWallSpanMs = wallSpanMs;
    timing.processingSpanMs = processingSpanMs;
    timing.pacingRatio = Number(pacingRatio.toFixed(3));
    timing.sourceDurationSeconds = metadata.durationSeconds;
    assert.ok(timing.sourceFrameIntervalP95Ms > 10 && timing.sourceFrameIntervalP95Ms < 80, `unexpected source frame interval ${timing.sourceFrameIntervalP95Ms}ms`);
    pass(
      `Replay looped for ${timing.loopsObserved} more cycles with strictly increasing processing timestamps`,
      `pacing=${timing.pacingRatio} sourceFrameP95=${timing.sourceFrameIntervalP95Ms}ms ${loopShot}`,
    );

    await page.locator('[data-testid="capture"]').click();
    const captureText = await waitFor('capture result', async () => {
      const text = await page.locator('[data-testid="capture-result"]').textContent();
      return text && text.startsWith('Captured ') ? text : null;
    });
    const capturePath = captureText.replace(/^Captured\s+/, '').trim();
    assert.ok(existsSync(capturePath), `capture file should exist: ${capturePath}`);
    const png = readFileSync(capturePath);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const pngWidth = png.readUInt32BE(16);
    const pngHeight = png.readUInt32BE(20);
    assert.equal(pngWidth, 1280);
    assert.equal(pngHeight, 720);
    pass('Public capture control writes the full output canvas as PNG evidence', `${path.basename(capturePath)} ${png.length} bytes`);

    await page.locator('[data-testid="simulate-failure"]').check();
    const failure = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(failure.explanation, /simulated/i);
    const failureShot = await screenshotCanvas(page, '08-processing-failure-paused.png');
    pass('Simulated effect-processing failure hides the feed', failureShot);

    await page.locator('[data-testid="simulate-failure"]').uncheck();
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    pass('Output recovers automatically after the processing failure clears', await readDiagnostic(page, 'diag-output'));

    await page.screenshot({ path: path.join(screenshotsDir, '09-app-window.png'), fullPage: false });
    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);
    pass('No renderer console errors during the normal scenario');
  } finally {
    await closeApp(app);
  }
}

async function missingFixtureScenario() {
  log('\n== Scenario B: missing fixture ==');
  const missingDir = path.join(evidenceDir, 'missing-fixture');
  mkdirSync(missingDir, { recursive: true });
  const { app, page, consoleErrors } = await launchApp({
    SHYMASK_EVIDENCE_DIR: evidenceDir,
    SHYMASK_FIXTURE_DIR: missingDir,
  });
  try {
    const status = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(status.explanation, /missing/i);
    assert.match(status.action, /npm run fetch:fixture/);
    assert.equal(await page.locator('[data-testid="start"]').isDisabled(), true);
    assert.equal(await page.locator('video').count(), 0, 'no video element may be created when the fixture is missing');
    const shot = await screenshotCanvas(page, '10-missing-fixture.png');
    assert.equal(consoleErrors.length, 0, `renderer console errors: ${consoleErrors.join(' | ')}`);
    pass('Missing fixture shows an actionable error, hidden output and a disabled Start', shot);
  } finally {
    await closeApp(app);
  }
}

async function invalidFixtureScenario() {
  log('\n== Scenario C: corrupt fixture (checksum mismatch) ==');
  const invalidDir = path.join(evidenceDir, 'invalid-fixture');
  mkdirSync(invalidDir, { recursive: true });
  const corruptPath = path.join(invalidDir, metadata.fileName);
  writeFileSync(corruptPath, Buffer.alloc(metadata.bytes, 0));
  const { app, page, consoleErrors } = await launchApp({
    SHYMASK_EVIDENCE_DIR: evidenceDir,
    SHYMASK_FIXTURE_DIR: invalidDir,
  });
  try {
    const status = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(status.explanation, /checksum mismatch/i);
    assert.match(status.action, /npm run fetch:fixture/);
    assert.equal(await page.locator('[data-testid="start"]').isDisabled(), true);
    const shot = await screenshotCanvas(page, '11-invalid-fixture.png');
    assert.equal(consoleErrors.length, 0, `renderer console errors: ${consoleErrors.join(' | ')}`);
    pass('Corrupt fixture shows the checksum error and hidden output', shot);
  } finally {
    await closeApp(app);
  }
}

function staticCameraGuard() {
  log('\n== Camera-safety source guard ==');
  const sourceFiles = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith('.ts')) sourceFiles.push(fullPath);
    }
  }
  walk(path.join(root, 'src'));
  const offenders = [];
  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8');
    if (/getUserMedia|mediaDevices|enumerateDevices/.test(source)) {
      offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, [], `camera APIs must not be used in this slice: ${offenders.join(', ')}`);
  pass('No physical-camera API is referenced in application source', `${sourceFiles.length} source files scanned`);
}

function verifyFixtureFile() {
  if (!existsSync(mediaPath)) {
    throw new Error(`Fixture missing at ${mediaPath}. Run: npm run fetch:fixture`);
  }
  const bytes = readFileSync(mediaPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length, metadata.bytes, 'committed fixture metadata bytes must match the cached clip');
  assert.equal(sha256, metadata.sha256, 'cached clip must match the committed checksum');
}

async function main() {
  verifyFixtureFile();
  staticCameraGuard();
  await normalFixtureScenario();
  await missingFixtureScenario();
  await invalidFixtureScenario();

  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const summary = {
    generatedAt: new Date().toISOString(),
    headSha,
    fixture: {
      id: metadata.id,
      title: metadata.title,
      license: metadata.license,
      sha256: metadata.sha256,
      bytes: metadata.bytes,
      durationSeconds: metadata.durationSeconds,
      sourcePage: metadata.sourcePage,
    },
    timing: {
      ...timing,
      basis: 'replay-derived preview measurements at this head; not the 720p/30 FPS / 100 ms camera-to-output target',
    },
    results,
    limitations: [
      'Replay fixture only; no physical webcam was opened and no human participated.',
      'Preview only; no virtual webcam publication, face tracking, or secondary motion exists in this slice.',
      'Measured on this development desktop; laptop integrated-graphics behavior is unverified.',
      'Color treatments use canvas CSS filters in this spike; a later tracking/effect slice may replace the implementation.',
    ],
  };
  writeFileSync(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  log('\n== Timing baseline (replay-based preview only) ==');
  log(`source clip duration:        ${metadata.durationSeconds}s`);
  log(`source frame interval p95:   ${timing.sourceFrameIntervalP95Ms.toFixed(1)}ms`);
  log(`render + filter cost p95:    ${timing.renderCostP95Ms.toFixed(2)}ms`);
  log(`loop cycles observed:        ${timing.loopsObserved} in ${(timing.loopWallSpanMs / 1000).toFixed(2)}s`);
  log(`replay pacing ratio:         ${timing.pacingRatio} (processing time / wall time)`);
  log('These numbers are replay-derived and preview-only. They do not establish the 100ms target,');
  log('physical-camera compatibility, or laptop integrated-graphics suitability.');
  log(`\nEvidence: ${evidenceDir}`);
  const failures = results.filter((result) => result.status === 'fail');
  log(`\n${results.length - failures.length}/${results.length} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  fail('check harness', error);
  const failures = results.filter((result) => result.status === 'fail');
  log(`\n${results.length - failures.length}/${results.length} checks passed`);
  log(`Evidence: ${evidenceDir}`);
  process.exitCode = 1;
});
