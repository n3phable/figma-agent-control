/**
 * [INPUT]: Imports node:child_process, node:fs, node:os, node:path, node:url.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for contract samples.mjs; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)), runs = process.argv[2];
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
if (!runs) { process.stderr.write('Usage: node tests/contract-samples.mjs <.figma-agent-control/runs directory>\n'); process.exit(2); }
if (!fs.existsSync(tsc)) { process.stderr.write(`Missing development dependencies: run npm ci in ${root} and retry\n`); process.exit(1); }

const results = fs.readdirSync(runs).sort().map(id => path.join(runs, id)).filter(dir => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')).operation === 'extract' && fs.existsSync(path.join(dir, 'result.json')); } catch { return false; }
});
if (!results.length) { process.stderr.write(`${runs} contains no extract result.json files\n`); process.exit(1); }

// Write each result.json as a typed .mts file: annotations check excess keys, like satisfies, and validate each literal value.
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-contract-'));
try {
  const files = results.map(dir => {
    const file = path.join(out, `${path.basename(dir)}.mts`);
    fs.writeFileSync(file, `import type { ExtractResult } from ${JSON.stringify(path.join(root, 'src/html/extract-contract.js'))};\nexport const r: ExtractResult = ${fs.readFileSync(path.join(dir, 'result.json'), 'utf8')};\n`);
    return file;
  });
  const compilerOptions = { noEmit: true, strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2024', lib: ['es2024'], types: [], skipLibCheck: true };
  fs.writeFileSync(path.join(out, 'tsconfig.json'), JSON.stringify({ compilerOptions, files }));
  const { status } = spawnSync(process.execPath, [tsc, '-p', path.join(out, 'tsconfig.json')], { stdio: 'inherit' });
  process.stdout.write(`${files.length} extract results: ${status === 0 ? 'all satisfy the contract' : 'contract violations found; see diagnostics above'}\n`);
  process.exitCode = status === 0 ? 0 : 1;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
