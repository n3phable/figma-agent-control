/**
 * [INPUT]: src/html/match match/blockscan/crop/differing/upscale/stack; src/png decodePng; helpers/match PNG pairs and expected.json generated with pixelmatch 7.2.0.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Matches reproducible synthetic reference pairs against upstream pixelmatch counts, antialiasing, diff/mask hashes, and structural blocks. Focused cases cover identical/single-pixel/YIQ/transparent boundaries, block density and 8-connectivity, RGBA crop copy/bounds, shifted comparison with transparent overflow and early exit, nearest-neighbor scaling, and vertical stacking.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { match, blockscan, crop, differing, upscale, stack } from '../src/html/match.mjs';
import { decodePng } from '../src/png.mjs';

const DIR = new URL('./helpers/match/', import.meta.url);
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

test('crop copies a half-open rectangle into independent packed RGBA rows and rejects empty, out-of-bounds, or noninteger rectangles', () => {
  // A 3x2 image uses pixel ordinal i as [i, i, i, 255].
  const img = new Uint8Array(24);
  for (let i = 0; i < 6; i++) img.set([i, i, i, 255], i * 4);
  const out = crop(img, 3, [1, 0, 3, 2]);
  assert.deepEqual([...out].filter((_, i) => i % 4 === 0), [1, 2, 4, 5]);
  out[0] = 99;
  assert.equal(img[4], 1);
  assert.deepEqual([...crop(img, 3, [0, 1, 3, 2])].filter((_, i) => i % 4 === 0), [3, 4, 5]);
  for (const rect of [[0, 0, 0, 1], [2, 0, 4, 1], [0, 1, 1, 3], [-1, 0, 1, 1], [0.5, 0, 2, 1]]) assert.throws(() => crop(img, 3, rect), /Crop rectangle is outside the image/, String(rect));
});

test('differing at zero equals match mismatched + aa, aligned shifts yield zero, overflow is transparent, and counting stops at limit', () => {
  for (const f of fixtures) {
    const a = decodePng(fs.readFileSync(new URL(`${f.name}.a.png`, DIR))), b = decodePng(fs.readFileSync(new URL(`${f.name}.b.png`, DIR)));
    const m = match(a.data, b.data, a.width, a.height);
    assert.equal(differing(a.data, b.data, a.width, a.height, [0, 0, a.width, a.height], 0, 0), m.mismatched + m.aa, f.name);
  }
  // 6x4: pixels in a contain their column number; b shifts a right by two columns with gray padding.
  const a = new Uint8Array(96), b = new Uint8Array(96);
  for (let i = 0; i < 24; i++) { const x = i % 6; a.set([x * 40, 0, 0, 255], i * 4); b.set(x < 2 ? [128, 128, 128, 255] : [(x - 2) * 40, 0, 0, 255], i * 4); }
  assert.equal(differing(a, b, 6, 4, [0, 0, 4, 4], 2, 0), 0, 'a(x, y) equals b(x + 2, y)');
  assert.equal(differing(a, b, 6, 4, [0, 0, 6, 4], 2, 0), 8, 'The last two columns fall outside b and compare transparent against opaque a');
  assert.equal(differing(new Uint8Array(96), b, 6, 4, [0, 0, 6, 4], 0, 9), 0, 'Transparent pixels equal out-of-bounds transparency');
  assert.equal(differing(a, b, 6, 4, [0, 0, 6, 4], 0, 0), 24, 'Every column differs without a shift');
  assert.equal(differing(a, b, 6, 4, [0, 0, 6, 4], 0, 0, 0.1, 5), 5);
});

test('upscale uses nearest-neighbor pixels; stack joins equal-width RGBA images vertically with four transparent rows between them', () => {
  const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], clear = [0, 0, 0, 0];
  const px = img => Array.from({ length: img.length / 4 }, (_, i) => [...img.subarray(i * 4, i * 4 + 4)]);
  assert.deepEqual(px(upscale(Uint8Array.from([...red, ...blue]), 2, 1, 2)), [red, red, blue, blue, red, red, blue, blue]);
  assert.deepEqual(px(stack([Uint8Array.from(red), Uint8Array.from(blue)], 1)), [red, clear, clear, clear, clear, blue]);
  assert.deepEqual(px(stack([Uint8Array.from(red)], 1)), [red]);
});
