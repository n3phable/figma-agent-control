/**
 * [INPUT]: Exact devDependency versions from package.json and local typescript, @types/node, and @figma/plugin-typings; node:child_process spawnSync runs local tsc with the current Node executable.
 * [OUTPUT]: No exports; exits 0 when every type environment passes, or 1 for missing/mismatched dependencies or type errors.
 * [POS]: npm run check entry point: checks the host tsconfig, plugin globals, then isolated motion and prototype library environments with figma/target/data. Its filename excludes it from npm test, keeping tests and runtime independent of node_modules.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// -- Development dependencies ---------------------------------------------
// Only the locked local versions count: global tsc or stale node_modules can produce different diagnostics and cannot substitute.
/** @type {Record<string, string>} */
const pinned = read(path.join(root, 'package.json')).devDependencies;
const stale = Object.entries(pinned).filter(([name, version]) => {
  try { return read(path.join(root, 'node_modules', name, 'package.json')).version !== version; } catch { return true; }
}).map(([name, version]) => `${name}@${version}`);
if (stale.length) {
  process.stderr.write(`Type checking requires development dependencies; missing or mismatched: ${stale.join(', ')}.\nRun npm ci in ${root} (using package-lock.json), then retry. Runtime and npm test do not need these dependencies.\n`);
  process.exit(1);
}

// -- Type environments ----------------------------------------------------
for (const project of ['tsconfig.json', 'plugin/tsconfig.json', 'lib/tsconfig.json', 'lib/tsconfig.prototype.json']) {
  const { status } = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, project)], { stdio: 'inherit' });
  if (status !== 0) { process.stderr.write(`Type check failed: ${project}\n`); process.exit(1); }
}
process.stdout.write('Type checks passed: tsconfig.json (bin, src), plugin/tsconfig.json (plugin/main.js, extract.js), lib/tsconfig.json and lib/tsconfig.prototype.json (lib/*.js)\n');
