/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs, node:crypto, ../src/html/match.mjs, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for html match; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { match, blockscan } from '../src/html/match.mjs';
import { decodePng } from '../src/png.mjs';

const DIR = new URL('./fixtures/html/match/', import.meta.url);
const { fixtures } = JSON.parse(fs.readFileSync(new URL('expected.json', DIR), 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
// Solid-color image with optional pixel overrides: [[x, y, [r, g, b, a]], ...].
const solid = (width, height, color, edits = []) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  for (const [x, y, c] of edits) data.set(c, (y * width + x) * 4);
  return data;
};

test('Synthetic pairs match pixelmatch 7.2.0 counts, antialiasing, diff images, masks, and structural blocks, including transparency', () => {
  assert.ok(fixtures.length >= 7, 'Seven synthetic reference pairs cover geometry, glyphs, gradients, and transparency');
  for (const f of fixtures) {
    const a = decodePng(fs.readFileSync(new URL(`${f.name}.a.png`, DIR))), b = decodePng(fs.readFileSync(new URL(`${f.name}.b.png`, DIR)));
    assert.deepEqual([a.width, a.height], f.size, f.name);
    const m = match(a.data, b.data, a.width, a.height, { threshold: 0.1 });
    assert.deepEqual({ name: f.name, mismatched: m.mismatched, aa: m.aa, image: sha(m.image), mask: sha(m.mask) },
      { name: f.name, mismatched: f.mismatched, aa: f.aa, image: f.imageSha256, mask: f.maskSha256 });
    assert.deepEqual(blockscan(m.mask, a.width, a.height), f.blocks, f.name);
  }
  // Exercise transparency in at least four pairs, including alpha-shift's overlapping translucent shapes.
  const transparent = fixtures.filter(f => ['a', 'b'].some(s => decodePng(fs.readFileSync(new URL(`${f.name}.${s}.png`, DIR))).data.some((v, i) => i % 4 === 3 && v < 255)));
  assert.ok(transparent.length >= 4, transparent.map(f => f.name).join());
});

test('Synthetic boundaries: identical images yield zero and gray diff, one changed pixel counts once, gray delta 26/27 straddles YIQ threshold, and transparent RGB values are equivalent', () => {
  const gray = [128, 128, 128, 255], base = solid(9, 9, gray);
  const same = match(base, solid(9, 9, gray), 9, 9);
  assert.deepEqual([same.mismatched, same.aa, same.mask.every(v => v === 0)], [0, 0, true]);
  // Gray background: truncate 255 + (128 - 255) * 0.1 to 242.
  assert.deepEqual([...same.image.subarray(0, 4)], [242, 242, 242, 255]);

  const at = (delta, threshold) => match(base, solid(9, 9, gray, [[4, 4, [128 + delta, 128 + delta, 128 + delta, 255]]]), 9, 9, { threshold });
  assert.equal(at(26).mismatched, 0);
  const one = at(27);
  assert.deepEqual([one.mismatched, one.mask[4 * 9 + 4], [...one.image.subarray((4 * 9 + 4) * 4, (4 * 9 + 4) * 4 + 4)]], [1, 1, [255, 0, 0, 255]]);
  assert.equal(at(1, 0).mismatched, 1, 'Threshold 0 counts every difference');

  const clear = match(solid(4, 4, [0, 0, 0, 0]), solid(4, 4, [255, 255, 255, 0]), 4, 4);
  assert.equal(clear.mismatched, 0);
  assert.throws(() => match(base, solid(8, 8, gray), 9, 9), /Image sizes differ/);
  // Copy inputs that are not 4-byte aligned, such as pooled Buffer slices, before comparison.
  const shifted = new Uint8Array(base.length + 1); shifted.set(base, 1);
  assert.equal(match(shifted.subarray(1), base, 9, 9).mismatched, 0);
});

test('blockscan uses density 0.22 (57/256 passes, 56 fails), 8-connected merging, a 150 px reporting minimum, and descending difference counts', () => {
  const W = 96, H = 64;
  const mask = cells => {
    const m = new Uint8Array(W * H);
    // Fill n difference pixels per cell row by row from the upper-left corner.
    for (const [cx, cy, n] of cells) for (let k = 0; k < n; k++) m[(cy * 16 + (k / 16 | 0)) * W + cx * 16 + k % 16] = 1;
    return m;
  };
  assert.deepEqual(blockscan(mask([[0, 0, 56], [1, 0, 56], [2, 0, 56]]), W, H), [], 'Sparse cells do not form blocks');
  // Diagonally adjacent cells merge through 8-connectivity; a separate 100 px cell stays below the 150 px reporting threshold.
  assert.deepEqual(blockscan(mask([[0, 0, 100], [1, 1, 100], [4, 0, 100]]), W, H), [{ x: 0, y: 0, w: 32, h: 32, diffPx: 200 }]);
  const two = blockscan(mask([[0, 0, 57], [1, 0, 57], [2, 0, 57], [5, 3, 200]]), W, H);
  assert.deepEqual(two, [{ x: 0, y: 0, w: 48, h: 16, diffPx: 171 }, { x: 80, y: 48, w: 16, h: 16, diffPx: 200 }].sort((p, q) => q.diffPx - p.diffPx));
  // Antialiasing pixels (mask 2) do not count.
  assert.deepEqual(blockscan(mask([[0, 0, 200]]).map(v => v * 2), W, H), []);
});
