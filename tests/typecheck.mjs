/**
 * [INPUT]: Imports node:child_process, node:fs, node:path, node:url.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for typecheck.mjs; tests use local synthetic inputs and isolated state.
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

// -- Two type environments ----------------------------------------------
for (const project of ['tsconfig.json', 'plugin/tsconfig.json']) {
  const { status } = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, project)], { stdio: 'inherit' });
  if (status !== 0) { process.stderr.write(`Type check failed: ${project}\n`); process.exit(1); }
}
process.stdout.write('Type checks passed: tsconfig.json (bin, src), plugin/tsconfig.json (plugin/main.js)\n');
