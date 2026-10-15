// What the surfaces look like on the machine running this: one line per surface,
// present or absent with the path that was looked for. Useful on its own, and it
// gives CI a first step that fails loudly if the table cannot even be loaded.
//
//   node scripts/which-surfaces.mjs

import { resolveSurfaces } from '../lib/surfaces.js';

const surfaces = resolveSurfaces();
for (const [id, spec] of Object.entries(surfaces)) {
  const state = spec.present ? 'present' : `absent (looked for ${spec.absent})`;
  console.log(`${id.padEnd(6)} ${spec.kind.padEnd(8)} ${state}`);
}
const present = Object.values(surfaces).filter((s) => s.present).length;
console.log(`\n${present} of ${Object.keys(surfaces).length} surfaces are on this machine.`);
