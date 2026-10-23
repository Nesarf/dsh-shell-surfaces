#!/usr/bin/env node
// dss-tabby-agent: what a Tabby profile runs.
//
// Tabby has no `-e <program>` and no `new-tab -- <program>`, but it does have a
// CLI (`tabby profile <name>`) and a profile whose options carry `command` and
// `args`. Those are static, so the profile points at THIS script once, and every
// later call only rewrites the job file it reads. That is the opening: a fixed
// entry point, a per-call job, and a result file the caller polls.
//
// Job file (written by the caller, JSON):
//   { id, command, timeoutMs }
// Result file (`<job>.result`, written here, JSON):
//   { id, exitCode, timedOut, spawnError, durationMs, stdout, stderr, command }
//
// Both live beside each other, and the result is written atomically, so a reader
// never sees half a document.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const jobFile = process.env.DSS_TABBY_JOB ?? 'E:\\DaShaoHuo\\cache\\tmp\\dss-tabby-job.json';
const resultFile = `${jobFile}.result`;

// One line per launch, so "Tabby never started the agent" and "the agent started
// but could not read the job" are different sentences in a log instead of a
// guess. Not stdout: a Tabby tab closes on exit and would take it with it.
try {
  mkdirSync(dirname(jobFile), { recursive: true });
  appendFileSync(`${jobFile}.starts.log`, `${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))}\n`, 'utf8');
} catch {
  /* logging is a convenience, not the job */
}

function writeResult(value) {
  try {
    mkdirSync(dirname(resultFile), { recursive: true });
    const temp = `${resultFile}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(temp, resultFile);
  } catch {
    /* the caller reports "no result", which is the honest answer */
  }
}

function main() {
  let job;
  try {
    job = JSON.parse(readFileSync(jobFile, 'utf8'));
  } catch (error) {
    writeResult({ id: '', exitCode: null, timedOut: false, spawnError: `no readable job: ${error?.message ?? error}`, durationMs: 0, stdout: '', stderr: '', command: '' });
    process.exit(2);
  }
  const started = Date.now();
  const timeoutMs = Number(job.timeoutMs) > 0 ? Number(job.timeoutMs) : 120000;
  const command = String(job.command ?? '');
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true });
  const out = [];
  const err = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));

  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    writeResult({
      id: String(job.id ?? ''),
      exitCode: value.exitCode ?? null,
      timedOut: value.timedOut === true,
      spawnError: value.spawnError ?? '',
      durationMs: Date.now() - started,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      command,
    });
    process.exit(0);
  };

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    finish({ timedOut: true });
  }, timeoutMs);

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
