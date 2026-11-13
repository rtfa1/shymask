import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CameraFrame, CaptureResult, FixtureInfo, StartupInfo, VirtualCameraStatus } from '../core/bridge';
import { loadFixture } from './fixture';
import { VirtualCameraPublisher } from './virtual-camera';

// Electron's `app.getAppPath()` is the project root when launched with `electron .`;
// the Playwright check harness uses the same entry point.
const repoRoot = app.getAppPath();
const fixtureDir = process.env.SHYMASK_FIXTURE_DIR
  ? path.resolve(process.env.SHYMASK_FIXTURE_DIR)
  : path.join(repoRoot, 'fixtures', 'cache');
const evidenceDir = process.env.SHYMASK_EVIDENCE_DIR
  ? path.resolve(process.env.SHYMASK_EVIDENCE_DIR)
  : path.join(repoRoot, 'evidence');

let currentFixture: FixtureInfo = loadFixture({ repoRoot, fixtureDir });
let mainWindow: BrowserWindow | null = null;
let virtualCamera: VirtualCameraPublisher | null = null;
let quitting = false;

function writeCapture(dataUrl: string): CaptureResult {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    return { ok: false, error: 'Capture rejected: expected a PNG data URL.' };
  }
  try {
    const png = Buffer.from(dataUrl.slice(prefix.length), 'base64');
    if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      return { ok: false, error: 'Capture rejected: decoded bytes are not a PNG image.' };
    }
    mkdirSync(evidenceDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(evidenceDir, `capture-${stamp}.png`);
    writeFileSync(filePath, png);
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: `Capture failed: ${(error as Error).message}` };
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0a0d12',
    title: 'Shymask - development preview',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadFile(path.join(repoRoot, 'dist', 'renderer', 'index.html'));
}

ipcMain.handle('shymask:startup-info', (): StartupInfo => {
  return { fixture: currentFixture };
});

ipcMain.handle('shymask:recheck-fixture', (): FixtureInfo => {
  currentFixture = loadFixture({ repoRoot, fixtureDir });
  return currentFixture;
});

ipcMain.handle('shymask:capture-output', (_event, dataUrl: unknown): CaptureResult => {
  return writeCapture(typeof dataUrl === 'string' ? dataUrl : '');
});

ipcMain.on('shymask:camera-frame', (_event, frame: unknown) => {
  if (!frame || typeof frame !== 'object') return;
  const candidate = frame as Partial<CameraFrame>;
  if (
    typeof candidate.captureUnixMs !== 'number' ||
    typeof candidate.width !== 'number' ||
    typeof candidate.height !== 'number' ||
    !(candidate.data instanceof ArrayBuffer)
  ) {
    return;
  }
  virtualCamera?.publishFrame({
    captureUnixMs: candidate.captureUnixMs,
    width: candidate.width,
    height: candidate.height,
    data: candidate.data,
  });
});

ipcMain.handle('shymask:vcam-status', (): VirtualCameraStatus => {
  return virtualCamera?.getStatus() ?? startingVirtualCameraStatus();
});

ipcMain.handle('shymask:vcam-restart', async (): Promise<VirtualCameraStatus> => {
  if (!virtualCamera) return startingVirtualCameraStatus();
  return virtualCamera.restart();
});

function startingVirtualCameraStatus(): VirtualCameraStatus {
  return {
    state: 'starting',
    friendlyName: 'Shymask Camera',
    enumerable: false,
    clients: 0,
    framesPublished: 0,
    port: null,
    hostPid: null,
    message: 'Starting the Windows virtual camera…',
    action: null,
    hresult: null,
  };
}

function broadcastVirtualCameraStatus(status: VirtualCameraStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('shymask:vcam-status', status);
  }
}

app.whenReady().then(() => {
  createWindow();
  virtualCamera = new VirtualCameraPublisher({
    repoRoot,
    onStatus: broadcastVirtualCameraStatus,
  });
  void virtualCamera.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing Shymask stops the camera output: the host owns the session-lifetime
// IMFVirtualCamera and is asked to Stop/Remove before the app exits.
app.on('before-quit', (event) => {
  if (quitting || !virtualCamera) return;
  event.preventDefault();
  quitting = true;
  void virtualCamera.stop().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  app.quit();
});
