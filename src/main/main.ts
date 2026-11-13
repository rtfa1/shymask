import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CaptureResult, FixtureInfo, StartupInfo } from '../core/bridge';
import { loadFixture } from './fixture';

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
  return { fixture: currentFixture, fixtureDir, evidenceDir };
});

ipcMain.handle('shymask:recheck-fixture', (): FixtureInfo => {
  currentFixture = loadFixture({ repoRoot, fixtureDir });
  return currentFixture;
});

ipcMain.handle('shymask:capture-output', (_event, dataUrl: unknown): CaptureResult => {
  return writeCapture(typeof dataUrl === 'string' ? dataUrl : '');
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
