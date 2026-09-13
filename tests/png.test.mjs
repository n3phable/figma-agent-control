/**
 * [INPUT]: Imports node:test, node:assert/strict, node:zlib, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for png; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, encodePng } from '../src/png.mjs';

// -- PNG construction -----------------------------------------------------
// Apply PNG forward filters per row: subtract the predictor from each sample; left, above, and upper-left come from original samples, with zero outside bounds.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
function png({ width, height, colorType, samples, filters, plte, trns }) {
  const ch = CHANNELS[colorType], stride = width * ch, raw = Buffer.alloc((stride + 1) * height);
  const at = (x, y) => x < 0 || y < 0 ? 0 : samples[y * stride + x];
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length]; raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const left = at(x - ch, y), up = at(x, y - 1), corner = at(x - ch, y - 1);
      raw[y * (stride + 1) + 1 + x] = (at(x, y) - [0, left, up, (left + up) >> 1, paeth(left, up, corner)][f] + 512) & 0xff;
    }
  }
  const chunk = (type, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, 'latin1'); return Buffer.concat([head, body, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr.set([8, colorType, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []),
    ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Deterministic pseudorandom samples include values near 0 and 255 to exercise modular wraparound.
const samples = (n, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (seed = (seed * 1103515245 + 12345) >>> 0) % 7 === 0 ? 255 : seed >>> 24);

test('All five row filters decode to original samples at first-row, first-pixel, and interior positions', () => {
  for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4], [4, 3, 2, 1, 0]]) {
    for (const [width, height] of [[1, 1], [1, 5], [7, 5], [16, 3]]) {
      const data = samples(width * height * 4, width * 31 + height + filters[0]);
      const decoded = decodePng(png({ width, height, colorType: 6, samples: data, filters }));
      assert.deepEqual([decoded.width, decoded.height], [width, height]);
      assert.deepEqual(decoded.data, data, `filter ${filters} · ${width}×${height}`);
    }
  }
});

test('Color types expand to RGBA: 16-bit RGB/grayscale keys, grayscale + alpha, palettes, and palette transparency', () => {
  const rgb = Uint8Array.from([10, 20, 30, 0, 7, 0, 0, 7, 1, 255, 255, 255]);
  // Key (0,7,0) makes only exact matches transparent; a nonzero high byte never matches an 8-bit sample.
  assert.deepEqual([...decodePng(png({ width: 4, height: 1, colorType: 2, samples: rgb, filters: [1], trns: [0, 0, 0, 7, 0, 0] })).data],
    [10, 20, 30, 255, 0, 7, 0, 0, 0, 7, 1, 255, 255, 255, 255, 255]);
  assert.equal(decodePng(png({ width: 4, height: 1, colorType: 2, samples: rgb, filters: [0], trns: [1, 0, 0, 7, 0, 0] })).data[7], 255);
  assert.deepEqual([...decodePng(png({ width: 3, height: 1, colorType: 0, samples: Uint8Array.from([9, 200, 9]), filters: [4], trns: [0, 9] })).data],
    [9, 9, 9, 0, 200, 200, 200, 255, 9, 9, 9, 0]);
  assert.deepEqual([...decodePng(png({ width: 2, height: 1, colorType: 4, samples: Uint8Array.from([50, 128, 250, 0]), filters: [3] })).data],
    [50, 50, 50, 128, 250, 250, 250, 0]);
  const plte = [255, 0, 0, 0, 255, 0, 0, 0, 255];
  assert.deepEqual([...decodePng(png({ width: 3, height: 1, colorType: 3, samples: Uint8Array.from([2, 0, 1]), filters: [2], plte, trns: [100] })).data],
    [0, 0, 255, 255, 255, 0, 0, 100, 0, 255, 0, 255]);
  assert.throws(() => decodePng(png({ width: 1, height: 1, colorType: 3, samples: Uint8Array.from([3]), filters: [0], plte })), /Invalid PNG palette/);
});

test('Invalid filters and incomplete data still fail; encoded PNGs decode byte for byte', () => {
  const good = png({ width: 2, height: 2, colorType: 6, samples: samples(16), filters: [0] });
  assert.throws(() => decodePng(png({ width: 2, height: 2, colorType: 6, samples: samples(16), filters: [0, 5] })), /Invalid PNG filter type/);
  const truncated = zlib.deflateSync(Buffer.alloc(9));
  assert.throws(() => decodePng(Buffer.concat([good.subarray(0, 33), Buffer.from([0, 0, 0, truncated.length]), Buffer.from('IDAT'), truncated, Buffer.alloc(4)])), /incomplete/);
  const rgba = samples(5 * 3 * 4, 3);
  assert.deepEqual(decodePng(encodePng(5, 3, rgba)).data, rgba);
});
