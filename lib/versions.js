// Which version each collected face is, asked of the face itself.
//
// The table already answered "is it here?" and "where is it?". It could not answer
// "which version?", and that is the question that comes up the moment a script
// behaves differently on two machines -- or the moment a shell is upgraded and the
// only trace is a `--help` that now lists a flag it did not before.
//
// Asking costs one process per face, so the answer is cached and refreshed when
// asked for, never on the way past.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSurface } from './runner.js';

const FILE = process.env.DSH_VERSIONS_FILE ?? join(process.env.DSH_HOME ?? tmpdir(), 'shell-surfaces-versions.json');

/** Where the cached versions live. */
export function versionsPath() {
  return FILE;
}

let cache = null;

/**
 * The cached version map, read once per process.
 *
 * A malformed file is treated as empty rather than as an error: a version string is
 * a hint for a person, and refusing to start over a corrupted hint would trade a
 * cosmetic problem for a real one.
 */
export function readVersions() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    cache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(map) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const temporary = `${FILE}.tmp`;
    // Written through a rename so a half-written file cannot be read back as a version.
    writeFileSync(temporary, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    renameSync(temporary, FILE);
  } catch {
    /* a version that cannot be cached is not a run that should fail */
  }
}

/** The first line of a result, which is where a version string lives for every tool here. */
function firstLineOf(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.slice(0, 120);
  }
  return '';
}

/**
 * Ask every present face that knows how to answer, and cache the answers.
 *
 * A face opts in with `versionCommand`, written in that face's own language: asking
 * `bash` for its version and asking `nu` for its version are different commands, and
 * a single guessed flag would get one of them wrong. A face without one is left out
 * rather than guessed at -- `wt --version` opens a window, which is exactly the
 * failure this table has already paid for once.
 *
 * @param surfaces - the resolved table.
 * @param options - `concurrency` (default 6) and `timeoutMs` (default 12 s).
 * @returns the answers from this pass, plus everything known.
 */
export async function probeVersions(surfaces, options = {}) {
  const known = readVersions();
  const probed = {};
  const ids = Object.keys(surfaces).filter((id) => {
    const spec = surfaces[id];
    return spec.present === true && typeof spec.versionCommand === 'string' && spec.versionCommand !== '';
  });
  const concurrency = Math.max(1, Math.min(Number(options.concurrency ?? 6) || 6, 12));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 12000) || 12000);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      const spec = surfaces[id];
      const at = new Date().toISOString();
      try {
        const result = await runSurface(id, spec, {
          command: spec.versionCommand,
          script: '',
          cwd: '',
          send: [],
          timeoutMs,
          maxOutputChars: 4000,
        });
        probed[id] = { version: firstLineOf(result), at };
      } catch (error) {
        probed[id] = { version: '', at, error: String(error?.message ?? error).slice(0, 120) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(ids.length, 1)) }, worker));
  const merged = { ...known, ...probed };
  save(merged);
  cache = merged;
  return { probed, known: merged, asked: ids.length };
}
