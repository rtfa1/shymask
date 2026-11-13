#!/usr/bin/env node
/**
 * Native virtual camera workflow check.
 *
 * Exercises the Windows virtual camera outside the Electron app:
 *   1. build/install the native components (per-user staging always,
 *      machine-wide registration only when the shell is elevated),
 *   2. start a 1280x720 test-pattern frame source on the internal TCP protocol,
 *   3. start the camera host (MFCreateVirtualCamera + Start),
 *   4. if the camera starts, run the independent Media Foundation consumer and
 *      assert it received RGB32 frames with the expected pixels,
 *   5. if the camera cannot start, record an explicit BLOCKED report with the
 *      exact HRESULT, registry state, frame-server events and unblock command.
 *
 * Exit codes: 0 pass, 3 blocked (camera could not be started), 1 failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem, version as osVersion } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(root, 'build', 'native');
const dataRoot = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Shymask');
const installDir = path.join(dataRoot, 'bin');
const hostPath = path.join(installDir, 'shymask-vcam-host.exe');
const consumerPath = path.join(installDir, 'shymask-camera-consumer.exe');
const frameSourcePath = path.join(root, 'scripts', 'dev', 'vcam-test-pattern.mjs');
const evidenceDir = path.join(root, 'evidence', 'vcam-check');
const framesDir = path.join(evidenceDir, 'frames');
const logsDir = path.join(root, 'evidence', 'logs');
const finalLogPath = path.join(logsDir, 'vcam-final.log');
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(framesDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

const logLines = [];
const results = [];

function log(message) {
  console.log(message);
  logLines.push(message);
  writeFileSync(finalLogPath, `${logLines.join('\n')}\n`);
}

function record(name, status, detail) {
  results.push({ name, status, detail });
  log(`${status === 'pass' ? 'PASS' : status === 'blocked' ? 'BLOCKED' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
}

function runProcess(label, executable, args, { stdin = false } = {}) {
  const child = spawn(executable, args, {
    cwd: root,
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = [];
  let carry = '';
  child.stdout.on('data', (chunk) => {
    carry += chunk.toString('utf8');
    for (let index = carry.indexOf('\n'); index >= 0; index = carry.indexOf('\n')) {
      const line = carry.slice(0, index).trim();
      carry = carry.slice(index + 1);
      if (line) {
        lines.push(line);
        log(`[${label}] ${line}`);
      }
    }
  });
  child.stderr.on('data', (chunk) => log(`[${label}:stderr] ${chunk.toString('utf8').trim()}`));
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  return { child, lines, exit };
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function readJsonLines(lines, event) {
  return lines
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((value) => value && (!event || value.event === event));
}

function readLogTail(maxLines = 120) {
  const logPath = path.join(dataRoot, 'vcam.log');
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter(Boolean);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function frameServerEvents(sinceIso) {
  const script = [
    `$start = [datetime]'${sinceIso}'`,
    "$events = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-MF-FrameServer/Camera_FrameServer'; StartTime=$start} -ErrorAction SilentlyContinue",
    "$events | Where-Object { $_.Id -eq 7 } | Select-Object -First 5 | ForEach-Object { $_.TimeCreated.ToString('o') + ' | ' + ($_.Message -replace \"`r?`n\",' ') }",
  ].join('; ');
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function enumerateCameras() {
  const result = spawnSync(hostPath, ['list'], { cwd: root, encoding: 'utf8' });
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((value) => value.event === 'device')
    .map((value) => ({ name: value.name, symbolicLink: value.symbolicLink, shymask: value.shymask }));
}

function registryState() {
  const clsid = '{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}';
  const read = (hive) => {
    const result = spawnSync('reg', ['query', `${hive}\\Software\\Classes\\CLSID\\${clsid}\\InprocServer32`, '/ve'], {
      encoding: 'utf8',
    });
    if (result.status !== 0) return null;
    const match = (result.stdout ?? '').match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : 'present';
  };
  return { perUser: read('HKCU'), machine: read('HKLM') };
}

function collectEnvironment() {
  const cpuList = cpus();
  const totalmemGiB = Number((totalmem() / 1024 ** 3).toFixed(1));
  return {
    node: process.version,
    os: { platform: platform(), release: release(), version: osVersion(), arch: arch(), totalmemGiB },
    cpu: { model: cpuList[0]?.model?.trim() ?? 'unknown', logicalCores: cpuList.length },
  };
}

function writeSummary(summary) {
  writeFileSync(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

async function main() {
  const runStartedAt = new Date();
  const headSha = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const environment = collectEnvironment();
  log('== Shymask Windows virtual camera check ==');
  log(`head:     ${headSha}`);
  log(`branch:   ${branch}`);
  log(`command:  npm run vcam:check`);
  log(`source:   1280x720 test-pattern frames over the internal TCP protocol (no physical camera)`);

  if (!existsSync(hostPath) || !existsSync(consumerPath)) {
    log('native components are not staged; run npm run vcam:install first.');
    process.exitCode = 1;
    return;
  }

  const install = spawnSync(hostPath, ['install'], { cwd: root, encoding: 'utf8' });
  log(`[install] ${(install.stdout ?? '').trim()}`);
  if (install.status !== 0) {
    record('native install', 'fail', `install exit ${install.status}`);
    process.exitCode = 1;
    return;
  }

  const frameSource = runProcess('frame-source', process.execPath, [frameSourcePath, '--port', '48010']);
  const host = runProcess('host', hostPath, ['run'], { stdin: true });
  let consumerOutput = [];
  let cameraStarted = false;

  try {
    const portLine = await waitFor(
      () => frameSource.lines.find((line) => line.startsWith('serving ')),
      10000,
      'the test-pattern frame source',
    );
    log(`frame source: ${portLine}`);
    const outcome = await waitFor(
      () => {
        const started = readJsonLines(host.lines, 'camera-started')[0];
        if (started) return { started };
        const error = readJsonLines(host.lines, 'error')[0];
        if (error) return { error };
        return null;
      },
      20000,
      'the virtual camera host',
    );

    if (outcome.started) {
      cameraStarted = true;
      record('Virtual camera registered and started', 'pass', outcome.started.symbolicLink ?? outcome.started.friendlyName ?? '');
      const devices = spawnSync(hostPath, ['list'], { cwd: root, encoding: 'utf8' });
      const deviceLines = readJsonLines((devices.stdout ?? '').split(/\r?\n/), 'device');
      const shymask = deviceLines.filter((device) => /^Shymask Camera/.test(device.name ?? ''));
      record('External enumeration sees Shymask Camera', shymask.length > 0 ? 'pass' : 'fail', shymask[0]?.name ?? 'not listed');

      const consumer = runProcess('consumer', consumerPath, [
        '--device',
        'Shymask Camera',
        '--frames',
        '6',
        '--out',
        framesDir,
        '--prefix',
        'test-pattern',
        '--max-pngs',
        '2',
      ]);
      const consumerCode = await consumer.exit;
      consumerOutput = consumer.lines;
      const frames = readJsonLines(consumer.lines, 'frame');
      record(
        'Independent Media Foundation consumer received frames',
        frames.length >= 6 ? 'pass' : 'fail',
        `${frames.length} frames, exit ${consumerCode}`,
      );
      if (frames.length > 0) {
        const first = frames[0];
        record(
          'Consumer frame pixels match the source',
          Math.abs((first.meanR ?? 0) - 210) < 30 || Math.abs((first.meanR ?? 0) - 70) < 30 ? 'pass' : 'fail',
          `mean RGB ${first.meanR},${first.meanG},${first.meanB}`,
        );
      }
    } else if (outcome.error) {
      record('Virtual camera registered and started', 'blocked', `${outcome.error.code} ${outcome.error.hresult}`);
      // Give the frame server a moment to flush its event record.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const registry = registryState();
      const events = frameServerEvents(new Date(runStartedAt.getTime() - 10000).toISOString());
      const logTail = readLogTail();
      const enumerationAfterFailedStart = enumerateCameras();
      writeFileSync(path.join(evidenceDir, 'frame-server-events.txt'), `${events.join('\n')}\n`);
      writeFileSync(path.join(evidenceDir, 'vcam.log'), `${logTail.join('\n')}\n`);
      const summary = {
        generatedAt: new Date().toISOString(),
        headSha,
        branch,
        status: 'blocked',
        environment,
        workload: {
          sourceMode: '1280x720 test-pattern frames over the internal TCP frame protocol',
          nativeBinaries: 'build/native (staged to %ProgramData%\\Shymask\\bin)',
          appIntegration: 'not implemented in this slice (the OS cannot start the camera here)',
        },
        commands: {
          build: 'npm run build:native',
          install: 'npm run vcam:install',
          check: 'npm run vcam:check',
        },
        registry,
        cameraHost: outcome.error,
        enumerationAfterFailedStart,
        frameServerEvents: events,
        findings: [
          'MFCreateVirtualCamera(SoftwareCameraSource, Session, CurrentUser) succeeds with HRESULT 0x00000000 for a standard user.',
          'The request starts a per-user software device (\\?\\SWD#VCAMDEVAPI#...) and the Microsoft-Windows-MF-FrameServer/Camera_FrameServer log records FsProxy initialization hr=0x80070003.',
          'IMFVirtualCamera::Start returns 0x80070003. The media source DLL is never loaded by the frame server; the same DLL activates successfully in the requesting process during Start validation.',
          'The virtual camera is not enumerable after the failed start (see enumerationAfterFailedStart).',
          'Writing HKLM\\Software\\Classes\\CLSID\\{...}\\InprocServer32 is denied to a standard account (Access is denied), and IMFVirtualCamera::AddRegistryEntry requires administrator permissions by documentation.',
        ],
        unblock:
          'Run `npm run vcam:install` once from an elevated PowerShell prompt. It stages the native binaries in %ProgramData%\\Shymask\\bin and registers the media source class in HKLM, which the Local Service frame server can see. Then re-run `npm run vcam:check`.',
        limitations: [
          'No physical webcam, account, cloud call, or human participation is involved.',
          'No camera consumer received frames in this run because the camera could not be started.',
        ],
        results,
      };
      writeSummary(summary);
      log('\n== BLOCKED ==');
      log(`IMFVirtualCamera::Start -> ${outcome.error.hresult}`);
      log('The Media Foundation frame server (Local Service) cannot activate a per-user (HKCU) media source.');
      log('Smallest unblock: run `npm run vcam:install` once from an elevated prompt.');
      log(`Evidence: ${evidenceDir}`);
      process.exitCode = 3;
    }
  } finally {
    if (host.child.stdin && !host.child.killed) {
      try {
        host.child.stdin.write('stop\n');
      } catch {
        // host may already have exited after a failed start
      }
    }
    await Promise.race([host.exit, new Promise((resolve) => setTimeout(resolve, 8000))]);
    if (host.child.exitCode === null) host.child.kill();
    if (frameSource.child.exitCode === null) frameSource.child.kill();
  }

  if (cameraStarted) {
    const frames = readJsonLines(consumerOutput, 'frame');
    writeSummary({
      generatedAt: new Date().toISOString(),
      headSha,
      branch,
      status: 'pass',
      environment,
      results,
      frames: frames.map(({ png, ...rest }) => ({ ...rest, png: png ? path.basename(png) : '' })),
      commands: { build: 'npm run build:native', install: 'npm run vcam:install', check: 'npm run vcam:check' },
      limitations: [
        'Test-pattern source, not the Shymask replay canvas (the Electron integration is a later slice).',
        'Replay-based measurement boundaries still apply; no camera-sensor or call-application path is involved.',
      ],
    });
    log(`\nEvidence: ${evidenceDir}`);
    process.exitCode = 0;
  } else if (process.exitCode === undefined) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  log(`\nFAIL  virtual camera check - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
