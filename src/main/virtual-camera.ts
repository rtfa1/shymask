import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import type { CameraFrame, VirtualCameraStatus } from '../core/bridge';

/** Mirrors native/shymask-vcam/protocol.h. */
const FRAME_MAGIC = 0x4d594853;
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 40;
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 4;
const FRAME_STRIDE = FRAME_WIDTH * 4;
const PORT_RANGE = Array.from({ length: 10 }, (_, index) => 48010 + index);
const FRIENDLY_NAME = 'Shymask Camera';
const CONNECTED_CLIENTS_LIMIT = 8;

export interface VirtualCameraOptions {
  /** Repository root; the development build lives under build/native. */
  repoRoot: string;
  /** Directory shared with the native media source (defaults to %ProgramData%\Shymask). */
  dataDirectory?: string;
  onStatus?: (status: VirtualCameraStatus) => void;
}

type HostEvent =
  | { event: 'camera-started'; friendlyName?: string; enumerable?: boolean }
  | { event: 'camera-stopped' }
  | { event: 'error'; code?: string; message?: string; hresult?: string };

/**
 * Owns the Windows virtual camera from the app side:
 * - serves the renderer's output canvas over a loopback frame transport,
 * - spawns and supervises the native camera host (registrar + session camera),
 * - reports an in-app status, and stops the camera when the app quits.
 *
 * All Windows camera API work stays in the native host/media source; this class
 * only knows about a TCP frame protocol and a child process.
 */
export class VirtualCameraPublisher {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly sockets = new Set<Socket>();
  private host: ChildProcessWithoutNullStreams | null = null;
  private hostBuffer = '';
  private framesPublished = 0;
  private lastStatusAt = 0;
  private stopping = false;
  private status: VirtualCameraStatus = {
    state: 'starting',
    friendlyName: FRIENDLY_NAME,
    enumerable: false,
    clients: 0,
    framesPublished: 0,
    port: null,
    hostPid: null,
    message: 'Starting the Windows virtual camera…',
    action: null,
    hresult: null,
  };

  constructor(private readonly options: VirtualCameraOptions) {}

