#!/usr/bin/env node
/**
 * Virtual camera install/status wrapper for the Windows native components.
 *
 * The media source is a COM in-proc server. Media Foundation's frame server
 * runs as Local Service and loads it, so the DLL is staged in
 * %ProgramData%\Shymask\bin (readable by Local Service) and registered in the
 * machine hive when this command runs elevated. A normal (non-elevated) run
 * registers the same DLL per user; that is enough for in-process activation but
 * NOT enough for the frame server, which is why the elevated step is required.
 *
 * Usage:
 *   node scripts/vcam.mjs install
 *   node scripts/vcam.mjs uninstall
 *   node scripts/vcam.mjs status
 *   node scripts/vcam.mjs consumer --frames 5 --out <dir> --prefix <name>
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtDir = path.join(root, 'build', 'native');
const dataRoot = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Shymask');
const installDir = path.join(dataRoot, 'bin');
const hostPath = path.join(installDir, 'shymask-vcam-host.exe');
const consumerPath = path.join(installDir, 'shymask-camera-consumer.exe');
const binaries = ['ShymaskVirtualCamera.dll', 'shymask-vcam-host.exe', 'shymask-camera-consumer.exe'];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(executable, args, { echo = true } = {}) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  if (echo) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

function stage() {
  mkdirSync(installDir, { recursive: true });
  for (const binary of binaries) {
    const source = path.join(builtDir, binary);
    if (!existsSync(source)) fail(`missing ${binary}; run npm run build:native first`);
    copyFileSync(source, path.join(installDir, binary));
  }
  return installDir;
}

const command = process.argv[2] ?? 'status';
if (command === 'install') {
  const directory = stage();
  const result = run(hostPath, ['install']);
  console.log(`\nstaged native components in ${directory}`);
  if (/\"machine\":true/.test(result.stdout ?? '')) {
    console.log('Machine-wide (HKLM) registration is in place; the frame server can activate the source.');
  } else {
    console.log('');
    console.log('BLOCKED for a standard (non-elevated) account:');
    console.log('  The Media Foundation frame server runs as Local Service and cannot see per-user (HKCU)');
    console.log('  COM registration, so IMFVirtualCamera::Start fails with 0x80070003 and no camera is');
    console.log('  published. To unblock, run this once from an elevated PowerShell prompt:');
    console.log('');
    console.log(`    cd "${root}"`);
    console.log('    npm run vcam:install');
    console.log('');
    console.log('  That adds HKLM\\Software\\Classes\\CLSID\\{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}\\InprocServer32');
    console.log('  pointing at the staged DLL. `npm run vcam:uninstall` from the same elevated prompt removes it.');
  }
} else if (command === 'uninstall') {
  const executable = existsSync(hostPath) ? hostPath : path.join(builtDir, 'shymask-vcam-host.exe');
  if (!existsSync(executable)) fail('no host executable; run npm run build:native first');
  const result = run(executable, ['uninstall']);
  if (result.status !== 0) process.exit(result.status ?? 1);
} else if (command === 'status') {
  const executable = existsSync(hostPath) ? hostPath : path.join(builtDir, 'shymask-vcam-host.exe');
  if (!existsSync(executable)) fail('no host executable; run npm run build:native first');
  run(executable, ['list']);
} else if (command === 'consumer') {
  const executable = existsSync(consumerPath)
    ? consumerPath
    : path.join(builtDir, 'shymask-camera-consumer.exe');
  if (!existsSync(executable)) fail('no consumer executable; run npm run build:native first');
  const args = process.argv.slice(3);
  const result = run(executable, args.length > 0 ? args : ['--list']);
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  fail(`unknown command: ${command}`);
}
