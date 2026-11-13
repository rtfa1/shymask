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
/**
 * Per-capture evidence for processed camera states: how many consumer frames
 * were sampled and how many of them were app-published (captureUnixMs > 0).
 * Summarised in summary.json so the docs can report retry usage honestly.
 */
const cameraCaptureAttempts = [];

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

/**
 * Reads the mean output colour only once the public status reports `render` mode
 * and the throttled mean-RGB diagnostic is non-dark (sum > 60; the paused canvas
 * is ~{12,15,20}, sum 47). This gate proves render mode plus a non-dark mean; it
 * does not prove the mean is fresh, because a stale same-brightness mean would
 * also pass.
 */
async function readProcessedRgb(page, label, timeoutMs = 15000) {
  return waitFor(
    `${label} processed preview mean RGB`,
    async () => {
      const status = await readStatus(page);
      if (status.mode !== 'render') return null;
      const rgb = await readRgb(page);
      return rgbSum(rgb) > 60 ? rgb : null;
    },
    timeoutMs,
    100,
  );
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

/**
 * Counts pixels that differ between two saved PNGs. `rect` limits the count to
 * the tracked face box (in canvas pixels) so face-occlusion evidence can show
 * that the changed mask pixels are where the face is, not arbitrary video drift.
 */
function pngPixelDiff(fileA, fileB, tolerance = 4, rect = null) {
  const a = decodePng(fileA);
  const b = decodePng(fileB);
  assert.equal(a.width, b.width, 'compared PNGs must have the same width');
  assert.equal(a.height, b.height, 'compared PNGs must have the same height');
  let count = 0;
  let inside = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const index = y * a.stride + x * a.channels;
      const changed =
        Math.abs(a.pixels[index] - b.pixels[index]) > tolerance ||
        Math.abs(a.pixels[index + 1] - b.pixels[index + 1]) > tolerance ||
        Math.abs(a.pixels[index + 2] - b.pixels[index + 2]) > tolerance;
      if (!changed) continue;
      count += 1;
      if (
        rect &&
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      ) {
        inside += 1;
      }
    }
  }
  return { count, inside, width: a.width, height: a.height };
}

/**
 * Uses the public Capture evidence frame control and copies the exact 1280x720
 * output PNG into the run's screenshot folder, so a visual comparison is of the
 * real canvas rather than a scaled page screenshot.
 */
async function captureOutputThroughControl(page, name) {
  const previous = ((await page.locator('[data-testid="capture-result"]').textContent()) ?? '').trim();
  await page.locator('[data-testid="capture"]').click();
  const result = await waitFor(
    `capture control to write ${name}`,
    async () => {
      const text = ((await page.locator('[data-testid="capture-result"]').textContent()) ?? '').trim();
      if (!text.startsWith('Captured ') || text === previous) return null;
      return text;
    },
    12000,
    50,
  );
  const source = result.slice('Captured '.length).trim();
  assert.ok(existsSync(source), `capture control must write a PNG at ${source}`);
  const target = path.join(screenshotsDir, name);
  copyFileSync(source, target);
  return target;
}

/** Seeks the normal replay to a documented time and holds that processed frame. */
async function holdReplayFrameAt(page, seconds) {
  const seekSeconds = Math.max(0, seconds - 1);
  await page.evaluate((target) => {
    const video = document.querySelector('video');
    if (!video) throw new Error('expected a replay video element');
    video.currentTime = target;
  }, seekSeconds);
  // The motion-window sampling can leave the replay already past the target,
  // so the media time must be observed *near the seek position* before the
  // target wait; otherwise stale diagnostics from the end of the window would
  // satisfy the target check and Hold would freeze the wrong pre-seek frame.
  await waitFor(
    `replay seek to ${seekSeconds}s to take effect`,
    async () => {
      const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
      const mediaMs = Number(timestamp.mediaMs ?? 0);
      return mediaMs >= seekSeconds * 1000 - 400 && mediaMs <= seekSeconds * 1000 + 900 ? timestamp : null;
    },
    15000,
    40,
  );
  await waitFor(
    `replay to reach ${seconds}s`,
    async () => {
      const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
      return Number(timestamp.mediaMs ?? 0) >= seconds * 1000 ? timestamp : null;
    },
    15000,
    40,
  );
  // A backward seek can take longer than the 250 ms decode-stall threshold, so
  // the output can still be showing the opaque paused screen when the seek
  // target is reached. Wait for a rendered frame before holding; the hold
  // re-sample only updates tracking, it does not clear a decode-stall pause.
  await waitFor(
    `rendered output before holding ${seconds}s`,
    async () => {
      const status = await readStatus(page);
      return status.mode === 'render' ? status : null;
    },
    15000,
    40,
  );
  await page.locator('[data-testid="hold-frame"]').check();
  await page.waitForTimeout(1000);
}

/**
 * Holds a rendered frame, retrying if the hold re-sample lands on a transient
 * tracking/decode pause. A paused A/B would compare two identical paused frames
 * and prove nothing, so a retry is required rather than accepting the state.
 */
async function holdRenderedFrameAt(page, seconds, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await holdReplayFrameAt(page, seconds);
    const status = await readStatus(page);
    if (status.mode === 'render') return status;
    log(`[${label}] hold attempt ${attempt + 1} at ${seconds}s was paused (${status.explanation}); resuming to recover`);
    await releaseReplayFrame(page);
    await waitFor(
      `rendered output after ${label} hold retry`,
      async () => {
        const current = await readStatus(page);
        return current.mode === 'render' ? current : null;
      },
      15000,
      40,
    );
  }
  throw new Error(`${label}: could not hold a rendered frame at ${seconds}s`);
}

async function releaseReplayFrame(page) {
  await page.locator('[data-testid="hold-frame"]').uncheck();
  await page.waitForTimeout(300);
}

/**
 * Restarts live replay through the public Recheck/Start controls after a held
 * A/B. Resuming a long-held replay in this Electron/Playwright environment can
 * stall the video frame-callback pipeline at the next loop seam (a known
 * harness/decoder artifact documented in the scenario comments); a fresh replay
 * load is deterministic and still uses the normal public processing path.
 */
async function restartReplayAfterHold(page, label, fixtureId = metadata.id) {
  await page.locator('[data-testid="recheck"]').click();
  await waitFor(
    `${label} fixture rechecked`,
    async () => {
      const text = await readDiagnostic(page, 'diag-fixture');
      return text.includes(fixtureId) ? text : null;
    },
    20000,
    100,
  );
  await waitFor(
    `${label} start enabled after replay restart`,
    async () => {
      return (await page.locator('[data-testid="start"]').isDisabled()) ? null : true;
    },
    30000,
    100,
  );
  await page.locator('[data-testid="start"]').click();
  await waitForTrackingPhase(page);
  return waitFor(
    `${label} rendered output after replay restart`,
    async () => {
      const status = await readStatus(page);
      return status.mode === 'render' ? status : null;
    },
    20000,
    100,
  );
}

/**
 * Resets the paired jitter counters through the public smoothing control. The
 * toggles are the normal public diagnostic control; no private state is poked.
 */
async function resetPoseSmoothingMetrics(page) {
  await page.locator('[data-testid="pose-smoothing"]').selectOption('raw');
  await page.locator('[data-testid="pose-smoothing"]').selectOption('smoothed');
  await page.waitForTimeout(150);
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

/**
 * Selects the app-published frame whose mean is closest to the asserted
 * processed preview. A newly connected consumer can receive only the native
 * paused fallback for its first samples, and a switch/recovery can publish one
 * paused frame while it settles, so processed evidence selects the closest app
 * frame instead of blindly taking the first. Shared by the mean-RGB and saved-PNG
 * processors so both use the same selection rule.
 */
function closestAppFrame(frames, previewRgb, { requirePng = false } = {}) {
  const candidates = frames.filter(
    (frame) => frame.captureUnixMs > 0 && (!requirePng || frame.png),
  );
  return candidates.reduce((best, frame) => {
    const distance = channelDistance(cameraFrameRgb(frame), previewRgb);
    return !best || distance < best.distance ? { frame, distance } : best;
  }, null);
}

function assertProcessedFrames(frames, previewRgb, label) {
  const appFrames = frames.filter((frame) => frame.captureUnixMs > 0);
  assert.ok(
    appFrames.length >= 2,
    `${label}: expected at least two app-published processed camera frames, got ${appFrames.length} of ${frames.length} (captureUnixMs === 0 frames are the native pre-connection fallback)`,
  );
  const closest = closestAppFrame(appFrames, previewRgb);
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
 * The app can publish one paused frame while a switch/recovery settles, so this
 * selects the app-published PNG whose mean is closest to the asserted processed
 * preview rather than blindly taking the first app frame.
 */
function assertProcessedPng(frames, previewRgb, label) {
  const closest = closestAppFrame(frames, previewRgb, { requirePng: true });
  assert.ok(
    closest !== null,
    `${label}: expected camera PNG evidence from an app-published processed frame`,
  );
  const png = closest.frame.png;
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

/**
 * Paused capture with bounded retries. A newly started consumer can receive
 * only the native paused fallback until the app notices the client and its
 * 100 ms heartbeat publishes the opaque paused canvas; with only four consumer
 * frames that race can lose. Retry a bounded number of times and still require
 * an app-published frame in the caller, so a persistent fallback fails.
 */
async function capturePausedCameraState(page, prefix, label, frames = 8) {
  const attempts = [];
  let lastRun = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastRun = await captureCameraState(page, prefix, frames);
    const appFrames = lastRun.frames.filter((frame) => frame.captureUnixMs > 0).length;
    attempts.push({
      attempt: attempt + 1,
      frames: lastRun.frames.length,
      appFrames,
      nativePausedFallbackFrames: lastRun.frames.length - appFrames,
    });
    log(`[${label}] paused camera attempt ${attempt + 1}/3: frames=${lastRun.frames.length} appFrames=${appFrames}`);
    if (appFrames >= 1) {
      cameraCaptureAttempts.push({ label, prefix, frames, state: 'paused', attempts });
      lastRun.captureAttempts = attempts;
      return lastRun;
    }
    await page.waitForTimeout(400);
  }
  cameraCaptureAttempts.push({ label, prefix, frames, state: 'paused', attempts, failed: true });
  if (lastRun) lastRun.captureAttempts = attempts;
  return lastRun;
}

/**
 * A newly started consumer can briefly receive only the native paused fallback
 * before the app's first published frame. The media source clears its cache for
 * every consumer stream and the renderer only starts publishing once the camera
 * host reports the client, so the first frames of a capture can legitimately be
 * the fallback. Capture enough frames to cover that startup and retry a bounded
 * number of times. Every attempt's total/app-published frame counts are logged
 * and recorded in summary.json; the final attempt still throws, so a persistent
 * fallback can never be accepted as processed evidence.
 */
async function captureProcessedCameraState(
  page,
  prefix,
  frames = PROCESSED_CAMERA_FRAMES,
  previewRgb,
  label,
) {
  // The app must already be drawing a processed output before the consumer
  // starts; this removes a paused/switch transition from the measured window.
  // The gate is: status mode is `render` and the mean-RGB sum is > 60 (the
  // paused canvas sums ~47). It proves a non-dark rendered mean, not that the
  // mean is fresh; a stale same-brightness mean would also pass.
  try {
    await waitFor(
      `${label} processed preview before camera capture`,
      async () => {
        const status = await readStatus(page);
        if (status.mode !== 'render') return null;
        return rgbSum(await readRgb(page)) > 60 ? status : null;
      },
      10000,
      100,
    );
  } catch (error) {
    const status = await readStatus(page);
    const rgb = await readRgb(page);
    const videoState = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video
        ? { paused: video.paused, ended: video.ended, currentTime: video.currentTime, readyState: video.readyState }
        : null;
    });
    log(
      `[${label}] readiness timeout: mode=${status.mode} title=${status.title} rgb=${JSON.stringify(rgb)} video=${JSON.stringify(videoState)} explanation=${status.explanation}`,
    );
    throw error;
  }
  const attempts = [];
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const run = await captureCameraState(page, prefix, frames);
    const appFrames = run.frames.filter((frame) => frame.captureUnixMs > 0).length;
    const fallbackFrames = run.frames.length - appFrames;
    attempts.push({
      attempt: attempt + 1,
      frames: run.frames.length,
      appFrames,
      nativePausedFallbackFrames: fallbackFrames,
    });
    log(
      `[${label}] camera attempt ${attempt + 1}/3: frames=${run.frames.length} appFrames=${appFrames} nativePausedFallbackFrames=${fallbackFrames}`,
    );
    try {
      assertProcessedFrames(run.frames, previewRgb, label);
      cameraCaptureAttempts.push({ label, prefix, frames, attempts });
      run.captureAttempts = attempts;
      return run;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        log(
          `[${label}] camera attempt ${attempt + 1} did not observe enough processed frames; retrying after a publish interval`,
        );
        await page.waitForTimeout(600);
      }
    }
  }
  cameraCaptureAttempts.push({ label, prefix, frames, attempts, failed: true });
  throw lastError;
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
    const previewWarm = await readProcessedRgb(page, 'warm preview');
    const warmRun = await captureProcessedCameraState(page, 'warm', PROCESSED_CAMERA_FRAMES, previewWarm, 'warm');
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
    const previewCool = await readProcessedRgb(page, 'cool preview');
    const coolRun = await captureProcessedCameraState(page, 'cool', PROCESSED_CAMERA_FRAMES, previewCool, 'cool');
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
    const resumedPreview = await readProcessedRgb(page, 'resumed preview');
    const resumedRun = await captureProcessedCameraState(page, 'resumed', PROCESSED_CAMERA_FRAMES, resumedPreview, 'resume');
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
    const recoveryPreview = await readProcessedRgb(page, 'effect recovery preview');
    const recoveryRun = await captureProcessedCameraState(page, 'effect-recovered', PROCESSED_CAMERA_FRAMES, recoveryPreview, 'effect recovery');
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
    const failureRecoveryPreview = await readProcessedRgb(page, 'failure recovery preview');
    const failureRecoveryRun = await captureProcessedCameraState(page, 'failure-recovered', PROCESSED_CAMERA_FRAMES, failureRecoveryPreview, 'failure recovery');
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
/** Exact unlit material colour of the committed sample mask GLB (guard-visor). */
const PACKAGE_MASK_RGB = { r: 225, g: 29, b: 154 };
/** Exact unlit material colour of the second sample mask GLB (rose-visor). */
const ROSE_MASK_RGB = { r: 32, g: 196, b: 128 };
const PACKAGE_FIXTURES_DIR = path.join(root, 'fixtures', 'packages');
const PACKAGE_NEGATIVE_DIR = path.join(PACKAGE_FIXTURES_DIR, 'negative');
const GUARD_VISOR_EFFECT_ID = 'package:shymask.guard-visor';
const ROSE_VISOR_EFFECT_ID = 'package:shymask.rose-visor';
const VERDANT_TINT_EFFECT_ID = 'package:shymask.verdant-tint';
const FACE_DISTORTION_EFFECT_ID = 'package:shymask.face-distortion';
/** Exact unlit material colour of the schema v3 secondary-motion sample mask. */
const REACTIVE_EARS_RGB = { r: 150, g: 90, b: 240 };
const REACTIVE_EARS_EFFECT_ID = 'package:shymask.reactive-ears';
/**
 * Documented default-clip frame used for the warp on/off A/B. The clip is a
 * 3.379 s replay loop; 1.5 s is a tracked, non-paused frame with the face
 * roughly centred, and the check holds it before capturing exact output PNGs.
 */
const DISTORTION_AB_CAPTURE_SECONDS = 1.5;
/**
 * Documented `pose-loop-v1` frame used for the secondary-motion A/B. Just after
 * the recorded left turn at ~47.6 s the ears hold a large simulated angle, so a
 * held frame shows a substantial rest-vs-simulated change.
 */
const SECONDARY_MOTION_AB_CAPTURE_SECONDS = 47.7;
/**
 * Recorded window where a head turn (yaw/pitch peak around 25.9 s) is followed
 * by ~1 s of low head angular velocity. The spring keeps moving after the turn
 * and decays there, which is the replay-based settling evidence.
 */
const POST_TURN_WINDOW_START_SECONDS = 25.0;
const POST_TURN_WINDOW_SECONDS = 1.9;
/**
 * Required negative package fixtures and the actionable code each must produce.
 * They are generated reproducibly by `npm run build:packages`.
 */
const NEGATIVE_PACKAGE_CASES = [
  { name: 'malformed-json', code: 'manifest-invalid-json' },
  { name: 'schema-version-4', code: 'schema-version-unsupported' },
  { name: 'distortion-schema-v1', code: 'schema-version-unsupported' },
  { name: 'distortion-invalid-mode', code: 'distortion-invalid' },
  { name: 'distortion-out-of-range', code: 'distortion-invalid' },
  { name: 'distortion-unknown-field', code: 'distortion-invalid' },
  { name: 'secondary-motion-schema-v2', code: 'schema-version-unsupported' },
  { name: 'secondary-motion-invalid-axis', code: 'secondary-motion-invalid' },
  { name: 'secondary-motion-unknown-node', code: 'secondary-motion-invalid' },
  { name: 'secondary-motion-out-of-range', code: 'secondary-motion-invalid' },
  { name: 'secondary-motion-unknown-field', code: 'secondary-motion-invalid' },
  { name: 'secondary-motion-rest-beyond-max', code: 'secondary-motion-invalid' },
  { name: 'secondary-motion-without-mask', code: 'secondary-motion-invalid' },
  { name: 'unsupported-behavior', code: 'unsupported-behavior' },
  { name: 'missing-asset', code: 'missing-asset' },
  { name: 'invalid-color', code: 'color-parameter-out-of-range' },
  { name: 'zip-slip', code: 'entry-path-unsafe' },
  { name: 'oversized-entry', code: 'entry-too-large' },
  { name: 'executable-file', code: 'executable-content' },
  { name: 'unsupported-gltf-extension', code: 'glb-unsupported-extension' },
  { name: 'glb-missing-component-type', code: 'glb-invalid' },
  { name: 'glb-missing-accessor-type', code: 'glb-invalid' },
  { name: 'glb-camera', code: 'glb-unsupported-feature' },
];
/** Window with the largest recorded pose swing in fixtures/pose-loop.json. */
const MOTION_WINDOW_START_SECONDS = 41.6;
/** Documented motion window length (docs/fixture-pose-loop.md, docs/notes/0003). */
const MOTION_WINDOW_SECONDS = 8;
const MOTION_WINDOW_START_MS = MOTION_WINDOW_START_SECONDS * 1000;
const MOTION_WINDOW_END_MS = MOTION_WINDOW_START_MS + MOTION_WINDOW_SECONDS * 1000;
/**
 * Documented side-view moments used for the deterministic occlusion A/B on a
 * held frame. 47.7 s is a turned frame inside the motion window (yaw about
 * -22 deg); 16.0 s is a recorded frame with yaw in the opposite direction
 * (about +9 deg at the frozen frame), so the A/B covers both turn directions.
 * Choosing the frozen frame by seeking and holding keeps the video frame and the
 * mask pose fixed while only the occluder toggles.
 */
const OCCLUSION_CAPTURE_SECONDS = 47.7;
const OCCLUSION_CAPTURE_SECONDS_OPPOSITE = 16.0;
/**
 * Frames requested for one processed camera capture. The native media source
 * clears its frame cache on every new consumer stream (FrameTransport::Reset in
 * MediaStream::Start), and the app only reads its canvas back once the virtual
 * camera reports a connected client and then at the 30 Hz publication floor /
 * 100 ms heartbeat. The first ~3 of the 30 Hz samples can therefore be the
 * native opaque fallback; 8 samples span ~230 ms and cover that startup.
 */
const PROCESSED_CAMERA_FRAMES = 8;

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

function faceRect(face) {
  return { x: Number(face.x), y: Number(face.y), width: Number(face.w), height: Number(face.h) };
}

/** Colour match on a diagnostic `r/g/b` key-value object. */
function colorNearRgb(actual, expected, tolerance = 16) {
  return (
    Math.abs(Number(actual.r) - expected.r) <= tolerance &&
    Math.abs(Number(actual.g) - expected.g) <= tolerance &&
    Math.abs(Number(actual.b) - expected.b) <= tolerance
  );
}

/**
 * Positive proof that the occlusion ON state reveals non-mask content where the
 * OFF state drew mask material.
 *
 * For an imported package the renderer reports the exact unlit material colour:
 * the changed face-box pixels must be that colour in OFF and must not be it in
 * ON. The bundled procedural mask uses lit materials, so instead we take the
 * dominant exact OFF-frame colours from the changed region (the mask's rendered
 * shades) and require that the ON frame does not reproduce them at those pixels.
 *
 * Removing the mask colour is not by itself proof that the reveal is video: a
 * black, transparent or uniform fill would also remove it. The ON changed pixels
 * must additionally pass a plausible-video floor (mean luminance, luminance
 * variance, near-black fraction and colour variety). The callers compare the
 * untreated bundled/rose pixels against the underlying held replay frame for the
 * strongest check; a treated effect cannot be compared pixel-for-pixel.
 */
const MATERIAL_COLOUR_TOLERANCE = 28;
const REVEAL_VIDEO_FLOORS = {
  meanLuminance: 30,
  luminanceStdDev: 6,
  maxNearBlackFraction: 0.1,
  minDistinctColours: 16,
};

function isMaterialColour(pixels, index, rgb, tolerance = MATERIAL_COLOUR_TOLERANCE) {
  return (
    Math.abs(pixels[index] - rgb.r) <= tolerance &&
    Math.abs(pixels[index + 1] - rgb.g) <= tolerance &&
    Math.abs(pixels[index + 2] - rgb.b) <= tolerance
  );
}