  getStatus(): VirtualCameraStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    await this.startServer();
    this.startHost();
  }

  async restart(): Promise<VirtualCameraStatus> {
    if (this.stopping) return this.getStatus();
    await this.stopHost();
    if (!this.server) await this.startServer();
    this.startHost();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.stopHost();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = null;
    if (this.port !== null) {
      try {
        rmSync(path.join(this.dataDirectory(), 'vcam-port'), { force: true });
      } catch {
        // Best effort: a stale port file only makes the media source retry.
      }
    }
    this.emit({
      state: 'stopped',
      enumerable: false,
      clients: 0,
      port: null,
      hostPid: null,
      message: 'Shymask has closed; its virtual camera output has stopped.',
      action: null,
    });
  }

  /**
   * Sends one output canvas frame (processed or the exact opaque paused
   * screen) to every camera media-source client. Frames are dropped when no
   * camera is consuming them.
   */
  publishFrame(frame: CameraFrame): void {
    if (!this.server || this.sockets.size === 0) return;
    if (frame.width !== FRAME_WIDTH || frame.height !== FRAME_HEIGHT) return;
    if (!(frame.data instanceof ArrayBuffer) || frame.data.byteLength !== FRAME_BYTES) return;

    const captureUnixMs = Number.isFinite(frame.captureUnixMs) ? frame.captureUnixMs : Date.now();
    const sequence = this.framesPublished;
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32LE(FRAME_MAGIC, 0);
    header.writeUInt16LE(FRAME_VERSION, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt32LE(FRAME_WIDTH, 8);
    header.writeUInt32LE(FRAME_HEIGHT, 12);
    header.writeUInt32LE(FRAME_STRIDE, 16);
    header.writeUInt32LE(FRAME_BYTES, 20);
    header.writeBigUInt64LE(BigInt(Math.round(captureUnixMs)), 24);
    header.writeBigUInt64LE(BigInt(sequence), 32);
    const payload = new Uint8Array(frame.data);

    let sent = false;
    for (const socket of this.sockets) {
      if (socket.destroyed) continue;
      // Do not queue more than a couple of frames behind a slow camera client.
      if (socket.writableLength > FRAME_BYTES * 2) continue;
      socket.write(header);
      socket.write(payload);
      sent = true;
    }
    if (!sent) return;
    this.framesPublished += 1;
    const now = Date.now();
    if (now - this.lastStatusAt >= 500) {
      this.lastStatusAt = now;
      this.emit({ framesPublished: this.framesPublished, clients: this.sockets.size });
    }
  }

  private emit(patch: Partial<VirtualCameraStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatus?.(this.getStatus());
  }

  private dataDirectory(): string {
    return this.options.dataDirectory ?? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Shymask');
  }

  private async startServer(): Promise<void> {
    for (const candidate of PORT_RANGE) {
      const server = createServer();
      const listening = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(candidate, '127.0.0.1', () => resolve(true));
      });
      if (!listening) {
        server.close();
        continue;
      }
      this.server = server;
      this.port = candidate;
      server.on('connection', (socket) => this.acceptClient(socket));
      server.on('error', (error) => {
        this.emit({
          state: 'error',
          message: `Frame transport failed: ${error.message}`,
          action: 'Press Restart virtual camera.',
          hresult: null,
        });
      });
      this.writePortFile(candidate);
      this.emit({ port: candidate });
      return;
    }
    this.emit({
      state: 'error',
      message: 'No loopback port in the 48010–48019 range is available for the virtual camera.',
      action: 'Close the other camera instance and press Restart virtual camera.',
      hresult: null,
    });
  }

  private acceptClient(socket: Socket): void {
    if (this.sockets.size >= CONNECTED_CLIENTS_LIMIT) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on('data', () => {
      // The media source never writes to the app; drain and ignore.
    });
    socket.on('error', () => this.sockets.delete(socket));
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.emit({ clients: this.sockets.size });
    });
    this.emit({ clients: this.sockets.size });
  }

  private writePortFile(port: number): void {
    try {
      const directory = this.dataDirectory();
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'vcam-port'), String(port), 'ascii');
    } catch {
      // The media source also probes 48010–48019, so a missing port file is not fatal.
    }
  }

  private resolveHostPath(): string | null {
    const installed = path.join(this.dataDirectory(), 'bin', 'shymask-vcam-host.exe');
    if (existsSync(installed)) return installed;
    const built = path.join(this.options.repoRoot, 'build', 'native', 'shymask-vcam-host.exe');
    return existsSync(built) ? built : null;
  }

  private startHost(): void {
    const hostPath = this.resolveHostPath();
    if (!hostPath) {
      this.emit({
        state: 'unavailable',
        message:
          'The Windows virtual camera host is not installed, so no camera is published. The preview keeps working.',
        action: 'Run `npm run vcam:install` once (elevated for the machine-wide registration), then press Restart virtual camera.',
        hresult: null,
      });
      return;
    }

    this.emit({
      state: 'starting',
      message: 'Registering the Shymask Camera virtual webcam…',
      action: null,
      hresult: null,
      enumerable: false,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(hostPath, ['run'], {
        cwd: this.options.repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.emit({
        state: 'error',
        message: `Could not start the virtual camera host: ${(error as Error).message}`,
        action: 'Run `npm run build:native` and `npm run vcam:install`, then press Restart virtual camera.',
        hresult: null,
      });
      return;
    }

    this.host = child;
    this.hostBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onHostOutput(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {
      // The native host logs details to %ProgramData%\Shymask\vcam.log.
    });
    child.on('error', (error) => {
      if (this.host === child) this.host = null;
      this.emit({
        state: 'error',
        message: `The virtual camera host could not run: ${error.message}`,
        action: 'Run `npm run build:native` and `npm run vcam:install`, then press Restart virtual camera.',
        hresult: null,
      });
    });
    child.on('exit', (code) => {
      if (this.host === child) this.host = null;
      if (this.stopping) return;
      this.emit({
        state: 'error',
        enumerable: false,
        hostPid: null,
        message: `The virtual camera host stopped unexpectedly (exit ${code ?? 'unknown'}).`,
        action: 'Press Restart virtual camera. Details are in %ProgramData%\\Shymask\\vcam.log.',
        hresult: null,
      });
    });
    this.emit({ hostPid: child.pid ?? null });
  }

  private onHostOutput(chunk: string): void {
    this.hostBuffer += chunk;
    for (let index = this.hostBuffer.indexOf('\n'); index >= 0; index = this.hostBuffer.indexOf('\n')) {
      const line = this.hostBuffer.slice(0, index).trim();
      this.hostBuffer = this.hostBuffer.slice(index + 1);
      if (!line) continue;
      let event: HostEvent;
      try {
        event = JSON.parse(line) as HostEvent;
      } catch {
        continue;
      }
      this.handleHostEvent(event);
    }
  }

  private handleHostEvent(event: HostEvent): void {
    if (event.event === 'camera-started') {
      this.emit({
        state: 'publishing',
        friendlyName: event.friendlyName ?? FRIENDLY_NAME,
        enumerable: event.enumerable ?? false,
        message: 'Shymask Camera is registered. Other apps can select it and receive the same output as the preview.',
        action: null,
        hresult: null,
      });
      return;
    }
    if (event.event === 'camera-stopped') {
      this.emit({
        state: 'stopped',
        enumerable: false,
        message: 'The virtual camera was stopped.',
        action: null,
      });
      return;
    }
    if (event.event === 'error') {
      const hresult = event.hresult ?? null;
      let action =
        'Press Restart virtual camera. Details are in %ProgramData%\\Shymask\\vcam.log.';
      if (hresult === '0x80070003' || hresult === '0x80040154') {
        action =
          'The machine-wide camera registration is missing or stale. Run `npm run vcam:install` once from an elevated prompt, then press Restart virtual camera.';
      } else if (hresult === '0x80070005') {
        action =
          'Windows camera privacy is blocking access. Allow desktop apps to use the camera, then press Restart virtual camera.';
      }
      this.emit({
        state: 'error',
        enumerable: false,
        message: event.message ?? 'The virtual camera could not be started.',
        action,
        hresult,
      });
    }
  }

  private async stopHost(): Promise<void> {
    const child = this.host;
    this.host = null;
    if (!child) return;
    try {
      child.stdin.write('stop\n');
    } catch {
      // The child may already have exited.
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
