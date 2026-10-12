/**
 * [INPUT]: tests/helpers/doc extractDoc; tests/helpers/harness fakeFigma/pluginSource; src/html/generate generate/fontRequests; src/png pngSize; node:vm runs the real plugin/main.js.
 * [OUTPUT]: Exports extracted(id, job?) returning an independent { output, bytes } copy, run(output, options?) returning generate results, and handwritten KANIT metrics.
 * [POS]: Generator fixture shared by generation, attribution, suggestions, layout, rendering, command-layer suites, and local whole-output comparisons. Extracts the mock document in the real VM plugin, converts binary placeholders to file descriptors, and passes them to generate; handwritten metrics make results machine-independent.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { extractDoc } from './doc.mjs';
import { fakeFigma, pluginSource } from './harness.mjs';
import { generate, fontRequests } from '../../src/html/generate.mjs';
import { pngSize } from '../../src/png.mjs';

// -- Extraction -----------------------------------------------------------
// Same assembly as extract tests. Replace binary placeholders with persisted-file descriptors, detecting type from header bytes; retain bytes by sha256 for embedding.
async function extractFrame(id, job = {}) {
  const doc = extractDoc(), results = [];
  const figma = Object.assign(fakeFigma(doc, { onUi: raw => { let m = structuredClone(raw); if (m.type === 'serialized-result') m = JSON.parse(m.serialized); results.push(m); } }), doc.globals);
  vm.runInNewContext(pluginSource, { figma, __html__: '', setTimeout: () => 0, clearTimeout() {} });
  await figma.ui.onmessage({ id: 'job', channelNonce: 'n', operation: 'extract', binding: { fileKey: 'example', nodeId: id }, ...job });
  const r = results.find(m => m.id === 'job');
  assert.equal(r.ok, true, r.error);
  const bytes = {};
  const file = i => {
    const b = Buffer.from(r.binaries[i], 'base64'), sha256 = crypto.createHash('sha256').update(b).digest('hex'), png = b[0] === 0x89;
    const type = png ? 'png' : b.toString('utf8', 0, 4) === '<svg' ? 'svg' : 'bin';
    bytes[sha256] = b;
    return { file: `files/output-${i + 1}.${type}`, bytes: b.length, sha256, type, ...(png ? pngSize(b) : {}) };
  };
  const land = v => Array.isArray(v) ? v.map(land) : v && typeof v === 'object'
    ? ('__figmaAgentControlBinary' in v ? file(v.__figmaAgentControlBinary) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, land(x)]))) : v;
  return { output: land(r.output), bytes };
}
const cache = new Map();
// Each test receives an independent mutable copy.
export const extracted = async (id, job) => { const key = JSON.stringify([id, job]); if (!cache.has(key)) cache.set(key, await extractFrame(id, job)); return structuredClone(cache.get(key)); };

// Handwritten Kanit and SF Pro hhea metrics were checked against local font files. SF Pro Text resolves to a named variable-font instance whose name differs from the segment.
export const KANIT = { unitsPerEm: 1000, hhea: { ascender: 1100, descender: -395, lineGap: 0 } };
const SF = { unitsPerEm: 2048, hhea: { ascender: 1950, descender: -494, lineGap: 0 } };
const record = r => r.family === 'Kanit' ? { ...KANIT, postScriptName: 'Kanit-' + r.style } : r.family === 'SF Pro Text' ? { ...SF, postScriptName: 'SFPro-' + r.style } : null;
const fontsOf = output => Object.fromEntries(fontRequests(output).map(r => [r.key, record(r)]));
export const run = (output, options = {}) => generate(output, { fonts: fontsOf(output), ...options });
