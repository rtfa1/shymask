import { app, BrowserWindow, dialog, ipcMain, protocol, type OpenDialogOptions } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CameraFrame,
  CaptureResult,
  FixtureInfo,
  ImportEffectPackageResult,
  RemoveEffectPackageResult,
  StartupInfo,
  TrackerInfo,
  VirtualCameraStatus,
} from '../core/bridge';
import { createAssetHandler } from './asset-protocol';
import { EffectPackageStore } from './effect-packages';
import { FIXTURE_METADATA_FILENAME, loadFixture } from './fixture';
import { loadTracker } from './tracker';
import { VirtualCameraPublisher } from './virtual-camera';

// `app.getAppPath()` is the project root when launched with `electron .`;
// the Playwright check harness uses the same entry point.
const repoRoot = app.getAppPath();
const fixtureDir = process.env.SHYMASK_FIXTURE_DIR
  ? path.resolve(process.env.SHYMASK_FIXTURE_DIR)
  : path.join(repoRoot, 'fixtures', 'cache');
const evidenceDir = process.env.SHYMASK_EVIDENCE_DIR
  ? path.resolve(process.env.SHYMASK_EVIDENCE_DIR)
  : path.join(repoRoot, 'evidence');
// The default recorded replay; the public-workflow check points this at the
// documented larger-motion fixture to exercise real head turns and nods.
const fixtureManifest = (process.env.SHYMASK_FIXTURE_MANIFEST ?? FIXTURE_METADATA_FILENAME).trim();
const fixtureFetchCommand = fixtureManifest === FIXTURE_METADATA_FILENAME ? 'npm run fetch:fixture' : 'npm run fetch:motion-fixture';
const rendererDir = path.join(repoRoot, 'dist', 'renderer');
const trackerDir = process.env.SHYMASK_TRACKER_DIR
  ? path.resolve(process.env.SHYMASK_TRACKER_DIR)
  : path.join(rendererDir, 'tracker');
const assetScheme = 'shymask';
const assetBaseUrl = `${assetScheme}://app`;
const fixtureUrlBase = `${assetBaseUrl}/fixture`;
const trackerUrlBase = `${assetBaseUrl}/tracker`;
const packageUrlBase = `${assetBaseUrl}/packages`;
// Imported effect packages persist under Electron's userData by default. The
// public-workflow check points this at an evidence-local directory so a check
// run never edits the developer's installed packages.
const packageDir = process.env.SHYMASK_PACKAGE_DIR
  ? path.resolve(process.env.SHYMASK_PACKAGE_DIR)
  : path.join(app.getPath('userData'), 'effect-packages');
let packageStore: EffectPackageStore | null = null;

function getPackageStore(): EffectPackageStore {
  packageStore ??= new EffectPackageStore(packageDir, packageUrlBase);
  return packageStore;
}

// The renderer, its WASM assets and the replay clip are served from a local
// asset scheme so Fetch API/WASM and byte-range media work under a strict CSP.
// The scheme is privileged before `app.whenReady()`; nothing leaves the machine.
protocol.registerSchemesAsPrivileged([
  {
    scheme: assetScheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let currentFixture: FixtureInfo = loadFixture({
  repoRoot,
  fixtureDir,
  metadataFileName: fixtureManifest,
  fetchCommand: fixtureFetchCommand,
  videoUrlForFile: (fileName) => `${fixtureUrlBase}/${encodeURIComponent(fileName)}`,
});
let currentTracker: TrackerInfo = loadTracker({
  repoRoot,
  trackerDir,
  wasmBaseUrl: trackerUrlBase,
});
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

  void mainWindow.loadURL(`${assetBaseUrl}/index.html`);
}

ipcMain.handle('shymask:startup-info', (): StartupInfo => {
  return { fixture: currentFixture, tracker: currentTracker, effectPackages: getPackageStore().list() };
});

ipcMain.handle('shymask:effect-packages', () => {
  return getPackageStore().list();
});

ipcMain.handle('shymask:effect-package-import', async (event): Promise<ImportEffectPackageResult> => {
  const store = getPackageStore();
  const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  const options: OpenDialogOptions = {
    title: 'Import a Shymask effect package',
    buttonLabel: 'Import package',
    properties: ['openFile'],
    filters: [{ name: 'Shymask effect package', extensions: ['zip'] }],
  };
  const picked = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) {
    return { status: 'cancelled', message: 'Import cancelled.', issues: [], list: store.list() };
  }
  return store.importArchive(picked.filePaths[0] as string);
});

ipcMain.handle('shymask:effect-package-remove', (_event, id: unknown): RemoveEffectPackageResult => {
  return getPackageStore().remove(typeof id === 'string' ? id : '');
});

ipcMain.handle('shymask:recheck-fixture', (): FixtureInfo => {
  currentFixture = loadFixture({
    repoRoot,
    fixtureDir,
    metadataFileName: fixtureManifest,
    fetchCommand: fixtureFetchCommand,
    videoUrlForFile: (fileName) => `${fixtureUrlBase}/${encodeURIComponent(fileName)}`,
  });
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
  protocol.handle(
    assetScheme,
    createAssetHandler({ rendererDir, trackerDir, fixtureDir, packageDir }),
  );
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
