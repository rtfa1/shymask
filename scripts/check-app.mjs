#!/usr/bin/env node
/**
 * Public-workflow check for the Shymask development preview.
 *
 * Launches the real Electron app with Playwright, drives the visible controls,
 * captures the preview canvas to an evidence directory, and asserts observable
 * behavior:
 *   - startup, no-effect, manual pause, simulated failure and a silent decode
 *     stall show the opaque "Tracking paused" canvas and never the raw feed;
 *   - a color treatment visibly changes the canvas output and can be switched;
 *   - the replay loops for multiple cycles with strictly increasing processing
 *     timestamps and roughly real-time pacing; each reported seam is checked
 *     against an independent backward media-time jump in the samples;
 *   - a missing or corrupt fixture produces an actionable paused error and
 *     Start stays disabled; a second, different invalid message replaces the
 *     first after Recheck.
 *
 * The run records the tested head SHA, hardware, workload, measured boundaries,
 * commands and validation-gate facts in summary.json, and refreshes
 * evidence/logs/check-final.log for the same run.
 *
 * Timing numbers printed by this harness are replay-derived measurements of
 * this preview slice only. They do not establish the 720p/30 FPS / 100 ms
 * camera-to-output target, which requires later tracking and virtual-webcam
 * slices plus a physical camera.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem, version as osVersion } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Committed fixture cache; scenarios override the app's input via SHYMASK_FIXTURE_DIR. */
