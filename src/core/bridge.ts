/**
 * Shared types across the Electron main process, the preload bridge, and the
 * renderer. This module is erased at runtime except for constants.
 */

import type {
  EffectPackageList,
  ImportEffectPackageResult,
  RemoveEffectPackageResult,
} from './effect-package-contract';

export type {
  ColorTreatmentParameters,
  EffectPackageAuthor,
  EffectPackageList,
  ImportEffectPackageResult,
  InstalledEffectPackage,
  MaskAttachment,
  PackageComplexity,
  PackageIssue,
  RemoveEffectPackageResult,
} from './effect-package-contract';

export interface FixtureMetadata {
  /** Stable identifier for the exact clip revision. */
  id: string;
  title: string;
  fileName: string;
  sourcePage: string;
  originalUrl: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  sha256: string;
  bytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  notes: string;
}

export type FixtureState = 'checking' | 'ready' | 'missing' | 'invalid';

export interface FixtureInfo {
  state: FixtureState;
  metadata: FixtureMetadata | null;
  /** file:// URL the renderer can hand to a <video> element. */
  videoUrl?: string;
  /** Human-readable explanation, always present when state is missing/invalid. */
  message?: string;
  /** Actionable next step shown in the app status area. */
  action?: string;
}

/** Committed metadata for the checksum-pinned Face Landmarker model. */
export interface TrackerMetadata {
  /** Stable identifier for the exact model revision. */
  id: string;
  /** Human-readable model version, for diagnostics and docs. */
  version: string;
  fileName: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  sha256: string;
  bytes: number;
  notes: string;
}

export type TrackerState = 'checking' | 'ready' | 'missing' | 'invalid' | 'error';

/**
 * Face-tracker asset state. The renderer loads the WASM fileset and model from
 * the app's local asset protocol; a missing or corrupt model hides the output
 * with an actionable explanation and never falls back to a camera.
 */
export interface TrackerInfo {
  state: TrackerState;
  metadata: TrackerMetadata | null;
  /** `shymask://app/tracker/vision_wasm_*` base URL passed to FilesetResolver. */
  wasmBaseUrl?: string;
  /** `shymask://app/tracker/face_landmarker.task` model URL. */
  modelUrl?: string;
  /** Human-readable explanation, always present when state is not ready. */
  message?: string;
  /** Actionable next step shown in the app status area. */
  action?: string;
}

export interface StartupInfo {
  fixture: FixtureInfo;
  tracker: TrackerInfo;
  /** Validated effect packages persisted under the app's package store. */
  effectPackages: EffectPackageList;
}

export interface CaptureResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * One RGBA output frame leaving the renderer. The buffer is copied per frame by
 * the structured-clone IPC send (`ipcRenderer.send`; a transfer would detach
 * the renderer's buffer): 1280×720 RGBA is 3.7 MB, ~110 MB/s at the 30 Hz
 * publish cap. The copy is part of the measured replay-to-camera latency in the
 * README baseline; it is not separately instrumented. The main process forwards
 * the frame to the native virtual camera media source over the loopback frame
 * transport.
 */
export interface CameraFrame {
  /** Wall-clock time (Date.now) when the canvas produced this frame. */
  captureUnixMs: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export type VirtualCameraState = 'starting' | 'publishing' | 'stopped' | 'error' | 'unavailable';

/** Status of the Windows virtual camera integration, shown in the app. */
export interface VirtualCameraStatus {
  state: VirtualCameraState;
  /** Device name Windows enumerates for consumers. */
  friendlyName: string;
  /** True when the OS camera enumeration includes the camera. */
  enumerable: boolean;
  /** Number of camera media-source clients connected to the app. */
  clients: number;
  /** Output frames handed to the transport since launch. */
  framesPublished: number;
  /** Loopback port the camera media source connects to, when listening. */
  port: number | null;
  hostPid: number | null;
  message: string;
  /** Actionable next step for an operator, when the state is not healthy. */
  action: string | null;
  /** HRESULT string from the native host for a failed camera registration. */
  hresult: string | null;
}

export interface ShymaskBridge {
  getStartupInfo(): Promise<StartupInfo>;
  recheckFixture(): Promise<FixtureInfo>;
  /** Re-read validated packages from the persisted store (survives restart). */
  getEffectPackages(): Promise<EffectPackageList>;
  /** Opens the OS file picker, validates and stores the chosen package. */
  importEffectPackage(): Promise<ImportEffectPackageResult>;
  /** Removes an imported package from the persisted store. */
  removeEffectPackage(id: string): Promise<RemoveEffectPackageResult>;
  captureOutputPng(dataUrl: string): Promise<CaptureResult>;
  publishCameraFrame(frame: CameraFrame): void;
  getVirtualCameraStatus(): Promise<VirtualCameraStatus>;
  restartVirtualCamera(): Promise<VirtualCameraStatus>;
  onVirtualCameraStatus(listener: (status: VirtualCameraStatus) => void): () => void;
}
