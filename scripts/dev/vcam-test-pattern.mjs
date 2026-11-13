#!/usr/bin/env node
/**
 * Development-only frame source for the native virtual camera spike.
 *
 * The real app serves its output canvas over the same TCP protocol. This script
 * lets the native media source, host and consumer be validated independently of
 * Electron: it serves two alternating solid-colour frames at 30 Hz and writes
 * the listening port to %ProgramData%\Shymask\vcam-port.
 *
 * Usage: node scripts/dev/vcam-test-pattern.mjs [--port 48010] [--stop-after N]
 *
 * `--stop-after N` stops writing frames after N frames but keeps the client
 * connection open. That simulates a hung renderer so the native media source's
 * staleness bound can be checked: the consumer must switch from the coloured
 * test pattern to the opaque native paused fallback within a bounded time.
 */
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WIDTH = 1280;
const HEIGHT = 720;
const HEADER_BYTES = 40;
const MAGIC = 0x4d594853;

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const requestedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : 48010;
const stopAfterIndex = args.indexOf('--stop-after');
const requestedStopAfter = stopAfterIndex >= 0 ? Number(args[stopAfterIndex + 1]) : 0;
const stopAfter = Number.isFinite(requestedStopAfter) && requestedStopAfter > 0 ? requestedStopAfter : 0;

function buildFrame({ r, g, b }, captureUnixMs, sequence) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(WIDTH, 8);
  header.writeUInt32LE(HEIGHT, 12);
  header.writeUInt32LE(WIDTH * 4, 16);
  header.writeUInt32LE(WIDTH * HEIGHT * 4, 20);
  header.writeBigUInt64LE(BigInt(captureUnixMs), 24);
  header.writeBigUInt64LE(BigInt(sequence), 32);
  const payload = Buffer.allocUnsafe(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    payload[index * 4 + 0] = r;
    payload[index * 4 + 1] = g;
    payload[index * 4 + 2] = b;
    payload[index * 4 + 3] = 255;
  }
  return Buffer.concat([header, payload]);
}

const warm = buildFrame({ r: 210, g: 150, b: 90 }, Date.now(), 0);
const cool = buildFrame({ r: 70, g: 120, b: 200 }, Date.now(), 0);

const server = createServer((socket) => {
  console.log(`client connected from ${socket.remoteAddress}:${socket.remotePort}`);
  let sequence = 0;
  let sent = 0;
  let useWarm = true;
  const timer = setInterval(() => {
    const base = useWarm ? warm : cool;
    useWarm = !useWarm;
    base.writeBigUInt64LE(BigInt(Date.now()), 24);
    base.writeBigUInt64LE(BigInt(sequence++), 32);
    socket.write(base);
    sent += 1;
    if (stopAfter > 0 && sent >= stopAfter) {
      clearInterval(timer);
      console.log(`stopped sending after ${sent} frames (connection kept open)`);
    }
  }, 33);
  socket.on('close', () => {
    clearInterval(timer);
    console.log('client disconnected');
  });
  socket.on('error', () => clearInterval(timer));
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  const dataDirectory = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Shymask');
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(path.join(dataDirectory, 'vcam-port'), String(address.port), 'ascii');
  console.log(`serving ${WIDTH}x${HEIGHT} test frames on 127.0.0.1:${address.port}`);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
