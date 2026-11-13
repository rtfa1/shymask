import type { ShymaskBridge } from '../core/bridge';

declare global {
  interface Window {
    shymask: ShymaskBridge;
  }
}

export {};
