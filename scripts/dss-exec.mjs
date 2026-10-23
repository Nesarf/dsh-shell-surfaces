#!/usr/bin/env node
// dss-exec: the shim a terminal program (or anything else that can only START a
// process) launches so its result can come back.
//
// A terminal window answers nothing: it draws a program and keeps the output to
// itself. This shim is the physical piece that changes that -- it runs one
// command, forwards every byte to the screen as usual, and writes a structured
// result beside itself. The caller polls that file instead of guessing at a
// window's contents.
//
// Usage:
//   node dss-exec.mjs --out <result.json> [--timeout <ms>] [--shell cmd|sh] --cmd "<command>"
//
// The result file is written atomically (temp file + rename), so a reader never
// sees half a JSON document.

import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function parseArgs(argv) {
  const options = { out: '', timeoutMs: 120000, shell: process.platform === 'win32' ? 'cmd' : 'sh', command: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.command = argv.slice(i + 1).join(' ');
      break;
    }
    if (arg === '--out' || arg === '--timeout' || arg === '--shell' || arg === '--cmd') {
      const value = argv[i + 1] ?? '';
      i += 1;
      if (arg === '--out') options.out = value;
      else if (arg === '--timeout') options.timeoutMs = Number(value) || options.timeoutMs;
      else if (arg === '--shell') options.shell = value;
      else options.command = value;
      continue;
    }
    // Anything else is the command itself: `--` is not required.
    options.command = argv.slice(i).join(' ');
    break;
  }
  return options;
}

function writeResult(out, value) {
  if (out === '') return;
  try {
    mkdirSync(dirname(out), { recursive: true });
    const temp = `${out}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(temp, out);
  } catch {
    /* the caller will report "no result", which is the honest answer */
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const argv =
    options.shell === 'cmd' ? ['cmd', ['/d', '/s', '/c', options.command]] : ['sh', ['-c', options.command]];

  let child;
  try {
    child = spawn(argv[0], argv[1], { windowsHide: true });
  } catch (error) {
    const result = {
      exitCode: null,
      timedOut: false,
      spawnError: String(error?.message ?? error),
      durationMs: Date.now() - started,
      stdout: '',
      stderr: '',
      command: options.command,
    };
    writeResult(options.out, result);
    process.stderr.write(`${result.spawnError}\n`);
    process.exit(2);
  }

  const out = [];
  const err = [];
  child.stdout.on('data', (chunk) => {
    out.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    err.push(chunk);
    process.stderr.write(chunk);
  });

  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    const result = {
      exitCode: value.exitCode ?? null,
      timedOut: value.timedOut === true,
      spawnError: value.spawnError ?? '',
      durationMs: Date.now() - started,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      command: options.command,
    };
    writeResult(options.out, result);
    process.exit(result.timedOut ? 124 : (result.exitCode ?? 1));
  };

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    finish({ timedOut: true });
  }, Math.max(1000, options.timeoutMs));

  child.on('error', (error) => {
    clearTimeout(timer);
    finish({ spawnError: String(error?.message ?? error) });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    finish({ exitCode: code });
  });
}

main();