function maskRevealEvidence(onFile, offFile, rect, materialRgb = null) {
  const on = decodePng(onFile);
  const off = decodePng(offFile);
  assert.equal(on.width, off.width, 'occlusion reveal PNG widths must match');
  assert.equal(on.height, off.height, 'occlusion reveal PNG heights must match');
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(on.width - 1, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(on.height - 1, Math.ceil(rect.y + rect.height));
  const changedIndexes = [];
  const offColourCounts = new Map();
  let changedMaterialPixelsOff = 0;
  let changedMaterialPixelsOn = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const index = y * on.stride + x * on.channels;
      const changed =
        Math.abs(on.pixels[index] - off.pixels[index]) > 4 ||
        Math.abs(on.pixels[index + 1] - off.pixels[index + 1]) > 4 ||
        Math.abs(on.pixels[index + 2] - off.pixels[index + 2]) > 4;
      if (!changed) continue;
      changedIndexes.push(index);
      if (materialRgb) {
        if (isMaterialColour(off.pixels, index, materialRgb)) changedMaterialPixelsOff += 1;
        if (isMaterialColour(on.pixels, index, materialRgb)) changedMaterialPixelsOn += 1;
      } else {
        const key = `${off.pixels[index]},${off.pixels[index + 1]},${off.pixels[index + 2]}`;
        offColourCounts.set(key, (offColourCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const changedPixels = changedIndexes.length;
  assert.ok(changedPixels >= 1500, `occlusion reveal needs a substantial changed region, got ${changedPixels} face-box pixels`);

  // Plausible-video floor on the revealed ON pixels.
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let nearBlackPixels = 0;
  const distinctColours = new Set();
  for (const index of changedIndexes) {
    const red = on.pixels[index];
    const green = on.pixels[index + 1];
    const blue = on.pixels[index + 2];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
    if (luminance <= 16) nearBlackPixels += 1;
    distinctColours.add((red << 16) | (green << 8) | blue);
  }
  const meanLuminance = luminanceSum / changedPixels;
  const luminanceVariance = Math.max(0, luminanceSquaredSum / changedPixels - meanLuminance * meanLuminance);
  const luminanceStdDev = Math.sqrt(luminanceVariance);
  const nearBlackFraction = nearBlackPixels / changedPixels;
  assert.ok(
    meanLuminance >= REVEAL_VIDEO_FLOORS.meanLuminance,
    `occlusion ON pixels must be plausible video, not a black fill: mean luminance=${meanLuminance.toFixed(1)} (floor ${REVEAL_VIDEO_FLOORS.meanLuminance})`,
  );
  assert.ok(
    luminanceStdDev >= REVEAL_VIDEO_FLOORS.luminanceStdDev,
    `occlusion ON pixels must be plausible video, not a uniform fill: luminance stddev=${luminanceStdDev.toFixed(1)} (floor ${REVEAL_VIDEO_FLOORS.luminanceStdDev})`,
  );
  assert.ok(
    nearBlackFraction <= REVEAL_VIDEO_FLOORS.maxNearBlackFraction,
    `occlusion ON pixels must be plausible video, not a black cutout: ${(100 * nearBlackFraction).toFixed(1)}% near-black (limit ${100 * REVEAL_VIDEO_FLOORS.maxNearBlackFraction}%)`,
  );
  assert.ok(
    distinctColours.size >= REVEAL_VIDEO_FLOORS.minDistinctColours,
    `occlusion ON pixels must be plausible video, not a flat patch: only ${distinctColours.size} distinct colours (floor ${REVEAL_VIDEO_FLOORS.minDistinctColours})`,
  );
  const plausibleVideo = {
    meanLuminance: Number(meanLuminance.toFixed(1)),
    luminanceStdDev: Number(luminanceStdDev.toFixed(1)),
    nearBlackFraction: Number(nearBlackFraction.toFixed(3)),
    distinctColours: distinctColours.size,
    floors: REVEAL_VIDEO_FLOORS,
  };

  // Up to 600 evenly spaced changed pixels with their ON colour, for the
  // caller's optional comparison against the underlying held replay frame.
  const changedSamples = [];
  const sampleStride = Math.max(1, Math.floor(changedIndexes.length / 600));
  for (let index = 0; index < changedIndexes.length && changedSamples.length < 600; index += sampleStride) {
    const pixelIndex = changedIndexes[index];
    changedSamples.push({
      x: (pixelIndex % on.stride) / on.channels,
      y: Math.floor(pixelIndex / on.stride),
      r: on.pixels[pixelIndex],
      g: on.pixels[pixelIndex + 1],
      b: on.pixels[pixelIndex + 2],
    });
  }

  if (materialRgb) {
    const offFraction = changedMaterialPixelsOff / changedPixels;
    const onFraction = changedMaterialPixelsOn / changedPixels;
    assert.ok(
      offFraction >= 0.97,
      `occlusion OFF must draw the package material at the changed face-box pixels (found ${(100 * offFraction).toFixed(1)}% material)`,
    );
    assert.ok(
      onFraction <= 0.03,
      `occlusion ON must reveal non-material content at the changed face-box pixels (found ${(100 * onFraction).toFixed(1)}% material)`,
    );
    return {
      kind: 'exact-material',
      materialRgb,
      changedPixels,
      changedMaterialPixelsOff,
      changedMaterialPixelsOn,
      changedMaterialFractionOff: Number(offFraction.toFixed(3)),
      changedMaterialFractionOn: Number(onFraction.toFixed(3)),
      plausibleVideo,
      changedSamples,
    };
  }
  const dominant = [...offColourCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 64);
  const coverage = dominant.reduce((total, [, count]) => total + count, 0) / changedPixels;
  assert.ok(
    coverage >= 0.9,
    `the dominant bundled mask colours must cover most changed pixels, covered ${(100 * coverage).toFixed(1)}%`,
  );
  const palette = dominant.map(([key]) => key.split(',').map(Number));
  let onPaletteMatches = 0;
  for (const index of changedIndexes) {
    if (
      palette.some(
        (colour) =>
          Math.abs(on.pixels[index] - colour[0]) <= 4 &&
          Math.abs(on.pixels[index + 1] - colour[1]) <= 4 &&
          Math.abs(on.pixels[index + 2] - colour[2]) <= 4,
      )
    ) {
      onPaletteMatches += 1;
    }
  }
  assert.ok(
    onPaletteMatches <= Math.max(2, Math.ceil(changedPixels * 0.01)),
    `occlusion ON must replace the dominant bundled mask colours with non-mask content, still matched ${onPaletteMatches}/${changedPixels}`,
  );
  return {
    kind: 'dominant-bundled-palette',
    paletteSize: palette.length,
    dominantCoverage: Number(coverage.toFixed(3)),
    changedPixels,
    onPaletteMatches,
    plausibleVideo,
    changedSamples,
  };
}

/**
 * Draws the held replay video into a canvas at the same 0,0,width,height scale
 * the pipeline uses and compares the ON changed pixels against it. This is only
 * valid for an effect with no colour treatment (the bundled mask and the
 * mask-only rose package); a treated effect changes the video before compositing.
 */
async function compareRevealToHeldVideo(page, samples, label) {
  if (!samples || samples.length === 0) return null;
  const videoPixels = await page.evaluate((points) => {
    const video = document.querySelector('video');
    if (!video) throw new Error('expected a replay video element');
    const output = document.querySelector('[data-testid="output-canvas"]');
    const width = output && output.width ? output.width : 1280;
    const height = output && output.height ? output.height : 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    return points.map((point) => {
      const x = Math.min(width - 1, Math.max(0, Math.round(point.x)));
      const y = Math.min(height - 1, Math.max(0, Math.round(point.y)));
      const index = (y * width + x) * 4;
      return [data[index], data[index + 1], data[index + 2]];
    });
  }, samples.map(({ x, y }) => ({ x, y })));
  let matching = 0;
  let totalChannelDiff = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const pixel = samples[index];
    const videoPixel = videoPixels[index] ?? [0, 0, 0];
    const diff = Math.max(
      Math.abs(pixel.r - videoPixel[0]),
      Math.abs(pixel.g - videoPixel[1]),
      Math.abs(pixel.b - videoPixel[2]),
    );
    totalChannelDiff += diff;
    if (diff <= 24) matching += 1;
  }
  const matchFraction = matching / samples.length;
  assert.ok(
    matchFraction >= 0.9,
    `${label}: at least 90% of the ON changed pixels must match the held replay video (mask removed, not replaced), matched ${(100 * matchFraction).toFixed(1)}% of ${samples.length} samples (mean max-channel diff ${(totalChannelDiff / samples.length).toFixed(1)})`,
  );
  return {
    samples: samples.length,
    matchFraction: Number(matchFraction.toFixed(3)),
    meanMaxChannelDiff: Number((totalChannelDiff / samples.length).toFixed(1)),
    tolerance: 24,
  };
}

function spread(values) {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Sliding metric for one pass over the recorded motion window. The projected
 * mask origin's offset from the tracked face-box centre is the attachment
 * baseline; the p95 deviation from the median offset is the sliding figure.
 * The face-box centre itself shifts under yaw, so this is a bounded proxy
 * metric, not a ground-truth surface-distance measurement.
 */
function slidingMetrics(samples) {
  const faceOffsets = samples.map((sample) => {
    const faceX = Number(sample.face.x);
    const faceY = Number(sample.face.y);
    const faceW = Number(sample.face.w);
    const faceH = Number(sample.face.h);
    return {
      dx: sample.originX - (faceX + faceW / 2),
      dy: sample.originY - (faceY + faceH / 2),
      faceWidth: faceW,
    };
  });
  const medianOffsetX = median(faceOffsets.map((offset) => offset.dx));
  const medianOffsetY = median(faceOffsets.map((offset) => offset.dy));
  const slideDeviations = faceOffsets.map((offset) =>
    Math.hypot(offset.dx - medianOffsetX, offset.dy - medianOffsetY),
  );
  const anchorOffsets = faceOffsets.map((offset) => Math.hypot(offset.dx, offset.dy));
  const meanFaceWidth =
    faceOffsets.reduce((total, offset) => total + offset.faceWidth, 0) / faceOffsets.length;
  const slideP95Px = percentile(slideDeviations, 0.95);
  const anchorOffsetP95Px = percentile(anchorOffsets, 0.95);
  return {
    samples: samples.length,
    medianOffset: { x: Number(medianOffsetX.toFixed(1)), y: Number(medianOffsetY.toFixed(1)) },
    slideP95Px: Number(slideP95Px.toFixed(1)),
    slideP95FractionOfFaceWidth: Number((slideP95Px / meanFaceWidth).toFixed(3)),
    anchorOffsetP95Px: Number(anchorOffsetP95Px.toFixed(1)),
    meanFaceWidthPx: Number(meanFaceWidth.toFixed(1)),
    boundPx: 24,
  };
}

/**
 * Public A/B occlusion evidence on a held replay frame:
 *   on, on again (must be pixel-identical), off, off again (must be
 *   pixel-identical), back on.
 * The output PNGs go through the same capture control users use. The diff must
 * be substantial and must sit inside the tracked face's axis-aligned bounding
 * box, which is where mask geometry behind the canonical face surface is hidden.
 * `probeRgb` is the mask's declared probe colour (the bundled eye plate or the
 * package's exact unlit material). The diagnostic readback only decides whether
 * the probe is visible; the assertion is on the saved ON PNG's actual pixel.
 * `materialRgb` enables the exact-colour reveal proof for an imported package;
 * the bundled mask uses its dominant rendered palette instead. `compareVideo`
 * additionally compares the untreated ON pixels with the held replay frame.
 */
async function occlusionAbEvidence(page, label, probeRgb = MASK_EYE_RGB, materialRgb = null, options = {}) {
  const statusBefore = await readStatus(page);
  assert.equal(
    statusBefore.mode,
    'render',
    `${label}: the held A/B frame must be rendered, not the paused screen (${statusBefore.explanation})`,
  );
  const occlusionBefore = parseKeyValues(await readDiagnostic(page, 'diag-occlusion'));
  assert.equal(occlusionBefore.enabled, 'true', `${label}: face occlusion must be on for normal output`);
  assert.equal(occlusionBefore.mode, 'depth-only', `${label}: occlusion must use the depth-only mask scene path`);
  assert.equal(occlusionBefore.vertices, '468', `${label}: canonical face occluder vertex count`);
  assert.equal(occlusionBefore.triangles, '898', `${label}: canonical face occluder triangle count`);
  assert.equal(occlusionBefore.colorWrite, 'false', `${label}: face occluder must not write colour`);
  assert.equal(occlusionBefore.depthWrite, 'true', `${label}: face occluder must write depth`);
  const maskBefore = await readMask(page);
  const face = await readFace(page);
  assert.equal(maskBefore.visible, 'true', `${label}: a tracked mask must be visible for the occlusion A/B`);
  assert.equal(face.count, '1', `${label}: exactly one face must be tracked for the occlusion A/B`);
  // Diagnostic readback is metadata: it decides whether the probe is visible,
  // but the assertion below reads the actual saved ON PNG pixel, so it cannot
  // pass by comparing the diagnostic value with itself.
  const probe = parseKeyValues(await readDiagnostic(page, 'diag-mask-probe'));
  const probeTolerance = 12;
  const probeVisible = colorNearRgb(probe, probeRgb, probeTolerance);
  const on = await captureOutputThroughControl(page, `${label}-occlusion-on.png`);
  await page.waitForTimeout(250);
  const onRepeat = await captureOutputThroughControl(page, `${label}-occlusion-on-repeat.png`);
  let probePixel = null;
  let probePixelMatches = null;
  if (probeVisible) {
    probePixel = pngPixel(on, Number(probe.x), Number(probe.y));
    probePixelMatches = colorNearRgb(probePixel, probeRgb, probeTolerance);
    assert.ok(
      probePixelMatches,
      `${label}: the ON PNG pixel at the diagnostic probe (${probe.x},${probe.y}) must be the mask colour ${JSON.stringify(probeRgb)} when the diagnostic reports it visible, got ${JSON.stringify(probePixel)}`,
    );
  }
  await page.locator('[data-testid="occlusion-toggle"]').uncheck();
  await page.waitForTimeout(250);
  const occlusionOff = parseKeyValues(await readDiagnostic(page, 'diag-occlusion'));
  assert.equal(occlusionOff.enabled, 'false', `${label}: diagnostic control must disable only the occluder`);
  const off = await captureOutputThroughControl(page, `${label}-occlusion-off.png`);
  await page.waitForTimeout(250);
  const offRepeat = await captureOutputThroughControl(page, `${label}-occlusion-off-repeat.png`);
  await page.locator('[data-testid="occlusion-toggle"]').check();
  await page.waitForTimeout(250);
  const maskAfter = await readMask(page);
  // The held frame must not move between captures, otherwise a diff could be
  // video drift rather than the occlusion change.
  assert.equal(maskAfter.originX, maskBefore.originX, `${label}: held mask originX must not move during the A/B`);
  assert.equal(maskAfter.originY, maskBefore.originY, `${label}: held mask originY must not move during the A/B`);
  assert.equal(maskAfter.yaw, maskBefore.yaw, `${label}: held mask yaw must not move during the A/B`);

  const rect = faceRect(face);
  const selfDiff = pngPixelDiff(on, onRepeat);
  const offSelfDiff = pngPixelDiff(off, offRepeat);
  const change = pngPixelDiff(on, off, 4, rect);
  const insideFraction = change.count === 0 ? 0 : change.inside / change.count;
  assert.equal(
    selfDiff.count,
    0,
    `${label}: two ON captures of the same held frame must be pixel-identical, got ${selfDiff.count} changed pixels`,
  );
  assert.equal(
    offSelfDiff.count,
    0,
    `${label}: two OFF captures of the same held frame must be pixel-identical, got ${offSelfDiff.count} changed pixels`,
  );
  assert.ok(
    change.count >= 1500,
    `${label}: occlusion must visibly change the composited mask, changed ${change.count} pixels`,
  );
  assert.ok(
    insideFraction >= 0.88,
    `${label}: occlusion changes must be inside the tracked face bounding box (inside fraction ${insideFraction.toFixed(2)}, ${change.inside}/${change.count})`,
  );
  assert.ok(
    change.inside >= 1500,
    `${label}: occlusion must remove mask pixels inside the tracked face bounding box, removed ${change.inside}`,
  );
  const reveal = maskRevealEvidence(on, off, rect, materialRgb);
  const videoMatch = options.compareVideo
    ? await compareRevealToHeldVideo(page, reveal.changedSamples, label)
    : null;
  return {
    label,
    occlusion: occlusionBefore,
    mask: maskBefore,
    face,
    on,
    onRepeat,
    off,
    offRepeat,
    probe,
    probeVisible,
    probePixel,
    probePixelMatches,
    selfDiffPixels: selfDiff.count,
    offSelfDiffPixels: offSelfDiff.count,
    changedPixels: change.count,
    changedInsideFacePixels: change.inside,
    insideFaceFraction: Number(insideFraction.toFixed(3)),
    reveal,
    videoMatch,
    clipping: {
      removedMaskPixelsInsideFaceBox: change.inside,
      faceBoxAreaPixels: Math.round(rect.width * rect.height),
      removedFractionOfFaceBox: Number((change.inside / (rect.width * rect.height)).toFixed(4)),
    },
  };
}

/**
 * Virtual-camera half of the occlusion A/B: two app-published PNGs from the
 * independent Media Foundation consumer in the same held state must match, and
 * the on/off change must be exactly the preview's occlusion change. The camera
 * probe is asserted only when the preview probe is visible, because face
 * occlusion can legitimately hide it; the material/reveal counts always prove
 * composition in that case.
 */
async function occlusionCameraAbEvidence(page, label, rect, options = {}) {
  const preview = await readProcessedRgb(page, `${label} preview`);
  const onRun = await captureProcessedCameraState(page, `${label}-occlusion-on`, PROCESSED_CAMERA_FRAMES, preview, `${label} occlusion on camera`);
  const onPngs = onRun.frames
    .filter((frame) => frame.png && frame.captureUnixMs > 0)
    .map((frame) => frame.png);
  assert.ok(onPngs.length >= 2, `${label}: expected two app-published camera PNGs in the on state, got ${onPngs.length}`);
  await page.locator('[data-testid="occlusion-toggle"]').uncheck();
  await page.waitForTimeout(300);
  const offRun = await captureProcessedCameraState(page, `${label}-occlusion-off`, PROCESSED_CAMERA_FRAMES, preview, `${label} occlusion off camera`);
  const offPng = offRun.frames.find((frame) => frame.png && frame.captureUnixMs > 0)?.png;
  assert.ok(offPng, `${label}: expected an app-published camera PNG in the off state`);
  await page.locator('[data-testid="occlusion-toggle"]').check();
  await page.waitForTimeout(300);
  const selfDiff = pngPixelDiff(onPngs[0], onPngs[1]);
  const change = pngPixelDiff(onPngs[0], offPng, 4, rect);
  const insideFraction = change.count === 0 ? 0 : change.inside / change.count;
  assert.equal(
    selfDiff.count,
    0,
    `${label}: two camera PNGs of the same held frame must match, got ${selfDiff.count} changed pixels`,
  );
  assert.ok(
    change.count >= 1500,
    `${label}: the camera must receive the same occlusion change, changed ${change.count} pixels`,
  );
  assert.ok(
    insideFraction >= 0.88,
    `${label}: camera occlusion changes must be inside the tracked face bounding box (inside fraction ${insideFraction.toFixed(2)})`,
  );
  assert.ok(
    change.inside >= 1500,
    `${label}: the camera must receive the removed mask pixels inside the tracked face bounding box, removed ${change.inside}`,
  );
  assert.equal(
    change.count,
    options.previewChangedPixels,
    `${label}: camera and preview must receive the identical occlusion change (camera ${change.count}px, preview ${options.previewChangedPixels}px)`,
  );
  assert.equal(
    change.inside,
    options.previewChangedInsideFacePixels,
    `${label}: camera and preview must receive the identical inside-face change (camera ${change.inside}px, preview ${options.previewChangedInsideFacePixels}px)`,
  );
  let cameraProbePixel = null;
  let cameraProbeMatches = null;
  if (options.probeVisible) {
    cameraProbePixel = pngPixel(onPngs[0], Number(options.probe.x), Number(options.probe.y));
    cameraProbeMatches = colorNearRgb(cameraProbePixel, options.probeRgb, options.probeTolerance ?? 24);
    assert.ok(
      cameraProbeMatches,
      `${label}: the camera PNG probe must match the mask colour ${JSON.stringify(options.probeRgb)} when the preview probe is visible, got ${JSON.stringify(cameraProbePixel)}`,
    );
  }
  return {
    preview,
    onPng: onPngs[0],
    onRepeatPng: onPngs[1],
    offPng,
    selfDiffPixels: selfDiff.count,
    changedPixels: change.count,
    changedInsideFacePixels: change.inside,
    insideFaceFraction: Number(insideFraction.toFixed(3)),
    cameraProbePixel,
    cameraProbeMatches,
  };
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

    // The depth-only canonical face is active for the bundled mask, and the
    // bounded smoother is the normal path.
    const occlusion = parseKeyValues(await readDiagnostic(page, 'diag-occlusion'));
    assert.equal(occlusion.enabled, 'true');
    assert.equal(occlusion.mode, 'depth-only');
    assert.equal(occlusion.vertices, '468');
    assert.equal(occlusion.triangles, '898');
    const smoothing = await waitFor('smoothing metric frames', async () => {
      const values = parseKeyValues(await readDiagnostic(page, 'diag-smoothing'));
      return Number(values.samples) >= 30 ? values : null;
    });
    assert.equal(smoothing.mode, 'smoothed');
    assert.equal(smoothing.baseAlpha, '0.45');
    assert.ok(Number(smoothing.costMsP95) <= 1, `smoothing filter must stay cheap, got ${smoothing.costMsP95}ms`);
    evidence.states.occlusion = occlusion;
    evidence.states.smoothing = smoothing;
    pass(
      'Depth-only canonical face occluder and bounded pose smoothing are active for the bundled mask',
      `occluder vertices=${occlusion.vertices} triangles=${occlusion.triangles} smoothing samples=${smoothing.samples} cost p95=${smoothing.costMsP95}ms`,
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
    const cameraPreview = await readProcessedRgb(page, 'mask camera preview');
    const cameraProbe = await readMaskProbe(page);
    const maskRun = await captureProcessedCameraState(page, 'mask', PROCESSED_CAMERA_FRAMES, cameraPreview, 'mask');
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
  const evidence = { states: {}, motion: {}, smoothing: {}, occlusion: {}, distortion: {}, timing: {} };
  // Isolated package store so the imported-mask parity evidence in this
  // scenario does not touch the developer's installed packages.
  const motionPackageDir = path.join(evidenceDir, 'motion-effect-packages');
  mkdirSync(motionPackageDir, { recursive: true });
  const { app, page, consoleErrors } = await launchApp({
    SHYMASK_EVIDENCE_DIR: evidenceDir,
    SHYMASK_FIXTURE_MANIFEST: 'pose-loop.json',
    SHYMASK_PACKAGE_DIR: motionPackageDir,
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

    // Initial slow segment of the recorded window. It is not stationary, so the
    // check measures its actual pose span and the filter gain instead of
    // assuming "low motion": the measured span and p50 gain are the premise for
    // treating this segment as a slow-motion jitter measurement. Both raw and
    // shadow-smoothed poses are measured over the same frames.
    await resetPoseSmoothingMetrics(page);
    const slowSegmentSamples = [];
    for (let index = 0; index < 6; index += 1) {
      await page.waitForTimeout(330);
      const current = await readMask(page);
      if (current.visible === 'true') {
        slowSegmentSamples.push({
          yaw: Number(current.yaw),
          pitch: Number(current.pitch),
          roll: Number(current.roll),
          originX: Number(current.originX),
          originY: Number(current.originY),
        });
      }
    }
    const restSmoothing = parseKeyValues(await readDiagnostic(page, 'diag-smoothing'));
    assert.equal(restSmoothing.mode, 'smoothed');
    log(`[smoothing slow segment] ${JSON.stringify(restSmoothing)}`);
    const restRawOriginJitter = Number(restSmoothing.rawJitterOriginPxP95);
    const restSmoothedOriginJitter = Number(restSmoothing.smoothedJitterOriginPxP95);
    const restRawRotationJitter = Number(restSmoothing.rawJitterRotationDegP95);
    const restSmoothedRotationJitter = Number(restSmoothing.smoothedJitterRotationDegP95);
    assert.ok(Number(restSmoothing.samples) >= 40, `slow-segment jitter needs enough frames, got ${restSmoothing.samples}`);
    assert.ok(restRawOriginJitter > 0.5, `raw slow-segment origin jitter must be measurable, got ${restRawOriginJitter}px`);
    const slowYawSpan = spread(slowSegmentSamples.map((sample) => sample.yaw));
    const slowPitchSpan = spread(slowSegmentSamples.map((sample) => sample.pitch));
    const slowRollSpan = spread(slowSegmentSamples.map((sample) => sample.roll));
    const slowOriginSpanX = spread(slowSegmentSamples.map((sample) => sample.originX));
    const slowOriginSpanY = spread(slowSegmentSamples.map((sample) => sample.originY));
    const slowSegmentSeconds = (slowSegmentSamples.length * 330) / 1000;
    const slowYawRate = slowSegmentSeconds > 0 ? slowYawSpan / slowSegmentSeconds : 0;
    assert.ok(slowSegmentSamples.length >= 5, `slow-segment motion premise needs mask samples, got ${slowSegmentSamples.length}`);
    assert.ok(
      slowYawSpan <= 10 && slowPitchSpan <= 10 && slowRollSpan <= 5,
      `the jitter segment must be slow in rotation, measured yaw=${slowYawSpan.toFixed(1)} pitch=${slowPitchSpan.toFixed(1)} roll=${slowRollSpan.toFixed(1)} deg`,
    );
    assert.ok(
      Math.max(slowOriginSpanX, slowOriginSpanY) <= 30,
      `the jitter segment must be slow in translation, measured origin x=${slowOriginSpanX} y=${slowOriginSpanY} px`,
    );
    assert.ok(
      Number(restSmoothing.alphaP50) <= 0.4,
      `the slow-segment filter gain must stay near the base gain, got p50 alpha=${restSmoothing.alphaP50}`,
    );
    assert.ok(
      restSmoothedOriginJitter <= restRawOriginJitter * 0.8,
      `smoothing must reduce slow-segment origin jitter, raw=${restRawOriginJitter}px smoothed=${restSmoothedOriginJitter}px`,
    );
    assert.ok(
      restSmoothedRotationJitter <= restRawRotationJitter * 0.85,
      `smoothing must reduce slow-segment rotation jitter, raw=${restRawRotationJitter}deg smoothed=${restSmoothedRotationJitter}deg`,
    );

    /**
     * Seeks to the documented window and samples the public diagnostics over it
     * in the selected pose-smoothing mode. Used for the rendered (smoothed) pass
     * and for a raw pass over comparable recorded motion.
     */
    async function collectMotionWindowSamples({ smoothingMode = 'smoothed', captureShots = false } = {}) {
      await page.evaluate((startSeconds) => {
        const video = document.querySelector('video');
        if (!video) throw new Error('expected a replay video element');
        video.currentTime = startSeconds;
      }, MOTION_WINDOW_START_SECONDS);
      await waitFor(
        `motion window media time (${smoothingMode} pass)`,
        async () => {
          const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
          return Number(timestamp.mediaMs ?? 0) >= MOTION_WINDOW_START_SECONDS * 1000 ? timestamp : null;
        },
        15000,
        100,
      );
      await page.locator('[data-testid="pose-smoothing"]').selectOption(smoothingMode);
      // A backward seek can take longer than the decode-stall threshold, so the
      // first samples after the seek may still be the paused screen. Wait for a
      // rendered frame before sampling so the pass is not silently truncated.
      await waitFor(
        `rendered output before ${smoothingMode} motion sampling`,
        async () => {
          const status = await readStatus(page);
          return status.mode === 'render' ? status : null;
        },
        15000,
        40,
      );
      const collected = [];
      const shots = [];
      let exitedAtMs = null;
      let previousMediaMs = null;
      for (let index = 0; index < 18; index += 1) {
        await page.waitForTimeout(400);
        const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
        const mediaMs = Number(timestamp.mediaMs ?? 0);
        // Sampling can outrun the remaining window (the reads themselves take
        // time), so a loop seam back to the start of the clip also ends the
        // window instead of recording a media time of 0 as an in-window sample.
        if (
          mediaMs > MOTION_WINDOW_END_MS ||
          (previousMediaMs !== null && mediaMs < previousMediaMs - LOOP_SEAM_THRESHOLD_MS)
        ) {
          exitedAtMs = mediaMs;
          break;
        }
        previousMediaMs = mediaMs;
        const tracking = parseKeyValues(await readDiagnostic(page, 'diag-tracking'));
        if (tracking.phase !== 'tracking') continue;
        const mask = await readMask(page);
        const face = await readFace(page);
        if (mask.visible !== 'true') continue;
        collected.push({
          yaw: Number(mask.yaw),
          pitch: Number(mask.pitch),
          roll: Number(mask.roll),
          originX: Number(mask.originX),
          originY: Number(mask.originY),
          face,
          inside: originInsideFace(mask, face),
          mediaMs,
        });
        if (captureShots && (index === 3 || index === 9 || index === 15)) {
          shots.push(await screenshotCanvas(page, `18-motion-mask-${index}.png`));
        }
      }
      return { samples: collected, shots, windowExitedAtMs: exitedAtMs };
    }

    // Re-enter the documented window so the motion samples cover the full
    // turn/nod/lean range, and restart the paired counters for the motion pass.
    await resetPoseSmoothingMetrics(page);
    const smoothedPass = await collectMotionWindowSamples({ smoothingMode: 'smoothed', captureShots: true });
    const samples = smoothedPass.samples;
    const sampleShots = smoothedPass.shots;
    const windowExitedAtMs = smoothedPass.windowExitedAtMs;
    // Every kept sample must be inside the documented window; the window exists
    // so the pose ranges are not a whole-clip claim.
    assert.ok(
      samples.every((sample) => sample.mediaMs >= MOTION_WINDOW_START_MS && sample.mediaMs <= MOTION_WINDOW_END_MS),
      `motion samples must fall inside the ${MOTION_WINDOW_SECONDS}s window at ${MOTION_WINDOW_START_SECONDS}s: ${samples.map((sample) => sample.mediaMs).join(', ')}`,
    );
    assert.ok(samples.length >= 14, `expected most motion-window frames tracked, got ${samples.length}/18`);
    assert.ok(samples.every((sample) => sample.inside), 'the mask origin must stay inside the tracked face bounding box expanded by 35% during turns and nods');
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

    // Sliding: how much the projected mask origin drifts relative to the tracked
    // face-box centre across the motion window. The median offset is the
    // attachment baseline; the p95 deviation from it is the sliding metric. The
    // raw origin-to-face-centre distance is reported as the anchor offset.
    const slidingEvidence = slidingMetrics(samples);
    assert.ok(
      slidingEvidence.slideP95Px <= 24,
      `the rendered mask origin must stay within the 24 px sliding bound relative to the face-box centre, p95 deviation=${slidingEvidence.slideP95Px}px over ${samples.length} samples`,
    );
    assert.ok(
      slidingEvidence.anchorOffsetP95Px <= 60,
      `the projected mask origin must stay near the tracked face-box centre, p95 offset=${slidingEvidence.anchorOffsetP95Px}px`,
    );

    // Across the full turn/nod/lean window the adaptive gain prioritizes
    // responsiveness, so this pass measures the added lag and filter cost
    // rather than claiming jitter reduction during fast motion.
    const motionSmoothing = await waitFor(
      'pose-smoothing lag evidence over the motion window',
      async () => {
        const values = parseKeyValues(await readDiagnostic(page, 'diag-smoothing'));
        return Number(values.samples) >= 100 ? values : null;
      },
      10000,
      100,
    );
    assert.equal(motionSmoothing.mode, 'smoothed');
    log(`[smoothing motion] ${JSON.stringify(motionSmoothing)}`);
    assert.ok(
      Number(motionSmoothing.lagOriginPxP95) <= 8,
      `smoothing origin lag must stay bounded, got ${motionSmoothing.lagOriginPxP95}px`,
    );
    assert.ok(
      Number(motionSmoothing.lagRotationDegP95) <= 4,
      `smoothing rotation lag must stay bounded, got ${motionSmoothing.lagRotationDegP95}deg`,
    );
    assert.ok(
      Number(motionSmoothing.rampLagMsP95) <= 100,
      `smoothing constant-velocity delay must stay under the 100 ms processing budget, got ${motionSmoothing.rampLagMsP95}ms`,
    );
    assert.ok(
      Number(motionSmoothing.costMsP95) <= 1,
      `smoothing filter must stay cheap, got ${motionSmoothing.costMsP95}ms`,
    );
    evidence.smoothing = {
      slowSegment: restSmoothing,
      slowSegmentMeasured: {
        samples: slowSegmentSamples.length,
        seconds: Number(slowSegmentSeconds.toFixed(2)),
        yawSpanDeg: Number(slowYawSpan.toFixed(1)),
        pitchSpanDeg: Number(slowPitchSpan.toFixed(1)),
        rollSpanDeg: Number(slowRollSpan.toFixed(1)),
        originSpanXPx: slowOriginSpanX,
        originSpanYPx: slowOriginSpanY,
        yawRateDegPerSec: Number(slowYawRate.toFixed(1)),
        alphaP50: Number(restSmoothing.alphaP50),
      },
      motion: motionSmoothing,
      originJitterReductionSlowSegment: Number((1 - restSmoothedOriginJitter / restRawOriginJitter).toFixed(3)),
      rotationJitterReductionSlowSegment: Number((1 - restSmoothedRotationJitter / restRawRotationJitter).toFixed(3)),
      enforcedJitterGate: { originSmoothedRatioMax: 0.8, rotationSmoothedRatioMax: 0.85 },
    };
    pass(
      'Bounded pose smoothing reduces slow-segment jitter; motion-window lag and cost stay bounded',
      `slow segment ${slowSegmentSamples.length} samples, measured yaw=${slowYawSpan.toFixed(1)} pitch=${slowPitchSpan.toFixed(1)} roll=${slowRollSpan.toFixed(1)} deg, origin=${slowOriginSpanX}x${slowOriginSpanY}px, p50 alpha=${restSmoothing.alphaP50}; jitter p95 origin ${restRawOriginJitter}->${restSmoothedOriginJitter}px (${(100 * (1 - restSmoothedOriginJitter / restRawOriginJitter)).toFixed(1)}% lower, gate <=0.80x) rotation ${restRawRotationJitter}->${restSmoothedRotationJitter}deg (gate <=0.85x); motion lag p95=${motionSmoothing.lagOriginPxP95}px/${motionSmoothing.lagRotationDegP95}deg ramp=${motionSmoothing.rampLagMsP95}ms cost=${motionSmoothing.costMsP95}ms`,
    );

    // Paired raw pass over the same documented window. The public Pose smoothing
    // control renders the raw tracker pose while the same smoother still runs as
    // a shadow filter, so comparable recorded motion is measured in both modes.
    // Only the rendered (smoothed) pass is subject to the 24 px bound; the raw
    // value is reported to show the smoother's measured effect on this metric.
    // This runs after the motion-window lag evidence because switching the
    // public control resets the paired smoothing metrics.
    const rawPass = await collectMotionWindowSamples({ smoothingMode: 'raw' });
    await page.locator('[data-testid="pose-smoothing"]').selectOption('smoothed');
    await page.waitForTimeout(300);
    const rawSlidingEvidence = slidingMetrics(rawPass.samples);
    assert.ok(
      rawPass.samples.length >= 14,
      `expected most raw-mode motion-window frames tracked, got ${rawPass.samples.length}/18`,
    );
    const slidingReduction =
      rawSlidingEvidence.slideP95Px > 0
        ? Number((1 - slidingEvidence.slideP95Px / rawSlidingEvidence.slideP95Px).toFixed(3))
        : 0;
    evidence.sliding = {
      rendered: slidingEvidence,
      raw: rawSlidingEvidence,
      smoothedVsRawReduction: slidingReduction,
      rawSamples: rawPass.samples.length,
      note:
        'The face-box centre shifts under yaw, so this bounded proxy metric is not a ground-truth surface-distance measurement; the raw value is reported rather than asserting a correction.',
    };
    pass(
      'The projected mask origin stays within a bounded p95 sliding distance relative to the tracked face-box centre',
      `rendered p95 sliding=${slidingEvidence.slideP95Px}px (${(100 * slidingEvidence.slideP95FractionOfFaceWidth).toFixed(1)}% of face width; enforced bound ${slidingEvidence.boundPx}px), raw-mode p95=${rawSlidingEvidence.slideP95Px}px, smoothed-vs-raw change=${(100 * slidingReduction).toFixed(1)}%, anchor offset p95=${slidingEvidence.anchorOffsetP95Px}px (bound 60 px)`,
    );

    // --- The bounded face distortion follows the recorded face ---------------
    // Run this pass while playback is live, before the long held occlusion A/Bs:
    // the automated session can stall frame callbacks after resuming a long hold,
    // which would turn the motion sample into a decoder artifact.
    const motionDistortionImport = await importPackageThroughControl(
      app,
      page,
      path.join(PACKAGE_FIXTURES_DIR, 'face-distortion.zip'),
    );
    assert.equal(
      motionDistortionImport.state,
      'success',
      `face-distortion import must succeed in the motion scenario: ${motionDistortionImport.text}`,
    );
    await waitForEffectLoaded(page, FACE_DISTORTION_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Face distortion/);
    await page.evaluate((startSeconds) => {
      const video = document.querySelector('video');
      if (!video) throw new Error('expected a replay video element');
      video.currentTime = startSeconds;
    }, MOTION_WINDOW_START_SECONDS);
    await waitFor(
      'distortion motion window media time',
      async () => {
        const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
        return Number(timestamp.mediaMs ?? 0) >= MOTION_WINDOW_START_MS ? timestamp : null;
      },
      15000,
      100,
    );
    await waitFor(
      'rendered output before distortion motion sampling',
      async () => {
        const status = await readStatus(page);
        return status.mode === 'render' ? status : null;
      },
      15000,
      40,
    );
    const distortionMotionSamples = [];
    const distortionMotionShots = [];
    let previousDistortionMediaMs = null;
    for (let index = 0; index < 18; index += 1) {
      await page.waitForTimeout(400);
      const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
      const mediaMs = Number(timestamp.mediaMs ?? 0);
      if (
        mediaMs > MOTION_WINDOW_END_MS ||
        (previousDistortionMediaMs !== null && mediaMs < previousDistortionMediaMs - LOOP_SEAM_THRESHOLD_MS)
      ) {
        break;
      }
      previousDistortionMediaMs = mediaMs;
      const tracking = parseKeyValues(await readDiagnostic(page, 'diag-tracking'));
      if (tracking.phase !== 'tracking') continue;
      const distortion = await readDistortion(page);
      if (distortion.active !== 'true' || Number(distortion.insidePixels) < 8) continue;
      const independentFace = await readFace(page);
      assertDistortionGeometry(distortion, `distortion motion sample ${index}`, independentFace, 8);
      distortionMotionSamples.push({
        mediaMs,
        faceX: Number(distortion.faceX),
        faceY: Number(distortion.faceY),
        faceW: Number(distortion.faceW),
        faceH: Number(distortion.faceH),
        centerX: Number(distortion.centerX),
        centerY: Number(distortion.centerY),
        radiusX: Number(distortion.radiusX),
        radiusY: Number(distortion.radiusY),
        changedInsidePct: Number(distortion.changedInsidePct),
        changedOutsidePct: Number(distortion.changedOutsidePct),
        warpDelta: Number(distortion.warpDelta),
        costMsLast: Number(distortion.costMsLast),
      });
      if (index === 3 || index === 9 || index === 15) {
        distortionMotionShots.push(await screenshotCanvas(page, `18b-motion-distortion-${index}.png`));
      }
    }
    assert.ok(
      distortionMotionSamples.length >= 12,
      `expected most distortion motion-window frames tracked, got ${distortionMotionSamples.length}/18`,
    );
    assert.ok(
      distortionMotionSamples.every(
        (sample) => sample.mediaMs >= MOTION_WINDOW_START_MS && sample.mediaMs <= MOTION_WINDOW_END_MS,
      ),
      `distortion motion samples must fall inside the documented window: ${distortionMotionSamples.map((sample) => sample.mediaMs).join(', ')}`,
    );
    const distortionCenterXRange = spread(distortionMotionSamples.map((sample) => sample.centerX));
    const distortionCenterYRange = spread(distortionMotionSamples.map((sample) => sample.centerY));
    assert.ok(
      Math.max(distortionCenterXRange, distortionCenterYRange) >= 30,
      `the distortion ellipse must move with the recorded face, got x=${distortionCenterXRange} y=${distortionCenterYRange}px`,
    );
    evidence.distortion = {
      fixture: motionMetadata.id,
      windowStartSeconds: MOTION_WINDOW_START_SECONDS,
      windowSeconds: MOTION_WINDOW_SECONDS,
      windowStartMediaMs: MOTION_WINDOW_START_MS,
      windowEndMediaMs: MOTION_WINDOW_END_MS,
      trackedSamples: distortionMotionSamples.length,
      centerXRange: distortionCenterXRange,
      centerYRange: distortionCenterYRange,
      screenshots: distortionMotionShots,
      samples: distortionMotionSamples,
    };
    pass(
      'The face distortion follows recorded head movement instead of a static screen overlay',
      `tracked=${distortionMotionSamples.length}/18 warp centre moved ${distortionCenterXRange}x${distortionCenterYRange}px with the face box, changedInside=${distortionMotionSamples[0]?.changedInsidePct}%..${distortionMotionSamples[distortionMotionSamples.length - 1]?.changedInsidePct}% ${distortionMotionShots.join(' ')}`,
    );

    // Return to the bundled mask for the occlusion A/B and camera evidence.
    await selectEffectThroughControl(page, 'mask');
    await waitForStatusTitle(page, /Effect active: Rigid mask/);

    // Side-view occlusion A/B on two documented held frames in opposite yaw
    // directions. The capture control writes exact 1280x720 output PNGs; the
    // on/off diff must sit inside the tracked face's axis-aligned bounding box,
    // and the ON frame must reveal non-mask content there (exact material
    // colour for packages, the dominant bundled palette for the procedural
    // mask).
    await holdRenderedFrameAt(page, OCCLUSION_CAPTURE_SECONDS, 'primary occlusion');
    const heldTracking = parseKeyValues(await readDiagnostic(page, 'diag-tracking'));
    assert.equal(heldTracking.phase, 'tracking', 'the held side-view frame must still be tracked');
    const bundledOcclusion = await occlusionAbEvidence(page, '28-bundled-mask', MASK_EYE_RGB, null, {
      compareVideo: true,
    });
    const primaryYaw = Number(bundledOcclusion.mask.yaw);
    assert.ok(primaryYaw <= -10, `the primary occlusion sample must be a turned frame, got yaw=${primaryYaw}`);
    const bundledCameraOcclusion = await occlusionCameraAbEvidence(
      page,
      '28-bundled-mask-camera',
      faceRect(bundledOcclusion.face),
      {
        probeRgb: MASK_EYE_RGB,
        probeTolerance: 24,
        probe: bundledOcclusion.probe,
        probeVisible: bundledOcclusion.probeVisible,
        previewChangedPixels: bundledOcclusion.changedPixels,
        previewChangedInsideFacePixels: bundledOcclusion.changedInsideFacePixels,
      },
    );
    evidence.occlusion = {
      captureSeconds: OCCLUSION_CAPTURE_SECONDS,
      bundled: bundledOcclusion,
      camera: bundledCameraOcclusion,
    };
    pass(
      'Face-based occlusion removes mask pixels inside the turned face bounding box in preview and camera',
      `yaw=${bundledOcclusion.mask.yaw} changed=${bundledOcclusion.changedPixels}px (${(100 * bundledOcclusion.insideFaceFraction).toFixed(1)}% inside face bbox, reveal=${bundledOcclusion.reveal.kind}) camera=${bundledCameraOcclusion.changedPixels}px self-diff ON ${bundledOcclusion.selfDiffPixels}px OFF ${bundledOcclusion.offSelfDiffPixels}px plausibility meanLuma=${bundledOcclusion.reveal.plausibleVideo.meanLuminance} stddev=${bundledOcclusion.reveal.plausibleVideo.luminanceStdDev} videoMatch=${bundledOcclusion.videoMatch?.matchFraction} probePixel=${JSON.stringify(bundledOcclusion.probePixel)} ${bundledOcclusion.on} ${bundledOcclusion.off}`,
    );
    pass(
      'The virtual camera receives exactly the same occlusion change on the same held frame',
      `camera change=${bundledCameraOcclusion.changedPixels}px inside=${bundledCameraOcclusion.changedInsideFacePixels}px self-diff=${bundledCameraOcclusion.selfDiffPixels}px probe=${JSON.stringify(bundledCameraOcclusion.cameraProbePixel)}`,
    );

    // Imported masks use the same renderer and therefore the same occluder; the
    // exact unmasked-material colour proves composition and the ON reveal.
    const guardImport = await importPackageThroughControl(app, page, path.join(PACKAGE_FIXTURES_DIR, 'guard-visor.zip'));
    assert.equal(guardImport.state, 'success', `guard-visor import must succeed: ${guardImport.text}`);
    await waitForEffectLoaded(page, GUARD_VISOR_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Guard visor/);
    const guardOcclusion = await occlusionAbEvidence(page, '28-guard-visor', PACKAGE_MASK_RGB, PACKAGE_MASK_RGB);
    const guardCameraOcclusion = await occlusionCameraAbEvidence(page, '28-guard-visor-camera', faceRect(guardOcclusion.face), {
      probeRgb: PACKAGE_MASK_RGB,
      probeTolerance: 28,
      probe: guardOcclusion.probe,
      probeVisible: guardOcclusion.probeVisible,
      previewChangedPixels: guardOcclusion.changedPixels,
      previewChangedInsideFacePixels: guardOcclusion.changedInsideFacePixels,
    });
    evidence.occlusion.guardVisor = guardOcclusion;
    evidence.occlusion.guardVisorCamera = guardCameraOcclusion;
    pass(
      'An imported package mask (guard-visor) uses the same face-based occlusion path in preview and camera',
      `changed=${guardOcclusion.changedPixels}px (${(100 * guardOcclusion.insideFaceFraction).toFixed(1)}% inside face bbox) camera=${guardCameraOcclusion.changedPixels}px materialOff=${(100 * guardOcclusion.reveal.changedMaterialFractionOff).toFixed(1)}% materialOn=${(100 * guardOcclusion.reveal.changedMaterialFractionOn).toFixed(1)}% self-diff ON ${guardOcclusion.selfDiffPixels}px OFF ${guardOcclusion.offSelfDiffPixels}px probePixel=${JSON.stringify(guardOcclusion.probePixel)} ${guardOcclusion.on} ${guardOcclusion.off}`,
    );

    const roseImport = await importPackageThroughControl(app, page, path.join(PACKAGE_FIXTURES_DIR, 'rose-visor.zip'));
    assert.equal(roseImport.state, 'success', `rose-visor import must succeed: ${roseImport.text}`);
    await waitForEffectLoaded(page, ROSE_VISOR_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Rose visor/);
    const roseOcclusion = await occlusionAbEvidence(page, '28-rose-visor', ROSE_MASK_RGB, ROSE_MASK_RGB, {
      compareVideo: true,
    });
    evidence.occlusion.roseVisor = roseOcclusion;
    pass(
      'A mask-only imported package with a nonzero attachment (rose-visor) uses the same occlusion path',
      `changed=${roseOcclusion.changedPixels}px (${(100 * roseOcclusion.insideFaceFraction).toFixed(1)}% inside face bbox) materialOff=${(100 * roseOcclusion.reveal.changedMaterialFractionOff).toFixed(1)}% materialOn=${(100 * roseOcclusion.reveal.changedMaterialFractionOn).toFixed(1)}% self-diff ON ${roseOcclusion.selfDiffPixels}px OFF ${roseOcclusion.offSelfDiffPixels}px videoMatch=${roseOcclusion.videoMatch?.matchFraction} ${roseOcclusion.on} ${roseOcclusion.off}`,
    );

    // Return to the bundled mask for the remaining camera evidence. The primary
    // occlusion A/B left the replay held on a tracked motion-window frame
    // (47.7 s), so the camera capture below uses that stable processed frame
    // instead of resuming live playback first: in this Electron/Playwright
    // environment, a backward seek followed by a loop seam can stall the video
    // frame-callback pipeline, which would turn a camera-startup check into a
    // decoder artifact. The moving behavior itself is evidenced by the sampled
    // motion window above and the three saved screenshots.
    await selectEffectThroughControl(page, 'mask');
    await waitForStatusTitle(page, /Effect active: Rigid mask/);

    // The fixed local eye probe is exact only when the eye plate faces the
    // camera; at some large yaw/pitch poses the same view ray lands on the
    // surrounding shell. The held motion-window frame is not guaranteed to show
    // it, so it is asserted only when visible; the camera PNG's mask-pixel count
    // below proves composition either way.
    const motionProbe = await readMaskProbe(page);
    const motionProbeVisible = maskEyeColourMatches(motionProbe);
    if (motionProbeVisible) {
      assertMaskProbe(motionProbe, 'held motion-window preview probe');
    }
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
      previewProbeVisible: motionProbeVisible,
      cameraEvidenceFrame: OCCLUSION_CAPTURE_SECONDS,
      sliding: slidingEvidence,
      rawSliding: rawSlidingEvidence,
      rawSamples: rawPass.samples.length,
      smoothedVsRawReduction: slidingReduction,
      screenshots: sampleShots,
      samples,
    };
    pass(
      'The mask follows recorded head turns, nods and leaning through the normal pipeline',
      `tracked=${samples.length}/18 yaw=${yawRange.toFixed(1)} pitch=${pitchRange.toFixed(1)} roll=${rollRange.toFixed(1)} origin=${originXRange}x${originYRange}px sliding p95=${slidingEvidence.slideP95Px}px mediaMs=${samples[0]?.mediaMs ?? '?'}-${samples[samples.length - 1]?.mediaMs ?? '?'} (window ${MOTION_WINDOW_START_MS}-${MOTION_WINDOW_END_MS})`,
    );
    pass('Masked motion-window screenshots captured at three points in the turn', sampleShots.join(' '));

    const cameraPreview = await readProcessedRgb(page, 'motion mask camera preview');
    // Give the renderer's 100 ms publish heartbeat time to replace any paused
    // frame cached from the preceding effect switch before the consumer samples.
    await page.waitForTimeout(500);
    const cameraRun = await captureProcessedCameraState(page, 'motion-mask', 10, cameraPreview, 'motion mask');
    const cameraPng = assertProcessedPng(cameraRun.frames, cameraPreview, 'motion mask');
    const eyePixels = pngColorCount(cameraPng.png, MASK_EYE_RGB, 24);
    assert.ok(eyePixels > 60, `motion camera PNG must contain the mask, found ${eyePixels} eye pixels`);
    evidence.camera = {
      preview: cameraPreview,
      camera: averageFrameRgb(cameraRun.frames),
      eyePixels,
      heldFrameSeconds: OCCLUSION_CAPTURE_SECONDS,
      png: cameraPng.png,
    };
    pass(
      'The camera consumer receives the masked output for the held motion-window frame as well',
      `heldFrame=${OCCLUSION_CAPTURE_SECONDS}s camera=${JSON.stringify(evidence.camera.camera)} eyePixels=${eyePixels} ${cameraPng.png}`,
    );

    // --- Published-output warp A/B at the held 47.7 s pose ------------------
    // Same held frame, warp ON vs identity OFF, exact 1280x720 captures through
    // the public control plus the independent camera. This is the primary pose
    // for the face-following centroid comparison below.
    await selectEffectThroughControl(page, FACE_DISTORTION_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Face distortion/);
    await waitForDistortionActive(page, 'motion distortion A/B');
    const primaryDistortionAb = await distortionAbEvidence(page, 'distortion-ab-primary', { captureCamera: true });
    evidence.distortion.ab = { captureSeconds: OCCLUSION_CAPTURE_SECONDS, ...primaryDistortionAb };
    pass(
      'The published preview and camera outputs contain the face-following warp on the held 47.7 s pose',
      `held=${OCCLUSION_CAPTURE_SECONDS}s changed=${primaryDistortionAb.changedPixels}px inside-ellipse=${primaryDistortionAb.changedInsideEllipsePixels}px (${(100 * primaryDistortionAb.insideEllipseFraction).toFixed(2)}%) outside=${primaryDistortionAb.changedOutsideEllipsePixels}px centroid=(${primaryDistortionAb.centroid.x},${primaryDistortionAb.centroid.y}) face-ellipse=(${primaryDistortionAb.ellipse.centerX.toFixed(0)},${primaryDistortionAb.ellipse.centerY.toFixed(0)}) self-diff ON ${primaryDistortionAb.selfDiffPixels}px OFF ${primaryDistortionAb.offSelfDiffPixels}px camera changed=${primaryDistortionAb.camera?.changedPixels}px ${primaryDistortionAb.on} ${primaryDistortionAb.off} ${primaryDistortionAb.camera?.onPng ?? ''}`,
    );
    // Resume the replay only after the camera evidence is captured; the opposite
    // side view uses a fresh app instance.
    await releaseReplayFrame(page);

    const trackingTiming = parseKeyValues(await readDiagnostic(page, 'diag-tracking-timing'));
    evidence.timing = {
      inferenceP95Ms: Number(trackingTiming.p95Ms ?? 0),
      inferenceWarmupMs: Number(trackingTiming.warmupMs ?? 0),
      inferenceFrames: Number(trackingTiming.frames ?? 0),
    };
    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);
    pass('No renderer console errors during the recorded-motion scenario');

    // Second documented side view in the opposite yaw direction. A fresh app
    // instance avoids carrying a backward-seek pause into the hold; the imported
    // guard-visor package persists in the isolated package directory.
    await closeApp(app);
    const opposite = await launchApp({
      SHYMASK_EVIDENCE_DIR: evidenceDir,
      SHYMASK_FIXTURE_MANIFEST: 'pose-loop.json',
      SHYMASK_PACKAGE_DIR: motionPackageDir,
    });
    try {
      await waitFor('opposite-angle fixture diagnostics', async () => {
        const text = await readDiagnostic(opposite.page, 'diag-fixture');
        return text.includes(motionMetadata.id) ? text : null;
      });
      await waitForTrackerModelReady(opposite.page);
      await waitFor('start enabled for opposite-angle hold', async () => {
        return (await opposite.page.locator('[data-testid="start"]').isDisabled()) ? null : true;
      }, 60000);
      await opposite.page.locator('[data-testid="start"]').click();
      await waitForTrackingPhase(opposite.page);
      await opposite.page.locator('[data-testid="effect-select"]').selectOption('mask');
      await waitForStatusTitle(opposite.page, /Effect active: Rigid mask/);
      await holdRenderedFrameAt(opposite.page, OCCLUSION_CAPTURE_SECONDS_OPPOSITE, 'opposite occlusion');
      const oppositeTracking = parseKeyValues(await readDiagnostic(opposite.page, 'diag-tracking'));
      assert.equal(oppositeTracking.phase, 'tracking', 'the opposite side-view frame must still be tracked');
      const oppositeBundled = await occlusionAbEvidence(opposite.page, '28b-bundled-mask', MASK_EYE_RGB, null, {
        compareVideo: true,
      });
      const oppositeYaw = Number(oppositeBundled.mask.yaw);
      assert.ok(oppositeYaw >= 5, `the second occlusion sample must be a different turned frame, got yaw=${oppositeYaw}`);
      assert.ok(
        Math.sign(oppositeYaw) !== Math.sign(primaryYaw),
        `the two occlusion samples must cover opposite yaw directions, primary=${primaryYaw} opposite=${oppositeYaw}`,
      );
      const oppositeCamera = await occlusionCameraAbEvidence(opposite.page, '28b-bundled-mask-camera', faceRect(oppositeBundled.face), {
        probeRgb: MASK_EYE_RGB,
        probeTolerance: 24,
        probe: oppositeBundled.probe,
        probeVisible: oppositeBundled.probeVisible,
        previewChangedPixels: oppositeBundled.changedPixels,
        previewChangedInsideFacePixels: oppositeBundled.changedInsideFacePixels,
      });
      await selectEffectThroughControl(opposite.page, GUARD_VISOR_EFFECT_ID);
      await waitForStatusTitle(opposite.page, /Effect active: Guard visor/);
      const guardOpposite = await occlusionAbEvidence(opposite.page, '28b-guard-visor', PACKAGE_MASK_RGB, PACKAGE_MASK_RGB);
      evidence.occlusion.opposite = {
        captureSeconds: OCCLUSION_CAPTURE_SECONDS_OPPOSITE,
        bundled: oppositeBundled,
        camera: oppositeCamera,
        guardVisor: guardOpposite,
      };
      pass(
        'A second held side view in the opposite yaw direction shows the same occlusion behavior',
        `primaryYaw=${primaryYaw.toFixed(1)} oppositeYaw=${oppositeYaw.toFixed(1)} bundledChanged=${oppositeBundled.changedPixels}px (${(100 * oppositeBundled.insideFaceFraction).toFixed(1)}% inside face bbox) guardChanged=${guardOpposite.changedPixels}px ${oppositeBundled.on} ${oppositeBundled.off}`,
      );
      pass(
        'The virtual camera receives the same occlusion change on the opposite side view too',
        `camera change=${oppositeCamera.changedPixels}px inside=${oppositeCamera.changedInsideFacePixels}px self-diff=${oppositeCamera.selfDiffPixels}px`,
      );

      // --- Second documented pose: the changed region must follow the face --
      // Same public A/B at the 16.0 s held frame. The face is at a different
      // position than the 47.7 s pose, so the published changed-region centroid
      // must move with it. A static screen-space overlay would keep the change at
      // a fixed location and fall outside the tracked face ellipse at one pose.
      await selectEffectThroughControl(opposite.page, FACE_DISTORTION_EFFECT_ID);
      await waitForStatusTitle(opposite.page, /Effect active: Face distortion/);
      await waitForDistortionActive(opposite.page, 'opposite distortion A/B');
      const oppositeDistortionAb = await distortionAbEvidence(opposite.page, 'distortion-ab-opposite', {
        captureCamera: true,
      });
      const poseDistancePx = Math.hypot(
        oppositeDistortionAb.ellipse.centerX - primaryDistortionAb.ellipse.centerX,
        oppositeDistortionAb.ellipse.centerY - primaryDistortionAb.ellipse.centerY,
      );
      const centroidDistancePx = Math.hypot(
        oppositeDistortionAb.centroid.x - primaryDistortionAb.centroid.x,
        oppositeDistortionAb.centroid.y - primaryDistortionAb.centroid.y,
      );
      assert.ok(
        poseDistancePx >= 40,
        `the two documented A/B poses must have different face positions, got ${poseDistancePx.toFixed(1)}px apart`,
      );
      assert.ok(
        centroidDistancePx >= 40,
        `the published changed-region centroid must move with the face between poses, got ${centroidDistancePx.toFixed(1)}px`,
      );
      assert.ok(
        centroidDistancePx >= poseDistancePx * 0.5,
        `the changed-region centroid must follow the face movement (centroid ${centroidDistancePx.toFixed(1)}px vs face ${poseDistancePx.toFixed(1)}px)`,
      );
      evidence.distortion.abOpposite = {
        captureSeconds: OCCLUSION_CAPTURE_SECONDS_OPPOSITE,
        ...oppositeDistortionAb,
      };
      evidence.distortion.faceFollowingPoses = {
        primaryCaptureSeconds: OCCLUSION_CAPTURE_SECONDS,
        oppositeCaptureSeconds: OCCLUSION_CAPTURE_SECONDS_OPPOSITE,
        primaryFaceCenter: primaryDistortionAb.ellipse,
        oppositeFaceCenter: oppositeDistortionAb.ellipse,
        primaryCentroid: primaryDistortionAb.centroid,
        oppositeCentroid: oppositeDistortionAb.centroid,
        poseDistancePx: Number(poseDistancePx.toFixed(1)),
        centroidDistancePx: Number(centroidDistancePx.toFixed(1)),
      };
      pass(
        'The published warp change follows the recorded face between two documented held poses',
        `pose ${OCCLUSION_CAPTURE_SECONDS}s centroid=(${primaryDistortionAb.centroid.x},${primaryDistortionAb.centroid.y}) -> ${OCCLUSION_CAPTURE_SECONDS_OPPOSITE}s centroid=(${oppositeDistortionAb.centroid.x},${oppositeDistortionAb.centroid.y}) moved ${centroidDistancePx.toFixed(1)}px with a ${poseDistancePx.toFixed(1)}px face move; inside-ellipse ${oppositeDistortionAb.changedInsideEllipsePixels}px (${(100 * oppositeDistortionAb.insideEllipseFraction).toFixed(2)}%), outside ${oppositeDistortionAb.changedOutsideEllipsePixels}px; camera changed=${oppositeDistortionAb.camera?.changedPixels}px ${oppositeDistortionAb.on} ${oppositeDistortionAb.off}`,
      );
      assert.deepEqual(
        opposite.consoleErrors,
        [],
        `renderer console errors during the opposite-angle scenario: ${opposite.consoleErrors.join(' | ')}`,
      );
    } finally {
      await closeApp(opposite.app);
    }
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

function verifyPackageFixtures() {
  const required = [
    path.join(PACKAGE_FIXTURES_DIR, 'guard-visor.zip'),
    path.join(PACKAGE_FIXTURES_DIR, 'verdant-tint.zip'),
    path.join(PACKAGE_FIXTURES_DIR, 'face-distortion.zip'),
    path.join(PACKAGE_FIXTURES_DIR, 'reactive-ears.zip'),
    ...NEGATIVE_PACKAGE_CASES.map((entry) => path.join(PACKAGE_NEGATIVE_DIR, `${entry.name}.zip`)),
  ];
  for (const file of required) {
    assert.ok(existsSync(file), `Missing effect-package fixture ${file}. Run \`npm run build:packages\`.`);
    assert.ok(readFileSync(file).length > 0, `Effect-package fixture ${file} is empty.`);
  }
}

async function effectOptionValues(page) {
  return page
    .locator('[data-testid="effect-select"] option')
    .evaluateAll((options) => options.map((option) => option.value));
}

/** Stubs only the OS picker; the real validation/import/store path still runs. */
async function stubPackageDialog(app, filePath) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, filePath);
}

async function importPackageThroughControl(app, page, filePath) {
  await stubPackageDialog(app, filePath);
  await page.locator('[data-testid="import-package"]').click();
  return waitFor(
    `import result for ${path.basename(filePath)}`,
    async () => {
      const state = await page.locator('[data-testid="package-result"]').getAttribute('data-state');
      const text = ((await page.locator('[data-testid="package-result"]').textContent()) ?? '').trim();
      if (state === 'success' || state === 'error') return { state, text };
      return null;
    },
    20000,
    100,
  );
}

async function readEffectDiagnostic(page) {
  return parseKeyValues(await readDiagnostic(page, 'diag-effect'));
}

async function waitForEffectLoaded(page, id, timeoutMs = 20000) {
  return waitFor(
    `effect ${id} loaded`,
    async () => {
      const values = await readEffectDiagnostic(page);
      return values.id === id && values.switching === 'false' && values.error === 'no' ? values : null;
    },
    timeoutMs,
    100,
  );
}

async function selectEffectThroughControl(page, id) {
  await page.locator('[data-testid="effect-select"]').selectOption(id);
  return waitForEffectLoaded(page, id);
}

function colorNear(actual, expected, tolerance = 16) {
  return (
    Math.abs(Number(actual.r) - expected.r) <= tolerance &&
    Math.abs(Number(actual.g) - expected.g) <= tolerance &&
    Math.abs(Number(actual.b) - expected.b) <= tolerance
  );
}

async function readDistortion(page) {
  return parseKeyValues(await readDiagnostic(page, 'diag-distortion'));
}

/**
 * Waits for the imported face distortion to be active *and* for the pipeline's
 * warp-delta diagnostic to have compared at least one presented frame, so the
 * assertion is about observed pixel change rather than configuration metadata.
 */
async function waitForDistortionActive(page, label, timeoutMs = 20000) {
  return waitFor(
    `${label} active face distortion`,
    async () => {
      const values = await readDistortion(page);
      if (values.active !== 'true') return null;
      if (Number(values.insidePixels) < 8) return null;
      return values;
    },
    timeoutMs,
    100,
  );
}

/**
 * Asserts the warp ellipse follows the tracked face and that the distortion
 * changed real pixels inside it while leaving the rest of the frame unchanged.
 *
 * `independentFace` is the face box read from the *tracking* diagnostic
 * (`diag-face`, populated from the detector's `faceBbox`), not the distortion's
 * own `faceX/faceY/faceW/faceH` fields. Comparing the ellipse against that
 * independent source is what makes this assertion meaningful: a static or
 * mis-anchored warp cannot satisfy it. When supplied, the expected centre and
 * radii are derived from the independent box and the declared parameters.
 */
function assertDistortionGeometry(values, label, independentFace = null, tolerancePx = 2) {
  const faceX = Number(values.faceX);
  const faceY = Number(values.faceY);
  const faceW = Number(values.faceW);
  const faceH = Number(values.faceH);
  assert.ok(faceW > 40 && faceH > 40, `${label}: the warp must have a measurable tracked face box, got ${faceW}x${faceH}`);
  assert.ok(
    Math.abs(Number(values.centerX) - (faceX + faceW / 2)) <= 2,
    `${label}: the warp centre must follow the tracked face box centre: ${JSON.stringify(values)}`,
  );
  assert.ok(
    Math.abs(Number(values.centerY) - (faceY + faceH / 2)) <= 2,
    `${label}: the warp centre must follow the tracked face box centre: ${JSON.stringify(values)}`,
  );
  const expectedRadiusX = (faceW / 2) * Number(values.radiusScale);
  const expectedRadiusY = (faceH / 2) * Number(values.radiusScale);
  assert.ok(
    Math.abs(Number(values.radiusX) - expectedRadiusX) <= 2 &&
      Math.abs(Number(values.radiusY) - expectedRadiusY) <= 2,
    `${label}: the warp size must scale with the tracked face: ${JSON.stringify(values)}`,
  );
  if (independentFace) {
    const independent = {
      x: Number(independentFace.x),
      y: Number(independentFace.y),
      w: Number(independentFace.w),
      h: Number(independentFace.h),
    };
    assert.ok(
      independent.w > 40 && independent.h > 40,
      `${label}: the independent tracking diagnostic must report a measurable face box, got ${independent.w}x${independent.h}`,
    );
    const [offsetX, offsetY] = String(values.centerOffset ?? '0,0').split(',').map(Number);
    const expectedCenterX = independent.x + independent.w * (0.5 + offsetX);
    const expectedCenterY = independent.y + independent.h * (0.5 + offsetY);
    const expectedIndependentRadiusX = (independent.w / 2) * Number(values.radiusScale);
    const expectedIndependentRadiusY = (independent.h / 2) * Number(values.radiusScale);
    assert.ok(
      Math.abs(Number(values.centerX) - expectedCenterX) <= tolerancePx &&
        Math.abs(Number(values.centerY) - expectedCenterY) <= tolerancePx,
      `${label}: the warp centre must follow the independent diag-face box (centre ${expectedCenterX},${expectedCenterY}, tolerance ${tolerancePx}px): ${JSON.stringify({ values, independentFace })}`,
    );
    assert.ok(
      Math.abs(Number(values.radiusX) - expectedIndependentRadiusX) <= tolerancePx + 1 &&
        Math.abs(Number(values.radiusY) - expectedIndependentRadiusY) <= tolerancePx + 1,
      `${label}: the warp radius must scale with the independent diag-face box (radius ${expectedIndependentRadiusX},${expectedIndependentRadiusY}): ${JSON.stringify({ values, independentFace })}`,
    );
  }
  assert.ok(
    Number(values.changedInsidePct) >= 8,
    `${label}: the distortion must change pixels inside the tracked face region, got ${values.changedInsidePct}% (warpDelta=${values.warpDelta})`,
  );
  assert.ok(
    Number(values.changedOutsidePct) <= 3,
    `${label}: the distortion must stay localized to the tracked face region, got ${values.changedOutsidePct}% changed outside`,
  );
  assert.ok(
    Number(values.warpDelta) >= 0.25,
    `${label}: the warp-delta diagnostic must measure a real image change, got ${values.warpDelta}`,
  );
}

/**
 * Independent expected warp ellipse for a tracked face box and a distortion
 * declaration parsed from the public `diag-effect` line (`mode:strength:
 * radiusScale:centerOffset`). Derived from the face box and the manifest values,
 * not from the distortion diagnostic's own geometry fields.
 */
function distortionEllipse(face, distortion) {
  const x = Number(face.x);
  const y = Number(face.y);
  const width = Number(face.w);
  const height = Number(face.h);
  const radiusScale = Number(distortion.radiusScale);
  const [offsetX, offsetY] = String(distortion.centerOffset).split(',').map(Number);
  return {
    centerX: x + width * (0.5 + offsetX),
    centerY: y + height * (0.5 + offsetY),
    radiusX: (width / 2) * radiusScale,
    radiusY: (height / 2) * radiusScale,
  };
}

/**
 * Counts pixels that differ between two saved PNGs and classifies each changed
 * pixel inside or outside the expected warp ellipse. The changed-region centroid
 * is the published-output location of the warp: for a face-following distortion
 * it must sit on the tracked face, and it must move when the face moves.
 */
function pngEllipseDiff(fileA, fileB, ellipse, tolerance = 4) {
  const a = decodePng(fileA);
  const b = decodePng(fileB);
  assert.equal(a.width, b.width, 'compared PNGs must have the same width');
  assert.equal(a.height, b.height, 'compared PNGs must have the same height');
  let count = 0;
  let inside = 0;
  let outside = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const index = y * a.stride + x * a.channels;
      const changed =
        Math.abs(a.pixels[index] - b.pixels[index]) > tolerance ||
        Math.abs(a.pixels[index + 1] - b.pixels[index + 1]) > tolerance ||
        Math.abs(a.pixels[index + 2] - b.pixels[index + 2]) > tolerance;
      if (!changed) continue;
      count += 1;
      sumX += x + 0.5;
      sumY += y + 0.5;
      const dx = (x + 0.5 - ellipse.centerX) / ellipse.radiusX;
      const dy = (y + 0.5 - ellipse.centerY) / ellipse.radiusY;
      if (dx * dx + dy * dy < 1) inside += 1;
      else outside += 1;
    }
  }
  return {
    count,
    inside,
    outside,
    width: a.width,
    height: a.height,
    centroidX: count > 0 ? sumX / count : 0,
    centroidY: count > 0 ? sumY / count : 0,
  };
}

function parseDistortionDeclaration(effectValues) {
  const [mode, strength, radiusScale, centerOffset] = String(effectValues.distortion ?? '').split(':');
  return { mode, strength: Number(strength), radiusScale: Number(radiusScale), centerOffset };
}

/**
 * Public A/B proof that the *published* output contains the face-following warp.
 *
 * The caller holds a documented replay frame. This captures exact 1280x720
 * output PNGs through the public Capture control in two states that differ only
 * in the warp: the effect stays selected and the offscreen renderer still
 * produces the frame, but `warp off` draws the same uploaded frame through the
 * identity shader. The changed region must be substantial, must sit inside the
 * independent diag-face-derived ellipse and be ~zero outside it, same-state
 * captures must be pixel-identical, and the independent Media Foundation camera
 * must receive the identical change. This fails for a dropped warp (ON == OFF)
 * and for a raw passthrough (OFF would not come from the effect renderer at
 * all). A fixed screen-space overlay is excluded by the cross-pose centroid
 * gate in the caller: the two tracked ellipses overlap, so containment alone
 * cannot exclude it, but the changed-region centroid must move at least 40 px
 * and at least 50% of the face-box movement between the two documented poses.
 */
async function distortionAbEvidence(page, label, options = {}) {
  const captureCamera = options.captureCamera === true;
  const statusBefore = await readStatus(page);
  assert.equal(
    statusBefore.mode,
    'render',
    `${label}: the held A/B frame must be rendered, not the paused screen (${statusBefore.explanation})`,
  );
  const effectBefore = await readEffectDiagnostic(page);
  assert.notEqual(effectBefore.distortion, 'none', `${label}: a distortion effect must be selected`);
  const declaration = parseDistortionDeclaration(effectBefore);
  const tracking = await readTracking(page);
  assert.equal(tracking.phase, 'tracking', `${label}: the held A/B frame must be tracked`);
  const distortionBefore = await readDistortion(page);
  assert.equal(distortionBefore.active, 'true', `${label}: the distortion effect must be active`);
  assert.equal(distortionBefore.warpEnabled, 'true', `${label}: the warp must start enabled`);
  const face = await readFace(page);
  assert.equal(face.count, '1', `${label}: exactly one face must be tracked for the distortion A/B`);
  assertDistortionGeometry(distortionBefore, label, face, 2);
  const ellipse = distortionEllipse(face, declaration);

  const on = await captureOutputThroughControl(page, `${label}-warp-on.png`);
  await page.waitForTimeout(250);
  const onRepeat = await captureOutputThroughControl(page, `${label}-warp-on-repeat.png`);
  const onFace = await readFace(page);
  const onDistortion = await readDistortion(page);

  await page.locator('[data-testid="distortion-warp-toggle"]').uncheck();
  await page.waitForTimeout(250);
  const offDistortion = await readDistortion(page);
  assert.equal(offDistortion.active, 'true', `${label}: disabling only the warp must keep the distortion effect active`);
  assert.equal(offDistortion.warpEnabled, 'false', `${label}: the diagnostic control must disable only the warp term`);
  const offEffect = await readEffectDiagnostic(page);
  assert.equal(offEffect.distortion, effectBefore.distortion, `${label}: the effect declaration must not change in the A/B`);
  const off = await captureOutputThroughControl(page, `${label}-warp-off.png`);
  await page.waitForTimeout(250);
  const offRepeat = await captureOutputThroughControl(page, `${label}-warp-off-repeat.png`);

  await page.locator('[data-testid="distortion-warp-toggle"]').check();
  await page.waitForTimeout(250);
  const restored = await readDistortion(page);
  assert.equal(restored.active, 'true', `${label}: the effect must stay active after the A/B`);
  assert.equal(restored.warpEnabled, 'true', `${label}: the warp must be restored after the A/B`);
  const faceAfter = await readFace(page);
  // The held frame must not move between captures, otherwise a diff could be
  // video drift rather than the warp A/B.
  assert.equal(faceAfter.x, face.x, `${label}: held face x must not move during the A/B`);
  assert.equal(faceAfter.y, face.y, `${label}: held face y must not move during the A/B`);
  assert.equal(faceAfter.w, face.w, `${label}: held face width must not move during the A/B`);
  assert.equal(faceAfter.h, face.h, `${label}: held face height must not move during the A/B`);

  const selfDiff = pngPixelDiff(on, onRepeat);
  const offSelfDiff = pngPixelDiff(off, offRepeat);
  const change = pngEllipseDiff(on, off, ellipse);
  const insideFraction = change.count === 0 ? 0 : change.inside / change.count;
  assert.equal(selfDiff.count, 0, `${label}: two ON captures of the same held frame must be pixel-identical, got ${selfDiff.count} changed pixels`);
  assert.equal(offSelfDiff.count, 0, `${label}: two OFF captures of the same held frame must be pixel-identical, got ${offSelfDiff.count} changed pixels`);
  assert.ok(
    change.inside >= 1500,
    `${label}: the warp must visibly change published pixels inside the tracked face ellipse, changed ${change.inside} inside (${change.count} total)`,
  );
  assert.ok(
    insideFraction >= 0.97,
    `${label}: the warp change must stay inside the tracked face ellipse (inside fraction ${insideFraction.toFixed(3)}, ${change.inside}/${change.count})`,
  );
  assert.ok(
    change.outside <= Math.max(40, Math.round(change.count * 0.01)),
    `${label}: the warp must not change the frame outside the tracked face ellipse, got ${change.outside} outside pixels (allowed ${Math.max(40, Math.round(change.count * 0.01))})`,
  );
  const centroidDx = (change.centroidX - ellipse.centerX) / ellipse.radiusX;
  const centroidDy = (change.centroidY - ellipse.centerY) / ellipse.radiusY;
  assert.ok(
    centroidDx * centroidDx + centroidDy * centroidDy <= 0.36,
    `${label}: the changed-region centroid must sit on the tracked face ellipse centre (${change.centroidX.toFixed(1)},${change.centroidY.toFixed(1)} vs ${ellipse.centerX.toFixed(1)},${ellipse.centerY.toFixed(1)})`,
  );

  let camera = null;
  if (captureCamera) {
    // The independent camera must receive the same change on the held frame.
    const previewOn = await readRgb(page);
    const onRun = await captureProcessedCameraState(
      page,
      `${label}-warp-on-camera`,
      PROCESSED_CAMERA_FRAMES,
      previewOn,
      `${label} warp on camera`,
    );
    const onPngs = onRun.frames.filter((frame) => frame.png && frame.captureUnixMs > 0).map((frame) => frame.png);
    assert.ok(onPngs.length >= 2, `${label}: expected two app-published camera PNGs in the warp-on state, got ${onPngs.length}`);
    await page.locator('[data-testid="distortion-warp-toggle"]').uncheck();
    await page.waitForTimeout(300);
    const previewOff = await readRgb(page);
    const offRun = await captureProcessedCameraState(
      page,
      `${label}-warp-off-camera`,
      PROCESSED_CAMERA_FRAMES,
      previewOff,
      `${label} warp off camera`,
    );
    const offPng = offRun.frames.find((frame) => frame.png && frame.captureUnixMs > 0)?.png;
    assert.ok(offPng, `${label}: expected an app-published camera PNG in the warp-off state`);
    await page.locator('[data-testid="distortion-warp-toggle"]').check();
    await page.waitForTimeout(300);
    const cameraSelfDiff = pngPixelDiff(onPngs[0], onPngs[1]);
    const cameraChange = pngEllipseDiff(onPngs[0], offPng, ellipse);
    assert.equal(
      cameraSelfDiff.count,
      0,
      `${label}: two camera PNGs of the same held frame must match, got ${cameraSelfDiff.count} changed pixels`,
    );
    assert.equal(
      cameraChange.count,
      change.count,
      `${label}: camera and preview must receive the identical warp change (camera ${cameraChange.count}px, preview ${change.count}px)`,
    );
    assert.equal(
      cameraChange.inside,
      change.inside,
      `${label}: camera and preview must receive the identical inside-ellipse warp change (camera ${cameraChange.inside}px, preview ${change.inside}px)`,
    );
    camera = {
      onPng: onPngs[0],
      onRepeatPng: onPngs[1],
      offPng,
      selfDiffPixels: cameraSelfDiff.count,
      changedPixels: cameraChange.count,
      changedInsideEllipsePixels: cameraChange.inside,
    };
  }

  return {
    declared: declaration,
    face,
    ellipse,
    distortion: onDistortion,
    offDistortion,
    on,
    onRepeat,
    off,
    offRepeat,
    selfDiffPixels: selfDiff.count,
    offSelfDiffPixels: offSelfDiff.count,
    changedPixels: change.count,
    changedInsideEllipsePixels: change.inside,
    changedOutsideEllipsePixels: change.outside,
    insideEllipseFraction: Number(insideFraction.toFixed(3)),
    centroid: { x: Number(change.centroidX.toFixed(1)), y: Number(change.centroidY.toFixed(1)) },
    camera,
  };
}

async function readSecondaryMotion(page) {
  return parseKeyValues(await readDiagnostic(page, 'diag-secondary-motion'));
}

function secondaryMotionAngleList(values, key) {
  return String(values[key] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(Number);
}

/** Asserts every part angle the simulator reports is inside its declared bound. */
function assertSecondaryMotionBounds(values, label) {
  assert.equal(values.active, 'true', `${label}: the secondary-motion effect must be active`);
  const angles = secondaryMotionAngleList(values, 'angles');
  const maxima = secondaryMotionAngleList(values, 'maxAngleDeg');
  assert.equal(angles.length, maxima.length, `${label}: every declared part must report one angle and one bound`);
  assert.ok(angles.length >= 1, `${label}: at least one movable part must be declared`);
  for (const [index, angle] of angles.entries()) {
    const maximum = maxima[index];
    assert.ok(Number.isFinite(angle), `${label}: part ${index} angle must be finite, got ${values.angles}`);
    assert.ok(Number.isFinite(maximum) && maximum > 0, `${label}: part ${index} must have a positive bound`);
    assert.ok(
      Math.abs(angle) <= maximum + 0.01,
      `${label}: part ${index} angle ${angle} must stay inside its ${maximum} degree bound`,
    );
  }
  assert.ok(Number.isFinite(Number(values.maxAbsAngleDeg)), `${label}: maxAbsAngleDeg must be finite`);
}

/**
 * Public published-output A/B for secondary motion on a held frame.
 *
 * The effect stays selected; the diagnostic toggle only draws the movable parts
 * at their authored rest orientation. Exact 1280x720 PNGs through the public
 * Capture control must differ substantially, the change must sit on the mask,
 * same-state repeats must be pixel-identical, and the independent camera must
 * receive the identical change. A dropped simulation makes ON == OFF.
 */
async function secondaryMotionAbEvidence(page, label, options = {}) {
  const captureCamera = options.captureCamera === true;
  const statusBefore = await readStatus(page);
  assert.equal(
    statusBefore.mode,
    'render',
    `${label}: the held A/B frame must be rendered, not the paused screen (${statusBefore.explanation})`,
  );
  const effectBefore = await readEffectDiagnostic(page);
  assert.equal(effectBefore.mask, 'gltf', `${label}: a packaged mask must be selected`);
  assert.equal(effectBefore.motion, '3', `${label}: the reactive-ears sample must declare 3 movable parts`);
  const tracking = await readTracking(page);
  assert.equal(tracking.phase, 'tracking', `${label}: the held A/B frame must be tracked`);
  const motionBefore = await readSecondaryMotion(page);
  assertSecondaryMotionBounds(motionBefore, label);
  assert.equal(motionBefore.enabled, 'true', `${label}: secondary motion must start enabled`);
  assert.equal(motionBefore.applied, 'simulated', `${label}: the simulated angles must be applied`);
  const heldAngle = Number(motionBefore.maxAbsAngleDeg);
  assert.ok(
    heldAngle >= 5,
    `${label}: the held post-turn frame must retain a visible simulated angle, got ${heldAngle} degrees (${JSON.stringify(motionBefore)})`,
  );
  const mask = await readMask(page);
  assert.equal(mask.visible, 'true', `${label}: the held A/B frame must show the packaged mask`);
  const maskRect = {
    x: Number(mask.centerX) - Number(mask.widthPx) / 2 - 20,
    y: Number(mask.centerY) - Number(mask.heightPx) / 2 - 20,
    width: Number(mask.widthPx) + 40,
    height: Number(mask.heightPx) + 40,
  };

  const on = await captureOutputThroughControl(page, `${label}-motion-on.png`);
  await page.waitForTimeout(250);
  const onRepeat = await captureOutputThroughControl(page, `${label}-motion-on-repeat.png`);
  const onMotion = await readSecondaryMotion(page);

  await page.locator('[data-testid="secondary-motion-toggle"]').uncheck();
  await page.waitForTimeout(300);
  const offMotion = await readSecondaryMotion(page);
  assert.equal(offMotion.active, 'true', `${label}: disabling only the motion must keep the effect active`);
  assert.equal(offMotion.enabled, 'false', `${label}: the diagnostic control must disable only the simulation application`);
  assert.equal(offMotion.applied, 'rest', `${label}: the OFF state must draw the authored rest orientation`);
  assert.equal(
    offMotion.updates,
    onMotion.updates,
    `${label}: the held frame must not advance the simulator between ON and OFF captures`,
  );
  const offEffect = await readEffectDiagnostic(page);
  assert.equal(offEffect.id, effectBefore.id, `${label}: the held A/B must not switch effects`);
  assert.equal(offEffect.motion, effectBefore.motion, `${label}: the held A/B must not change the declaration`);
  const off = await captureOutputThroughControl(page, `${label}-motion-off.png`);
  await page.waitForTimeout(250);
  const offRepeat = await captureOutputThroughControl(page, `${label}-motion-off-repeat.png`);

  await page.locator('[data-testid="secondary-motion-toggle"]').check();
  await page.waitForTimeout(300);
  const restored = await readSecondaryMotion(page);
  assert.equal(restored.enabled, 'true', `${label}: secondary motion must be restored after the A/B`);
  const maskAfter = await readMask(page);
  assert.equal(maskAfter.centerX, mask.centerX, `${label}: the held mask must not move during the A/B`);
  assert.equal(maskAfter.centerY, mask.centerY, `${label}: the held mask must not move during the A/B`);

  const selfDiff = pngPixelDiff(on, onRepeat);
  const offSelfDiff = pngPixelDiff(off, offRepeat);
  const change = pngPixelDiff(on, off);
  const changeOnMask = pngPixelDiff(on, off, 4, maskRect);
  assert.equal(selfDiff.count, 0, `${label}: two ON captures of the held frame must be pixel-identical, got ${selfDiff.count}`);
  assert.equal(offSelfDiff.count, 0, `${label}: two OFF captures of the held frame must be pixel-identical, got ${offSelfDiff.count}`);
  assert.ok(
    change.count >= 800,
    `${label}: the held visible angle must change a meaningful number of published pixels, got ${change.count}`,
  );
  assert.ok(
    changeOnMask.inside >= change.count * 0.98,
    `${label}: the secondary-motion change must sit on the packaged mask (${changeOnMask.inside}/${change.count} inside the mask rectangle)`,
  );

  let camera = null;
  if (captureCamera) {
    const previewOn = await readRgb(page);
    const onRun = await captureProcessedCameraState(
      page,
      `${label}-motion-on-camera`,
      PROCESSED_CAMERA_FRAMES,
      previewOn,
      `${label} motion on camera`,
    );
    const onPngs = onRun.frames.filter((frame) => frame.png && frame.captureUnixMs > 0).map((frame) => frame.png);
    assert.ok(onPngs.length >= 2, `${label}: expected two app-published camera PNGs in the motion-on state, got ${onPngs.length}`);
    await page.locator('[data-testid="secondary-motion-toggle"]').uncheck();
    await page.waitForTimeout(300);
    const previewOff = await readRgb(page);
    const offRun = await captureProcessedCameraState(
      page,
      `${label}-motion-off-camera`,
      PROCESSED_CAMERA_FRAMES,
      previewOff,
      `${label} motion off camera`,
    );
    const offPng = offRun.frames.find((frame) => frame.png && frame.captureUnixMs > 0)?.png;
    assert.ok(offPng, `${label}: expected an app-published camera PNG in the motion-off state`);
    await page.locator('[data-testid="secondary-motion-toggle"]').check();
    await page.waitForTimeout(300);
    const cameraSelfDiff = pngPixelDiff(onPngs[0], onPngs[1]);
    const cameraChange = pngPixelDiff(onPngs[0], offPng);
    assert.equal(
      cameraSelfDiff.count,
      0,
      `${label}: two camera PNGs of the held frame must match, got ${cameraSelfDiff.count} changed pixels`,
    );
    assert.equal(
      cameraChange.count,
      change.count,
      `${label}: camera and preview must receive the identical secondary-motion change (camera ${cameraChange.count}px, preview ${change.count}px)`,
    );
    camera = {
      onPng: onPngs[0],
      onRepeatPng: onPngs[1],
      offPng,
      selfDiffPixels: cameraSelfDiff.count,
      changedPixels: cameraChange.count,
    };
  }

  return {
    effect: effectBefore,
    face: await readFace(page),
    mask,
    motion: onMotion,
    offMotion,
    on,
    onRepeat,
    off,
    offRepeat,
    heldAngleDeg: heldAngle,
    selfDiffPixels: selfDiff.count,
    offSelfDiffPixels: offSelfDiff.count,
    changedPixels: change.count,
    changedOnMaskPixels: changeOnMask.inside,
    camera,
  };
}

async function waitForPackageMask(page, label, expected = PACKAGE_MASK_RGB) {
  const mask = await waitFor(`${label} mask projection`, async () => {
    const values = await readMask(page);
    return values.visible === 'true' ? values : null;
  }, 20000);
  const face = await readFace(page);
  assert.ok(
    originInsideFace(mask, face),
    `${label}: packaged mask origin must sit on the tracked face: mask=${JSON.stringify(mask)} face=${JSON.stringify(face)}`,
  );
  const probe = await readMaskProbe(page);
  const expectedDiagnostic = await readDiagnostic(page, 'diag-mask-color');
  const expectedRgb = parseKeyValues(expectedDiagnostic);
  assert.ok(
    colorNear(expectedRgb, expected, 4),
    `${label}: the packaged unlit material colour must be reported as the probe colour, got ${expectedDiagnostic}`,
  );
  // Face occlusion can legitimately hide the bounding-box-centre probe (the
  // face is in front of that part of the mask). The caller proves the packaged
  // material is composited by counting its exact colour in the preview/camera
  // PNG, asserts the camera probe when this preview probe is visible, and only
  // then treats the probe pixel as evidence.
  const probeVisible = colorNear(probe, expected, 20);
  return { mask, face, probe, expectedRgb, probeVisible };
}

/**
 * Scenario I: import validated effect packages through the public control, select
 * them as complete effects, and prove preview + independent camera output, the
 * paused-output switching policy, negative imports and removal/persistence.
 */
async function effectPackageScenario() {
  log('\n== Scenario I: effect package import, selection, switching and removal ==');
  const evidence = {
    imports: {},
    distortion: {},
    negative: [],
    switching: {},
    removal: {},
    persistence: {},
    camera: {},
  };
  // Isolated store so a check run never mutates the developer's userData.
  const packageDir = path.join(evidenceDir, 'effect-packages');
  mkdirSync(packageDir, { recursive: true });
  const env = { SHYMASK_EVIDENCE_DIR: evidenceDir, SHYMASK_PACKAGE_DIR: packageDir };

  let app;
  let page;
  let consoleErrors = [];
  try {
    ({ app, page, consoleErrors } = await launchApp(env));
    await waitFor('fixture diagnostics', async () => {
      const text = await readDiagnostic(page, 'diag-fixture');
      return text.includes(metadata.id) ? text : null;
    });
    await waitForTrackerModelReady(page);
    await waitFor('start enabled after tracker initialization', async () => {
      return (await page.locator('[data-testid="start"]').isDisabled()) ? null : true;
    }, 60000);
    await page.locator('[data-testid="start"]').click();
    await waitForTrackingPhase(page);
    await waitForVirtualCamera(page);

    const initialPackages = await readDiagnostic(page, 'diag-packages');
    assert.match(initialPackages, /installed=0/);
    assert.equal(await page.locator('[data-testid="effect-select"]').getAttribute('multiple'), null);
    assert.equal(await page.locator('select[multiple]').count(), 0);

    // Bundled baseline on the same output path the packages must use.
    await page.locator('[data-testid="effect-select"]').selectOption('mask');
    await waitForStatusTitle(page, /Effect active: Rigid mask/);
    await waitFor('bundled mask projection', async () => {
      const mask = await readMask(page);
      return mask.visible === 'true' ? mask : null;
    });
    const bundledRgb = await readRgb(page);

    // --- Import the valid mask + treatment package through the UI ------------
    const guardImport = await importPackageThroughControl(app, page, path.join(PACKAGE_FIXTURES_DIR, 'guard-visor.zip'));
    assert.equal(guardImport.state, 'success', `valid import must succeed: ${guardImport.text}`);
    assert.match(guardImport.text, /Imported "Guard visor" v1\.0\.0/);
    const optionsAfterGuard = await effectOptionValues(page);
    assert.ok(optionsAfterGuard.includes(GUARD_VISOR_EFFECT_ID), 'imported effect must appear in the selector');
    const guardLoaded = await waitForEffectLoaded(page, GUARD_VISOR_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Guard visor/);
    assert.equal(await page.locator('[data-testid="effect-select"]').inputValue(), GUARD_VISOR_EFFECT_ID);
    assert.equal(guardLoaded.source, 'package');
    assert.equal(guardLoaded.mask, 'gltf');
    assert.equal(guardLoaded.treatment, 'yes');
    assert.ok(
      Number(guardLoaded.switchingPausedFrames) >= 1,
      `an async package switch must pause the output while loading, got ${guardLoaded.switchingPausedFrames}`,
    );
    assert.ok(Number(guardLoaded.switchCount) >= 1);
    const guardPreview = await waitForPackageMask(page, 'imported guard visor');
    const guardOcclusion = parseKeyValues(await readDiagnostic(page, 'diag-occlusion'));
    assert.equal(guardOcclusion.enabled, 'true', 'face occlusion must stay active for an imported package mask');
    assert.equal(guardOcclusion.vertices, '468');
    assert.equal(guardOcclusion.triangles, '898');
    const guardRgb = await readProcessedRgb(page, 'imported guard visor preview');
    const guardShot = await screenshotCanvas(page, '21-imported-guard-visor-preview.png');
    // Exact 1280x720 canvas evidence through the public Capture control; the
    // exact unlit material colour proves the package GLB is composited even if
    // face occlusion hides the bounding-box-centre probe. The enforced count is
    // a meaningful fraction of the observed ~31k-33k pixels across recent runs.
    const guardMaterialPng = await captureOutputThroughControl(page, '21b-imported-guard-visor-material.png');
    const guardMaterialPixels = pngColorCount(guardMaterialPng, PACKAGE_MASK_RGB, 28);
    assert.ok(
      guardMaterialPixels > 20000,
      `preview PNG must contain the package mask material, found ${guardMaterialPixels} pixels (enforced >20,000)`,
    );
    evidence.imports.guardVisor = {
      importMessage: guardImport.text,
      effect: guardLoaded,
      mask: guardPreview.mask,
      face: guardPreview.face,
      probe: guardPreview.probe,
      probeVisible: guardPreview.probeVisible,
      preview: guardRgb,
      previewMaterialPixels: guardMaterialPixels,
      previewMaterialPng: guardMaterialPng,
      bundledPreview: bundledRgb,
      occlusion: guardOcclusion,
      screenshot: guardShot,
    };
    pass(
      'A valid effect package imports through the public control and renders its mask + color treatment in preview',
      `effect=${GUARD_VISOR_EFFECT_ID} probe=${JSON.stringify(guardPreview.probe)} probeVisible=${guardPreview.probeVisible} materialPixels=${guardMaterialPixels} switchingPausedFrames=${guardLoaded.switchingPausedFrames} ${guardShot}`,
    );

    // The independent camera consumer must receive the same packaged canvas.
    const guardCameraRun = await captureProcessedCameraState(page, 'imported-guard-visor', PROCESSED_CAMERA_FRAMES, guardRgb, 'imported guard visor');
    const guardPng = assertProcessedPng(guardCameraRun.frames, guardRgb, 'imported guard visor');
    const guardMaskPixels = pngColorCount(guardPng.png, PACKAGE_MASK_RGB, 28);
    assert.ok(
      guardMaskPixels > 20000,
      `camera PNG must contain the package mask material, found ${guardMaskPixels} pixels (enforced >20,000)`,
    );
    const guardCameraPixel = pngPixel(guardPng.png, Number(guardPreview.probe.x), Number(guardPreview.probe.y));
    const guardCameraProbeMatches = colorNear(guardCameraPixel, PACKAGE_MASK_RGB, 28);
    if (guardPreview.probeVisible) {
      assert.ok(
        guardCameraProbeMatches,
        `the camera PNG probe must match the package material when the preview probe is visible: preview=${JSON.stringify(guardPreview.probe)} camera=${JSON.stringify(guardCameraPixel)}`,
      );
    }
    evidence.camera.guardVisor = {
      preview: guardRgb,
      camera: averageFrameRgb(guardCameraRun.frames),
      png: guardPng.png,
      pngRgb: guardPng.rgb,
      maskPixels: guardMaskPixels,
      cameraPixel: guardCameraPixel,
      cameraProbeMatchesMaterial: guardCameraProbeMatches,
    };
    pass(
      'The virtual camera receives the same imported mask + treatment through the shared output path',
      `camera=${JSON.stringify(evidence.camera.guardVisor.camera)} maskPixels=${guardMaskPixels} probePixel=${JSON.stringify(guardCameraPixel)} probeMatches=${guardCameraProbeMatches} ${guardPng.png}`,
    );

    // --- Import a color-treatment-only package -------------------------------
    const verdantImport = await importPackageThroughControl(app, page, path.join(PACKAGE_FIXTURES_DIR, 'verdant-tint.zip'));
    assert.equal(verdantImport.state, 'success', `valid color-only import must succeed: ${verdantImport.text}`);
    const optionsAfterVerdant = await effectOptionValues(page);
    assert.ok(optionsAfterVerdant.includes(VERDANT_TINT_EFFECT_ID));
    const verdantLoaded = await waitForEffectLoaded(page, VERDANT_TINT_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Verdant tint/);
    assert.equal(await page.locator('[data-testid="effect-select"]').inputValue(), VERDANT_TINT_EFFECT_ID);
    assert.equal(verdantLoaded.mask, 'none');
    assert.equal(verdantLoaded.treatment, 'yes');
    await page.waitForTimeout(350);
    const verdantRgb = await readProcessedRgb(page, 'imported verdant tint preview');
    assert.ok(
      verdantRgb.g > verdantRgb.r + 8 && verdantRgb.g > verdantRgb.b + 8,
      `the package's declarative green treatment must visibly change the preview, got ${JSON.stringify(verdantRgb)}`,
    );
    const verdantShot = await screenshotCanvas(page, '22-imported-verdant-tint-preview.png');
    const verdantRun = await captureProcessedCameraState(page, 'imported-verdant-tint', PROCESSED_CAMERA_FRAMES, verdantRgb, 'imported verdant tint');
    const verdantPng = assertProcessedPng(verdantRun.frames, verdantRgb, 'imported verdant tint');
    evidence.imports.verdantTint = {
      importMessage: verdantImport.text,
      effect: verdantLoaded,
      preview: verdantRgb,
      screenshot: verdantShot,
    };
    evidence.camera.verdantTint = {
      preview: verdantRgb,
      camera: averageFrameRgb(verdantRun.frames),
      png: verdantPng.png,
      pngRgb: verdantPng.rgb,
    };
    pass(
      'A color-treatment-only package renders in preview and the virtual camera through the same path',
      `preview=${JSON.stringify(verdantRgb)} camera=${JSON.stringify(evidence.camera.verdantTint.camera)} ${verdantShot} ${verdantPng.png}`,
    );

    // --- A mask-only package with a nonzero attachment ------------------------
    const roseImport = await importPackageThroughControl(app, page, path.join(PACKAGE_FIXTURES_DIR, 'rose-visor.zip'));
    assert.equal(roseImport.state, 'success', `valid mask-only import must succeed: ${roseImport.text}`);
    assert.match(roseImport.text, /Imported "Rose visor" v1\.0\.0/);
    const optionsAfterRose = await effectOptionValues(page);
    assert.ok(optionsAfterRose.includes(ROSE_VISOR_EFFECT_ID));
    const roseLoaded = await waitForEffectLoaded(page, ROSE_VISOR_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Rose visor/);
    assert.equal(roseLoaded.mask, 'gltf');
    assert.equal(roseLoaded.treatment, 'no');
    // The renderer must receive the manifest's nonzero position/rotation/scale,
    // not silently default them, before it parses the package GLB.
    assert.equal(roseLoaded.attachment, '2,3.5,0/0,0,12/1.1');
    const rosePreview = await waitForPackageMask(page, 'imported rose visor', ROSE_MASK_RGB);
    const roseOcclusion = parseKeyValues(await readDiagnostic(page, 'diag-occlusion'));
    assert.equal(roseOcclusion.enabled, 'true', 'face occlusion must stay active for a mask-only package');
    assert.equal(roseOcclusion.vertices, '468');
    const roseRgb = await readProcessedRgb(page, 'imported rose visor preview');
    const roseShot = await screenshotCanvas(page, '22b-imported-rose-visor-preview.png');
    const roseMaterialPng = await captureOutputThroughControl(page, '22c-imported-rose-visor-material.png');
    const roseMaterialPixels = pngColorCount(roseMaterialPng, ROSE_MASK_RGB, 28);
    assert.ok(
      roseMaterialPixels > 25000,
      `preview PNG must contain the rose mask material, found ${roseMaterialPixels} pixels (enforced >25,000)`,
    );
    const roseRun = await captureProcessedCameraState(page, 'imported-rose-visor', PROCESSED_CAMERA_FRAMES, roseRgb, 'imported rose visor');
    const rosePng = assertProcessedPng(roseRun.frames, roseRgb, 'imported rose visor');
    const roseMaskPixels = pngColorCount(rosePng.png, ROSE_MASK_RGB, 28);
    assert.ok(
      roseMaskPixels > 25000,
      `camera PNG must contain the rose mask material, found ${roseMaskPixels} pixels (enforced >25,000)`,
    );
    const roseCameraPixel = pngPixel(rosePng.png, Number(rosePreview.probe.x), Number(rosePreview.probe.y));
    const roseCameraProbeMatches = colorNear(roseCameraPixel, ROSE_MASK_RGB, 28);
    if (rosePreview.probeVisible) {
      assert.ok(
        roseCameraProbeMatches,
        `the camera PNG probe must match the rose material when the preview probe is visible: preview=${JSON.stringify(rosePreview.probe)} camera=${JSON.stringify(roseCameraPixel)}`,
      );
    }
    evidence.imports.roseVisor = {
      importMessage: roseImport.text,
      effect: roseLoaded,
      mask: rosePreview.mask,
      probe: rosePreview.probe,
      probeVisible: rosePreview.probeVisible,
      preview: roseRgb,
      previewMaterialPixels: roseMaterialPixels,
      previewMaterialPng: roseMaterialPng,
      occlusion: roseOcclusion,
      screenshot: roseShot,
    };
    evidence.camera.roseVisor = {
      preview: roseRgb,
      camera: averageFrameRgb(roseRun.frames),
      png: rosePng.png,
      pngRgb: rosePng.rgb,
      maskPixels: roseMaskPixels,
      cameraPixel: roseCameraPixel,
      cameraProbeMatchesMaterial: roseCameraProbeMatches,
    };
    pass(
      'A mask-only package with nonzero attachment position/rotation/scale renders in preview and camera',
      `attachment=${roseLoaded.attachment} probe=${JSON.stringify(rosePreview.probe)} maskPixels=${roseMaskPixels} ${roseShot}`,
    );

    // --- Switching: bundled -> imported -> imported, with paused output ------
    await page.locator('[data-testid="effect-select"]').selectOption('mask');
    await waitForEffectLoaded(page, 'mask');
    const beforeSwitch = await readEffectDiagnostic(page);
    await selectEffectThroughControl(page, GUARD_VISOR_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Guard visor/);
    const afterGuardSwitch = await readEffectDiagnostic(page);
    assert.ok(
      Number(afterGuardSwitch.switchingPausedFrames) > Number(beforeSwitch.switchingPausedFrames),
      `switching to an imported effect must paint the paused output first: before=${beforeSwitch.switchingPausedFrames} after=${afterGuardSwitch.switchingPausedFrames}`,
    );
    await selectEffectThroughControl(page, VERDANT_TINT_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Verdant tint/);
    await selectEffectThroughControl(page, GUARD_VISOR_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Guard visor/);
    const afterRoundTrip = await readEffectDiagnostic(page);
    assert.ok(Number(afterRoundTrip.switchCount) >= Number(afterGuardSwitch.switchCount));
    evidence.switching.bundledToImported = { before: beforeSwitch, after: afterGuardSwitch, roundTrip: afterRoundTrip };
    pass(
      'Switching between bundled and imported effects completes without raw passthrough',
      `switchCount=${afterRoundTrip.switchCount} switchingPausedFrames=${afterRoundTrip.switchingPausedFrames}`,
    );

    // --- Rapid double switch: only the latest load may publish ----------------
    await selectEffectThroughControl(page, VERDANT_TINT_EFFECT_ID);
    await page.locator('[data-testid="effect-select"]').selectOption(ROSE_VISOR_EFFECT_ID);
    // Do not wait for the rose load: selecting a different package immediately
    // leaves the first parse in flight. Its token must be stale when it resolves.
    await page.locator('[data-testid="effect-select"]').selectOption(GUARD_VISOR_EFFECT_ID);
    const rapidLatest = await waitForEffectLoaded(page, GUARD_VISOR_EFFECT_ID);
    await page.waitForTimeout(700);
    const rapidSettled = await readEffectDiagnostic(page);
    assert.equal(rapidSettled.id, GUARD_VISOR_EFFECT_ID, 'the later selection must stay active');
    assert.equal(rapidSettled.switching, 'false');
    assert.equal(rapidSettled.error, 'no');
    assert.equal(
      rapidSettled.maskProbe,
      `${PACKAGE_MASK_RGB.r},${PACKAGE_MASK_RGB.g},${PACKAGE_MASK_RGB.b}`,
      `a stale rose load must not replace the guard mask summary: ${JSON.stringify(rapidSettled)}`,
    );
    const rapidMask = await waitForPackageMask(page, 'rapid double switch', PACKAGE_MASK_RGB);
    assert.equal(await page.locator('[data-testid="effect-select"]').inputValue(), GUARD_VISOR_EFFECT_ID);
    evidence.switching.rapidDoubleSwitch = {
      latest: rapidLatest,
      settled: rapidSettled,
      probe: rapidMask.probe,
    };
    pass(
      'Two rapid package selections commit only the latest mask (stale load discarded)',
      `id=${rapidSettled.id} probe=${JSON.stringify(rapidMask.probe)} switchCount=${rapidSettled.switchCount}`,
    );

    // --- Manual pause persists across a switch -------------------------------
    await page.locator('[data-testid="pause-toggle"]').click();
    const manualPause = await waitFor('manual pause status', async () => {
      const status = await readStatus(page);
      return /paused manually/i.test(status.explanation) ? status : null;
    });
    await page.locator('[data-testid="effect-select"]').selectOption(VERDANT_TINT_EFFECT_ID);
    await page.waitForTimeout(300);
    const stillPaused = await readStatus(page);
    assert.equal(stillPaused.mode, 'paused');
    assert.match(stillPaused.explanation, /paused manually/i);
    // Let the camera host report the new client and the renderer's 100 ms
    // publish heartbeat run once before sampling, otherwise the consumer can
    // read only the native pre-connection fallback frames.
    await page.waitForTimeout(300);
    const manualRun = await captureCameraState(page, 'imported-manual-pause', 6);
    assertAllPausedFrames(manualRun.frames, 'imported effect manual pause');
    const manualPng = assertPausedPng(manualRun.frames, 'imported effect manual pause');
    const manualShot = await screenshotCanvas(page, '23-imported-effect-manual-pause.png');
    await page.locator('[data-testid="pause-toggle"]').click();
    await waitForStatusTitle(page, /Effect active: Verdant tint/);
    evidence.switching.manualPause = {
      status: manualPause,
      pausedAfterSwitch: stillPaused,
      camera: averageFrameRgb(manualRun.frames),
      png: manualPng.png,
      screenshot: manualShot,
    };
    pass(
      'Manual pause persists across an effect switch and the camera stays on the opaque paused canvas',
      `camera=${JSON.stringify(evidence.switching.manualPause.camera)} ${manualShot}`,
    );

    // --- Tracking gates still apply to imported effects ----------------------
    await selectEffectThroughControl(page, GUARD_VISOR_EFFECT_ID);
    await page.locator('[data-testid="tracking-injection"]').selectOption('lost');
    const importedLost = await waitFor('imported effect tracking loss', async () => {
      const status = await readStatus(page);
      return /tracking was lost/i.test(status.explanation) ? status : null;
    });
    assert.equal(importedLost.mode, 'paused');
    await page.waitForTimeout(300);
    const importedLostRgb = await readRgb(page);
    assert.ok(rgbSum(importedLostRgb) < 120, `tracking loss must hide the imported effect, got ${JSON.stringify(importedLostRgb)}`);
    const importedLostRun = await captureCameraState(page, 'imported-tracking-lost', 4);
    assertAllPausedFrames(importedLostRun.frames, 'imported effect tracking loss');
    const importedLostPng = assertPausedPng(importedLostRun.frames, 'imported effect tracking loss');
    const importedLostShot = await screenshotCanvas(page, '24-imported-effect-tracking-lost.png');
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Guard visor/);
    // The status decision and the throttled mean-RGB diagnostic update on
    // different ticks after a tracking recovery, so wait for the processed frame
    // itself instead of reading the previous paused sample.
    const recoveredRgb = await waitFor(
      'imported effect recovered output',
      async () => {
        const rgb = await readRgb(page);
        return rgbSum(rgb) > 120 ? rgb : null;
      },
      10000,
      100,
    );
    evidence.switching.trackingGate = {
      paused: importedLostRgb,
      camera: averageFrameRgb(importedLostRun.frames),
      png: importedLostPng.png,
      screenshot: importedLostShot,
      recovered: recoveredRgb,
    };
    pass(
      'Tracking loss hides an imported effect in preview and camera, and recovery is automatic',
      `preview=${JSON.stringify(importedLostRgb)} camera=${JSON.stringify(evidence.switching.trackingGate.camera)} recovered=${JSON.stringify(recoveredRgb)}`,
    );

    // --- An effect-processing interruption keeps the paused-output policy ----
    await page.locator('[data-testid="simulate-failure"]').check();
    const interrupted = await waitFor('imported effect processing interruption', async () => {
      const status = await readStatus(page);
      return /simulated by the diagnostic control/i.test(status.explanation) ? status : null;
    });
    assert.equal(interrupted.mode, 'paused');
    await page.waitForTimeout(300);
    const interruptedRgb = await readRgb(page);
    assert.ok(rgbSum(interruptedRgb) < 120, `a processing interruption must hide the imported effect, got ${JSON.stringify(interruptedRgb)}`);
    const interruptedRun = await captureCameraState(page, 'imported-processing-failure', 4);
    assertAllPausedFrames(interruptedRun.frames, 'imported effect processing interruption');
    const interruptedPng = assertPausedPng(interruptedRun.frames, 'imported effect processing interruption');
    await page.locator('[data-testid="simulate-failure"]').uncheck();
    await waitForStatusTitle(page, /Effect active: Guard visor/);
    const interruptionRecovered = await readRgb(page);
    assert.ok(rgbSum(interruptionRecovered) > 120, 'the imported effect must recover after the interruption clears');
    evidence.switching.processingInterruption = {
      paused: interruptedRgb,
      camera: averageFrameRgb(interruptedRun.frames),
      png: interruptedPng.png,
      recovered: interruptionRecovered,
    };
    pass(
      'An effect-processing interruption hides an imported effect in preview and camera, and recovery is automatic',
      `preview=${JSON.stringify(interruptedRgb)} camera=${JSON.stringify(evidence.switching.processingInterruption.camera)} recovered=${JSON.stringify(interruptionRecovered)}`,
    );

    // --- Schema v2 bounded face-distortion package ---------------------------
    const distortionImport = await importPackageThroughControl(
      app,
      page,
      path.join(PACKAGE_FIXTURES_DIR, 'face-distortion.zip'),
    );
    assert.equal(distortionImport.state, 'success', `valid distortion import must succeed: ${distortionImport.text}`);
    assert.match(distortionImport.text, /Imported "Face distortion" v1\.0\.0/);
    const optionsAfterDistortion = await effectOptionValues(page);
    assert.ok(optionsAfterDistortion.includes(FACE_DISTORTION_EFFECT_ID), 'the distortion effect must appear in the selector');
    const distortionLoaded = await waitForEffectLoaded(page, FACE_DISTORTION_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Face distortion/);
    assert.equal(await page.locator('[data-testid="effect-select"]').inputValue(), FACE_DISTORTION_EFFECT_ID);
    assert.equal(distortionLoaded.source, 'package');
    assert.equal(distortionLoaded.mask, 'none');
    assert.equal(distortionLoaded.treatment, 'no');
    assert.equal(distortionLoaded.distortion, 'bulge:0.6:1.35:0,0');
    const distortionActive = await waitForDistortionActive(page, 'imported face distortion');
    assertDistortionGeometry(distortionActive, 'imported face distortion', await readFace(page), 6);
    // Let the rolling cost and warp-delta diagnostics collect a steady window.
    await page.waitForTimeout(2200);
    const distortionSample = await waitForDistortionActive(page, 'settled imported face distortion');
    assertDistortionGeometry(distortionSample, 'settled imported face distortion', await readFace(page), 6);
    const distortionPreview = await readProcessedRgb(page, 'imported face distortion preview');
    const distortionShot = await screenshotCanvas(page, '22d-imported-face-distortion-preview.png');
    const distortionPng = await captureOutputThroughControl(page, '22e-imported-face-distortion-output.png');
    const distortionPngMean = pngMeanRgb(distortionPng);
    assert.ok(
      rgbSum(distortionPngMean) > 60,
      `the captured distortion output must be processed content, not the paused canvas: ${JSON.stringify(distortionPngMean)}`,
    );
    const distortionFrameDelta = parseKeyValues(await readDiagnostic(page, 'diag-frame-delta'));
    const distortionRenderCost = parseKeyValues(await readDiagnostic(page, 'diag-render-cost'));
    const distortionCameraRun = await captureProcessedCameraState(
      page,
      'imported-face-distortion',
      PROCESSED_CAMERA_FRAMES,
      distortionPreview,
      'imported face distortion',
    );
    const distortionCameraPng = assertProcessedPng(distortionCameraRun.frames, distortionPreview, 'imported face distortion');
    evidence.distortion.preview = {
      importMessage: distortionImport.text,
      effect: distortionLoaded,
      active: distortionSample,
      rgb: distortionPreview,
      screenshot: distortionShot,
      png: distortionPng,
      pngMean: distortionPngMean,
    };
    evidence.distortion.timing = {
      warpSubmissionCostP95Ms: Number(distortionSample.costMsP95),
      renderCostP95Ms: Number(distortionRenderCost.p95Ms ?? 0),
      frameIntervalP95Ms: Number(distortionFrameDelta.p95Ms ?? 0),
    };
    evidence.camera.faceDistortion = {
      preview: distortionPreview,
      camera: averageFrameRgb(distortionCameraRun.frames),
      png: distortionCameraPng.png,
      pngRgb: distortionCameraPng.rgb,
    };
    pass(
      'A schema v2 face-distortion package imports through the public control and warps the tracked face in preview and camera',
      `effect=${FACE_DISTORTION_EFFECT_ID} centre=(${distortionSample.centerX},${distortionSample.centerY}) radius=${distortionSample.radiusX}x${distortionSample.radiusY} changedInside=${distortionSample.changedInsidePct}% changedOutside=${distortionSample.changedOutsidePct}% warpDelta=${distortionSample.warpDelta} camera=${JSON.stringify(evidence.camera.faceDistortion.camera)} ${distortionShot} ${distortionCameraPng.png}`,
    );

    // --- Public published-output A/B: warped vs identity on a held frame ---
    // The effect stays selected and the offscreen renderer still produces the
    // frame; the diagnostic toggle removes only the warp term. This proves the
    // published 1280x720 output (and the independent camera) really contains the
    // face-following warp, which the offscreen warp-delta diagnostic cannot.
    await holdRenderedFrameAt(page, DISTORTION_AB_CAPTURE_SECONDS, 'default distortion A/B');
    const distortionAb = await distortionAbEvidence(page, '22f-distortion-warp-ab', { captureCamera: true });
    evidence.distortion.ab = { captureSeconds: DISTORTION_AB_CAPTURE_SECONDS, ...distortionAb };
    pass(
      'The published preview and camera outputs contain the face-following warp (warp ON vs identity OFF on a held frame)',
      `held=${DISTORTION_AB_CAPTURE_SECONDS}s changed=${distortionAb.changedPixels}px inside-ellipse=${distortionAb.changedInsideEllipsePixels}px (${(100 * distortionAb.insideEllipseFraction).toFixed(2)}%) outside=${distortionAb.changedOutsideEllipsePixels}px centroid=(${distortionAb.centroid.x},${distortionAb.centroid.y}) centroid-face=(${distortionAb.ellipse.centerX.toFixed(0)},${distortionAb.ellipse.centerY.toFixed(0)}) self-diff ON ${distortionAb.selfDiffPixels}px OFF ${distortionAb.offSelfDiffPixels}px camera changed=${distortionAb.camera?.changedPixels}px ${distortionAb.on} ${distortionAb.off} ${distortionAb.camera?.onPng ?? ''}`,
    );
    await restartReplayAfterHold(page, 'default distortion A/B');

    // --- Distortion obeys the paused-output policy in preview and camera -----
    await page.locator('[data-testid="pause-toggle"]').click();
    const distortionManualPause = await waitFor('distortion manual pause status', async () => {
      const status = await readStatus(page);
      return /paused manually/i.test(status.explanation) ? status : null;
    });
    await page.waitForTimeout(300);
    const distortionManualRun = await capturePausedCameraState(page, 'distortion-manual-pause', 'face distortion manual pause');
    assertAllPausedFrames(distortionManualRun.frames, 'face distortion manual pause');
    const distortionManualPng = assertPausedPng(distortionManualRun.frames, 'face distortion manual pause');
    await page.locator('[data-testid="pause-toggle"]').click();
    await waitForStatusTitle(page, /Effect active: Face distortion/);

    await page.locator('[data-testid="tracking-injection"]').selectOption('lost');
    const distortionLost = await waitFor('distortion tracking loss', async () => {
      const status = await readStatus(page);
      return /tracking was lost/i.test(status.explanation) ? status : null;
    });
    await page.waitForTimeout(300);
    const distortionLostRgb = await readRgb(page);
    assert.ok(rgbSum(distortionLostRgb) < 120, `tracking loss must hide the distortion, got ${JSON.stringify(distortionLostRgb)}`);
    const distortionLostRun = await capturePausedCameraState(page, 'distortion-tracking-lost', 'face distortion tracking loss');
    assertAllPausedFrames(distortionLostRun.frames, 'face distortion tracking loss');
    const distortionLostPng = assertPausedPng(distortionLostRun.frames, 'face distortion tracking loss');
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Face distortion/);

    await page.locator('[data-testid="tracking-injection"]').selectOption('multiple');
    const distortionMultiple = await waitFor('distortion multiple faces', async () => {
      const status = await readStatus(page);
      return /more than one face is visible/i.test(status.explanation) ? status : null;
    });
    await page.waitForTimeout(300);
    const distortionMultipleRgb = await readRgb(page);
    assert.ok(rgbSum(distortionMultipleRgb) < 120, `multiple faces must hide the distortion, got ${JSON.stringify(distortionMultipleRgb)}`);
    const distortionMultipleRun = await capturePausedCameraState(page, 'distortion-multiple-faces', 'face distortion multiple faces');
    assertAllPausedFrames(distortionMultipleRun.frames, 'face distortion multiple faces');
    const distortionMultiplePng = assertPausedPng(distortionMultipleRun.frames, 'face distortion multiple faces');
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Face distortion/);

    await page.locator('[data-testid="simulate-failure"]').check();
    const distortionInterrupted = await waitFor('distortion processing interruption', async () => {
      const status = await readStatus(page);
      return /simulated by the diagnostic control/i.test(status.explanation) ? status : null;
    });
    await page.waitForTimeout(300);
    const distortionInterruptedRgb = await readRgb(page);
    assert.ok(rgbSum(distortionInterruptedRgb) < 120, `a processing failure must hide the distortion, got ${JSON.stringify(distortionInterruptedRgb)}`);
    const distortionInterruptedRun = await capturePausedCameraState(page, 'distortion-processing-failure', 'face distortion processing failure');
    assertAllPausedFrames(distortionInterruptedRun.frames, 'face distortion processing failure');
    const distortionInterruptedPng = assertPausedPng(distortionInterruptedRun.frames, 'face distortion processing failure');
    await page.locator('[data-testid="simulate-failure"]').uncheck();
    await waitForStatusTitle(page, /Effect active: Face distortion/);
    const distortionRecovered = await readProcessedRgb(page, 'distortion recovered after processing failure');

    // Switching to an imported mask that is not already loaded paints the
    // paused output first (a cached mask switch is synchronous and does not);
    // switching back to the distortion renders it again. The distortion itself
    // needs no async asset load, so its switch is synchronous and cannot expose
    // a frame.
    const beforeDistortionSwitch = await readEffectDiagnostic(page);
    await page.locator('[data-testid="effect-select"]').selectOption(ROSE_VISOR_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Rose visor/);
    const afterDistortionSwitch = await readEffectDiagnostic(page);
    assert.ok(
      Number(afterDistortionSwitch.switchingPausedFrames) > Number(beforeDistortionSwitch.switchingPausedFrames),
      `switching from the distortion to an imported mask must paint the paused output: before=${beforeDistortionSwitch.switchingPausedFrames} after=${afterDistortionSwitch.switchingPausedFrames}`,
    );
    await selectEffectThroughControl(page, FACE_DISTORTION_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Face distortion/);
    const distortionAfterSwitchBack = await waitForDistortionActive(page, 'distortion after switching back');

    // --- WebGL context loss on the distortion renderer ----------------------
    // A real context loss must hide the whole output through the existing
    // 250 ms undrawable guard, not composite a stale/blank canvas and never
    // reveal the raw replay frame. The public control injects the failure with
    // WEBGL_lose_context; unchecking requests a browser restore.
    await page.locator('[data-testid="distortion-context-loss"]').check();
    const contextLostStatus = await waitFor(
      'distortion context-loss paused output',
      async () => {
        const status = await readStatus(page);
        return status.mode === 'paused' && /WebGL context|not drawable/i.test(status.explanation) ? status : null;
      },
      10000,
      100,
    );
    const contextLostDiagnostic = parseKeyValues(await readDiagnostic(page, 'diag-distortion'));
    assert.equal(contextLostDiagnostic.active, 'true', 'the distortion effect must stay selected during context loss');
    assert.equal(contextLostDiagnostic.drawable, 'false', 'a lost WebGL context must make the renderer non-drawable');
    assert.equal(contextLostDiagnostic.contextLost, 'true', 'the context-loss diagnostic must report the lost context');
    await page.waitForTimeout(300);
    const contextLostRgb = await readRgb(page);
    assert.ok(rgbSum(contextLostRgb) < 120, `a lost distortion context must hide the output, got ${JSON.stringify(contextLostRgb)}`);
    const contextLostRun = await capturePausedCameraState(page, 'distortion-context-lost', 'face distortion context loss');
    assertAllPausedFrames(contextLostRun.frames, 'face distortion context loss');
    const contextLostPng = assertPausedPng(contextLostRun.frames, 'face distortion context loss');
    await page.locator('[data-testid="distortion-context-loss"]').uncheck();
    const contextRestored = await waitFor(
      'distortion recovered after context restore',
      async () => {
        const status = await readStatus(page);
        if (status.mode !== 'render') return null;
        const distortion = await readDistortion(page);
        return distortion.drawable === 'true' && distortion.active === 'true' ? { status, distortion } : null;
      },
      20000,
      100,
    );
    const contextRestoredRgb = await readProcessedRgb(page, 'distortion recovered after context restore');
    evidence.distortion.contextLoss = {
      status: contextLostStatus,
      diagnostic: contextLostDiagnostic,
      preview: contextLostRgb,
      camera: averageFrameRgb(contextLostRun.frames),
      png: contextLostPng.png,
      recovered: { status: contextRestored.status, diagnostic: contextRestored.distortion, preview: contextRestoredRgb },
    };
    pass(
      'A lost face-distortion WebGL context hides the output in preview and camera instead of compositing a stale frame, and restoring the context resumes the effect',
      `paused=${JSON.stringify(contextLostStatus.explanation)} camera=${JSON.stringify(evidence.distortion.contextLoss.camera)} contextLost=${contextLostDiagnostic.contextLost} drawable=${contextLostDiagnostic.drawable} restoredDrawable=${contextRestored.distortion.drawable} ${contextLostPng.png}`,
    );

    // Disabling the effect (explicit No effect) hides the output instead of
    // passing the raw replay frame through.
    await page.locator('[data-testid="effect-select"]').selectOption('none');
    await waitForStatusTitle(page, /^Tracking paused$/);
    const distortionDisabled = await readStatus(page);
    assert.match(distortionDisabled.explanation, /No effect is active/i);
    await page.waitForTimeout(300);
    const distortionDisabledRgb = await readRgb(page);
    assert.ok(rgbSum(distortionDisabledRgb) < 120, `No effect must hide the distortion output, got ${JSON.stringify(distortionDisabledRgb)}`);
    const distortionDisabledRun = await capturePausedCameraState(page, 'distortion-no-effect', 'face distortion disabled');
    assertAllPausedFrames(distortionDisabledRun.frames, 'face distortion disabled');
    const distortionDisabledPng = assertPausedPng(distortionDisabledRun.frames, 'face distortion disabled');

    // Removing the active distortion package also falls back to the opaque
    // paused no-effect output in both paths.
    await selectEffectThroughControl(page, FACE_DISTORTION_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Face distortion/);
    await page.locator('[data-testid="remove-package"]').click();
    await waitFor('distortion removal result', async () => {
      const state = await page.locator('[data-testid="package-result"]').getAttribute('data-state');
      const text = ((await page.locator('[data-testid="package-result"]').textContent()) ?? '').trim();
      return state === 'success' && /Removed the imported effect/.test(text) ? text : null;
    });
    await waitForStatusTitle(page, /^Tracking paused$/);
    await page.waitForTimeout(300);
    const distortionRemovedRgb = await readRgb(page);
    assert.ok(rgbSum(distortionRemovedRgb) < 120, `removing the distortion must leave the paused output, got ${JSON.stringify(distortionRemovedRgb)}`);
    const distortionRemovedRun = await capturePausedCameraState(page, 'distortion-removed', 'face distortion removed');
    assertAllPausedFrames(distortionRemovedRun.frames, 'face distortion removed');
    const distortionRemovedPng = assertPausedPng(distortionRemovedRun.frames, 'face distortion removed');
    const optionsAfterDistortionRemoval = await effectOptionValues(page);
    assert.ok(!optionsAfterDistortionRemoval.includes(FACE_DISTORTION_EFFECT_ID), 'the removed distortion must leave the selector');
    const packagesAfterDistortionRemoval = parseKeyValues(await readDiagnostic(page, 'diag-packages'));
    assert.equal(
      packagesAfterDistortionRemoval.installed,
      '3',
      `the distortion removal must leave the other packages installed: ${JSON.stringify(packagesAfterDistortionRemoval)}`,
    );
    evidence.distortion.pausedOutput = {
      manualPause: {
        status: distortionManualPause,
        camera: averageFrameRgb(distortionManualRun.frames),
        png: distortionManualPng.png,
      },
      trackingLoss: {
        status: distortionLost,
        preview: distortionLostRgb,
        camera: averageFrameRgb(distortionLostRun.frames),
        png: distortionLostPng.png,
      },
      multipleFaces: {
        status: distortionMultiple,
        preview: distortionMultipleRgb,
        camera: averageFrameRgb(distortionMultipleRun.frames),
        png: distortionMultiplePng.png,
      },
      processingFailure: {
        status: distortionInterrupted,
        preview: distortionInterruptedRgb,
        camera: averageFrameRgb(distortionInterruptedRun.frames),
        png: distortionInterruptedPng.png,
        recovered: distortionRecovered,
      },
      switching: { before: beforeDistortionSwitch, afterMaskSwitch: afterDistortionSwitch, afterSwitchBack: distortionAfterSwitchBack },
      disabled: {
        status: distortionDisabled,
        preview: distortionDisabledRgb,
        camera: averageFrameRgb(distortionDisabledRun.frames),
        png: distortionDisabledPng.png,
      },
      removed: {
        preview: distortionRemovedRgb,
        camera: averageFrameRgb(distortionRemovedRun.frames),
        png: distortionRemovedPng.png,
      },
    };
    pass(
      'Face distortion obeys manual pause, tracking loss, multiple faces, processing failure, switching, no-effect and removal in preview and camera',
      `manual=${JSON.stringify(evidence.distortion.pausedOutput.manualPause.camera)} lost=${JSON.stringify(evidence.distortion.pausedOutput.trackingLoss.camera)} multiple=${JSON.stringify(evidence.distortion.pausedOutput.multipleFaces.camera)} failure=${JSON.stringify(evidence.distortion.pausedOutput.processingFailure.camera)} switchingPausedFrames=${afterDistortionSwitch.switchingPausedFrames}`,
    );

    // Baseline for the later complete-effect benchmark: a color-only package on
    // the same fixture and output path, so the distortion's added cost is
    // reported relative to an effect with no warp. Replay-derived only.
    await selectEffectThroughControl(page, VERDANT_TINT_EFFECT_ID);
    await page.waitForTimeout(2200);
    const treatmentFrameDelta = parseKeyValues(await readDiagnostic(page, 'diag-frame-delta'));
    const treatmentRenderCost = parseKeyValues(await readDiagnostic(page, 'diag-render-cost'));
    evidence.distortion.timingBaseline = {
      effect: VERDANT_TINT_EFFECT_ID,
      renderCostP95Ms: Number(treatmentRenderCost.p95Ms ?? 0),
      frameIntervalP95Ms: Number(treatmentFrameDelta.p95Ms ?? 0),
    };
    // The two 2.2 s sampling windows run sequentially, so the frame-interval
    // difference is an observed delta rather than an isolated causal cost. The
    // render-cost delta and the warp submission time are the attributable numbers.
    evidence.distortion.timing.observedRenderCostDeltaP95Ms = Number(
      (evidence.distortion.timing.renderCostP95Ms - evidence.distortion.timingBaseline.renderCostP95Ms).toFixed(2),
    );
    evidence.distortion.timing.observedFrameIntervalDeltaP95Ms = Number(
      (evidence.distortion.timing.frameIntervalP95Ms - evidence.distortion.timingBaseline.frameIntervalP95Ms).toFixed(2),
    );
    evidence.distortion.timing.frameIntervalNote =
      'Observed difference between sequential 2.2 s windows; not isolated and not attributed to the distortion. The warp submission time and the render-cost delta are the attributable main-thread numbers; the GPU cost is not measured.',
    evidence.distortion.timing.warpSubmissionNote =
      'costMsP95 is main-thread WebGL submission only (performance.now() around renderer.render() at 1280x720); there is no GPU sync or readback, so it is not the total warp cost.';
    pass(
      'Replay-based timing for the distortion path is recorded for the later complete-effect benchmark',
      `warp submission p95=${evidence.distortion.timing.warpSubmissionCostP95Ms}ms (main-thread only) render p95=${evidence.distortion.timing.renderCostP95Ms}ms baseline render p95=${evidence.distortion.timingBaseline.renderCostP95Ms}ms observed frame interval ${evidence.distortion.timing.frameIntervalP95Ms}ms vs ${evidence.distortion.timingBaseline.frameIntervalP95Ms}ms (sequential, not isolated)`,
    );

    // --- Negative imports keep the current effect and never crash ------------
    await selectEffectThroughControl(page, GUARD_VISOR_EFFECT_ID);
    for (const negative of NEGATIVE_PACKAGE_CASES) {
      const result = await importPackageThroughControl(app, page, path.join(PACKAGE_NEGATIVE_DIR, `${negative.name}.zip`));
      assert.equal(result.state, 'error', `${negative.name}: negative import must be rejected`);
      assert.ok(
        result.text.includes(negative.code),
        `${negative.name}: expected actionable code ${negative.code}, got: ${result.text}`,
      );
      assert.ok(result.text.length > 60, `${negative.name}: error feedback must be actionable`);
      const statusAfterReject = await readStatus(page);
      assert.equal(statusAfterReject.mode, 'render', `${negative.name}: a rejected import must not change the active output`);
      assert.match(statusAfterReject.title, /Effect active: Guard visor/);
      const rejectionMask = await readMask(page);
      const rejectionProbe = await readMaskProbe(page);
      const rejectionColour = parseKeyValues(await readDiagnostic(page, 'diag-mask-color'));
      assert.equal(rejectionMask.visible, 'true', `${negative.name}: the previous packaged mask must stay visible`);
      assert.ok(
        colorNear(rejectionColour, PACKAGE_MASK_RGB, 4),
        `${negative.name}: the previous packaged effect must keep rendering, got material colour ${JSON.stringify(rejectionColour)}`,
      );
      evidence.negative.push({
        name: negative.name,
        expectedCode: negative.code,
        message: result.text.slice(0, 400),
        maskVisible: rejectionMask.visible,
        maskProbe: rejectionProbe,
      });
    }
    await page.screenshot({ path: path.join(screenshotsDir, '25-package-import-error.png') });
    const afterNegatives = await readEffectDiagnostic(page);
    assert.equal(afterNegatives.id, GUARD_VISOR_EFFECT_ID);
    assert.equal(afterNegatives.error, 'no');
    pass(
      'Malformed, unsupported, unsafe and oversized packages are rejected with actionable feedback and no crash',
      `${NEGATIVE_PACKAGE_CASES.length} negative fixtures: ${NEGATIVE_PACKAGE_CASES.map((entry) => entry.code).join(', ')}`,
    );

    // --- Removal falls back to no-effect paused output -----------------------
    await page.locator('[data-testid="remove-package"]').click();
    const removalText = await waitFor('removal result', async () => {
      const state = await page.locator('[data-testid="package-result"]').getAttribute('data-state');
      const text = ((await page.locator('[data-testid="package-result"]').textContent()) ?? '').trim();
      return state === 'success' && /Removed the imported effect/.test(text) ? text : null;
    });
    const optionsAfterRemoval = await effectOptionValues(page);
    assert.ok(!optionsAfterRemoval.includes(GUARD_VISOR_EFFECT_ID), 'removed effect must leave the selector');
    assert.ok(optionsAfterRemoval.includes(VERDANT_TINT_EFFECT_ID), 'other imported effects must remain');
    await waitForStatusTitle(page, /^Tracking paused$/);
    await page.waitForTimeout(300);
    const removalStatus = await readStatus(page);
    assert.match(removalStatus.explanation, /No effect is active/i);
    const removalRgb = await readRgb(page);
    assert.ok(rgbSum(removalRgb) < 120, `removal must leave the opaque paused output, got ${JSON.stringify(removalRgb)}`);
    const removalRun = await captureCameraState(page, 'removed-package', 4);
    assertAllPausedFrames(removalRun.frames, 'removed imported package');
    const removalPng = assertPausedPng(removalRun.frames, 'removed imported package');
    const removalShot = await screenshotCanvas(page, '26-removed-package-paused.png');
    evidence.removal = {
      message: removalText,
      status: removalStatus,
      preview: removalRgb,
      camera: averageFrameRgb(removalRun.frames),
      png: removalPng.png,
      screenshot: removalShot,
    };
    pass(
      'Removing the active imported effect falls back to the no-effect opaque paused output in preview and camera',
      `${JSON.stringify(removalRgb)} camera=${JSON.stringify(evidence.removal.camera)} ${removalShot}`,
    );

    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);

    // --- Persistence across restart -----------------------------------------
    await closeApp(app);
    app = null;
    const relaunched = await launchApp(env);
    app = relaunched.app;
    page = relaunched.page;
    consoleErrors = relaunched.consoleErrors;
    await waitForTrackerModelReady(page);
    const persistedPackages = parseKeyValues(await readDiagnostic(page, 'diag-packages'));
    assert.equal(persistedPackages.installed, '2', `expected two persisted packages, got ${JSON.stringify(persistedPackages)}`);
    const persistedOptions = await effectOptionValues(page);
    assert.ok(persistedOptions.includes(VERDANT_TINT_EFFECT_ID), 'imported effect must survive an app restart');
    assert.ok(persistedOptions.includes(ROSE_VISOR_EFFECT_ID), 'the rose mask package must survive an app restart');
    assert.ok(!persistedOptions.includes(GUARD_VISOR_EFFECT_ID), 'removed effect must stay removed after restart');
    await waitFor('start enabled after restart', async () => {
      return (await page.locator('[data-testid="start"]').isDisabled()) ? null : true;
    }, 60000);
    await page.locator('[data-testid="start"]').click();
    await waitForTrackingPhase(page);
    await waitForVirtualCamera(page);
    await selectEffectThroughControl(page, VERDANT_TINT_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Verdant tint/);
    await page.waitForTimeout(350);
    const persistedRgb = await readProcessedRgb(page, 'persisted package preview');
    assert.ok(
      persistedRgb.g > persistedRgb.r + 8 && persistedRgb.g > persistedRgb.b + 8,
      `persisted package treatment must render after restart, got ${JSON.stringify(persistedRgb)}`,
    );
    const persistedRun = await captureProcessedCameraState(page, 'persisted-package', PROCESSED_CAMERA_FRAMES, persistedRgb, 'persisted package');
    const persistedPng = assertProcessedPng(persistedRun.frames, persistedRgb, 'persisted package');
    const persistedShot = await screenshotCanvas(page, '27-persisted-package-preview.png');
    evidence.persistence = {
      packages: persistedPackages,
      preview: persistedRgb,
      camera: averageFrameRgb(persistedRun.frames),
      png: persistedPng.png,
      screenshot: persistedShot,
    };
    pass(
      'An imported effect survives an app restart and renders through preview and camera',
      `installed=${persistedPackages.installed} preview=${JSON.stringify(persistedRgb)} ${persistedShot} ${persistedPng.png}`,
    );
    assert.deepEqual(consoleErrors, [], `renderer console errors after restart: ${consoleErrors.join(' | ')}`);
  } finally {
    if (app) await closeApp(app);
  }
  return evidence;
}