const committedFixtureCacheDir = path.join(root, 'fixtures', 'cache');
const metadata = JSON.parse(readFileSync(path.join(root, 'fixtures', 'webcam-loop.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const mediaPath = path.join(committedFixtureCacheDir, metadata.fileName);
const programData = process.env.ProgramData ?? 'C:\\ProgramData';
const installedBin = path.join(programData, 'Shymask', 'bin');
const nativeBin = path.join(root, 'build', 'native');
const consumerPath = existsSync(path.join(installedBin, 'shymask-camera-consumer.exe'))
  ? path.join(installedBin, 'shymask-camera-consumer.exe')
  : path.join(nativeBin, 'shymask-camera-consumer.exe');
const hostListPath = existsSync(path.join(installedBin, 'shymask-vcam-host.exe'))
  ? path.join(installedBin, 'shymask-vcam-host.exe')
  : path.join(nativeBin, 'shymask-vcam-host.exe');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(root, 'evidence', `check-${runStamp}`);
const screenshotsDir = path.join(evidenceDir, 'screenshots');
const cameraFramesDir = path.join(evidenceDir, 'camera-frames');
const logsDir = path.join(root, 'evidence', 'logs');
mkdirSync(screenshotsDir, { recursive: true });
mkdirSync(cameraFramesDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
// Fixed path for the most recent run so a cited log always matches this run.
const finalLogPath = path.join(logsDir, 'check-final.log');
// Mirrors LOOP_SEAM_THRESHOLD_MS in src/core/replay-clock.ts; the public check
// counts backward media-time jumps independently of the reported seam counter.
const LOOP_SEAM_THRESHOLD_MS = 250;

const { ELECTRON_RUN_AS_NODE, ...baseEnv } = process.env;
const results = [];
const timing = {};
const logLines = [];

function log(message) {
  console.log(message);
  logLines.push(message);
  writeFileSync(finalLogPath, `${logLines.join('\n')}\n`);
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

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * Derives the validation base instead of hard-coding a SHA. The default is the
 * merge-base with origin/main; a caller can pin a different ref with
 * SHYMASK_BASE_REF or an explicit SHA with SHYMASK_BASE_SHA.
 */
function resolveValidationBase() {
  const override = (process.env.SHYMASK_BASE_SHA ?? '').trim();
  if (override) return { ref: 'SHYMASK_BASE_SHA', sha: override };
  const candidates = [process.env.SHYMASK_BASE_REF, 'origin/main', 'main'].filter(Boolean);
  for (const ref of candidates) {
    try {
      const sha = git(['merge-base', ref, 'HEAD']);
      if (sha) return { ref, sha };
    } catch {
      // Try the next candidate ref.
    }
  }
  throw new Error(
    'Could not derive the validation base; set SHYMASK_BASE_REF to a local ref or SHYMASK_BASE_SHA to a commit.',
  );
}

/** Best-effort GPU name(s); Windows-only WMI query, empty elsewhere. */
function detectGpuNames() {
  try {
    const output = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
      { cwd: root, encoding: 'utf8', timeout: 15000 },
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectEnvironment() {
  const cpuList = cpus();
  const totalmemBytes = totalmem();
  return {
    node: process.version,
    electron: packageJson.devDependencies?.electron ?? 'unknown',
    os: {
      platform: platform(),
      release: release(),
      version: osVersion(),
      arch: arch(),
      totalmemBytes,
      totalmemGiB: Number((totalmemBytes / 1024 ** 3).toFixed(1)),
    },
    cpu: {
      model: cpuList[0]?.model?.trim() ?? 'unknown',
      logicalCores: cpuList.length,
    },
    gpu: detectGpuNames(),
  };
}

/**
 * Counts independent backward media-time jumps in the sampled diagnostics. This
 * is what the replay clock treats as a loop seam, so it does not rely on the
 * app's own seam counter to validate that counter.
 */
function countBackwardMediaJumps(samples) {
  let jumps = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous && current && current.mediaMs < previous.mediaMs - LOOP_SEAM_THRESHOLD_MS) {
      jumps += 1;
    }
  }
  return jumps;
}

async function normalFixtureScenario() {
  log('\n== Scenario A: valid fixture, public controls, looping and treatments ==');
  const { app, page, consoleErrors } = await launchApp({ SHYMASK_EVIDENCE_DIR: evidenceDir });
  try {
    await waitFor('fixture diagnostics', async () => {
      const text = await readDiagnostic(page, 'diag-fixture');
      return text.includes(metadata.id) ? text : null;
    });
    // The face-tracker assets are loaded and validated asynchronously at launch;
    // Start stays disabled until the tracker is ready.
    await waitFor('face tracker ready', async () => {
      const model = parseKeyValues(await readDiagnostic(page, 'diag-model'));
      if (model.state !== 'ready') return null;
      return (await page.locator('[data-testid="start"]').isDisabled()) ? null : true;
    }, 60000);
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
    // sample the public diagnostics throughout. The seam count is validated
    // separately against backward media-time jumps in the samples, so it is not
    // compared with the loop counter that increments alongside it.
    const initialLoopValues = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
    const initialLoops = Number(initialLoopValues.loops ?? 0);
    const initialSeams = Number(initialLoopValues.seams ?? 0);
    const samples = [];
    const sampleStart = Date.now();
    let lastTimestamp = -1;
    await waitFor(`three loops after loop ${initialLoops}`, async () => {
      const values = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
      const timestampValues = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
      const processingMs = Number(timestampValues.processingMs ?? 0);
      samples.push({
        atMs: Date.now() - sampleStart,
        processingMs,
        mediaMs: Number(timestampValues.mediaMs ?? 0),
        loops: Number(values.loops ?? 0),
        seams: Number(values.seams ?? 0),
        rgb: await readRgb(page),
      });
      if (processingMs <= lastTimestamp) {
        throw new Error(`processing timestamp regressed within the sample series: ${lastTimestamp} -> ${processingMs}`);
      }
      lastTimestamp = processingMs;
      return Number(values.loops ?? 0) >= initialLoops + 3 ? Number(values.loops ?? 0) : null;
    }, 30000, 300);

    const finalLoopValues = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
    const finalLoops = Number(finalLoopValues.loops ?? -1);
    const finalSeams = Number(finalLoopValues.seams ?? -1);
    assert.equal(finalLoops, initialLoops + 3, 'the sample window must observe exactly three completed loops');
    assert.ok(finalSeams > initialSeams, 'at least one loop seam must have been crossed');
    const backwardMediaJumps = countBackwardMediaJumps(samples);
    const seamsDuringSampling = finalSeams - initialSeams;
    assert.ok(seamsDuringSampling >= 1, 'the seam counter must advance during the sample window');
    assert.equal(
      backwardMediaJumps,
      seamsDuringSampling,
      `independently observed backward media-time jumps (${backwardMediaJumps}) must match reported seams (${seamsDuringSampling})`,
    );
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
    timing.seamsObserved = seamsDuringSampling;
    timing.backwardMediaJumps = backwardMediaJumps;
    timing.loopWallSpanMs = wallSpanMs;
    timing.processingSpanMs = processingSpanMs;
    timing.pacingRatio = Number(pacingRatio.toFixed(3));
    timing.sourceDurationSeconds = metadata.durationSeconds;
    assert.ok(timing.sourceFrameIntervalP95Ms > 10 && timing.sourceFrameIntervalP95Ms < 80, `unexpected source frame interval ${timing.sourceFrameIntervalP95Ms}ms`);
    pass(
      `Replay looped for ${timing.loopsObserved} more cycles with strictly increasing processing timestamps`,
      `seams=${seamsDuringSampling} mediaJumps=${backwardMediaJumps} pacing=${timing.pacingRatio} sourceFrameP95=${timing.sourceFrameIntervalP95Ms}ms ${loopShot}`,
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

    // Recheck while the diagnostic failure is active must reset the injected
    // failure state rather than leaving a stale simulated-failure pause.
    await page.locator('[data-testid="simulate-failure"]').check();
    const simulatedAgain = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(simulatedAgain.explanation, /simulated/i);
    await page.locator('[data-testid="recheck"]').click();
    const recheckedStartup = await waitFor('fixture recheck after simulated failure', async () => {
      const status = await readStatus(page);
      return /has not started/i.test(status.explanation) ? status : null;
    });
    assert.equal(await page.locator('[data-testid="simulate-failure"]').isChecked(), false);
    assert.equal(await page.locator('[data-testid="start"]').isDisabled(), false);
    await page.locator('[data-testid="start"]').click();
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    await waitFor('warm output after recheck', async () => (rgbSum(await readRgb(page)) > 120 ? true : null));
    pass(
      'Recheck during a simulated failure clears it and recovers the processed preview on Start',
      `${recheckedStartup.title} ${await readDiagnostic(page, 'diag-output')}`,
    );

    // Injected decode stall: pause the media element directly (not through the
    // manual Pause control), so the renderer still expects frames while the
    // decoder presents none. The timer watchdog must hide the output, then
    // recovery must be automatic when the next valid frame arrives.
    await page.evaluate(() => {
      const element = document.querySelector('video');
      if (!element) throw new Error('expected a replay video element');
      element.pause();
    });
    const stall = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(stall.explanation, /decoded for more than 250 ms/i);
    assert.equal(stall.mode, 'paused');
    await page.waitForTimeout(600);
    const stillStalled = await readStatus(page);
    assert.equal(stillStalled.mode, 'paused', 'a silent decode stall must not reveal the last processed frame');
    assert.match(stillStalled.explanation, /decoded for more than 250 ms/i);
    const stallShot = await screenshotCanvas(page, '08b-decode-stall-paused.png');
    await page.evaluate(() => {
      const element = document.querySelector('video');
      if (!element) throw new Error('expected a replay video element');
      void element.play();
    });
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    pass('A silent decode stall shows the opaque paused screen and recovers on the next frame', stallShot);

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
  log('\n== Scenario C: corrupt fixture (checksum mismatch, then size mismatch) ==');
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
    pass('Corrupt fixture shows the checksum error and hidden output', shot);

    // Change the failure kind without relaunching. Recheck must replace the
    // stale checksum explanation with the new size-mismatch explanation even
    // though mode/reason/title are unchanged.
    writeFileSync(corruptPath, Buffer.alloc(metadata.bytes - 17, 0));
    await page.locator('[data-testid="recheck"]').click();
    const changed = await waitFor('size mismatch explanation', async () => {
      const current = await readStatus(page);
      return /size mismatch/i.test(current.explanation) ? current : null;
    });
    assert.doesNotMatch(changed.explanation, /checksum mismatch/i);
    assert.match(changed.action, /npm run fetch:fixture/);
    assert.equal(changed.mode, 'paused');
    assert.equal(await page.locator('[data-testid="start"]').isDisabled(), true);
    const changedShot = await screenshotCanvas(page, '11b-invalid-fixture-changed-message.png');
    assert.equal(consoleErrors.length, 0, `renderer console errors: ${consoleErrors.join(' | ')}`);
    pass('Recheck replaces a stale invalid-fixture explanation with the new failure message', changedShot);
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------------------
// Windows virtual camera evidence through the independent native consumer.
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await delay(100);
  }
  return !processExists(pid);
}

function parseJsonEvents(lines) {
  const events = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      events.push(JSON.parse(text));
    } catch {
      // Diagnostics are best-effort; an unparsable line is not a frame.
    }
  }
  return events;
}

function spawnCameraConsumer(prefix, frames, timeoutMs) {
  const child = spawn(
    consumerPath,
    [
      '--device',
      'Shymask Camera',
      '--frames',
      String(frames),
      '--out',
      cameraFramesDir,
      '--prefix',
      prefix,
      '--max-pngs',
      '2',
      '--timeout-ms',
      String(timeoutMs),
    ],
    { cwd: root, windowsHide: true },
  );
  const lines = [];
  let carry = '';
  child.stdout.on('data', (chunk) => {
    carry += chunk.toString('utf8');
    for (let index = carry.indexOf('\n'); index >= 0; index = carry.indexOf('\n')) {
      const line = carry.slice(0, index).trim();
      carry = carry.slice(index + 1);
      if (line) lines.push(line);
    }
  });
  child.stderr.on('data', () => {
    // The consumer reports failures as JSON events on stdout.
  });
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  return { child, lines, exit };
}

/**
 * The consumer writes PNG evidence after it decides whether any app frame
 * arrived, so the PNG paths come as separate `png` events. Attach each path to
 * its frame by index so assertions can require app-published evidence.
 */
function attachCameraPngs(events, frames) {
  for (const event of events) {
    if (event.event !== 'png' || typeof event.index !== 'number') continue;
    const frame = frames.find((candidate) => candidate.index === event.index);
    if (frame && typeof event.path === 'string') frame.png = event.path;
  }
  return frames;
}

async function runCameraConsumer(prefix, frames, timeoutMs = 15000) {
  const running = spawnCameraConsumer(prefix, frames, timeoutMs);
  const code = await Promise.race([running.exit, delay(timeoutMs + 5000).then(() => 'running')]);
  if (code === 'running') {
    running.child.kill();
    throw new Error(`camera consumer ${prefix} did not exit within ${timeoutMs + 5000}ms`);
  }
  const events = parseJsonEvents(running.lines);
  return {
    code,
    events,
    frames: attachCameraPngs(events, events.filter((event) => event.event === 'frame')),
    lines: running.lines,
  };
}

function cameraFrameRgb(frame) {
  return { r: frame.meanR ?? 0, g: frame.meanG ?? 0, b: frame.meanB ?? 0 };
}

function averageFrameRgb(frames) {
  const appFrames = frames.filter((frame) => frame.captureUnixMs > 0);
  const source = appFrames.length > 0 ? appFrames : frames;
  if (source.length === 0) return { r: 0, g: 0, b: 0 };
  const total = source.reduce((sum, frame) => {
    const rgb = cameraFrameRgb(frame);
    return { r: sum.r + rgb.r, g: sum.g + rgb.g, b: sum.b + rgb.b };
  }, { r: 0, g: 0, b: 0 });
  return {
    r: Math.round(total.r / source.length),
    g: Math.round(total.g / source.length),
    b: Math.round(total.b / source.length),
  };
}

function channelDistance(left, right) {
  return Math.max(
    Math.abs(left.r - right.r),
    Math.abs(left.g - right.g),
    Math.abs(left.b - right.b),
  );
}

/**
 * Selects PNG evidence from an app-published frame when one exists. The native
 * media source also holds a native opaque paused fallback for the window before
 * the app's first frame; that fallback must never be used to evidence a
 * processed state.
 */
function firstCameraPng(frames) {
  const appFrame = frames.find((candidate) => candidate.png && candidate.captureUnixMs > 0);
  if (appFrame) return appFrame.png;
  const fallbackFrame = frames.find((candidate) => candidate.png);
  return fallbackFrame ? fallbackFrame.png : null;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

/**
 * Decodes a saved PNG into top-down RGB pixels. Assertions use the pixels that
 * are actually on disk, not the consumer's in-memory statistics, so a wrong PNG
 * (for example a pre-connection native fallback) cannot satisfy a state check.
 */
function decodePng(file) {
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'camera frame must be a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  assert.equal(bitDepth, 8, `unsupported PNG bit depth ${bitDepth}`);
  assert.equal(interlace, 0, 'interlaced PNG evidence is not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels > 0, `unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  assert.equal(raw.length, height * (stride + 1), 'PNG data length must match its dimensions');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const rowOut = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? rowOut[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      let value = rowIn[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upLeft);
      rowOut[x] = value & 0xff;
    }
  }
  return { width, height, channels, stride, pixels };
}

function pngMeanRgb(file) {
  const { width, height, channels, stride, pixels } = decodePng(file);
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const index = y * stride + x * channels;
      red += pixels[index];
      green += pixels[index + 1];
      blue += pixels[index + 2];
      count += 1;
    }
  }
  return {
    r: Math.round(red / count),
    g: Math.round(green / count),
    b: Math.round(blue / count),
  };
}

function pngPixel(file, x, y) {
  const { width, height, channels, stride, pixels } = decodePng(file);
  const px = Math.max(0, Math.min(width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(height - 1, Math.round(y)));
  const index = py * stride + px * channels;
  return { r: pixels[index], g: pixels[index + 1], b: pixels[index + 2] };
}

/** Counts pixels close to a target colour; used to prove the mask is in a camera PNG. */
function pngColorCount(file, target, tolerance = 20) {
  const { height, width, channels, stride, pixels } = decodePng(file);
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * stride + x * channels;
      if (
        Math.abs(pixels[index] - target.r) <= tolerance &&
        Math.abs(pixels[index + 1] - target.g) <= tolerance &&
        Math.abs(pixels[index + 2] - target.b) <= tolerance
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function pngSize(file) {
  const png = readFileSync(file);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'camera frame must be a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function assertAllPausedFrames(frames, label) {
  assert.ok(frames.length >= 2, `${label}: expected at least two camera frames, got ${frames.length}`);
  const appFrames = frames.filter((frame) => frame.captureUnixMs > 0);
  assert.ok(
    appFrames.length >= 1,
    `${label}: expected at least one app-published paused frame (captureUnixMs > 0) proving the shared output policy, got ${appFrames.length}`,
  );
  for (const frame of frames) {
    const rgb = cameraFrameRgb(frame);
    assert.ok(
      rgbSum(rgb) < 120,
      `${label}: every camera frame must be the opaque paused canvas, got ${JSON.stringify(rgb)}`,
    );
  }
}

function assertProcessedFrames(frames, previewRgb, label) {
  const appFrames = frames.filter((frame) => frame.captureUnixMs > 0);
  assert.ok(appFrames.length >= 2, `${label}: expected processed camera frames, got ${appFrames.length}`);
  const closest = appFrames.reduce((best, frame) => {
    const distance = channelDistance(cameraFrameRgb(frame), previewRgb);
    return !best || distance < best.distance ? { frame, distance } : best;
  }, null);
  assert.ok(
    closest !== null && closest.distance <= 25,
    `${label}: camera frame must match the preview treatment, preview=${JSON.stringify(previewRgb)} camera=${JSON.stringify(cameraFrameRgb(closest?.frame ?? {}))}`,
  );
  assert.ok(
    rgbSum(cameraFrameRgb(closest.frame)) > 120,
    `${label}: processed camera frame must not be the dark paused screen`,
  );
}

/**
 * Processed states must be evidenced by a saved PNG that really shows the
 * processed pixels and comes from an app frame, not the native paused fallback.
 */
function assertProcessedPng(frames, previewRgb, label) {
  const png = firstCameraPng(frames);
  assert.ok(png, `${label}: expected camera PNG evidence from an app frame`);
  const frame = frames.find((candidate) => candidate.png === png);
  assert.ok(
    frame && frame.captureUnixMs > 0,
    `${label}: saved PNG must come from an app-published frame (captureUnixMs > 0)`,
  );
  const pngRgb = pngMeanRgb(png);
  assert.ok(
    rgbSum(pngRgb) > 120,
    `${label}: saved PNG must show processed content, got ${JSON.stringify(pngRgb)}`,
  );
  assert.ok(
    channelDistance(pngRgb, previewRgb) <= 25,
    `${label}: saved PNG mean ${JSON.stringify(pngRgb)} must match the asserted processed colour ${JSON.stringify(previewRgb)}`,
  );
  return { png, rgb: pngRgb };
}

/**
 * Paused states must be evidenced by an app-published paused frame and a saved
 * PNG whose pixels are actually the opaque paused canvas.
 */
function assertPausedPng(frames, label) {
  const png = firstCameraPng(frames);
  assert.ok(png, `${label}: expected camera PNG evidence for the paused canvas`);
  const frame = frames.find((candidate) => candidate.png === png);
  assert.ok(
    frame && frame.captureUnixMs > 0,
    `${label}: saved PNG must come from an app-published paused frame (captureUnixMs > 0)`,
  );
  const pngRgb = pngMeanRgb(png);
  assert.ok(
    rgbSum(pngRgb) < 120,
    `${label}: saved PNG must be the opaque paused canvas, got ${JSON.stringify(pngRgb)}`,
  );
  return { png, rgb: pngRgb };
}

async function waitForVirtualCamera(page, timeoutMs = 30000) {
  return waitFor(
    'virtual camera publishing',
    async () => {
      const vcam = parseKeyValues(await readDiagnostic(page, 'diag-vcam'));
      if (vcam.state === 'publishing' && vcam.enumerable === 'true') return vcam;
      const title = ((await page.locator('[data-testid="vcam-state"]').textContent()) ?? '').trim();
      const action = ((await page.locator('[data-testid="vcam-action"]').textContent()) ?? '').trim();
      if (/unavailable|not installed/i.test(title)) {
        throw new Error(`virtual camera is not available: ${title} ${action}`);
      }
      return null;
    },
    timeoutMs,
    250,
  );
}

async function captureCameraState(page, prefix, frames = 4) {
  const run = await runCameraConsumer(prefix, frames);
  assert.equal(run.code, 0, `camera consumer ${prefix} exited ${run.code}: ${run.lines.slice(-3).join(' | ')}`);
  return run;
}

async function virtualCameraScenario() {
  log('\n== Scenario D: Windows virtual camera through the independent Media Foundation consumer ==');
  assert.ok(existsSync(consumerPath), `missing camera consumer at ${consumerPath}; run npm run vcam:install`);
  assert.ok(existsSync(hostListPath), `missing camera host at ${hostListPath}; run npm run vcam:install`);

  const evidence = { states: {}, timing: {}, close: {} };
  const { app, page, consoleErrors } = await launchApp({ SHYMASK_EVIDENCE_DIR: evidenceDir });
  try {
    await waitFor('fixture diagnostics', async () => {
      const text = await readDiagnostic(page, 'diag-fixture');
      return text.includes(metadata.id) ? text : null;
    });
    await waitForVirtualCamera(page);
    const registration = await readDiagnostic(page, 'diag-vcam');
    pass('Shymask Camera is registered and published by the running app', registration);

    // Startup: the preview and the camera both show the opaque paused canvas.
    const previewStartup = await readRgb(page);
    const startupRun = await captureCameraState(page, 'startup-paused', 6);
    assertAllPausedFrames(startupRun.frames, 'startup');
    const startupPng = assertPausedPng(startupRun.frames, 'startup');
    const startupSize = pngSize(startupPng.png);
    assert.deepEqual(startupSize, { width: 1280, height: 720 });
    evidence.states.startup = {
      preview: previewStartup,
      camera: averageFrameRgb(startupRun.frames),
      frames: startupRun.frames.length,
      png: startupPng.png,
      pngRgb: startupPng.rgb,
    };
    pass(
      'Camera startup output is the opaque "Tracking paused" canvas, not the raw feed',
      `${JSON.stringify(evidence.states.startup.camera)} ${startupPng.png}`,
    );

    await page.locator('[data-testid="start"]').click();
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    await waitFor('warm preview output', async () => (rgbSum(await readRgb(page)) > 120 ? true : null));
    await delay(500);
    const previewWarm = await readRgb(page);
    const warmRun = await captureCameraState(page, 'warm', 6);
    assertProcessedFrames(warmRun.frames, previewWarm, 'warm');
    const warmPng = assertProcessedPng(warmRun.frames, previewWarm, 'warm');
    evidence.states.warm = {
      preview: previewWarm,
      camera: averageFrameRgb(warmRun.frames),
      frames: warmRun.frames.length,
      png: warmPng.png,
      pngRgb: warmPng.rgb,
    };
    pass(
      'Processed replay frames reach the external camera consumer with the preview treatment',
      `preview=${JSON.stringify(previewWarm)} camera=${JSON.stringify(evidence.states.warm.camera)} png=${JSON.stringify(warmPng.rgb)}`,
    );

    await page.locator('[data-testid="effect-select"]').selectOption('cool');
    await waitForStatusTitle(page, /Effect active: Cool tint/);
    await delay(600);
    const previewCool = await readRgb(page);
    const coolRun = await captureCameraState(page, 'cool', 6);
    assertProcessedFrames(coolRun.frames, previewCool, 'cool');
    const coolPng = assertProcessedPng(coolRun.frames, previewCool, 'cool');
    const coolCamera = averageFrameRgb(coolRun.frames);
    assert.ok(
      rgbDistance(coolCamera, evidence.states.warm.camera) > 40,
      `switching the effect must change the camera output, warm=${JSON.stringify(evidence.states.warm.camera)} cool=${JSON.stringify(coolCamera)}`,
    );
    evidence.states.cool = {
      preview: previewCool,
      camera: coolCamera,
      frames: coolRun.frames.length,
      png: coolPng.png,
      pngRgb: coolPng.rgb,
    };
    pass('Switching the color treatment changes the camera output too', JSON.stringify(coolCamera));

    await page.locator('[data-testid="pause-toggle"]').click();
    await waitForStatusTitle(page, /^Tracking paused$/);
    await delay(400);
    const previewPaused = await readRgb(page);
    const pausedRun = await captureCameraState(page, 'manual-pause', 6);
    assertAllPausedFrames(pausedRun.frames, 'manual pause');
    const pausedPng = assertPausedPng(pausedRun.frames, 'manual pause');
    assert.ok(rgbSum(previewPaused) < 120, 'preview paused output must be dark');
    evidence.states.manualPause = {
      preview: previewPaused,
      camera: averageFrameRgb(pausedRun.frames),
      frames: pausedRun.frames.length,
      png: pausedPng.png,
      pngRgb: pausedPng.rgb,
    };
    pass(
      'Manual pause produces the opaque paused canvas in the camera consumer',
      JSON.stringify(evidence.states.manualPause.camera),
    );

    await page.locator('[data-testid="pause-toggle"]').click();
    await waitForStatusTitle(page, /Effect active: Cool tint/);
    await delay(600);
    const resumedPreview = await readRgb(page);
    const resumedRun = await captureCameraState(page, 'resumed', 6);
    assertProcessedFrames(resumedRun.frames, resumedPreview, 'resume');
    const resumedPng = assertProcessedPng(resumedRun.frames, resumedPreview, 'resume');
    evidence.states.resumed = {
      preview: resumedPreview,
      camera: averageFrameRgb(resumedRun.frames),
      png: resumedPng.png,
      pngRgb: resumedPng.rgb,
    };
    pass('Resume restores processed camera output', JSON.stringify(evidence.states.resumed.camera));

    await page.locator('[data-testid="effect-select"]').selectOption('none');
    await waitForStatusTitle(page, /^Tracking paused$/);
    await delay(400);
    const noEffectRun = await captureCameraState(page, 'no-effect', 6);
    assertAllPausedFrames(noEffectRun.frames, 'no effect');
    const noEffectPng = assertPausedPng(noEffectRun.frames, 'no effect');
    evidence.states.noEffect = {
      camera: averageFrameRgb(noEffectRun.frames),
      png: noEffectPng.png,
      pngRgb: noEffectPng.rgb,
    };
    pass('No active effect hides the camera feed behind the opaque paused canvas', JSON.stringify(evidence.states.noEffect.camera));

    await page.locator('[data-testid="effect-select"]').selectOption('warm');
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    await delay(600);
    const recoveryPreview = await readRgb(page);
    const recoveryRun = await captureCameraState(page, 'effect-recovered', 6);
    assertProcessedFrames(recoveryRun.frames, recoveryPreview, 'effect recovery');
    const recoveryPng = assertProcessedPng(recoveryRun.frames, recoveryPreview, 'effect recovery');
    evidence.states.effectRecovered = {
      preview: recoveryPreview,
      camera: averageFrameRgb(recoveryRun.frames),
      png: recoveryPng.png,
      pngRgb: recoveryPng.rgb,
    };
    pass('Selecting a treatment restores processed camera output', JSON.stringify(evidence.states.effectRecovered.camera));

    await page.locator('[data-testid="simulate-failure"]').check();
    await waitForStatusTitle(page, /^Tracking paused$/);
    await delay(400);
    const failureRun = await captureCameraState(page, 'processing-failure', 6);
    assertAllPausedFrames(failureRun.frames, 'processing failure');
    const failurePng = assertPausedPng(failureRun.frames, 'processing failure');
    evidence.states.processingFailure = {
      camera: averageFrameRgb(failureRun.frames),
      png: failurePng.png,
      pngRgb: failurePng.rgb,
    };
    pass('Injected processing failure hides the camera feed behind the opaque paused canvas', JSON.stringify(evidence.states.processingFailure.camera));

    await page.locator('[data-testid="simulate-failure"]').uncheck();
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    await delay(600);
    const failureRecoveryPreview = await readRgb(page);
    const failureRecoveryRun = await captureCameraState(page, 'failure-recovered', 6);
    assertProcessedFrames(failureRecoveryRun.frames, failureRecoveryPreview, 'failure recovery');
    const failureRecoveryPng = assertProcessedPng(
      failureRecoveryRun.frames,
      failureRecoveryPreview,
      'failure recovery',
    );
    evidence.states.failureRecovered = {
      preview: failureRecoveryPreview,
      camera: averageFrameRgb(failureRecoveryRun.frames),
      png: failureRecoveryPng.png,
      pngRgb: failureRecoveryPng.rgb,
    };
    pass('Camera output recovers automatically after the processing failure clears', JSON.stringify(evidence.states.failureRecovered.camera));

    // Multiple replay loops and the replay-to-camera timing baseline.
    const initialLoopValues = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
    const initialLoops = Number(initialLoopValues.loops ?? 0);
    const loopRun = await runCameraConsumer('loops', 100000, 7000);
    const loopFrames = loopRun.frames;
    assert.ok(loopFrames.length >= 120, `expected a sustained camera stream, got ${loopFrames.length} frames`);
    for (let index = 1; index < loopFrames.length; index += 1) {
      assert.ok(
        loopFrames[index].sampleTimeMs > loopFrames[index - 1].sampleTimeMs,
        'camera sample times must increase across loops',
      );
    }
    const finalLoopValues = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
    const finalLoops = Number(finalLoopValues.loops ?? 0);
    assert.ok(finalLoops >= initialLoops + 2, `expected at least two more replay loops, ${initialLoops} -> ${finalLoops}`);
    const appLoopFrames = loopFrames.filter((frame) => frame.captureUnixMs > 0);
    const intervalValues = appLoopFrames
      .slice(1)
      .map((frame, index) => frame.receivedUnixMs - appLoopFrames[index].receivedUnixMs)
      .filter((value) => value > 0);
    const latencyValues = appLoopFrames.map((frame) => frame.latencyMs).filter((value) => value >= 0);
    const means = appLoopFrames.map((frame) => rgbSum(cameraFrameRgb(frame)));
    const meanSpread = means.length > 0 ? Math.max(...means) - Math.min(...means) : 0;
    assert.ok(meanSpread > 10, `camera frames must show replay content changes, spread=${meanSpread}`);
    const wallSpanMs = appLoopFrames[appLoopFrames.length - 1].receivedUnixMs - appLoopFrames[0].receivedUnixMs;
    const sampleSpanMs = appLoopFrames[appLoopFrames.length - 1].sampleTimeMs - appLoopFrames[0].sampleTimeMs;
    evidence.timing = {
      cameraFrames: loopFrames.length,
      appFrames: appLoopFrames.length,
      durationMs: wallSpanMs,
      cameraSampleRateHz: Number((appLoopFrames.length / (wallSpanMs / 1000)).toFixed(1)),
      sampleClockRatio: Number((sampleSpanMs / wallSpanMs).toFixed(3)),
      intervalP95Ms: Number(percentile(intervalValues, 0.95).toFixed(1)),
      latencyP95Ms: Number(percentile(latencyValues, 0.95).toFixed(1)),
      latencyP50Ms: Number(percentile(latencyValues, 0.5).toFixed(1)),
      meanRgbSpread: meanSpread,
      loopsObserved: finalLoops - initialLoops,
    };
    pass(
      'Camera consumer keeps receiving processed frames across multiple replay loops',
      `frames=${loopFrames.length} loops=${finalLoops - initialLoops} p95 interval=${evidence.timing.intervalP95Ms}ms`,
    );
    pass(
      'Replay-to-camera timing baseline recorded (replay-based)',
      `latency p50=${evidence.timing.latencyP50Ms}ms p95=${evidence.timing.latencyP95Ms}ms rate=${evidence.timing.cameraSampleRateHz}Hz`,
    );

    // Closing the app must stop camera output and remove the camera device.
    const vcamBeforeClose = parseKeyValues(await readDiagnostic(page, 'diag-vcam'));
    const hostPid = Number(vcamBeforeClose.pid ?? 0);
    assert.ok(
      Number.isInteger(hostPid) && hostPid > 0,
      `virtual camera host PID must be reported before closing, got ${vcamBeforeClose.pid}`,
    );
    const streaming = spawnCameraConsumer('close-stop', 100000, 15000);
    await waitFor(
      'camera stream before closing the app',
      () => (parseJsonEvents(streaming.lines).some((event) => event.event === 'frame') ? true : null),
      15000,
    );
    const closedAt = Date.now();
    await closeApp(app);
    const hostPidExited = await waitForProcessExit(hostPid, 8000);
    assert.ok(hostPidExited, `camera host pid ${hostPid} must exit after the app closes`);
    const consumerExit = await Promise.race([streaming.exit, delay(12000).then(() => 'running')]);
    if (consumerExit === 'running') streaming.child.kill();
    const closeEvents = parseJsonEvents(streaming.lines);
    const closeFrames = closeEvents.filter((event) => event.event === 'frame');
    const lateFrames = closeFrames.filter((frame) => frame.receivedUnixMs > closedAt + 1500);
    assert.equal(lateFrames.length, 0, `camera kept delivering ${lateFrames.length} frames after the app closed`);
    const sawStreamEnd = closeEvents.some(
      (event) => event.event === 'stream-end' || event.event === 'read-failed',
    );
    const sawTimeout = closeEvents.some((event) => event.event === 'timeout');
    await delay(1500);
    const listed = spawnSync(hostListPath, ['list'], { encoding: 'utf8' });
    const devices = parseJsonEvents((listed.stdout ?? '').split(/\r?\n/)).filter(
      (event) => event.event === 'device' && /^Shymask Camera/.test(event.name ?? ''),
    );
    assert.equal(devices.length, 0, 'the Shymask Camera must not be enumerable after the app closes');
    // A consumer timeout only counts as the stream ending when there were no
    // late frames and the camera device really disappeared, and the evidence
    // says so explicitly rather than treating "no event" as success.
    const consumerTimedOut = consumerExit === 'running' || sawTimeout;
    const timeoutAccepted = consumerTimedOut && lateFrames.length === 0 && devices.length === 0;
    assert.ok(
      sawStreamEnd || timeoutAccepted,
      `camera consumer must observe the stream ending after the app closes (streamEnd=${sawStreamEnd} timeout=${consumerTimedOut} lateFrames=${lateFrames.length} devices=${devices.length})`,
    );
    evidence.close = {
      hostPid,
      hostPidExited,
      framesBeforeClose: closeFrames.length,
      framesAfterClose: lateFrames.length,
      consumerExit,
      sawStreamEnd,
      sawTimeout,
      consumerTimedOut,
      timeoutAccepted,
      enumerableAfterClose: devices.length,
    };
    pass(
      'Closing Shymask stops camera output and removes the camera device',
      `hostPid=${hostPid} exited=${hostPidExited} consumer exit=${consumerExit} lateFrames=${lateFrames.length} timeoutAccepted=${timeoutAccepted} devices=${devices.length}`,
    );

    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);
    pass('No renderer console errors during the virtual camera scenario');
  } finally {
    await closeApp(app);
  }
  return evidence;
}

async function missingFixtureCameraScenario() {
  log('\n== Scenario E: virtual camera with a missing replay fixture ==');
  const missingDir = path.join(evidenceDir, 'missing-fixture-camera');
  mkdirSync(missingDir, { recursive: true });
  const { app, page, consoleErrors } = await launchApp({
    SHYMASK_EVIDENCE_DIR: evidenceDir,
    SHYMASK_FIXTURE_DIR: missingDir,
  });
  const evidence = { states: {} };
  try {
    const status = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(status.explanation, /missing/i);
    assert.equal(await page.locator('[data-testid="start"]').isDisabled(), true);
    await waitForVirtualCamera(page);
    const run = await captureCameraState(page, 'missing-fixture', 6);
    assertAllPausedFrames(run.frames, 'missing fixture');
    const pausedPng = assertPausedPng(run.frames, 'missing fixture');
    evidence.states.missingFixture = {
      camera: averageFrameRgb(run.frames),
      frames: run.frames.length,
      png: pausedPng.png,
      pngRgb: pausedPng.rgb,
    };
    pass(
      'Missing replay input keeps the camera on the opaque paused canvas',
      `${JSON.stringify(evidence.states.missingFixture.camera)} ${pausedPng.png}`,
    );
    assert.equal(consoleErrors.length, 0, `renderer console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    await closeApp(app);
  }
  return evidence;
}

const MASK_EYE_RGB = { r: 103, g: 232, b: 249 };
/** Window with the largest recorded pose swing in fixtures/pose-loop.json. */
const MOTION_WINDOW_START_SECONDS = 41.6;
/** Documented motion window length (docs/fixture-pose-loop.md, docs/notes/0003). */
const MOTION_WINDOW_SECONDS = 8;
const MOTION_WINDOW_START_MS = MOTION_WINDOW_START_SECONDS * 1000;
const MOTION_WINDOW_END_MS = MOTION_WINDOW_START_MS + MOTION_WINDOW_SECONDS * 1000;

async function readTracking(page) {
  return parseKeyValues(await readDiagnostic(page, 'diag-tracking'));
}

/**
 * Evidence for one injected policy state: the public diagnostics must label the
 * sample as injected and report the phase the output policy is acting on, so
 * summary.json proves these states were not produced by the real detector.
 */
function injectedTrackingEvidence(tracking) {
  return {
    phase: tracking.phase,
    classification: tracking.sample,
    injected: tracking.injected === 'true',
    source: tracking.source,
    faces: Number(tracking.faces),
    landmarks: Number(tracking.landmarks),
    transform: tracking.transform,
  };
}

async function waitForTrackingPhase(page, phase = 'tracking', timeoutMs = 30000) {
  return waitFor(
    `tracking phase ${phase}`,
    async () => {
      const values = await readTracking(page);
      return values.phase === phase ? values : null;
    },
    timeoutMs,
    100,
  );
}

async function waitForTrackerModelReady(page, timeoutMs = 60000) {
  return waitFor(
    'face tracker model ready',
    async () => {
      const model = parseKeyValues(await readDiagnostic(page, 'diag-model'));
      return model.state === 'ready' ? model : null;
    },
    timeoutMs,
    100,
  );
}

async function readMask(page) {
  return parseKeyValues(await readDiagnostic(page, 'diag-mask'));
}

async function readFace(page) {
  return parseKeyValues(await readDiagnostic(page, 'diag-face'));
}

async function readMaskProbe(page) {
  return parseKeyValues(await readDiagnostic(page, 'diag-mask-probe'));
}

function maskEyeColourMatches(values, tolerance = 12) {
  return (
    Math.abs(Number(values.r) - MASK_EYE_RGB.r) <= tolerance &&
    Math.abs(Number(values.g) - MASK_EYE_RGB.g) <= tolerance &&
    Math.abs(Number(values.b) - MASK_EYE_RGB.b) <= tolerance
  );
}

/**
 * The mask's cyan eye plate is an opaque, exact-colour probe: if the mask is not
 * composited into the output, the pixel is video content instead.
 */
function assertMaskProbe(probe, label) {
  assert.ok(
    maskEyeColourMatches(probe),
    `${label}: output pixel at the mask eye probe must be the mask colour ${JSON.stringify(MASK_EYE_RGB)}, got ${JSON.stringify(probe)}`,
  );
}

function originInsideFace(mask, face, marginFraction = 0.35) {
  const x = Number(face.x);
  const y = Number(face.y);
  const width = Number(face.w);
  const height = Number(face.h);
  const marginX = width * marginFraction;
  const marginY = height * marginFraction;
  const originX = Number(mask.originX);
  const originY = Number(mask.originY);
  return (
    originX >= x - marginX &&
    originX <= x + width + marginX &&
    originY >= y - marginY &&
    originY <= y + height + marginY
  );
}

function spread(values) {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

function verifyFixtureManifest(manifestFileName) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'fixtures', manifestFileName), 'utf8'));
  const file = path.join(committedFixtureCacheDir, manifest.fileName);
  if (!existsSync(file)) {
    throw new Error(`Fixture ${manifest.id} is missing at ${file}. Run \`npm run fetch:motion-fixture\`.`);
  }
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length, manifest.bytes, `${manifest.id} bytes must match its manifest`);
  assert.equal(sha256, manifest.sha256, `${manifest.id} must match its committed checksum`);
  return manifest;
}

async function trackingMaskScenario() {
  log('\n== Scenario F: one-face tracking, rigid mask and tracking-loss policy ==');
  const evidence = { states: {}, maskMotion: {}, camera: {}, timing: {} };
  const { app, page, consoleErrors } = await launchApp({ SHYMASK_EVIDENCE_DIR: evidenceDir });
  try {
    await waitFor('fixture diagnostics', async () => {
      const text = await readDiagnostic(page, 'diag-fixture');
      return text.includes(metadata.id) ? text : null;
    });
    const model = await waitForTrackerModelReady(page);
    await waitFor('start enabled after tracker initialization', async () => {
      return (await page.locator('[data-testid="start"]').isDisabled()) ? null : true;
    }, 60000);
    const startup = await readStatus(page);
    assert.equal(startup.title, 'Tracking paused');
    assert.match(startup.explanation, /has not started/i);
    pass('Face tracker assets are validated before Start and startup stays paused', `${model.state} ${model.sha256}`);

    await page.locator('[data-testid="start"]').click();
    // The mask transform is only updated from a sample the state machine
    // classifies reliable, so the public diagnostic must expose that
    // classification alongside the phase.
    const tracked = await waitFor(
      'tracking phase tracking with a reliably classified sample',
      async () => {
        const values = await readTracking(page);
        return values.phase === 'tracking' && values.sample === 'reliable' ? values : null;
      },
      30000,
      100,
    );
    assert.equal(tracked.sample, 'reliable');
    assert.equal(Number(tracked.faces), 1);
    assert.ok(Number(tracked.landmarks) >= 400, `tracked face must expose landmarks, got ${tracked.landmarks}`);
    assert.equal(tracked.transform, 'true');
    assert.equal(tracked.injected, 'false');
    const face = await readFace(page);
    assert.equal(Number(face.count), 1);
    assert.ok(Number(face.w) > 40, `tracked face must be measurable, got ${JSON.stringify(face)}`);
    evidence.states.trackingReady = { tracking: tracked, face };
    pass(
      'Recorded replay produces exactly one reliably tracked face through the normal pipeline',
      `faces=${tracked.faces} landmarks=${tracked.landmarks} bbox=${face.w}x${face.h}`,
    );

    await page.locator('[data-testid="effect-select"]').selectOption('mask');
    await waitForStatusTitle(page, /Effect active: Rigid mask/);
    const mask = await waitFor('mask projection', async () => {
      const values = await readMask(page);
      return values.visible === 'true' ? values : null;
    });
    const faceForMask = await readFace(page);
    assert.ok(originInsideFace(mask, faceForMask), `mask origin must sit on the tracked face: mask=${JSON.stringify(mask)} face=${JSON.stringify(faceForMask)}`);
    assert.ok(
      Number(mask.widthPx) > Number(faceForMask.w) * 0.35 && Number(mask.widthPx) < Number(faceForMask.w) * 2,
      `mask must be sized to the face: maskWidth=${mask.widthPx} faceWidth=${faceForMask.w}`,
    );
    const probe = await readMaskProbe(page);
    assertMaskProbe(probe, 'preview mask');
    const maskRgb = await readRgb(page);
    const maskShot = await screenshotCanvas(page, '12-mask-render.png');
    evidence.states.mask = { mask, face: faceForMask, probe, preview: maskRgb, screenshot: maskShot };
    pass(
      'Rigid mask is attached to the tracked face and composited into the output canvas',
      `origin=(${mask.originX},${mask.originY}) size=${mask.widthPx}x${mask.heightPx} probe=${JSON.stringify(probe)} ${maskShot}`,
    );

    // Real recorded motion on the default clip is small; sample it to prove the
    // mask follows the face rather than being a fixed overlay.
    const samples = [];
    for (let index = 0; index < 7; index += 1) {
      await page.waitForTimeout(350);
      const tracking = parseKeyValues(await readDiagnostic(page, 'diag-tracking'));
      if (tracking.phase !== 'tracking') continue;
      const current = await readMask(page);
      const currentFace = await readFace(page);
      samples.push({
        originX: Number(current.originX),
        originY: Number(current.originY),
        yaw: Number(current.yaw),
        pitch: Number(current.pitch),
        face,
        currentFace,
        inside: originInsideFace(current, currentFace),
      });
    }
    assert.ok(samples.length >= 5, `expected tracked mask samples, got ${samples.length}`);
    assert.ok(samples.every((sample) => sample.inside), 'the mask must stay on the face in every tracked sample');
    const originXSpread = spread(samples.map((sample) => sample.originX));
    const originYSpread = spread(samples.map((sample) => sample.originY));
    const yawSpread = spread(samples.map((sample) => sample.yaw));
    const pitchSpread = spread(samples.map((sample) => sample.pitch));
    assert.ok(Math.max(originXSpread, originYSpread) >= 2, `mask placement must move with recorded head motion, got x=${originXSpread} y=${originYSpread}`);
    assert.ok(Math.max(yawSpread, pitchSpread) >= 0.5, `mask orientation must follow the recorded pose, got yaw=${yawSpread} pitch=${pitchSpread}`);
    evidence.maskMotion.defaultClip = { samples: samples.length, originXSpread, originYSpread, yawSpread, pitchSpread };
    pass(
      'Mask position and orientation follow the recorded head motion frame by frame',
      `origin spread x=${originXSpread} y=${originYSpread} yaw=${yawSpread.toFixed(1)} pitch=${pitchSpread.toFixed(1)}`,
    );

    // Camera: the same canvas, including the mask, reaches the independent consumer.
    const cameraPreview = await readRgb(page);
    const cameraProbe = await readMaskProbe(page);
    const maskRun = await captureCameraState(page, 'mask', 6);
    assertProcessedFrames(maskRun.frames, cameraPreview, 'mask');
    const maskPng = assertProcessedPng(maskRun.frames, cameraPreview, 'mask');
    const eyePixels = pngColorCount(maskPng.png, MASK_EYE_RGB, 24);
    assert.ok(eyePixels > 100, `camera PNG must contain the mask eye plate, found ${eyePixels} matching pixels`);
    const cameraPixel = pngPixel(maskPng.png, Number(cameraProbe.x), Number(cameraProbe.y));
    assert.ok(
      maskEyeColourMatches(cameraPixel, 24),
      `camera PNG pixel at the mask probe must be the mask colour, got ${JSON.stringify(cameraPixel)} at (${cameraProbe.x},${cameraProbe.y})`,
    );
    evidence.camera.mask = {
      preview: cameraPreview,
      probe: cameraProbe,
      camera: averageFrameRgb(maskRun.frames),
      rng: maskPng.rgb,
      eyePixels,
      cameraPixel,
      png: maskPng.png,
    };
    pass(
      'The virtual camera consumer receives the same masked output as the preview',
      `camera=${JSON.stringify(evidence.camera.mask.camera)} eyePixels=${eyePixels} probePixel=${JSON.stringify(cameraPixel)} ${maskPng.png}`,
    );

    // Tracking loss: the whole output becomes the exact opaque paused screen in
    // both paths, and recovery is automatic when the injected loss clears.
    await page.locator('[data-testid="tracking-injection"]').selectOption('lost');
    const lost = await waitFor('tracking lost pause', async () => {
      const status = await readStatus(page);
      return /tracking was lost/i.test(status.explanation) ? status : null;
    });
    assert.equal(lost.mode, 'paused');
    assert.equal(lost.title, 'Tracking paused');
    await waitForTrackingPhase(page, 'lost');
    const lostTracking = injectedTrackingEvidence(await readTracking(page));
    assert.equal(lostTracking.injected, true, 'tracking-loss evidence must come from the labelled injection');
    assert.equal(lostTracking.source, 'lost');
    assert.equal(lostTracking.phase, 'lost');
    assert.equal(lostTracking.classification, 'none');
    assert.equal(lostTracking.faces, 0);
    await page.waitForTimeout(300);
    const lostRgb = await readRgb(page);
    assert.ok(rgbSum(lostRgb) < 120, `tracking-loss output must be the dark paused screen, got ${JSON.stringify(lostRgb)}`);
    const lostShot = await screenshotCanvas(page, '13-tracking-lost-paused.png');
    const lostRun = await captureCameraState(page, 'tracking-lost', 6);
    assertAllPausedFrames(lostRun.frames, 'tracking lost');
    const lostPng = assertPausedPng(lostRun.frames, 'tracking lost');
    evidence.states.trackingLost = { injectedTracking: lostTracking, status: lost, preview: lostRgb, camera: averageFrameRgb(lostRun.frames), png: lostPng.png, screenshot: lostShot };
    pass(
      'Tracking loss replaces the whole output with the opaque paused screen in preview and camera',
      `injected=${lostTracking.injected} phase=${lostTracking.phase} preview=${JSON.stringify(lostRgb)} camera=${JSON.stringify(evidence.states.trackingLost.camera)} ${lostShot}`,
    );

    // Multiple faces.
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Rigid mask/);
    await page.locator('[data-testid="tracking-injection"]').selectOption('multiple');
    const multiple = await waitFor('multiple faces pause', async () => {
      const status = await readStatus(page);
      return /more than one face/i.test(status.explanation) ? status : null;
    });
    assert.equal(multiple.mode, 'paused');
    await waitForTrackingPhase(page, 'multiple-faces');
    const multipleTracking = injectedTrackingEvidence(await readTracking(page));
    assert.equal(multipleTracking.injected, true, 'multiple-face evidence must come from the labelled injection');
    assert.equal(multipleTracking.source, 'multiple');
    assert.equal(multipleTracking.phase, 'multiple-faces');
    assert.equal(multipleTracking.classification, 'multiple');
    assert.ok(multipleTracking.faces > 1, `multiple-face evidence must report more than one face, got ${multipleTracking.faces}`);
    await page.waitForTimeout(300);
    const multipleRgb = await readRgb(page);
    assert.ok(rgbSum(multipleRgb) < 120, 'multiple-face output must be dark');
    const multipleShot = await screenshotCanvas(page, '14-multiple-faces-paused.png');
    const multipleRun = await captureCameraState(page, 'multiple-faces', 6);
    assertAllPausedFrames(multipleRun.frames, 'multiple faces');
    const multiplePng = assertPausedPng(multipleRun.frames, 'multiple faces');
    evidence.states.multipleFaces = { injectedTracking: multipleTracking, status: multiple, preview: multipleRgb, camera: averageFrameRgb(multipleRun.frames), png: multiplePng.png, screenshot: multipleShot };
    pass(
      'More than one detected face pauses the whole output in preview and camera',
      `injected=${multipleTracking.injected} phase=${multipleTracking.phase} preview=${JSON.stringify(multipleRgb)} camera=${JSON.stringify(evidence.states.multipleFaces.camera)} ${multipleShot}`,
    );

    // Unreliable tracking.
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForTrackingPhase(page);
    await page.locator('[data-testid="tracking-injection"]').selectOption('unreliable');
    const unreliable = await waitFor('unreliable tracking pause', async () => {
      const status = await readStatus(page);
      return /unreliable/i.test(status.explanation) ? status : null;
    });
    assert.equal(unreliable.mode, 'paused');
    await waitForTrackingPhase(page, 'unreliable');
    const unreliableTracking = injectedTrackingEvidence(await readTracking(page));
    assert.equal(unreliableTracking.injected, true, 'unreliable-tracking evidence must come from the labelled injection');
    assert.equal(unreliableTracking.source, 'unreliable');
    assert.equal(unreliableTracking.phase, 'unreliable');
    assert.equal(unreliableTracking.classification, 'unreliable');
    assert.equal(unreliableTracking.faces, 1);
    await page.waitForTimeout(300);
    const unreliableRgb = await readRgb(page);
    assert.ok(rgbSum(unreliableRgb) < 120, 'unreliable-tracking output must be dark');
    const unreliableShot = await screenshotCanvas(page, '15-unreliable-tracking-paused.png');
    const unreliableRun = await captureCameraState(page, 'unreliable', 6);
    assertAllPausedFrames(unreliableRun.frames, 'unreliable tracking');
    const unreliablePng = assertPausedPng(unreliableRun.frames, 'unreliable tracking');
    evidence.states.unreliable = { injectedTracking: unreliableTracking, status: unreliable, preview: unreliableRgb, camera: averageFrameRgb(unreliableRun.frames), png: unreliablePng.png, screenshot: unreliableShot };
    pass(
      'Unreliable tracking pauses the whole output in preview and camera',
      `injected=${unreliableTracking.injected} phase=${unreliableTracking.phase} preview=${JSON.stringify(unreliableRgb)} camera=${JSON.stringify(evidence.states.unreliable.camera)} ${unreliableShot}`,
    );

    // Automatic recovery to the selected effect.
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Rigid mask/);
    const recovered = await readStatus(page);
    const recoveredMask = await readMask(page);
    assert.equal(recoveredMask.visible, 'true');
    evidence.states.recovered = { status: recovered, mask: recoveredMask };
    pass('The selected mask is restored automatically when one face and healthy processing return', `${recovered.title} ${JSON.stringify(recoveredMask.visible)}`);

    // Manual pause must persist until Resume. The tracker is deliberately
    // skipped while paused, so this public-workflow check can observe
    // persistence, not an automatic recovery racing the manual pause; the
    // precedence itself is asserted through the public diag-output reason and
    // is covered exhaustively by the output-policy unit tests.
    await page.locator('[data-testid="pause-toggle"]').click();
    const manualPause = await waitForStatusTitle(page, /^Tracking paused$/);
    assert.match(manualPause.explanation, /paused manually/i);
    const manualReason = parseKeyValues(await readDiagnostic(page, 'diag-output')).reason;
    assert.equal(manualReason, 'manual-pause', 'the output policy must report manual pause as the active reason');
    await page.locator('[data-testid="tracking-injection"]').selectOption('lost');
    await page.waitForTimeout(400);
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await page.waitForTimeout(1500);
    const stillPaused = await readStatus(page);
    assert.equal(stillPaused.title, 'Tracking paused');
    assert.match(stillPaused.explanation, /paused manually/i);
    assert.equal(
      parseKeyValues(await readDiagnostic(page, 'diag-output')).reason,
      'manual-pause',
      'manual pause must stay the policy reason across tracking-injection changes',
    );
    assert.equal(await page.locator('[data-testid="pause-toggle"]').textContent(), 'Resume');
    const manualShot = await screenshotCanvas(page, '16-manual-pause-precedence.png');
    await page.locator('[data-testid="pause-toggle"]').click();
    await waitForStatusTitle(page, /Effect active: Rigid mask/);
    pass(
      'Manual pause persists until Resume and is the reported output reason across tracking changes',
      `${manualShot} ${stillPaused.explanation}`,
    );

    // AC4: tracking readiness/loss gates every selected effect, not just the mask.
    await page.locator('[data-testid="effect-select"]').selectOption('warm');
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    await page.locator('[data-testid="tracking-injection"]').selectOption('lost');
    const warmLost = await waitFor('color treatment tracking pause', async () => {
      const status = await readStatus(page);
      return /tracking was lost/i.test(status.explanation) ? status : null;
    });
    assert.equal(warmLost.mode, 'paused');
    const warmLostShot = await screenshotCanvas(page, '17-color-treatment-tracking-lost.png');
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Warm tint/);
    evidence.states.colorTreatmentTrackingLoss = { paused: warmLost, screenshot: warmLostShot };
    pass(
      'Tracking loss pauses the existing color treatment too, and recovery restores it',
      `${warmLostShot} -> ${await readDiagnostic(page, 'diag-output')}`,
    );

    const trackingTiming = parseKeyValues(await readDiagnostic(page, 'diag-tracking-timing'));
    const renderCost = parseKeyValues(await readDiagnostic(page, 'diag-render-cost'));
    evidence.timing = {
      inferenceLastMs: Number(trackingTiming.lastMs ?? 0),
      inferenceP95Ms: Number(trackingTiming.p95Ms ?? 0),
      inferenceWarmupMs: Number(trackingTiming.warmupMs ?? 0),
      inferenceFrames: Number(trackingTiming.frames ?? 0),
      renderCostP95Ms: Number(renderCost.p95Ms ?? 0),
    };
    pass(
      'Replay-based tracking and render timing baseline recorded',
      `inference p95=${evidence.timing.inferenceP95Ms}ms (warmup=${evidence.timing.inferenceWarmupMs}ms) render p95=${evidence.timing.renderCostP95Ms}ms`,
    );

    assert.equal(await page.evaluate(() => document.querySelectorAll('video').length > 0), true);
    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);
    pass('No renderer console errors during the tracking and mask scenario');
  } finally {
    await closeApp(app);
  }
  return evidence;
}

