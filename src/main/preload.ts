import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureResult, FixtureInfo, ShymaskBridge, StartupInfo } from '../core/bridge';

const bridge: ShymaskBridge = {
  getStartupInfo(): Promise<StartupInfo> {
    return ipcRenderer.invoke('shymask:startup-info') as Promise<StartupInfo>;
  },
  recheckFixture(): Promise<FixtureInfo> {
    return ipcRenderer.invoke('shymask:recheck-fixture') as Promise<FixtureInfo>;
  },
  captureOutputPng(dataUrl: string): Promise<CaptureResult> {
    return ipcRenderer.invoke('shymask:capture-output', dataUrl) as Promise<CaptureResult>;
  },
};

contextBridge.exposeInMainWorld('shymask', bridge);
