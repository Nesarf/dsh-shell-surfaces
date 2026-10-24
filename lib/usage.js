// How often each face has actually been used.
//
// The treemap's weights are the one place in this plugin where a number would make
// the picture say more than "these are all faces": a face used daily is not the same
// as one that exists and is never called, and equal cells pretend they are. The
// count is kept here rather than derived per call, because a derived number would be
// a guess about the past.
//
// The file lives beside the harness home (or in the temp directory when there is no
// home to write to). It is a cache, not a ledger: losing it costs the map its
// weighting, never a run.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const FILE = process.env.DSH_USAGE_FILE ?? join(process.env.DSH_HOME ?? tmpdir(), 'shell-surfaces-usage.json');

/** Where the counts are kept. Exposed so a test can point it somewhere harmless. */
export function usagePath() {
  return FILE;
}

let cache = null;

/**
 * The whole count map, read once per process.
 *
 * A malformed file is treated as empty rather than as an error: a count is a hint for
 * a drawing, and refusing to start over a corrupted hint would trade a cosmetic
 * problem for a real one.
 */
export function readUsage() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    cache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * Count one use of a face. A failure to write is swallowed on purpose -- the count
 * exists to make a picture better, and a picture is not worth failing a command over.
 * @param id - the surface id that ran.
 */
export function recordUse(id) {
  if (typeof id !== 'string' || id === '') return;
  const usage = readUsage();
  usage[id] = (typeof usage[id] === 'number' ? usage[id] : 0) + 1;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const temporary = `${FILE}.tmp`;
    // Written through a rename so a half-written file cannot be read back as a count.
    writeFileSync(temporary, `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
    renameSync(temporary, FILE);
  } catch {
    /* a count that cannot be persisted is not a run that should fail */
  }
}

/** How many times a face has run on this machine. */
export function usesOf(id) {
  const usage = readUsage();
  return typeof usage[id] === 'number' ? usage[id] : 0;
}

/** Drop the in-process copy so the next read sees the file as it is now. */
export function forgetUsage() {
  cache = null;
}