async function recordedMotionScenario() {
  log('\n== Scenario G: recorded head turns, nods and leaning (larger-motion CC0 clip) ==');
  const motionMetadata = verifyFixtureManifest('pose-loop.json');
  const evidence = { states: {}, motion: {}, timing: {} };
  const { app, page, consoleErrors } = await launchApp({
    SHYMASK_EVIDENCE_DIR: evidenceDir,
    SHYMASK_FIXTURE_MANIFEST: 'pose-loop.json',
  });
  try {
    await waitFor('motion fixture diagnostics', async () => {
      const text = await readDiagnostic(page, 'diag-fixture');
      return text.includes(motionMetadata.id) ? text : null;
    });
    await waitForTrackerModelReady(page);
    await page.locator('[data-testid="start"]').click();
    await waitForTrackingPhase(page);
    await page.locator('[data-testid="effect-select"]').selectOption('mask');
    await waitForStatusTitle(page, /Effect active: Rigid mask/);

    // Controlled scenario: seek to the documented 8 s window with the largest
    // observed pose swing in this recorded clip. The input is still the same
    // recorded video and the normal processing pipeline.
    await page.evaluate((startSeconds) => {
      const video = document.querySelector('video');
      if (!video) throw new Error('expected a replay video element');
      video.currentTime = startSeconds;
    }, MOTION_WINDOW_START_SECONDS);
    await waitFor(
      'motion window media time',
      async () => {
        const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
        return Number(timestamp.mediaMs ?? 0) >= MOTION_WINDOW_START_SECONDS * 1000 ? timestamp : null;
      },
      15000,
      100,
    );

    const samples = [];
    const sampleShots = [];
    let windowExitedAtMs = null;
    for (let index = 0; index < 18; index += 1) {
      await page.waitForTimeout(400);
      const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
      const mediaMs = Number(timestamp.mediaMs ?? 0);
      if (mediaMs > MOTION_WINDOW_END_MS) {
        // Sampling reached the end of the documented 8 s window; keep the
        // collected in-window samples and record where it stopped.
        windowExitedAtMs = mediaMs;
        break;
      }
      const tracking = parseKeyValues(await readDiagnostic(page, 'diag-tracking'));
      if (tracking.phase !== 'tracking') continue;
      const mask = await readMask(page);
      const face = await readFace(page);
      if (mask.visible !== 'true') continue;
      samples.push({
        yaw: Number(mask.yaw),
        pitch: Number(mask.pitch),
        roll: Number(mask.roll),
        originX: Number(mask.originX),
        originY: Number(mask.originY),
        face,
        inside: originInsideFace(mask, face),
        mediaMs,
      });
      if (index === 3 || index === 9 || index === 15) {
        const shot = await screenshotCanvas(page, `18-motion-mask-${index}.png`);
        sampleShots.push(shot);
      }
    }
    // Every kept sample must be inside the documented window; the window exists
    // so the pose ranges are not a whole-clip claim.
    assert.ok(
      samples.every((sample) => sample.mediaMs >= MOTION_WINDOW_START_MS && sample.mediaMs <= MOTION_WINDOW_END_MS),
      `motion samples must fall inside the ${MOTION_WINDOW_SECONDS}s window at ${MOTION_WINDOW_START_SECONDS}s: ${samples.map((sample) => sample.mediaMs).join(', ')}`,
    );
    assert.ok(samples.length >= 14, `expected most motion-window frames tracked, got ${samples.length}/18`);
    assert.ok(samples.every((sample) => sample.inside), 'the mask must stay attached to the face during turns and nods');
    const yawRange = spread(samples.map((sample) => sample.yaw));
    const pitchRange = spread(samples.map((sample) => sample.pitch));
    const rollRange = spread(samples.map((sample) => sample.roll));
    const originXRange = spread(samples.map((sample) => sample.originX));
    const originYRange = spread(samples.map((sample) => sample.originY));
    assert.ok(yawRange >= 12, `recorded turns must rotate the mask, yaw range=${yawRange}`);
    assert.ok(pitchRange >= 12, `recorded nods must rotate the mask, pitch range=${pitchRange}`);
    assert.ok(rollRange >= 4, `recorded leaning must roll the mask, roll range=${rollRange}`);
    assert.ok(
      Math.max(originXRange, originYRange) >= 40,
      `recorded motion must move the mask origin, x=${originXRange} y=${originYRange}`,
    );
    const motionProbe = await readMaskProbe(page);
    assertMaskProbe(motionProbe, 'motion-window preview mask');
    evidence.motion = {
      fixture: motionMetadata.id,
      windowStartSeconds: MOTION_WINDOW_START_SECONDS,
      windowSeconds: MOTION_WINDOW_SECONDS,
      windowStartMediaMs: MOTION_WINDOW_START_MS,
      windowEndMediaMs: MOTION_WINDOW_END_MS,
      windowExitedAtMs,
      trackedSamples: samples.length,
      yawRange,
      pitchRange,
      rollRange,
      originXRange,
      originYRange,
      previewProbe: motionProbe,
      screenshots: sampleShots,
      samples,
    };
    pass(
      'The mask follows recorded head turns, nods and leaning through the normal pipeline',
      `tracked=${samples.length}/18 yaw=${yawRange.toFixed(1)} pitch=${pitchRange.toFixed(1)} roll=${rollRange.toFixed(1)} origin=${originXRange}x${originYRange}px mediaMs=${samples[0]?.mediaMs ?? '?'}-${samples[samples.length - 1]?.mediaMs ?? '?'} (window ${MOTION_WINDOW_START_MS}-${MOTION_WINDOW_END_MS})`,
    );
    pass('Masked motion-window screenshots captured at three points in the turn', sampleShots.join(' '));

    const cameraPreview = await readRgb(page);
    const cameraRun = await captureCameraState(page, 'motion-mask', 6);
    assertProcessedFrames(cameraRun.frames, cameraPreview, 'motion mask');
    const cameraPng = assertProcessedPng(cameraRun.frames, cameraPreview, 'motion mask');
    const eyePixels = pngColorCount(cameraPng.png, MASK_EYE_RGB, 24);
    assert.ok(eyePixels > 60, `motion camera PNG must contain the mask, found ${eyePixels} eye pixels`);
    evidence.camera = {
      preview: cameraPreview,
      camera: averageFrameRgb(cameraRun.frames),
      eyePixels,
      png: cameraPng.png,
    };
    pass(
      'The camera consumer receives the masked head-turn output as well',
      `camera=${JSON.stringify(evidence.camera.camera)} eyePixels=${eyePixels} ${cameraPng.png}`,
    );

    const trackingTiming = parseKeyValues(await readDiagnostic(page, 'diag-tracking-timing'));
    evidence.timing = {
      inferenceP95Ms: Number(trackingTiming.p95Ms ?? 0),
      inferenceWarmupMs: Number(trackingTiming.warmupMs ?? 0),
      inferenceFrames: Number(trackingTiming.frames ?? 0),
    };
    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);
    pass('No renderer console errors during the recorded-motion scenario');
  } finally {
    await closeApp(app);
  }
  return evidence;
}

