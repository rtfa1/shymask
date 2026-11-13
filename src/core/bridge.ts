/**
 * Shared types across the Electron main process, the preload bridge, and the
 * renderer. This module is erased at runtime except for constants.
 */

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

export interface StartupInfo {
  fixture: FixtureInfo;
}

export interface CaptureResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface ShymaskBridge {
  getStartupInfo(): Promise<StartupInfo>;
  recheckFixture(): Promise<FixtureInfo>;
  captureOutputPng(dataUrl: string): Promise<CaptureResult>;
}
