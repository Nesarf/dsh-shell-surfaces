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
  const session = { key, argv, child, buffer: '', closed: false, exitCode: null, startedAt: Date.now(), lastUsed: Date.now() };
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
 * Close sessions that have been idle for longer than the given budget.
 *
 * A session is a real process, and nothing in this plugin closes one except
 * plugin unload -- so a long session that opens a few shells and then moves on
 * would hold them until the host restarts. The sweep runs before each session
 * call, which is the moment a caller is about to care how many are open.
 * @param maxIdleMs - idle time after which a session is closed.
 * @returns the keys that were closed, so a caller can say so.
 */
export function reapIdleSessions(maxIdleMs) {
  const now = Date.now();
  const closed = [];
  for (const [key, session] of [...pool.entries()]) {
    if (session.closed === true) {
      // A shell that exited on its own is not a session any more.
      pool.delete(key);
      continue;
    }
    const idleSince = session.lastUsed ?? session.startedAt ?? now;
    if (now - idleSince >= maxIdleMs) {
      dropSession(key);
      closed.push(key);
    }
  }
  return closed;
}

/**
 * Close every session belonging to one owner, without touching anyone else's.
 * @param ownerId - the agent id the sessions were opened for.
 * @returns the keys that were closed.
 */
export function dropOwnerSessions(ownerId) {
  const prefix = `${ownerId ?? 'anonymous'}\u0000`;
  const closed = [];
  for (const key of [...pool.keys()]) {
    if (!key.startsWith(prefix)) continue;
    dropSession(key);
    closed.push(key);
  }
  return closed;
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
  session.lastUsed = Date.now();
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