async function trackerModelScenario() {
  log('\n== Scenario H: missing and corrupt face-tracker model ==');
  const evidence = { missing: {}, corrupt: {} };
  const missingDir = path.join(evidenceDir, 'missing-tracker');
  mkdirSync(missingDir, { recursive: true });
  {
    const { app, page, consoleErrors } = await launchApp({
      SHYMASK_EVIDENCE_DIR: evidenceDir,
      SHYMASK_TRACKER_DIR: missingDir,
    });
    try {
      const status = await waitForStatusTitle(page, /^Tracking paused$/);
      assert.match(status.explanation, /face-tracker model is missing/i);
      assert.match(status.action, /fetch:tracker/);
      assert.equal(await page.locator('[data-testid="start"]').isDisabled(), true);
      await page.waitForTimeout(300);
      const rgb = await readRgb(page);
      assert.ok(rgbSum(rgb) < 120, `missing tracker model must hide the output, got ${JSON.stringify(rgb)}`);
      const shot = await screenshotCanvas(page, '19-missing-tracker-model.png');
      await waitForVirtualCamera(page);
      const run = await captureCameraState(page, 'missing-tracker', 6);
      assertAllPausedFrames(run.frames, 'missing tracker model');
      const png = assertPausedPng(run.frames, 'missing tracker model');
      evidence.missing = { status, preview: rgb, camera: averageFrameRgb(run.frames), png: png.png, screenshot: shot };
      pass(
        'A missing tracker model shows an actionable error and the hidden output in preview and camera',
        `${JSON.stringify(rgb)} ${png.png}`,
      );
      assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);
    } finally {
      await closeApp(app);
    }
  }

  {
    const modelMetadata = JSON.parse(readFileSync(path.join(root, 'tracker', 'face-landmarker-model.json'), 'utf8'));
    const corruptDir = path.join(evidenceDir, 'corrupt-tracker');
    mkdirSync(corruptDir, { recursive: true });
    const builtTrackerDir = path.join(root, 'dist', 'renderer', 'tracker');
    for (const fileName of [
      'vision_wasm_internal.js',
      'vision_wasm_internal.wasm',
      'vision_wasm_nosimd_internal.js',
      'vision_wasm_nosimd_internal.wasm',
    ]) {
      copyFileSync(path.join(builtTrackerDir, fileName), path.join(corruptDir, fileName));
    }
    // Same byte length, wrong bytes: exercises the checksum branch rather than
    // the size branch.
    writeFileSync(path.join(corruptDir, modelMetadata.fileName), Buffer.alloc(modelMetadata.bytes, 0));

    const { app, page, consoleErrors } = await launchApp({
      SHYMASK_EVIDENCE_DIR: evidenceDir,
      SHYMASK_TRACKER_DIR: corruptDir,
    });
    try {
      const status = await waitForStatusTitle(page, /^Tracking paused$/);
      assert.match(status.explanation, /checksum mismatch/i);
      assert.match(status.action, /fetch:tracker/);
      assert.equal(await page.locator('[data-testid="start"]').isDisabled(), true);
      await page.waitForTimeout(300);
      const rgb = await readRgb(page);
      assert.ok(rgbSum(rgb) < 120, `corrupt tracker model must hide the output, got ${JSON.stringify(rgb)}`);
      const shot = await screenshotCanvas(page, '20-corrupt-tracker-model.png');
      // The paused screen is one canvas shared with the camera path, so the
      // corrupt-model case is cheap to confirm through the camera consumer too.
      await waitForVirtualCamera(page);
      const run = await captureCameraState(page, 'corrupt-tracker', 6);
      assertAllPausedFrames(run.frames, 'corrupt tracker model');
      const png = assertPausedPng(run.frames, 'corrupt tracker model');
      evidence.corrupt = { status, preview: rgb, camera: averageFrameRgb(run.frames), png: png.png, screenshot: shot };
      pass(
        'A corrupt tracker model (checksum mismatch) shows an actionable error and hidden output',
        `${JSON.stringify(rgb)} camera=${JSON.stringify(evidence.corrupt.camera)} ${png.png}`,
      );
      assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);
    } finally {
      await closeApp(app);
    }
  }
  return evidence;
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

