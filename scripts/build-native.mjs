#!/usr/bin/env node
/**
 * Builds the Windows virtual camera native components.
 *
 * Requires the MSVC toolchain and the Windows 10/11 SDK (mfvirtualcamera.h,
 * mfsensorgroup.lib). It locates vcvars64.bat through vswhere. Outputs land in
 * build/native/ and are never committed.
 *
 *   ShymaskVirtualCamera.dll     in-proc COM media source (per-user registered)
 *   shymask-vcam-host.exe        registrar + session-lifetime camera host
 *   shymask-camera-consumer.exe  independent Media Foundation camera consumer
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'build', 'native');
const objectDir = path.join(outputDir, 'obj');
const nativeRoot = path.join(root, 'native', 'shymask-vcam');
const sourceDir = path.join(nativeRoot, 'source');

mkdirSync(objectDir, { recursive: true });

function findVcVars() {
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (existsSync(vswhere)) {
    const result = spawnSync(
      vswhere,
      ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
      { encoding: 'utf8' },
    );
    const installationPath = (result.stdout ?? '').trim();
    if (installationPath) {
      const candidate = path.join(installationPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
      if (existsSync(candidate)) return candidate;
    }
  }
  const fallback = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat';
  return existsSync(fallback) ? fallback : null;
}

const vcVars = findVcVars();
if (!vcVars) {
  console.error('Native build needs MSVC (vcvars64.bat) and the Windows 11 SDK with mfvirtualcamera.h.');
  console.error('Install "Desktop development with C++" in Visual Studio, then retry.');
  process.exit(1);
}

function runCl(label, args) {
  const scriptPath = path.join(outputDir, `build-${label.replace(/[^a-z0-9]+/gi, '-')}.cmd`);
  const lines = [
    '@echo off',
    `call "${vcVars}" >nul`,
    `cl ${args.join(' ')}`,
    'exit /b %ERRORLEVEL%',
  ];
  writeFileSync(scriptPath, `${lines.join('\r\n')}\r\n`, 'ascii');
  console.log(`\n[${label}] cl ${args.join(' ')}`);
  const result = spawnSync('cmd', ['/d', '/c', scriptPath], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`native build failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

const common = [
  '/nologo',
  '/EHsc',
  '/std:c++17',
  '/O2',
  '/MD',
  '/W3',
  '/DUNICODE',
  '/D_UNICODE',
  '/D_WIN32_WINNT=0x0A00',
  '/DNOMINMAX',
  `/I${nativeRoot}`,
  `/I${sourceDir}`,
];
const objectOut = `/Fo:${objectDir}\\`;

runCl('media source', [
  ...common,
  '/LD',
  `/Fe:${outputDir}\\ShymaskVirtualCamera.dll`,
  objectOut,
  path.join(sourceDir, 'dllmain.cpp'),
  path.join(sourceDir, 'activator.cpp'),
  path.join(sourceDir, 'media-source.cpp'),
  path.join(sourceDir, 'media-stream.cpp'),
  path.join(sourceDir, 'paused-frame.cpp'),
  path.join(sourceDir, 'frame-transport.cpp'),
  path.join(sourceDir, 'logging.cpp'),
  '/link',
  `/DEF:${path.join(sourceDir, 'shymask-source.def')}`,
  'mfplat.lib',
  'mfuuid.lib',
  'ole32.lib',
  'oleaut32.lib',
  'advapi32.lib',
  'gdi32.lib',
  'user32.lib',
  'shell32.lib',
  'ws2_32.lib',
]);

runCl('vcam host', [
  ...common,
  `/Fe:${outputDir}\\shymask-vcam-host.exe`,
  objectOut,
  path.join(nativeRoot, 'host', 'main.cpp'),
  path.join(sourceDir, 'logging.cpp'),
  '/link',
  'mfplat.lib',
  'mf.lib',
  'mfsensorgroup.lib',
  'mfuuid.lib',
  'ole32.lib',
  'oleaut32.lib',
  'advapi32.lib',
  'shell32.lib',
  'ws2_32.lib',
]);

runCl('camera consumer', [
  ...common,
  `/Fe:${outputDir}\\shymask-camera-consumer.exe`,
  objectOut,
  path.join(nativeRoot, 'consumer', 'main.cpp'),
  '/link',
  'mfplat.lib',
  'mfreadwrite.lib',
  'mf.lib',
  'mfuuid.lib',
  'ole32.lib',
  'oleaut32.lib',
  'windowscodecs.lib',
]);

console.log(`\nnative build ok: ${outputDir}`);

