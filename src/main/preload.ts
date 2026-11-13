import { contextBridge, ipcRenderer } from 'electron';
import type {
  CameraFrame,
  CaptureResult,
  EffectPackageList,
  FixtureInfo,
  ImportEffectPackageResult,
  RemoveEffectPackageResult,
  ShymaskBridge,
  StartupInfo,
  VirtualCameraStatus,
} from '../core/bridge';

const bridge: ShymaskBridge = {
  getStartupInfo(): Promise<StartupInfo> {
    return ipcRenderer.invoke('shymask:startup-info') as Promise<StartupInfo>;
  },
  recheckFixture(): Promise<FixtureInfo> {
    return ipcRenderer.invoke('shymask:recheck-fixture') as Promise<FixtureInfo>;
  },
  getEffectPackages(): Promise<EffectPackageList> {
    return ipcRenderer.invoke('shymask:effect-packages') as Promise<EffectPackageList>;
  },
  importEffectPackage(): Promise<ImportEffectPackageResult> {
    return ipcRenderer.invoke('shymask:effect-package-import') as Promise<ImportEffectPackageResult>;
  },
  removeEffectPackage(id: string): Promise<RemoveEffectPackageResult> {
    return ipcRenderer.invoke('shymask:effect-package-remove', id) as Promise<RemoveEffectPackageResult>;
  },
  captureOutputPng(dataUrl: string): Promise<CaptureResult> {
    return ipcRenderer.invoke('shymask:capture-output', dataUrl) as Promise<CaptureResult>;
  },
  publishCameraFrame(frame: CameraFrame): void {
    // Structured clone to the main process; main forwards it to the native
    // media source over the loopback frame transport.
    ipcRenderer.send('shymask:camera-frame', frame);
  },
  getVirtualCameraStatus(): Promise<VirtualCameraStatus> {
    return ipcRenderer.invoke('shymask:vcam-status') as Promise<VirtualCameraStatus>;
  },
  restartVirtualCamera(): Promise<VirtualCameraStatus> {
    return ipcRenderer.invoke('shymask:vcam-restart') as Promise<VirtualCameraStatus>;
  },
  onVirtualCameraStatus(listener: (status: VirtualCameraStatus) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, status: VirtualCameraStatus): void => {
      listener(status);
    };
    ipcRenderer.on('shymask:vcam-status', handler);
    return () => ipcRenderer.removeListener('shymask:vcam-status', handler);
  },
};

contextBridge.exposeInMainWorld('shymask', bridge);
