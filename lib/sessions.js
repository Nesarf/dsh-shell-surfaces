// Persistent surface sessions: one long-lived process per (owner, surface, name),
// with a random end marker that tells the reader where one command's output
// stops.
//
// Why a marker and not the prompt: these processes read a pipe, not a terminal,
// so the shells this plugin supports print no prompt at all. The marker is the
// only signal that is unambiguous in every one of them, and a nonce per command
// keeps a command's own text from being mistaken for it.
//
// What this deliberately is not: a terminal emulator. There is no scrollback,
// no cursor, no resize, and no prompt recognition -- only "write this line, read
// until the marker". A surface that needs a console uses the pty surface instead.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { decode } from './runner.js';

/** A session buffer is trimmed to this; a command's output above it is lossy, and says so. */
const MAX_BUFFER = 2 * 1024 * 1024;
const POLL_MS = 20;

const pool = new Map();

/** The key one session is addressed by: its owner, its surface, and its name. */
export function sessionKey(ownerId, surfaceId, name) {
  return `${ownerId ?? 'anonymous'}\u0000${surfaceId}\u0000${name}`;
}

/** The live session for a key, if one is open. */
export function getSession(key) {
  return pool.get(key);
}

/** Open one persistent surface process. */
export function openSession(key, argv, env, cwd) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd: cwd || undefined,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session = { key, argv, child, buffer: '', closed: false, exitCode: null, startedAt: Date.now() };
  const append = (chunk) => {
    session.buffer += decode(chunk);
    if (session.buffer.length > MAX_BUFFER) {
      session.buffer = session.buffer.slice(-Math.floor(MAX_BUFFER / 2));
      session.lossy = true;
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('close', (code) => {
    session.closed = true;
    session.exitCode = code;
  });
  child.on('error', () => {
    session.closed = true;
  });
  pool.set(key, session);
  return session;
}

/** End one session: kill the process and forget it. */
export function dropSession(key) {
  const session = pool.get(key);
  pool.delete(key);
  if (session === undefined) return false;
  try {
    session.child.stdin?.end();
  } catch {
    /* already closed */
  }
  try {
    session.child.kill();
  } catch {
    /* already gone */
  }
  return true;
}

/** End every session this plugin opened (plugin disposal, owner teardown). */
export function closeSessions() {
  for (const key of [...pool.keys()]) dropSession(key);
}

/**
 * Run one command in a session and wait for its end marker.
 * @param session - the persistent process.
 * @param command - the command text, written as its own line.
 * @param markerCommand - builds the marker line for this shell's syntax.
 * @param timeoutMs - how long to wait before returning what arrived.
 * @param signal - cancellation of the wait itself.
 * @returns the captured text, and how the wait ended.
 */
export function sendToSession(session, command, markerCommand, timeoutMs, signal) {
  const nonce = randomUUID().replaceAll('-', '');
  const marker = `__DSS_END_${nonce}__`;
  session.buffer = '';
  try {
    // The marker command is built from the NONCE, not from the finished marker
    // text: each surface's builder wraps the nonce in its own syntax, and
    // handing it the whole marker would print the prefix twice.
    session.child.stdin?.write(`${command}\n${markerCommand(nonce)}\n`);
  } catch (error) {
    return Promise.resolve({ text: session.buffer, timedOut: false, closed: true, error: String(error?.message ?? error) });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (signal?.aborted === true) {
        clearInterval(timer);
        resolve({ text: session.buffer, timedOut: false, aborted: true, closed: session.closed });
        return;
      }
      if (session.closed) {
        clearInterval(timer);
        resolve({ text: session.buffer, timedOut: false, closed: true, exitCode: session.exitCode });
        return;
      }
      const at = session.buffer.indexOf(marker);
      if (at === -1) {
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve({ text: session.buffer, timedOut: true, closed: false });
        }
        return;
      }
      clearInterval(timer);
      const text = session.buffer.slice(0, at);
      session.buffer = session.buffer.slice(at + marker.length);
      resolve({ text, timedOut: false, closed: false, durationMs: Date.now() - started, lossy: session.lossy === true });
    }, POLL_MS);
  });
}
