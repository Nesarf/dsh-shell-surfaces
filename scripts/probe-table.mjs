// Turn the probe's JSON into a markdown table, and write it to the file GitHub
// Actions shows as the run's summary when CI points GITHUB_STEP_SUMMARY at one.
//
//   node scripts/probe-table.mjs probe.json
//   probe-all-shells.ps1 | node scripts/probe-table.mjs
//
// Two shapes are handled because the probe reports two families: execution
// surfaces answer a question, terminals only have a version to read.

import { appendFileSync, readFileSync } from 'node:fs';

const file = process.argv[2];
const raw = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const data = JSON.parse(raw);

const esc = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

const lines = [];
if (Array.isArray(data.shells) && data.shells.length > 0) {
  lines.push('### Execution surfaces', '', '| surface | ms | answer |', '| --- | ---: | --- |');
  for (const row of data.shells) {
    lines.push(`| ${esc(row.shell)} | ${esc(row.ms)} | ${esc(row.answer).slice(0, 200)} |`);
  }
  lines.push('');
}
if (Array.isArray(data.terminals) && data.terminals.length > 0) {
  lines.push('### Terminals (windows, not execution surfaces)', '', '| terminal | version | path |', '| --- | --- | --- |');
  for (const row of data.terminals) {
    lines.push(`| ${esc(row.terminal)} | ${esc(row.version)} | ${esc(row.path)} |`);
  }
  lines.push('');
}

const table = lines.join('\n');
process.stdout.write(`${table}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${table}\n`);
}
