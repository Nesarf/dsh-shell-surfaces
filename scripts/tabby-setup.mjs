#!/usr/bin/env node
// tabby-setup: give the dss Tabby surface its OWN Tabby instance.
//
// Why not the user's config: Tabby's CLI has `profile <name>` and a profile can
// carry command+args, but every `profile` open calls `bringToFront()` -- so
// driving the user's instance would yank their window forward on every call. And
// a "start minimized" flag does not exist (`start /min` hangs the caller, measured
// 2026-10-24), so the window has to be minimised after launch.
//
// The clean shape is a second instance with its own `--user-data-dir`: the user's
// Tabby is never touched, its config is never rewritten, and the window that
// exists belongs entirely to this tool. This script writes that instance's config
// once; it does NOT read or write the user's config at all.
//
// Usage: node scripts/tabby-setup.mjs [--check] [--undo]

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROFILE_NAME = 'dss';
const PROFILE_ID = '7f3a1c2e-d55a-4b1a-9c3e-0a1b2c3d4e5f';
const AGENT = join(import.meta.dirname, 'dss-tabby-agent.mjs');
export const INSTANCE_DIR = process.env.DSS_TABBY_DATA ?? 'E:\\DaShaoHuo\\cache\\tabby-dss';

function configFile() {
  return join(INSTANCE_DIR, 'config.yaml');
}

/**
 * A minimal config for the private instance. Tabby fills every other field from
 * its own defaults; what must be here is the profile this tool opens.
 * `process.execPath` rather than `node`: measured 2026-10-24, Tabby does not
 * resolve a bare command through PATH.
 */
function configText() {
  return [
    'version: 8',
    'profiles:',
    `  - id: ${PROFILE_ID}`,
    '    type: local',
    `    name: ${PROFILE_NAME}`,
    '    options:',
    `      command: '${process.execPath}'`,
    '      args:',
    `        - '${AGENT}'`,
    '      env: {}',
    '      cwd: null',
    '      pauseAfterExit: false',
    'groups: []',
    '',
  ].join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const undo = process.argv.includes('--undo');
  const file = configFile();

  if (check) {
    if (!existsSync(file)) {
      console.log(`the private Tabby instance is NOT set up (${file} is missing)`);
      return;
    }
    const text = readFileSync(file, 'utf8');
    console.log(text.includes(`name: ${PROFILE_NAME}`) ? 'the private Tabby instance is ready' : 'the config exists but has no dss profile');
    return;
  }

  if (undo) {
    // Removing the config is enough: the instance is disposable, and the user's
    // own Tabby was never part of this.
    if (existsSync(file)) {
      unlinkSync(file);
      console.log(`removed ${file}; the dss tabby surface will report absent until it is set up again`);
    } else {
      console.log('nothing to undo');
    }
    return;
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, configText(), 'utf8');
  console.log(`wrote the private Tabby config at ${file}`);
  console.log('the user\'s own Tabby config was not read or written');
}

main();