/**
 * Builds and stages the native virtual camera before the scenarios. The camera
 * media source must match the committed sources, and the machine-wide (HKLM)
 * registration from `npm run vcam:install` (elevated once) must already exist.
 */
function prepareNativeComponents() {
  log('\n== Native virtual camera build ==');
  const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-native.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    throw new Error('native camera build failed; MSVC and the Windows 11 SDK are required');
  }
  const install = spawnSync(process.execPath, [path.join(root, 'scripts', 'vcam.mjs'), 'install'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (install.status !== 0) {
    throw new Error(`native camera install failed: ${(install.stderr || install.stdout || '').trim()}`);
  }
  for (const line of (install.stdout ?? '').trim().split(/\r?\n/).slice(-2)) log(`[native] ${line}`);
}

async function main() {
  const headSha = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const validationBase = resolveValidationBase();
  const environment = collectEnvironment();
  const ciWorkflowsPresent = existsSync(path.join(root, '.github', 'workflows'));
  log('== Shymask public-workflow check ==');
  log(`head:     ${headSha}`);
  log(`branch:   ${branch}`);
  log(`base:     ${validationBase.sha} (merge-base with ${validationBase.ref})`);
  log(`command:  npm run check (build + this Electron/Playwright harness)`);
  log(`source:   recorded replay fixture ${metadata.fileName} (no physical webcam; Windows virtual camera path included)`);
  log(
    `host:     ${environment.cpu.model} | ${environment.cpu.logicalCores} logical cores | ${environment.os.totalmemGiB} GiB RAM | ${environment.os.platform} ${environment.os.release} (${environment.os.version})`,
  );
  log(`gpu:      ${environment.gpu.join('; ') || 'not detected'}`);
  log(`node:     ${environment.node} | electron ${environment.electron}`);

  verifyFixtureFile();
  prepareNativeComponents();
  staticCameraGuard();
  await normalFixtureScenario();
  await missingFixtureScenario();
  await invalidFixtureScenario();
  const virtualCamera = await virtualCameraScenario();
  const missingFixtureCamera = await missingFixtureCameraScenario();
  const trackingMask = await trackingMaskScenario();
  const recordedMotion = await recordedMotionScenario();
  const trackerModel = await trackerModelScenario();
  const trackerMetadata = JSON.parse(readFileSync(path.join(root, 'tracker', 'face-landmarker-model.json'), 'utf8'));
  const motionManifest = JSON.parse(readFileSync(path.join(root, 'fixtures', 'pose-loop.json'), 'utf8'));

  const summary = {
    generatedAt: new Date().toISOString(),
    headSha,
    branch,
    baseSha: validationBase.sha,
    baseRef: validationBase.ref,
    environment,
    workload: {
      sourceMode: 'recorded replay fixture (no physical webcam)',
      app: 'Electron preview publishing its single output canvas as the Shymask Camera Windows virtual webcam',
      consumer: 'independent shymask-camera-consumer.exe process using Media Foundation device enumeration and the Source Reader',
      output: '1280x720 RGB32 canvas; processed frames and the opaque paused screen share this path',
      fixture: {
        id: metadata.id,
        fileName: metadata.fileName,
        durationSeconds: metadata.durationSeconds,
        resolution: `${metadata.width}x${metadata.height}`,
      },
      motionFixture: {
        id: motionManifest.id,
        fileName: motionManifest.fileName,
        durationSeconds: motionManifest.durationSeconds,
        resolution: `${motionManifest.width}x${motionManifest.height}`,
        windowStartSeconds: MOTION_WINDOW_START_SECONDS,
        windowSeconds: MOTION_WINDOW_SECONDS,
      },
    },
    measuredBoundaries: [
      'Processing timestamps, loops and seams are read from the app diagnostics; loop seams are also counted independently from backward media-time jumps in the samples.',
      'Source frame interval is the p95 of requestVideoFrameCallback presented-frame deltas (last 180 frames), not a camera or decoder throughput figure.',
      'Render cost is renderer main-thread draw/filter submission only; compositor/GPU/present latency is not measured.',
      'Replay pacing compares processing-timestamp span with wall-clock span inside one sampling window.',
      'Camera frames are read by a separate Media Foundation consumer process; camera latency is the consumer receive time minus the canvas capture wall-clock time carried in the sample attribute.',
      'The camera path adds the app canvas readback, an IPC copy, a loopback TCP hop, RGB32 conversion and the native media source; each is inside the measured latency, but no camera sensor or call application is involved.',
      'No physical-camera behavior, real Zoom/Meet/OBS compatibility, laptop or integrated-graphics suitability is measured.',
      'Tracker inference cost is performance.now() around one MediaPipe detectForVideo call; the first warm-up inference is reported separately and excluded from the p95.',
      'Mask placement/orientation is derived from the MediaPipe facial transformation matrix using its documented 63 degree vertical-FOV camera assumption; it is a rigid attachment, not occlusion-aware.',
      'Tracking-loss, multiple-face and unreliable-tracking policy states in Scenario F are produced by the labelled diagnostic injection control; the real detector path is used for the normal tracking and recorded-motion states. The recorded-motion clip is real recorded video from a second CC0 fixture, positioned by seeking to a documented window.',
    ],
    commands: {
      build: 'npm run build',
      buildNative: 'npm run build:native',
      installCamera: 'npm run vcam:install',
      typecheck: 'npm run typecheck',
      test: 'npm test',
      check: 'npm run check',
      nativeCameraCheck: 'npm run vcam:check',
    },
    validationGate: {
      continuousIntegration: ciWorkflowsPresent
        ? 'A .github/workflows directory exists; inspect its status separately.'
        : 'No CI is configured (no .github/workflows); local validation is the merge gate.',
      branchProtection:
        'No branch protection or rulesets are configured on main (verified read-only via the GitHub API on 2026-11-13: branch protection 404 "Branch not protected"; rulesets []).',
      requiredLocalValidation: 'npm run typecheck, npm test and npm run check must pass at the exact head SHA above.',
    },
    fixture: {
      id: metadata.id,
      title: metadata.title,
      license: metadata.license,
      sha256: metadata.sha256,
      bytes: metadata.bytes,
      durationSeconds: metadata.durationSeconds,
      sourcePage: metadata.sourcePage,
    },
    tracking: {
      engine:
        'MediaPipe Face Landmarker via @mediapipe/tasks-vision 0.10.21 (WASM, GPU delegate) in the renderer; Three.js 0.180.0 rigid mask composited into the single output canvas',
      model: {
        id: trackerMetadata.id,
        version: trackerMetadata.version,
        sourceUrl: trackerMetadata.sourceUrl,
        license: trackerMetadata.license,
        sha256: trackerMetadata.sha256,
        bytes: trackerMetadata.bytes,
      },
      mask:
        'bundled procedural low-poly helmet/visor attached to the face facial transformation matrix; MediaPipe 63 degree vertical FOV camera; occlusion refinement is a later issue',
      thresholds: {
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        lostGraceMs: 250,
        unreliableConfirmMs: 250,
        recoveryConfirmMs: 300,
        maxConsecutiveInferenceErrors: 5,
      },
      // Policy states produced by the labelled diagnostic injection, with the
      // phase the output policy acted on; the real detector path is used for
      // the trackingReady and recorded-motion evidence.
      injectedStates: {
        trackingLost: trackingMask.states.trackingLost.injectedTracking,
        multipleFaces: trackingMask.states.multipleFaces.injectedTracking,
        unreliable: trackingMask.states.unreliable.injectedTracking,
      },
      evidence: {
        defaultClip: trackingMask,
        recordedMotion,
        trackerModel,
      },
    },
    timing: {
      ...timing,
      basis: 'replay-derived preview and replay-to-camera measurements at this head; not the 720p/30 FPS / 100 ms camera-to-output target',
    },
    virtualCamera: {
      friendlyName: 'Shymask Camera (Windows Virtual Camera)',
      mediaType: 'RGB32 1280x720@30',
      transport: 'Electron output canvas -> IPC -> loopback TCP -> native Media Foundation media source -> frame server -> consumer',
      registration: 'per-user attempt plus machine-wide (HKLM) COM registration; see docs/notes/0002-windows-virtual-camera-spike.md',
      evidence: virtualCamera,
      missingFixture: missingFixtureCamera.states.missingFixture,
    },
    results,
    limitations: [
      'Replay fixtures only; no physical webcam was opened and no human participated.',
      'Virtual camera evidence is from a separate Media Foundation consumer harness, not a call or stream application; Zoom/Meet/OBS compatibility is a later slice.',
      'Camera latency is measured against canvas capture time in the same process tree; camera-sensor and call-network delay are out of scope.',
      'Tracking is demonstrated on recorded video (the default clip and a second larger-motion CC0 clip); there is no physical-camera or live-human tracking evidence in this slice.',
      'Tracking loss, multiple faces and unreliable tracking are exercised through a labelled diagnostic injection; the detected-face path is authoritative when the control is on normal. The policy cannot detect every possible tracking or rendering defect.',
      'The rigid mask has no occlusion refinement and no secondary motion; those are later issues. The mask is composited as one procedural low-poly effect.',
      'Measured on this development desktop with a discrete GPU; laptop integrated-graphics behavior is unverified.',
      'Color treatments use canvas CSS filters in this spike; a later effect-package slice may replace the implementation.',
      'No CI or branch protection exists; these local checks are the validation gate.',
    ],
  };
  writeFileSync(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  log('\n== Timing baseline (replay-based) ==');
  log(`source clip duration:        ${metadata.durationSeconds}s`);
  log(`source frame interval p95:   ${timing.sourceFrameIntervalP95Ms.toFixed(1)}ms`);
  log(`render + filter cost p95:    ${timing.renderCostP95Ms.toFixed(2)}ms`);
  log(`loop cycles observed:        ${timing.loopsObserved} in ${(timing.loopWallSpanMs / 1000).toFixed(2)}s`);
  log(`replay pacing ratio:         ${timing.pacingRatio} (processing time / wall time)`);
  log(`camera frames observed:      ${virtualCamera.timing.cameraFrames} at ${virtualCamera.timing.cameraSampleRateHz}Hz (${(virtualCamera.timing.durationMs / 1000).toFixed(2)}s)`);
  log(`camera frame interval p95:   ${virtualCamera.timing.intervalP95Ms}ms`);
  log(`replay-to-camera latency:    p50=${virtualCamera.timing.latencyP50Ms}ms p95=${virtualCamera.timing.latencyP95Ms}ms`);
  log(`camera mean-RGB spread:      ${virtualCamera.timing.meanRgbSpread} (replay content changes across loops)`);
  log('\n== Tracking baseline (replay-based) ==');
  log(`tracker:                     ${trackingMask.states.trackingReady?.tracking?.faces ?? '?'} face, ${trackingMask.states.trackingReady?.tracking?.landmarks ?? '?'} landmarks`);
  log(`tracker inference p95:       ${trackingMask.timing.inferenceP95Ms}ms (warm-up ${trackingMask.timing.inferenceWarmupMs}ms, ${trackingMask.timing.inferenceFrames} frames)`);
  log(`mask render + composite p95: ${trackingMask.timing.renderCostP95Ms}ms`);
  log(`default-clip mask motion:    origin x=${trackingMask.maskMotion.defaultClip?.originXSpread}px y=${trackingMask.maskMotion.defaultClip?.originYSpread}px yaw=${trackingMask.maskMotion.defaultClip?.yawSpread?.toFixed?.(1) ?? '?'} pitch=${trackingMask.maskMotion.defaultClip?.pitchSpread?.toFixed?.(1) ?? '?'}`);
  log(`recorded turns/nods window:  ${MOTION_WINDOW_START_SECONDS}s of ${motionManifest.id}: yaw=${recordedMotion.motion.yawRange.toFixed(1)} pitch=${recordedMotion.motion.pitchRange.toFixed(1)} roll=${recordedMotion.motion.rollRange.toFixed(1)} origin=${recordedMotion.motion.originXRange}x${recordedMotion.motion.originYRange}px (${recordedMotion.motion.trackedSamples}/18 tracked)`);
  log(`tracker model:               ${trackerMetadata.id} sha256=${trackerMetadata.sha256.slice(0, 12)}…`);
  log('These numbers are replay-derived. They do not establish physical-camera tracking, laptop suitability,');
  log('or the 720p/30 FPS / 100 ms target, and the policy cannot detect every possible visual defect.');
  log('These numbers are replay-derived with a virtual camera, not a physical camera. They do not establish');
  log('the 720p/30 FPS / 100 ms camera-to-output target, call-application compatibility, or laptop suitability.');
  log(`tested head SHA:             ${headSha}`);
  log(`\nEvidence: ${evidenceDir}`);
  log(`Final log: ${finalLogPath}`);
  const failures = results.filter((result) => result.status === 'fail');
  log(`\n${results.length - failures.length}/${results.length} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  fail('check harness', error);
  const failures = results.filter((result) => result.status === 'fail');
  log(`\n${results.length - failures.length}/${results.length} checks passed`);
  log(`Evidence: ${evidenceDir}`);
  log(`Final log: ${finalLogPath}`);
  process.exitCode = 1;
});