/**
 * Scenario J: a schema v3 imported package whose two ears and hair tuft are
 * spring-driven by recorded tracked head motion. Proves the public
 * import/select/preview/camera flow, bounded motion, post-turn settling, the
 * deliberate resets, the paused-output policy and replay-based timing.
 */
async function secondaryMotionScenario() {
  log('\n== Scenario J: imported packaged secondary motion (schema v3) ==');
  const motionMetadata = verifyFixtureManifest('pose-loop.json');
  const evidence = {
    states: {},
    motion: {},
    settle: {},
    loop: {},
    reacquisition: {},
    ab: {},
    paused: {},
    timing: {},
    negatives: [],
  };
  const packageDir = path.join(evidenceDir, 'secondary-motion-packages');
  mkdirSync(packageDir, { recursive: true });
  const env = {
    SHYMASK_EVIDENCE_DIR: evidenceDir,
    SHYMASK_FIXTURE_MANIFEST: 'pose-loop.json',
    SHYMASK_PACKAGE_DIR: packageDir,
  };
  const { app, page, consoleErrors } = await launchApp(env);
  try {
    await waitFor('secondary-motion fixture diagnostics', async () => {
      const text = await readDiagnostic(page, 'diag-fixture');
      return text.includes(motionMetadata.id) ? text : null;
    });
    await waitForTrackerModelReady(page);
    await page.locator('[data-testid="start"]').click();
    await waitForTrackingPhase(page);
    await waitForVirtualCamera(page);
    const initialPackages = parseKeyValues(await readDiagnostic(page, 'diag-packages'));
    assert.equal(initialPackages.installed, '0', 'the isolated store must start empty');

    // --- Import the schema v3 sample through the public control -------------
    const importResult = await importPackageThroughControl(
      app,
      page,
      path.join(PACKAGE_FIXTURES_DIR, 'reactive-ears.zip'),
    );
    assert.equal(importResult.state, 'success', `reactive-ears import must succeed: ${importResult.text}`);
    assert.match(importResult.text, /Imported "Reactive ears" v1\.0\.0/);
    assert.match(importResult.text, /3 movable part\(s\)/);
    const options = await effectOptionValues(page);
    assert.ok(options.includes(REACTIVE_EARS_EFFECT_ID), 'the imported secondary-motion effect must appear in the selector');
    const loaded = await waitForEffectLoaded(page, REACTIVE_EARS_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Reactive ears/);
    assert.equal(await page.locator('[data-testid="effect-select"]').inputValue(), REACTIVE_EARS_EFFECT_ID);
    assert.equal(loaded.source, 'package');
    assert.equal(loaded.mask, 'gltf');
    assert.equal(loaded.motion, '3');
    assert.equal(loaded.treatment, 'no');
    assert.equal(loaded.distortion, 'none');
    const preview = await waitForPackageMask(page, 'imported reactive ears', REACTIVE_EARS_RGB);
    const occlusion = parseKeyValues(await readDiagnostic(page, 'diag-occlusion'));
    assert.equal(occlusion.enabled, 'true', 'face occlusion must stay active for the movable mask');
    assert.equal(occlusion.vertices, '468');
    const previewRgb = await readProcessedRgb(page, 'imported reactive ears preview');
    const previewShot = await screenshotCanvas(page, '40-imported-reactive-ears-preview.png');
    const materialPng = await captureOutputThroughControl(page, '40b-reactive-ears-material.png');
    const materialPixels = pngColorCount(materialPng, REACTIVE_EARS_RGB, 28);
    assert.ok(
      materialPixels > 20000,
      `preview PNG must contain the reactive-ears material, found ${materialPixels} pixels (enforced >20,000)`,
    );
    const cameraRun = await captureProcessedCameraState(
      page,
      'reactive-ears',
      PROCESSED_CAMERA_FRAMES,
      previewRgb,
      'imported reactive ears',
    );
    const cameraPng = assertProcessedPng(cameraRun.frames, previewRgb, 'imported reactive ears');
    const cameraMaterialPixels = pngColorCount(cameraPng.png, REACTIVE_EARS_RGB, 28);
    assert.ok(
      cameraMaterialPixels > 20000,
      `camera PNG must contain the reactive-ears material, found ${cameraMaterialPixels} pixels (enforced >20,000)`,
    );
    const initialMotion = await readSecondaryMotion(page);
    assertSecondaryMotionBounds(initialMotion, 'imported reactive ears');
    assert.equal(initialMotion.parts, '3');
    assert.equal(initialMotion.names, 'ear-left,ear-right,hair-tuft');
    assert.equal(initialMotion.axes, 'y:yaw,y:yaw,x:pitch');
    evidence.states.imported = {
      importMessage: importResult.text,
      effect: loaded,
      mask: preview.mask,
      probe: preview.probe,
      occlusion,
      preview: previewRgb,
      previewMaterialPixels: materialPixels,
      previewPng: materialPng,
      screenshot: previewShot,
      camera: {
        rgb: averageFrameRgb(cameraRun.frames),
        png: cameraPng.png,
        materialPixels: cameraMaterialPixels,
      },
      motion: initialMotion,
    };
    pass(
      'A schema v3 secondary-motion package imports through the public control and renders in preview and camera',
      `effect=${REACTIVE_EARS_EFFECT_ID} parts=3 names=${initialMotion.names} previewMaterialPixels=${materialPixels} cameraMaterialPixels=${cameraMaterialPixels} ${previewShot} ${cameraPng.png}`,
    );

    // --- Recorded turns/nods: the parts move, bounded by their declarations --
    await page.evaluate((startSeconds) => {
      const video = document.querySelector('video');
      if (!video) throw new Error('expected a replay video element');
      video.currentTime = startSeconds;
    }, MOTION_WINDOW_START_SECONDS);
    await waitFor(
      'secondary-motion window media time',
      async () => {
        const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
        return Number(timestamp.mediaMs ?? 0) >= MOTION_WINDOW_START_MS ? timestamp : null;
      },
      15000,
      100,
    );
    await waitFor(
      'rendered output before secondary-motion sampling',
      async () => {
        const status = await readStatus(page);
        return status.mode === 'render' ? status : null;
      },
      15000,
      40,
    );
    const motionSamples = [];
    const motionShots = [];
    let previousMotionMediaMs = null;
    for (let index = 0; index < 18; index += 1) {
      await page.waitForTimeout(400);
      const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
      const mediaMs = Number(timestamp.mediaMs ?? 0);
      if (
        mediaMs > MOTION_WINDOW_END_MS ||
        (previousMotionMediaMs !== null && mediaMs < previousMotionMediaMs - LOOP_SEAM_THRESHOLD_MS)
      ) {
        break;
      }
      previousMotionMediaMs = mediaMs;
      const tracking = parseKeyValues(await readDiagnostic(page, 'diag-tracking'));
      if (tracking.phase !== 'tracking') continue;
      const motion = await readSecondaryMotion(page);
      if (motion.active !== 'true') continue;
      assertSecondaryMotionBounds(motion, `secondary-motion sample ${index}`);
      const angles = secondaryMotionAngleList(motion, 'angles');
      motionSamples.push({
        mediaMs,
        angles,
        maxAbsAngleDeg: Number(motion.maxAbsAngleDeg),
        headSpeedDegPerSec: Number(motion.headSpeedDegPerSec),
        resets: Number(motion.resets),
        lastReset: motion.lastReset,
      });
      if (index === 3 || index === 9 || index === 15) {
        motionShots.push(await screenshotCanvas(page, `40c-secondary-motion-${index}.png`));
      }
    }
    assert.ok(
      motionSamples.length >= 12,
      `expected most turn/nod window frames tracked with secondary motion, got ${motionSamples.length}/18`,
    );
    assert.ok(
      motionSamples.every((sample) => sample.mediaMs >= MOTION_WINDOW_START_MS && sample.mediaMs <= MOTION_WINDOW_END_MS),
      `secondary-motion samples must fall inside the documented window: ${motionSamples.map((sample) => sample.mediaMs).join(', ')}`,
    );
    const partRanges = [0, 1, 2].map((partIndex) =>
      spread(motionSamples.map((sample) => Number(sample.angles[partIndex] ?? 0))),
    );
    assert.ok(
      Math.max(...partRanges) >= 5,
      `recorded turns/nods must move the movable parts, per-part ranges=${partRanges.join(',')} degrees`,
    );
    assert.ok(
      partRanges.filter((range) => range >= 3).length >= 2,
      `at least two parts must move over the recorded window, per-part ranges=${partRanges.join(',')} degrees`,
    );
    const maxObservedAngle = Math.max(...motionSamples.map((sample) => sample.maxAbsAngleDeg));
    evidence.motion = {
      fixture: motionMetadata.id,
      windowStartSeconds: MOTION_WINDOW_START_SECONDS,
      windowSeconds: MOTION_WINDOW_SECONDS,
      windowStartMediaMs: MOTION_WINDOW_START_MS,
      windowEndMediaMs: MOTION_WINDOW_END_MS,
      trackedSamples: motionSamples.length,
      partRangesDeg: partRanges,
      maxObservedAngleDeg: maxObservedAngle,
      screenshots: motionShots,
      samples: motionSamples,
    };
    pass(
      'Recorded head turns and nods move the declared ears and hair tuft within their bounds',
      `tracked=${motionSamples.length}/18 part ranges=${partRanges.map((range) => range.toFixed(1)).join('/')} deg maxAngle=${maxObservedAngle.toFixed(2)} deg ${motionShots.join(' ')}`,
    );

    // --- Post-turn settling -------------------------------------------------
    // Documented window: the recorded turn peaks around 25.9 s; head angular
    // velocity drops after it while the underdamped spring is still moving, so
    // the angle decays toward rest instead of stopping with the head.
    await page.evaluate((startSeconds) => {
      const video = document.querySelector('video');
      if (!video) throw new Error('expected a replay video element');
      video.currentTime = startSeconds;
    }, POST_TURN_WINDOW_START_SECONDS);
    await waitFor(
      'post-turn window media time',
      async () => {
        const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
        return Number(timestamp.mediaMs ?? 0) >= POST_TURN_WINDOW_START_SECONDS * 1000 ? timestamp : null;
      },
      15000,
      100,
    );
    await waitFor(
      'rendered output before post-turn settling sampling',
      async () => {
        const status = await readStatus(page);
        return status.mode === 'render' ? status : null;
      },
      15000,
      40,
    );
    const settleSamples = [];
    let previousSettleMediaMs = null;
    const settleDeadline = Date.now() + POST_TURN_WINDOW_SECONDS * 1000;
    while (Date.now() < settleDeadline && settleSamples.length < 16) {
      await page.waitForTimeout(150);
      const timestamp = parseKeyValues(await readDiagnostic(page, 'diag-timestamp'));
      const mediaMs = Number(timestamp.mediaMs ?? 0);
      if (previousSettleMediaMs !== null && mediaMs === previousSettleMediaMs) continue;
      if (mediaMs < POST_TURN_WINDOW_START_SECONDS * 1000 || mediaMs > (POST_TURN_WINDOW_START_SECONDS + POST_TURN_WINDOW_SECONDS) * 1000) {
        break;
      }
      previousSettleMediaMs = mediaMs;
      const tracking = parseKeyValues(await readDiagnostic(page, 'diag-tracking'));
      if (tracking.phase !== 'tracking') continue;
      const motion = await readSecondaryMotion(page);
      if (motion.active !== 'true') continue;
      assertSecondaryMotionBounds(motion, `post-turn sample at ${mediaMs}`);
      settleSamples.push({
        mediaMs,
        angles: secondaryMotionAngleList(motion, 'angles'),
        maxAbsAngleDeg: Number(motion.maxAbsAngleDeg),
        headSpeedDegPerSec: Number(motion.headSpeedDegPerSec),
      });
    }
    assert.ok(settleSamples.length >= 8, `expected a dense post-turn sample window, got ${settleSamples.length} samples`);
    let peakIndex = 0;
    for (const [index, sample] of settleSamples.entries()) {
      if (sample.maxAbsAngleDeg > (settleSamples[peakIndex]?.maxAbsAngleDeg ?? 0)) peakIndex = index;
    }
    const peak = settleSamples[peakIndex];
    assert.ok(
      peak && peak.maxAbsAngleDeg >= 8,
      `the recorded turn must drive a visible part angle, peak=${peak?.maxAbsAngleDeg}`,
    );
    const afterPeak = settleSamples.slice(peakIndex + 1);
    const residual = afterPeak.find(
      (sample) => sample.headSpeedDegPerSec <= 20 && sample.maxAbsAngleDeg >= (peak?.maxAbsAngleDeg ?? 0) * 0.2 && sample.maxAbsAngleDeg >= 3,
    );
    const settled = afterPeak.find(
      (sample) => sample.headSpeedDegPerSec <= 20 && sample.maxAbsAngleDeg <= 3,
    );
    assert.ok(
      residual,
      `the spring must still be moving after the head angular velocity drops (peak=${peak?.maxAbsAngleDeg}, samples after peak=${JSON.stringify(afterPeak.map((sample) => [sample.maxAbsAngleDeg, sample.headSpeedDegPerSec]))})`,
    );
    assert.ok(
      settled,
      `the spring must reach a near-rest angle after the turn (peak=${peak?.maxAbsAngleDeg}, samples after peak=${JSON.stringify(afterPeak.map((sample) => [sample.maxAbsAngleDeg, sample.headSpeedDegPerSec]))})`,
    );
    // An underdamped spring oscillates around rest while it decays, and the
    // recorded person keeps producing small head motion later in the clip, so
    // this live window reports the residual and a near-rest sample rather than
    // asserting a monotonic tail. The deterministic held-frame settling gate
    // below is the strict post-turn decay evidence.
    evidence.settle = {
      windowStartSeconds: POST_TURN_WINDOW_START_SECONDS,
      windowSeconds: POST_TURN_WINDOW_SECONDS,
      peak: { mediaMs: peak?.mediaMs, maxAbsAngleDeg: peak?.maxAbsAngleDeg, headSpeedDegPerSec: peak?.headSpeedDegPerSec },
      residual: { mediaMs: residual.mediaMs, maxAbsAngleDeg: residual.maxAbsAngleDeg, headSpeedDegPerSec: residual.headSpeedDegPerSec },
      settled: { mediaMs: settled.mediaMs, maxAbsAngleDeg: settled.maxAbsAngleDeg, headSpeedDegPerSec: settled.headSpeedDegPerSec },
      settlingMs: settled.mediaMs - (peak?.mediaMs ?? 0),
      decayFraction: Number((settled.maxAbsAngleDeg / (peak?.maxAbsAngleDeg ?? 1)).toFixed(3)),
      samples: settleSamples,
    };
    pass(
      'The underdamped spring keeps moving after the recorded turn and settles toward rest',
      `peak=${peak?.maxAbsAngleDeg}deg at ${peak?.mediaMs}ms (head ${peak?.headSpeedDegPerSec}deg/s), residual=${residual.maxAbsAngleDeg}deg after head slowed to ${residual.headSpeedDegPerSec}deg/s, settled=${settled.maxAbsAngleDeg}deg at ${settled.mediaMs}ms (${settled.mediaMs - (peak?.mediaMs ?? 0)}ms after peak, ${(100 * settled.maxAbsAngleDeg / (peak?.maxAbsAngleDeg ?? 1)).toFixed(1)}% of peak)`,
    );

    // --- Loop boundary: deliberate reset, no unbounded motion --------------
    const seamsBefore = Number(parseKeyValues(await readDiagnostic(page, 'diag-loop')).seams ?? 0);
    const resetsBeforeLoop = Number((await readSecondaryMotion(page)).resets ?? 0);
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) throw new Error('expected a replay video element');
      video.currentTime = Math.max(0, video.duration - 1.2);
    });
    await waitFor(
      'loop seam for secondary-motion reset',
      async () => {
        const loop = parseKeyValues(await readDiagnostic(page, 'diag-loop'));
        return Number(loop.seams ?? 0) > seamsBefore ? loop : null;
      },
      20000,
      60,
    );
    const afterSeamMotion = await readSecondaryMotion(page);
    assertSecondaryMotionBounds(afterSeamMotion, 'after loop seam');
    assert.ok(
      Number(afterSeamMotion.resets) > resetsBeforeLoop,
      `a loop seam must deliberately reset the spring state (resets ${resetsBeforeLoop} -> ${afterSeamMotion.resets})`,
    );
    // The spring must start from rest after the seam rather than integrating the
    // pose jump as head velocity.
    const postSeamAngles = secondaryMotionAngleList(afterSeamMotion, 'angles');
    assert.ok(
      Math.max(...postSeamAngles.map((angle) => Math.abs(angle)), 0) <= 5,
      `the seam frame must start near rest, got angles ${afterSeamMotion.angles}`,
    );
    evidence.loop = {
      seamsBefore,
      seamsAfter: Number(parseKeyValues(await readDiagnostic(page, 'diag-loop')).seams ?? 0),
      resetsBefore: resetsBeforeLoop,
      resetsAfter: Number(afterSeamMotion.resets),
      motion: afterSeamMotion,
    };
    pass(
      'A replay loop seam resets the spring state instead of injecting a pose-jump impulse',
      `seams ${evidence.loop.seamsBefore}->${evidence.loop.seamsAfter} resets ${evidence.loop.resetsBefore}->${evidence.loop.resetsAfter} angles=${afterSeamMotion.angles}`,
    );

    // --- Reacquisition: paused output, reset, then bounded motion ----------
    const resetsBeforeLoss = Number((await readSecondaryMotion(page)).resets ?? 0);
    await page.locator('[data-testid="tracking-injection"]').selectOption('lost');
    const lossStatus = await waitFor('secondary-motion tracking loss', async () => {
      const status = await readStatus(page);
      return /tracking was lost/i.test(status.explanation) ? status : null;
    });
    assert.equal(lossStatus.mode, 'paused');
    await page.waitForTimeout(300);
    const lostMotion = await readSecondaryMotion(page);
    assert.ok(
      Number(lostMotion.resets) > resetsBeforeLoss,
      `tracking loss must reset the spring state (resets ${resetsBeforeLoss} -> ${lostMotion.resets})`,
    );
    assert.ok(
      secondaryMotionAngleList(lostMotion, 'angles').every((angle) => Math.abs(angle) < 1e-9),
      `the reset pose must be the authored rest orientation, got ${lostMotion.angles}`,
    );
    const lostRgb = await readRgb(page);
    assert.ok(rgbSum(lostRgb) < 120, `tracking loss must hide the secondary-motion effect, got ${JSON.stringify(lostRgb)}`);
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Reactive ears/);
    await waitForTrackingPhase(page);
    const recoveredRgb = await readProcessedRgb(page, 'secondary-motion recovered output');
    const recoveryMotion = await readSecondaryMotion(page);
    assertSecondaryMotionBounds(recoveryMotion, 'reacquisition');
    evidence.reacquisition = {
      status: lossStatus,
      lostRgb,
      lostMotion,
      recoveredRgb,
      recoveryMotion,
    };
    pass(
      'Tracking loss resets the spring and hides the effect; reacquisition resumes from rest without an impulse',
      `paused=${JSON.stringify(lostRgb)} resets=${lostMotion.resets} recovered=${JSON.stringify(recoveredRgb)} recoveryAngle=${recoveryMotion.maxAbsAngleDeg}deg`,
    );

    // --- Published-output A/B on a held post-turn frame ---------------------
    await holdRenderedFrameAt(page, SECONDARY_MOTION_AB_CAPTURE_SECONDS, 'secondary motion A/B');
    const ab = await secondaryMotionAbEvidence(page, '40d-secondary-motion', { captureCamera: true });
    evidence.ab = { captureSeconds: SECONDARY_MOTION_AB_CAPTURE_SECONDS, ...ab };
    pass(
      'The published preview and camera contain the simulated movable-part angle (ON vs authored rest OFF on a held frame)',
      `held=${SECONDARY_MOTION_AB_CAPTURE_SECONDS}s angle=${ab.heldAngleDeg}deg changed=${ab.changedPixels}px onMask=${ab.changedOnMaskPixels}px self-diff ON ${ab.selfDiffPixels}px OFF ${ab.offSelfDiffPixels}px camera=${ab.camera?.changedPixels}px ${ab.on} ${ab.off} ${ab.camera?.onPng ?? ''}`,
    );
    // --- Deterministic held-frame settling ---------------------------------
    // The replay stays held at the documented post-turn frame, so the accepted
    // head pose is stationary. The diagnostic settle control then advances the
    // same spring simulator with that constant pose: the retained post-turn
    // angle must decay toward rest without a synthetic reset or impulse.
    const heldBeforeSettle = await readSecondaryMotion(page);
    assertSecondaryMotionBounds(heldBeforeSettle, 'held before settling');
    assert.equal(heldBeforeSettle.settling, 'false');
    const settleStartAngle = Number(heldBeforeSettle.maxAbsAngleDeg);
    assert.ok(settleStartAngle >= 8, `the held post-turn angle must be visible before settling, got ${settleStartAngle}`);
    await page.locator('[data-testid="secondary-motion-settle"]').check();
    await page.waitForTimeout(100);
    const settleRunning = await readSecondaryMotion(page);
    assert.equal(settleRunning.settling, 'true', 'the held-frame settle control must advance the simulator');
    const heldSettleSamples = [];
    const settleShots = [];
    const heldSettleStart = Date.now();
    for (let index = 0; index < 24; index += 1) {
      await page.waitForTimeout(100);
      const motion = await readSecondaryMotion(page);
      assertSecondaryMotionBounds(motion, `held settle sample ${index}`);
      const elapsedMs = Date.now() - heldSettleStart;
      heldSettleSamples.push({
        elapsedMs,
        maxAbsAngleDeg: Number(motion.maxAbsAngleDeg),
        angles: secondaryMotionAngleList(motion, 'angles'),
        updates: Number(motion.updates),
      });
      if (index === 5 || index === 17) {
        settleShots.push(await screenshotCanvas(page, `40g-secondary-motion-settle-${index}.png`));
      }
    }
    const finalSettle = heldSettleSamples[heldSettleSamples.length - 1];
    const minAfterOneSecond = Math.min(
      ...heldSettleSamples
        .filter((sample) => sample.elapsedMs >= 1000)
        .map((sample) => sample.maxAbsAngleDeg),
    );
    assert.ok(
      Number(finalSettle?.updates) > Number(heldBeforeSettle.updates),
      'the held settle window must advance the spring simulation',
    );
    assert.ok(
      Number(finalSettle?.maxAbsAngleDeg) <= 2.5,
      `the held spring must settle toward rest, final max angle=${finalSettle?.maxAbsAngleDeg} from ${settleStartAngle}`,
    );
    assert.ok(
      Number(finalSettle?.maxAbsAngleDeg) <= settleStartAngle * 0.2,
      `the held spring must decay to <=20% of its retained angle, final=${finalSettle?.maxAbsAngleDeg} start=${settleStartAngle}`,
    );
    assert.ok(
      minAfterOneSecond <= 2.5,
      `the held spring must reach a near-rest angle after one second, minimum=${minAfterOneSecond}`,
    );
    await page.locator('[data-testid="secondary-motion-settle"]').uncheck();
    await page.waitForTimeout(200);
    const settleStopped = await readSecondaryMotion(page);
    assert.equal(settleStopped.settling, 'false', 'unchecking the settle control must stop the held simulation');
    evidence.heldSettle = {
      heldFrameSeconds: SECONDARY_MOTION_AB_CAPTURE_SECONDS,
      startAngleDeg: settleStartAngle,
      finalAngleDeg: finalSettle?.maxAbsAngleDeg,
      minAfterOneSecondDeg: minAfterOneSecond,
      decayFraction: Number(((finalSettle?.maxAbsAngleDeg ?? 0) / settleStartAngle).toFixed(3)),
      screenshots: settleShots,
      samples: heldSettleSamples,
    };
    pass(
      'A held post-turn frame settles from its retained angle toward rest through the same bounded simulator',
      `held=${SECONDARY_MOTION_AB_CAPTURE_SECONDS}s start=${settleStartAngle}deg final=${finalSettle?.maxAbsAngleDeg}deg after ${finalSettle?.elapsedMs}ms (${(100 * (finalSettle?.maxAbsAngleDeg ?? 0) / settleStartAngle).toFixed(1)}% of retained), min after 1s=${minAfterOneSecond}deg ${settleShots.join(' ')}`,
    );
    await restartReplayAfterHold(page, 'secondary motion A/B', motionMetadata.id);
    await waitForStatusTitle(page, /Effect active: Reactive ears/);

    // --- Paused-output policy ----------------------------------------------
    await page.locator('[data-testid="pause-toggle"]').click();
    const manualPause = await waitFor('secondary-motion manual pause', async () => {
      const status = await readStatus(page);
      return /paused manually/i.test(status.explanation) ? status : null;
    });
    await page.waitForTimeout(300);
    const manualRun = await capturePausedCameraState(page, 'secondary-motion-manual-pause', 'secondary motion manual pause');
    assertAllPausedFrames(manualRun.frames, 'secondary motion manual pause');
    const manualPng = assertPausedPng(manualRun.frames, 'secondary motion manual pause');
    await page.locator('[data-testid="pause-toggle"]').click();
    await waitForStatusTitle(page, /Effect active: Reactive ears/);

    await page.locator('[data-testid="tracking-injection"]').selectOption('lost');
    const lostPaused = await waitFor('secondary-motion paused tracking loss', async () => {
      const status = await readStatus(page);
      return /tracking was lost/i.test(status.explanation) ? status : null;
    });
    await page.waitForTimeout(300);
    const lostRun = await capturePausedCameraState(page, 'secondary-motion-tracking-lost', 'secondary motion tracking loss');
    assertAllPausedFrames(lostRun.frames, 'secondary motion tracking loss');
    const lostPng = assertPausedPng(lostRun.frames, 'secondary motion tracking loss');
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Reactive ears/);

    await page.locator('[data-testid="tracking-injection"]').selectOption('multiple');
    const multiplePaused = await waitFor('secondary-motion multiple faces', async () => {
      const status = await readStatus(page);
      return /more than one face is visible/i.test(status.explanation) ? status : null;
    });
    await page.waitForTimeout(300);
    const multipleRgb = await readRgb(page);
    assert.ok(rgbSum(multipleRgb) < 120, `multiple faces must hide the secondary-motion effect, got ${JSON.stringify(multipleRgb)}`);
    await page.locator('[data-testid="tracking-injection"]').selectOption('auto');
    await waitForStatusTitle(page, /Effect active: Reactive ears/);

    await page.locator('[data-testid="simulate-failure"]').check();
    const processingPaused = await waitFor('secondary-motion processing failure', async () => {
      const status = await readStatus(page);
      return /simulated by the diagnostic control/i.test(status.explanation) ? status : null;
    });
    await page.waitForTimeout(300);
    const processingRun = await capturePausedCameraState(page, 'secondary-motion-processing-failure', 'secondary motion processing failure');
    assertAllPausedFrames(processingRun.frames, 'secondary motion processing failure');
    const processingPng = assertPausedPng(processingRun.frames, 'secondary motion processing failure');
    await page.locator('[data-testid="simulate-failure"]').uncheck();
    await waitForStatusTitle(page, /Effect active: Reactive ears/);

    // Importing a package auto-selects it and therefore crosses the async
    // switch: the output must be the opaque paused screen while the new mask
    // loads. Returning to the already-loaded movable mask is then synchronous.
    const beforeSwitch = await readEffectDiagnostic(page);
    const guardImport = await importPackageThroughControl(app, page, path.join(PACKAGE_FIXTURES_DIR, 'guard-visor.zip'));
    assert.equal(guardImport.state, 'success', `guard-visor import must succeed: ${guardImport.text}`);
    await waitForEffectLoaded(page, GUARD_VISOR_EFFECT_ID);
    const afterSwitch = await readEffectDiagnostic(page);
    assert.ok(
      Number(afterSwitch.switchingPausedFrames) > Number(beforeSwitch.switchingPausedFrames),
      `an async package switch must paint the paused output first: before=${beforeSwitch.switchingPausedFrames} after=${afterSwitch.switchingPausedFrames}`,
    );
    await selectEffectThroughControl(page, REACTIVE_EARS_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Reactive ears/);

    await page.locator('[data-testid="effect-select"]').selectOption('none');
    await waitForStatusTitle(page, /^Tracking paused$/);
    const noEffectStatus = await readStatus(page);
    assert.match(noEffectStatus.explanation, /No effect is active/i);
    await page.waitForTimeout(300);
    const noEffectRgb = await readRgb(page);
    assert.ok(rgbSum(noEffectRgb) < 120, `No effect must hide the secondary-motion output, got ${JSON.stringify(noEffectRgb)}`);
    const noEffectShot = await screenshotCanvas(page, '40e-secondary-motion-no-effect.png');
    await selectEffectThroughControl(page, REACTIVE_EARS_EFFECT_ID);
    await waitForStatusTitle(page, /Effect active: Reactive ears/);

    evidence.paused = {
      manualPause: {
        status: manualPause,
        camera: averageFrameRgb(manualRun.frames),
        png: manualPng.png,
      },
      trackingLoss: {
        status: lostPaused,
        camera: averageFrameRgb(lostRun.frames),
        png: lostPng.png,
      },
      multipleFaces: { status: multiplePaused, preview: multipleRgb },
      processingFailure: {
        status: processingPaused,
        camera: averageFrameRgb(processingRun.frames),
        png: processingPng.png,
      },
      switching: { before: beforeSwitch, after: afterSwitch },
      noEffect: { status: noEffectStatus, preview: noEffectRgb, screenshot: noEffectShot },
    };
    pass(
      'Secondary motion obeys manual pause, tracking loss, multiple faces, processing failure, switching and no-effect',
      `manual=${JSON.stringify(evidence.paused.manualPause.camera)} lost=${JSON.stringify(evidence.paused.trackingLoss.camera)} multiple=${JSON.stringify(multipleRgb)} failure=${JSON.stringify(evidence.paused.processingFailure.camera)} switchingPausedFrames=${afterSwitch.switchingPausedFrames}`,
    );

    // --- Replay-based added workload ---------------------------------------
    await page.waitForTimeout(2200);
    const onMotion = await readSecondaryMotion(page);
    const onRender = parseKeyValues(await readDiagnostic(page, 'diag-render-cost'));
    const onFrame = parseKeyValues(await readDiagnostic(page, 'diag-frame-delta'));
    await page.locator('[data-testid="secondary-motion-toggle"]').uncheck();
    await page.waitForTimeout(2200);
    const offRender = parseKeyValues(await readDiagnostic(page, 'diag-render-cost'));
    const offFrame = parseKeyValues(await readDiagnostic(page, 'diag-frame-delta'));
    await page.locator('[data-testid="secondary-motion-toggle"]').check();
    await page.waitForTimeout(300);
    evidence.timing = {
      simulationCostP95Ms: Number(onMotion.costMsP95),
      simulationCostLastMs: Number(onMotion.costMsLast),
      renderCostP95MsOn: Number(onRender.p95Ms ?? 0),
      renderCostP95MsRest: Number(offRender.p95Ms ?? 0),
      frameIntervalP95MsOn: Number(onFrame.p95Ms ?? 0),
      frameIntervalP95MsRest: Number(offFrame.p95Ms ?? 0),
      observedRenderCostDeltaP95Ms: Number((Number(onRender.p95Ms ?? 0) - Number(offRender.p95Ms ?? 0)).toFixed(2)),
      observedFrameIntervalDeltaP95Ms: Number((Number(onFrame.p95Ms ?? 0) - Number(offFrame.p95Ms ?? 0)).toFixed(2)),
      note:
        'Replay-derived, development desktop, sequential 2.2 s windows with the same mask and playback; the diagnostic OFF state still runs the simulator but draws the authored rest pose, so the render/frame differences are observed run variation, not an isolated simulation cost. The simulation p95 is the pure spring update around the accepted pose. Not the final benchmark or a performance target.',
    };
    pass(
      'Replay-based secondary-motion simulation and render workload is recorded for the later complete-effect benchmark',
      `simulation p95=${evidence.timing.simulationCostP95Ms}ms render p95=${evidence.timing.renderCostP95MsOn}ms vs rest ${evidence.timing.renderCostP95MsRest}ms frame interval ${evidence.timing.frameIntervalP95MsOn}ms vs ${evidence.timing.frameIntervalP95MsRest}ms (sequential, not isolated)`,
    );

    // --- Negative motion declarations keep the current effect --------------
    await selectEffectThroughControl(page, REACTIVE_EARS_EFFECT_ID);
    const secondaryNegatives = NEGATIVE_PACKAGE_CASES.filter((entry) => entry.name.startsWith('secondary-motion-'));
    for (const negative of secondaryNegatives) {
      const result = await importPackageThroughControl(
        app,
        page,
        path.join(PACKAGE_NEGATIVE_DIR, `${negative.name}.zip`),
      );
      assert.equal(result.state, 'error', `${negative.name}: negative import must be rejected`);
      assert.ok(
        result.text.includes(negative.code),
        `${negative.name}: expected actionable code ${negative.code}, got: ${result.text}`,
      );
      assert.ok(result.text.length > 60, `${negative.name}: error feedback must be actionable`);
      const statusAfterReject = await readStatus(page);
      assert.equal(statusAfterReject.mode, 'render', `${negative.name}: a rejected import must not change the active output`);
      assert.match(statusAfterReject.title, /Effect active: Reactive ears/);
      const rejectionMask = await readMask(page);
      assert.equal(rejectionMask.visible, 'true', `${negative.name}: the previous movable mask must stay visible`);
      const rejectionMotion = await readSecondaryMotion(page);
      assertSecondaryMotionBounds(rejectionMotion, `${negative.name} rejection`);
      evidence.negatives.push({
        name: negative.name,
        expectedCode: negative.code,
        message: result.text.slice(0, 400),
        maskVisible: rejectionMask.visible,
        motion: rejectionMotion,
      });
    }
    await page.screenshot({ path: path.join(screenshotsDir, '40f-secondary-motion-import-error.png') });
    pass(
      'Unsupported and invalid secondary-motion declarations are rejected with actionable feedback and keep the current effect',
      `${secondaryNegatives.length} negative fixtures: ${secondaryNegatives.map((entry) => entry.code).join(', ')}`,
    );

    // --- Removal falls back to the opaque no-effect output -----------------
    await page.locator('[data-testid="remove-package"]').click();
    await waitFor('secondary-motion removal result', async () => {
      const state = await page.locator('[data-testid="package-result"]').getAttribute('data-state');
      const text = ((await page.locator('[data-testid="package-result"]').textContent()) ?? '').trim();
      return state === 'success' && /Removed the imported effect/.test(text) ? text : null;
    });
    await waitForStatusTitle(page, /^Tracking paused$/);
    await page.waitForTimeout(300);
    const removalRgb = await readRgb(page);
    assert.ok(rgbSum(removalRgb) < 120, `removal must leave the opaque paused output, got ${JSON.stringify(removalRgb)}`);
    const removalOptions = await effectOptionValues(page);
    assert.ok(!removalOptions.includes(REACTIVE_EARS_EFFECT_ID), 'the removed secondary-motion effect must leave the selector');
    evidence.removed = { preview: removalRgb, options: removalOptions };
    pass(
      'Removing the active secondary-motion package falls back to the no-effect opaque paused output',
      `${JSON.stringify(removalRgb)} remaining=${removalOptions.filter((id) => id.startsWith('package:')).join(',')}`,
    );

    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    await closeApp(app);
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
  verifyPackageFixtures();
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
  const effectPackages = await effectPackageScenario();
  const secondaryMotion = await secondaryMotionScenario();
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
        occlusionCaptureSeconds: OCCLUSION_CAPTURE_SECONDS,
        occlusionOppositeCaptureSeconds: OCCLUSION_CAPTURE_SECONDS_OPPOSITE,
        postTurnWindowStartSeconds: POST_TURN_WINDOW_START_SECONDS,
        postTurnWindowSeconds: POST_TURN_WINDOW_SECONDS,
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
      'Mask placement/orientation is derived from the MediaPipe facial transformation matrix using its documented 63 degree vertical-FOV camera assumption; it is a rigid attachment.',
      'Face occlusion renders a depth-only copy of MediaPipe\'s 468-vertex canonical face model (898 triangles) with the same tracked matrix into the mask scene; mask fragments behind the reconstructed face fail the depth test and the underlying video shows through. The occluder is the canonical face surface only: it has no hair, ears, neck or full head silhouette.',
      'Occlusion A/B evidence holds two documented recorded side-view frames (47.7 s, yaw about -22 deg, and 16.0 s, yaw in the opposite direction) via the diagnostic Hold replay frame control and captures exact 1280x720 output PNGs through the public Capture control. The held canvas is deterministic: ON and OFF are each captured twice and the two same-state captures must be pixel-identical. Each A/B requires at least 88% of changed pixels inside the tracked face axis-aligned bounding box and at least 1,500 removed mask pixels inside it.',
      'The occlusion ON frame is also proved to reveal non-mask content where the OFF frame drew mask material: for an imported package the changed face-box pixels are at least 97% the exact unlit material colour in OFF and at most 3% that colour in ON; for the bundled lit mask the dominant exact OFF-frame mask colours (top 64 shades, at least 90% of changed pixels) must not reappear in the ON frame at those pixels (at most 1%). The ON changed pixels must also pass a plausible-video floor (mean luminance >= 30, luminance stddev >= 6, <= 10% near-black, >= 16 distinct colours), and for the untreated bundled mask and rose package at least 90% of sampled ON pixels must match the held replay frame drawn at the pipeline scale. This proves mask material is removed and plausible video is revealed; it is not an exact-colour proof of identity.',
      'Raw and smoothed pose jitter are measured over the same presented frames in the initial slow segment of the recorded window. The segment\'s motion is measured, not assumed: its pose span and the filter p50 gain are reported, and it is required to stay within 10 deg yaw/pitch, 5 deg roll, 30 px origin and p50 alpha <= 0.4. Across the full turn/nod/lean window the reported p95 raw-vs-smoothed offset and the filter\'s implied constant-velocity delay measure the added lag.',
      'Camera capture attempts and their app-published/native-fallback frame counts are recorded in virtualCamera.captureAttempts. Processed captures request 8 consumer frames (10 for the motion-window capture) because the native source starts each consumer stream with an empty frame cache; captureProcessedCameraState retries up to 3 times and the final attempt still fails on a persistent fallback.',
      'Sliding is bounded, not corrected: it is quantified over the motion window as the p95 deviation of the projected mask origin from its median offset to the tracked face-box centre (bound 24 px, reported as a fraction of face width), plus the raw origin-to-face-centre offset p95 (bound 60 px). The same documented window is sampled again through the public Pose smoothing raw mode; the raw-mode sliding value is reported without asserting it. Observed rendered ~12-16 px vs raw-mode ~9-13 px (earlier runs up to ~20 px rendered), so smoothing did not reduce this proxy metric. The face-box centre shifts under yaw, so this bounded proxy metric is not a ground-truth surface-distance measurement and no correction is claimed. Clipping is quantified as the mask pixels removed inside the face bounding box by the occluder in each A/B (at least 1,500 px).',
      'Smoothing is a bounded exponential filter (base gain 0.45 at rest, rising toward 1 as measured face speed approaches 360 deg/s or 60 cm/s) with hard 4 cm / 8 degree lag caps. The 0.45 gain is normalized to the 41.67 ms reference interval, so the effective alpha at the observed ~35 ms interval is about 0.34 and the measured ramp lag is about 61 ms; the 50.9 ms reference-interval figure is not a global maximum. It is not a prediction filter and the recorded frames are replay input.',
      'Tracking-loss, multiple-face and unreliable-tracking policy states in Scenario F are produced by the labelled diagnostic injection control; the real detector path is used for the normal tracking and recorded-motion states. The recorded-motion clip is real recorded video from a second CC0 fixture, positioned by seeking to a documented window.',
      'Effect-package evidence uses an isolated SHYMASK_PACKAGE_DIR and stubs only the Electron OS file picker in the main process; validation, archive safety checks, storage, asset protocol loading and GLTFLoader parsing are the real paths. A rejected dialog cancellation is not exercised.',
      'The sample packages are committed generated fixtures (deterministic GLB writer + `npm run build:packages`), not Blender output; the contract and validator are what the later Blender/AI authoring slice will use.',
      'Package complexity measurements (triangles, meshes, materials, bytes) are reported for the later budget slice; they are not final complexity budgets and nothing here asserts an unmeasured threshold.',
      'Face distortion is a fixed radial shader (bulge/pinch) applied to the replay frame inside an ellipse computed from the tracked face box. The warp centre and radius are recalculated every processed frame; the public diag-distortion diagnostic reports the ellipse and a 64x36 identity-versus-warped comparison of the same uploaded frame texture (so the outside-ellipse delta is zero apart from GPU rounding). That warp-delta number is a diagnostic, not published-output proof. The published-output proof is a separate public A/B: a documented frame is held, the diagnostic Warp toggle keeps the effect selected but draws the same uploaded frame through the identity shader, and exact 1280x720 PNGs captured through the public Capture control must differ substantially inside the independent diag-face-derived ellipse, be ~0 outside it, be pixel-identical for same-state repeats, and the independent camera must receive the identical change. The A/B is repeated at a second documented held pose with a different face position and the changed-region centroid must move with the face (at least 40 px and at least 50% of the face-box movement). The ellipses overlap, so the centroid gate - not ellipse containment - is what excludes a fixed overlay. A dropped warp makes ON==OFF and fails; the identity pass still comes from the effect renderer canvas, so this is not raw-element passthrough. The A/B proves a localized published change and a face-relative changed-region centroid; it is not a measurement of the radial displacement kernel, and OFF provenance rests on the effect-selection assertions and code path.',
      'Face-distortion timing is replay-derived. costMsP95 is only the main-thread WebGL submission time around renderer.render() for the 1280x720 warp pass, with no GPU sync or readback, so the GPU cost lands later in the composite and is not included. diag-render-cost p95 includes the composite and diagnostic sampling; the baseline is a color-only package on the same fixture and output path. The render-cost and frame-interval deltas are sequential-window observations, not isolated distortion costs. These are observations for the later complete-effect benchmark, not a performance target.',
      'A lost WebGL context on the distortion renderer marks it non-drawable, so the processed-frame path returns false, the existing 250 ms undrawable guard hides the whole output in preview and camera, and no stale or raw frame is published. The public context-loss control injects the loss with WEBGL_lose_context and requests a browser restore; three.js re-initialises on restore and the effect resumes. Actual driver/GPU resets outside this injection are not reproduced, and a context that the browser refuses to restore stays hidden until the tracker renderer is rebuilt.',
      'Secondary motion is a fixed, bounded spring simulation per declared GLB node: a 120 Hz fixed sub-step, dt clamped to 250 ms, angles hard-clamped to maxAngleDeg, and deliberate resets (first sample, gap, pose discontinuity, loop seam, tracking reacquisition) that start from the authored rest pose instead of injecting an impulse. It is driven by the accepted tracked head angular velocity, not a canned clip. It is not strand-level hair simulation, does not convert arbitrary Blender physics, and does not use GPU cloth/bone simulation; each part is one rigid node rotating about one local axis.',
      'The secondary-motion A/B holds a documented post-turn frame (47.7 s on pose-loop-v1) and compares the simulated part angles with the authored rest pose through the public diagnostic toggle; the effect stays selected and every paused-output rule still applies. The held frame keeps the last simulated angle (the hold resample does not advance the spring), so the A/B is not a live-motion capture. Motion itself is evidenced by the recorded 8 s turn/nod window and the post-turn settling window on the same clip, plus saved screenshots. The independent camera receives the identical A/B change; continuous moving camera evidence is not asserted.',
      'Post-turn settling is measured on a documented recorded window around 25.9 s where a real head turn is followed by low head angular velocity; the peak, residual motion and decay to rest are reported from the public diagnostics. It is replay-based and does not establish physical-camera or live-human behavior.',
    ],
    commands: {
      build: 'npm run build',
      buildFaceOccluder: 'npm run build:face-occluder',
      buildNative: 'npm run build:native',
      buildPackages: 'npm run build:packages',
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
        'bundled procedural low-poly helmet/visor attached to the face facial transformation matrix; MediaPipe 63 degree vertical FOV camera; a depth-only canonical face occluder in the same scene hides mask fragments behind the tracked face',
      occlusion: {
        approach:
          'depth-only canonical MediaPipe face mesh rendered first with the same tracked facial transformation matrix; colorWrite=false, depthWrite=true; applies to bundled and imported package masks because both live under the same mask group',
        vertices: 468,
        triangles: 898,
        source: 'MediaPipe face_geometry canonical_face_model.obj (Apache-2.0), committed via npm run build:face-occluder',
        evidence: recordedMotion.occlusion,
      },
      poseSmoothing: {
        approach:
          'bounded exponential pose filter: base gain 0.45 at rest, adaptive gain toward 1 by measured speed, hard 4 cm / 8 degree lag caps; quaternion rotation smoothing with shortest-arc slerp',
        baseAlpha: 0.45,
        referenceFrameMs: Number((1000 / 24).toFixed(2)),
        referenceRampLagMs: Number((((1 - 0.45) / 0.45) * (1000 / 24)).toFixed(1)),
        evidence: recordedMotion.smoothing,
      },
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
    effectPackages: {
      contract: {
        schemaVersion: 3,
        supportedSchemaVersions: [1, 2, 3],
        shape: 'ZIP with a root manifest.json (schemaVersion 1, 2 or 3) and declared assets under assets/; mask (self-contained GLB + face attachment), declarative color treatment, a bounded faceDistortion (schema v2) and/or bounded secondaryMotion movable parts (schema v3); one complete effect selected at a time.',
        faceDistortion: {
          modes: ['bulge', 'pinch'],
          bounds: {
            strength: [0, 1],
            radiusScale: [0.25, 2.5],
            centerOffset: [-0.5, 0.5],
            maxWarpFactor: 0.75,
          },
          shape: 'Applied by a fixed radial shader inside an ellipse computed from the tracked face box; the package cannot supply geometry, shader code or per-frame displacement.',
        },
        unsupported: [
          'arbitrary executable/script content (rejected)',
          'expression reactions and other declared behaviors (reserved; non-empty declarations rejected)',
          'glTF animations, skins, cameras, lights and external resources (rejected)',
          'faceDistortion in a schema v1 manifest (rejected; raise schemaVersion to 2)',
          'secondaryMotion in a schema v1 or v2 manifest (rejected; raise schemaVersion to 3)',
          'moving-part declarations with an unknown node, axis, drive, field, duplicate node, >4 parts or out-of-range spring parameters (rejected as secondary-motion-invalid)',
          'distortion modes, strengths, radii or offsets outside the documented bounds (rejected as distortion-invalid)',
          'stacking multiple complete effects (no UI)',
        ],
      },
      validationCodes: NEGATIVE_PACKAGE_CASES.map((entry) => entry.code),
      negativeFixtures: effectPackages.negative,
      faceDistortion: {
        sample: 'fixtures/packages/face-distortion.zip (schema v2, distortion-only)',
        evidence: effectPackages.distortion,
        motionFollowing: recordedMotion.distortion,
        timingBasis:
          'replay-derived main-thread measurements on the development desktop; the warp submission cost is performance.now() around renderer.render() only (no GPU sync/readback), the render cost includes the composite, and the baseline is a color-only package on the same fixture. The render/frame-interval deltas are sequential-window observations. Not the final benchmark or a performance target.',
      },
      evidence: effectPackages,
    },
    secondaryMotion: {
      contract: {
        schemaVersion: 3,
        supportedSchemaVersions: [1, 2, 3],
        shape:
          'A schema v3 mask may declare secondaryMotion.parts (1-4): each part names exactly one mask GLB node and declares a local rotation axis, the tracked head-rotation component that drives it (yaw/pitch/roll), a spring stiffness (4-400 1/s^2), damping ratio (0.05-1.5), maxAngleDeg (1-60) and an optional restAngleDeg within that bound.',
        runtime:
          'Pure fixed-step spring simulation (fixed 120 Hz sub-steps, dt clamped to <=250 ms) driven by the accepted tracked head angular velocity; no canned clip, no package code, no per-frame displacement. Deliberate resets on first sample, >250 ms gap, pose discontinuity, loop seam and tracking reacquisition.',
        bounds: {
          maxParts: 4,
          stiffness: [4, 400],
          dampingRatio: [0.05, 1.5],
          maxAngleDeg: [1, 60],
          driveFullScaleDegPerSec: 45,
          fixedStepMs: Number((1000 / 120).toFixed(3)),
          maxGapMs: 250,
          maxPoseDeltaDeg: 45,
        },
      },
      sample: 'fixtures/packages/reactive-ears.zip (schema v3 mask with 2 ears + 1 hair tuft)',
      evidence: secondaryMotion,
      motionWindow: {
        fixture: motionManifest.id,
        startSeconds: MOTION_WINDOW_START_SECONDS,
        seconds: MOTION_WINDOW_SECONDS,
        basis: 'Recorded turns/nods; each sampled part angle is asserted inside its declared bound.',
      },
      settlingWindow: {
        startSeconds: POST_TURN_WINDOW_START_SECONDS,
        seconds: POST_TURN_WINDOW_SECONDS,
        basis:
          'Recorded turn around 25.9 s followed by low head angular velocity; the spring residual and its decay to rest are measured on the public diagnostics. Replay-based, not a physical-camera or human measurement.',
      },
      timingBasis:
        'Replay-derived main-thread measurements on the development desktop; the simulation cost is the pure spring update per accepted pose, and the render/frame-interval differences are sequential-window observations with the authored rest pose as the OFF state. Not the final benchmark or a performance target.',
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
      captureAttempts: cameraCaptureAttempts,
    },
    results,
    limitations: [
      'Replay fixtures only; no physical webcam was opened and no human participated.',
      'Virtual camera evidence is from a separate Media Foundation consumer harness, not a call or stream application; Zoom/Meet/OBS compatibility is a later slice.',
      'Camera latency is measured against canvas capture time in the same process tree; camera-sensor and call-network delay are out of scope.',
      'Tracking is demonstrated on recorded video (the default clip and a second larger-motion CC0 clip); there is no physical-camera or live-human tracking evidence in this slice. The motion-window camera capture is taken on the held 47.7 s frame; resuming live playback after the long held A/B is not used as evidence because the automated session can stall its frame-callback timestamps after a loop seam (the output correctly hides under the paused policy).',
      'Tracking loss, multiple faces and unreliable tracking are exercised through a labelled diagnostic injection; the detected-face path is authoritative when the control is on normal. The policy cannot detect every possible tracking or rendering defect.',
      'The mask has face-based occlusion and bounded pose smoothing; secondary motion is a later issue. The canonical face occluder does not deform for facial expressions, is the canonical face surface only (no hair, ears, neck or full head silhouette), and hand-over-mask occlusion is out of scope.',
      'Occlusion evidence quantifies the removed mask pixels inside the tracked face bounding box at two recorded side views in opposite yaw directions; it does not prove clean occlusion at poses outside the recorded clip (larger yaw/pitch, fast motion, hair/ear/neck overlap) and it is not asserted continuously during the moving motion window. The residual extreme-pose limitations are stated in docs/notes/0005.',
      'Measured on this development desktop with a discrete GPU; laptop integrated-graphics behavior is unverified.',
      'Color treatments use canvas CSS filters in this spike; a later effect-package slice may replace the implementation.',
      'Face distortion is a bounded whole-face radial warp (bulge or pinch) centred on the tracked face box. It does not warp individual landmarks, expressions or features (for example separate eyes and mouth), and it is not a 3D mesh deformation; a package cannot express those. The warp ellipse follows the face box, but the warp itself is a screen-space sampling of the recorded frame, so it carries no pose orientation beyond the ellipse position and size.',
      'Face-distortion motion evidence is replay-only on the recorded pose-loop fixture and desktop-only; no physical-camera, laptop integrated-graphics or call-application evidence exists in this slice.',
      'Effect-switch pauses for the distortion are asserted by the public switchingPausedFrames counter and the status text; a separate camera capture while a switch is in flight is not taken (the same shared output policy and camera paused captures in every other state cover the camera path). The combined mask+distortion effect is supported by the contract and unit-tested through package resolution, but no committed combined sample/end-to-end check exists in this slice.',
      'Distortion context loss is injected through WEBGL_lose_context in the public control; a real driver/GPU reset is not reproduced. Restore depends on the browser/three.js re-initialisation, which the check asserts for the injected case; a browser that refuses to restore leaves the output hidden.',
      'Face-distortion timing measures main-thread WebGL submission only (no GPU sync/readback); the GPU/compositor cost is not isolated and the render-cost and frame-interval deltas are sequential-window observations.',
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
  log(`recorded turns/nods window:  ${MOTION_WINDOW_START_SECONDS}s of ${motionManifest.id}: yaw=${recordedMotion.motion.yawRange.toFixed(1)} pitch=${recordedMotion.motion.pitchRange.toFixed(1)} roll=${recordedMotion.motion.rollRange.toFixed(1)} origin=${recordedMotion.motion.originXRange}x${recordedMotion.motion.originYRange}px sliding p95=${recordedMotion.motion.sliding.slideP95Px}px raw p95=${recordedMotion.motion.rawSliding.slideP95Px}px (${(100 * recordedMotion.motion.smoothedVsRawReduction).toFixed(1)}% smoothed-vs-raw change; ${recordedMotion.motion.trackedSamples}/18 tracked)`);
  log(`pose smoothing (slow seg):  measured yaw=${recordedMotion.smoothing.slowSegmentMeasured.yawSpanDeg} pitch=${recordedMotion.smoothing.slowSegmentMeasured.pitchSpanDeg} roll=${recordedMotion.smoothing.slowSegmentMeasured.rollSpanDeg} deg origin=${recordedMotion.smoothing.slowSegmentMeasured.originSpanXPx}x${recordedMotion.smoothing.slowSegmentMeasured.originSpanYPx}px p50 alpha=${recordedMotion.smoothing.slowSegmentMeasured.alphaP50}`);
  log(`pose smoothing (jitter):    origin p95 ${recordedMotion.smoothing.slowSegment.rawJitterOriginPxP95}->${recordedMotion.smoothing.slowSegment.smoothedJitterOriginPxP95}px (${(100 * recordedMotion.smoothing.originJitterReductionSlowSegment).toFixed(1)}% lower) rotation ${recordedMotion.smoothing.slowSegment.rawJitterRotationDegP95}->${recordedMotion.smoothing.slowSegment.smoothedJitterRotationDegP95}deg (${(100 * recordedMotion.smoothing.rotationJitterReductionSlowSegment).toFixed(1)}% lower)`);
  log(`smoothing added lag/cost:    origin p95=${recordedMotion.smoothing.motion.lagOriginPxP95}px rotation p95=${recordedMotion.smoothing.motion.lagRotationDegP95}deg ramp p95=${recordedMotion.smoothing.motion.rampLagMsP95}ms filter p95=${recordedMotion.smoothing.motion.costMsP95}ms`);
  log(`occlusion A/B (bundled):     ${recordedMotion.occlusion.bundled.changedPixels}px changed, ${(100 * recordedMotion.occlusion.bundled.insideFaceFraction).toFixed(1)}% inside face bbox, reveal ${recordedMotion.occlusion.bundled.reveal.kind}, self-diff ON ${recordedMotion.occlusion.bundled.selfDiffPixels}px OFF ${recordedMotion.occlusion.bundled.offSelfDiffPixels}px, plausibility meanLuma=${recordedMotion.occlusion.bundled.reveal.plausibleVideo.meanLuminance} stddev=${recordedMotion.occlusion.bundled.reveal.plausibleVideo.luminanceStdDev}, video match=${recordedMotion.occlusion.bundled.videoMatch?.matchFraction ?? 'n/a'}, probe=${JSON.stringify(recordedMotion.occlusion.bundled.probePixel)}`);
  log(`occlusion A/B (guard):       ${recordedMotion.occlusion.guardVisor.changedPixels}px changed, ${(100 * recordedMotion.occlusion.guardVisor.insideFaceFraction).toFixed(1)}% inside face bbox, material OFF ${(100 * recordedMotion.occlusion.guardVisor.reveal.changedMaterialFractionOff).toFixed(1)}% -> ON ${(100 * recordedMotion.occlusion.guardVisor.reveal.changedMaterialFractionOn).toFixed(1)}%, plausibility meanLuma=${recordedMotion.occlusion.guardVisor.reveal.plausibleVideo.meanLuminance}, self-diff ON ${recordedMotion.occlusion.guardVisor.selfDiffPixels}px OFF ${recordedMotion.occlusion.guardVisor.offSelfDiffPixels}px`);
  log(`occlusion A/B (rose):        ${recordedMotion.occlusion.roseVisor.changedPixels}px changed, ${(100 * recordedMotion.occlusion.roseVisor.insideFaceFraction).toFixed(1)}% inside face bbox, material OFF ${(100 * recordedMotion.occlusion.roseVisor.reveal.changedMaterialFractionOff).toFixed(1)}% -> ON ${(100 * recordedMotion.occlusion.roseVisor.reveal.changedMaterialFractionOn).toFixed(1)}%, video match=${recordedMotion.occlusion.roseVisor.videoMatch?.matchFraction ?? 'n/a'}, self-diff ON ${recordedMotion.occlusion.roseVisor.selfDiffPixels}px OFF ${recordedMotion.occlusion.roseVisor.offSelfDiffPixels}px`);
  log(`occlusion A/B (camera):      bundled ${recordedMotion.occlusion.camera.changedPixels}px, guard ${recordedMotion.occlusion.guardVisorCamera.changedPixels}px (identical to preview, self-diff 0)`);
  log(`occlusion A/B (opposite):    ${recordedMotion.occlusion.opposite.bundled.changedPixels}px changed at yaw=${recordedMotion.occlusion.opposite.bundled.mask.yaw}, ${(100 * recordedMotion.occlusion.opposite.bundled.insideFaceFraction).toFixed(1)}% inside face bbox; camera ${recordedMotion.occlusion.opposite.camera.changedPixels}px; guard ${recordedMotion.occlusion.opposite.guardVisor.changedPixels}px`);
  log('\n== Face distortion (replay-based) ==');
  log(`distortion warp submit p95: ${effectPackages.distortion.timing.warpSubmissionCostP95Ms}ms (main-thread WebGL submission only; no GPU sync/readback)`);
  log(`distortion render cost p95:  ${effectPackages.distortion.timing.renderCostP95Ms}ms vs ${effectPackages.distortion.timingBaseline.renderCostP95Ms}ms color-only baseline (observed delta ${effectPackages.distortion.timing.observedRenderCostDeltaP95Ms}ms)`);
  log(`distortion frame pacing p95: ${effectPackages.distortion.timing.frameIntervalP95Ms}ms vs ${effectPackages.distortion.timingBaseline.frameIntervalP95Ms}ms baseline (sequential windows; observed delta ${effectPackages.distortion.timing.observedFrameIntervalDeltaP95Ms}ms, not isolated or attributed to the warp)`);
  log(`distortion face following:   ${recordedMotion.distortion.trackedSamples}/18 samples, warp centre moved ${recordedMotion.distortion.centerXRange}x${recordedMotion.distortion.centerYRange}px with the tracked face box`);
  log(`distortion pixel evidence:   changedInsidePct=${effectPackages.distortion.preview.active.changedInsidePct}% changedOutsidePct=${effectPackages.distortion.preview.active.changedOutsidePct}% warpDelta=${effectPackages.distortion.preview.active.warpDelta} on the default clip (offscreen diagnostic)`);
  log(`distortion A/B (published):  ${effectPackages.distortion.ab.changedPixels}px changed on the held default-clip frame, ${(100 * effectPackages.distortion.ab.insideEllipseFraction).toFixed(2)}% inside the independent diag-face ellipse, self-diff ON ${effectPackages.distortion.ab.selfDiffPixels}px OFF ${effectPackages.distortion.ab.offSelfDiffPixels}px, camera ${effectPackages.distortion.ab.camera?.changedPixels}px (identical to preview)`);
  log(`distortion A/B (poses):      centroid ${recordedMotion.distortion.faceFollowingPoses.poseDistancePx}px face move -> ${recordedMotion.distortion.faceFollowingPoses.centroidDistancePx}px centroid move (${OCCLUSION_CAPTURE_SECONDS}s and ${OCCLUSION_CAPTURE_SECONDS_OPPOSITE}s)`);
  log(`distortion context loss:     output hidden in preview and camera (${effectPackages.distortion.contextLoss.diagnostic.contextLost}), restored drawable=${effectPackages.distortion.contextLoss.recovered.diagnostic.drawable}`);
  log(`tracker model:               ${trackerMetadata.id} sha256=${trackerMetadata.sha256.slice(0, 12)}…`);
  log('\n== Secondary motion (replay-based) ==');
  log(`secondary-motion motion:    ${secondaryMotion.motion.trackedSamples}/18 samples, part ranges ${secondaryMotion.motion.partRangesDeg.map((range) => range.toFixed(1)).join('/')} deg, max ${secondaryMotion.motion.maxObservedAngleDeg.toFixed(2)} deg (bounded)`);
  log(`post-turn settling:         peak ${secondaryMotion.settle.peak.maxAbsAngleDeg}deg -> residual ${secondaryMotion.settle.residual.maxAbsAngleDeg}deg after head slowed to ${secondaryMotion.settle.residual.headSpeedDegPerSec}deg/s -> settled ${secondaryMotion.settle.settled.maxAbsAngleDeg}deg in ${secondaryMotion.settle.settlingMs}ms (${(100 * secondaryMotion.settle.decayFraction).toFixed(1)}% of peak)`);
  log(`loop/reacquisition resets:  loop seams resets ${secondaryMotion.loop.resetsBefore}->${secondaryMotion.loop.resetsAfter}; tracking loss resets ${secondaryMotion.reacquisition.lostMotion.resets} with rest angles`);
  log(`secondary-motion A/B:       held ${SECONDARY_MOTION_AB_CAPTURE_SECONDS}s angle ${secondaryMotion.ab.heldAngleDeg}deg changed ${secondaryMotion.ab.changedPixels}px (${secondaryMotion.ab.changedOnMaskPixels}px on mask), self-diff ON ${secondaryMotion.ab.selfDiffPixels}px OFF ${secondaryMotion.ab.offSelfDiffPixels}px, camera ${secondaryMotion.ab.camera?.changedPixels}px (identical to preview)`);
  log(`secondary-motion workload:  simulation p95=${secondaryMotion.timing.simulationCostP95Ms}ms (main-thread spring update only) render p95=${secondaryMotion.timing.renderCostP95MsOn}ms vs rest ${secondaryMotion.timing.renderCostP95MsRest}ms frame interval ${secondaryMotion.timing.frameIntervalP95MsOn}ms vs ${secondaryMotion.timing.frameIntervalP95MsRest}ms (sequential, not isolated)`);
  log(`secondary-motion rejects:   ${secondaryMotion.negatives.map((entry) => entry.expectedCode).join(', ')}`);
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

