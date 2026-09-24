/**
 * [INPUT]: An external pixelmatch 7.2.0 package directory and its pngjs dependency; src/png.mjs encodePng writes synthetic RGBA arrays.
 * [OUTPUT]: Seven deterministic PNG pairs and expected.json beside this script; no runtime dependency is added.
 * [POS]: Reproducible, screenshot-free matching fixtures. Upstream pixelmatch supplies pixel expectations; a separate grid reference supplies blocks. Never imports src/html/match.mjs.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { encodePng } from '../../../src/png.mjs';

// npm install --prefix /tmp/fac-pixelmatch --ignore-scripts --no-save pixelmatch@7.2.0
// node tests/helpers/match/generate.mjs /tmp/fac-pixelmatch/node_modules/pixelmatch
assert.ok(process.argv[2], 'Pass an independently installed pixelmatch 7.2.0 package directory');
const reference = path.resolve(process.argv[2]);
const metadata = JSON.parse(fs.readFileSync(path.join(reference, 'package.json'), 'utf8'));
assert.equal(`${metadata.name}@${metadata.version}`, 'pixelmatch@7.2.0');
const { default: pixelmatch } = await import(pathToFileURL(path.join(reference, 'index.js')).href);
const { PNG } = createRequire(path.join(reference, 'package.json'))('pngjs');
const DIR = new URL('./', import.meta.url), CLEAR = [0, 0, 0, 0], WHITE = [250, 250, 250, 255];
const rect = (x, y, w, h, color) => (px, py) => px >= x && py >= y && px < x + w && py < y + h ? color : null;
const circle = (x, y, r, color) => (px, py) => (px - x) ** 2 + (py - y) ** 2 < r * r ? color : null;

// Four-by-four coverage samples create stable antialiased edges without fonts, browsers, or image inputs.
function render(width, height, background, layers) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
      let [r, g, b, a] = typeof background === 'function' ? background(px, py) : background;
      for (const layer of layers) {
        const color = layer(px, py);
        if (!color) continue;
        const source = color[3] / 255, dest = a / 255 * (1 - source), alpha = source + dest;
        if (alpha) { r = (color[0] * source + r * dest) / alpha; g = (color[1] * source + g * dest) / alpha; b = (color[2] * source + b * dest) / alpha; }
        a = alpha * 255;
      }
      sum[0] += r * a; sum[1] += g * a; sum[2] += b * a; sum[3] += a;
    }
    data.set(sum[3] ? [Math.round(sum[0] / sum[3]), Math.round(sum[1] / sum[3]), Math.round(sum[2] / sum[3]), Math.round(sum[3] / 16)] : CLEAR, (y * width + x) * 4);
  }
  return data;
}

// Only the literal word TEST is drawn, using these local 5x7 bitmap glyphs rather than installed fonts.
const GLYPHS = ['11111/00100/00100/00100/00100/00100/00100', '11111/10000/10000/11110/10000/10000/11111', '01111/10000/10000/01110/00001/00001/11110'];
const glyphs = offset => (x, y) => {
  const col = Math.floor((x - 18.25 - offset) / 3.5), row = Math.floor((y - 18.25) / 3.5), letter = Math.floor(col / 6);
  return col >= 0 && row >= 0 && row < 7 && letter < 4 && col % 6 < 5 && GLYPHS[[0, 1, 2, 0][letter]].split('/')[row][col % 6] === '1' ? [25, 35, 55, 255] : null;
};
const texture = offset => (x, y) => {
  const u = Math.floor(x - 18.25 - offset), v = Math.floor(y - 18.25);
  if (u < 0 || v < 0 || u >= 56 || v >= 56) return null;
  const tile = ((u >> 2) + (v >> 2)) % 2, noise = ((u * 37) ^ (v * 53)) & 31;
  return [40 + tile * 130 + noise, 150 - tile * 80, 80 + noise * 3, 255];
};
const pairs = [];
function pair(name, width, height, draw) { pairs.push({ name, size: [width, height], a: draw(0), b: draw(1) }); }
pair('alpha-edges', 128, 80, n => render(128, 80, CLEAR, [rect(12.25 + n * 0.5, 12.25, 52, 42, [35, 125, 210, 160 + n * 12]), circle(86, 42, 24 + n * 0.5, [235, 110, 40, 200])]));
pair('alpha-shift', 160, 96, n => render(160, 96, CLEAR, [rect(18.25 + n * 2, 24.25 + n, 76, 38, [40, 140, 220, 128]), circle(93 + n * 2, 51 + n, 26, [230, 70, 100, 180]), rect(40 + n * 2, 67 + n, 70, 3, [40, 180, 100, 210])]));
pair('clear-vs-solid', 128, 96, n => render(128, 96, CLEAR, n ? [rect(24.25, 20.25, 64, 48, [45, 130, 200, 255]), circle(91, 67, 17.5, [230, 90, 40, 180])] : []));
pair('gradient-image', 160, 96, n => render(160, 96, (x, y) => [30 + x, 45 + y, 175 - x / 3, 255], [texture(n), circle(119.25, 46.25 + n * 0.5, 20.5, [235, 185, 40, 180])]));
pair('opaque-vs-clear', 128, 80, n => render(128, 80, n ? CLEAR : WHITE, n ? [] : [rect(15.25, 18.25, 50, 30, [45, 65, 105, 255]), circle(92.25, 43.25, 22.5, [35, 145, 120, 255])]));
pair('statusbar-aa', 192, 48, n => render(192, 48, WHITE, [rect(14.25 + n * 0.5, 16.25, 7, 18, [20, 30, 50, 255]), rect(28.25 + n * 0.5, 11.25, 7, 23, [20, 30, 50, 255]), rect(42.25 + n * 0.5, 6.25, 7, 28, [20, 30, 50, 255]), circle(96.25 + n * 0.5, 24.25, 12.5, [20, 30, 50, 255]), rect(145.25, 13.25 + n * 0.5, 29, 20, [20, 30, 50, 255]), rect(179, 22, n * 3, 4, [20, 30, 50, 255])]));
pair('text-offset', 192, 64, n => render(192, 64, WHITE, [glyphs(n * 2)]));

// Deliberately simple reference: count each 16x16 tile, then flood connected hot tiles in a Map.
function referenceBlocks(mask, width, height) {
  const hot = new Map();
  for (let y = 0; y < height; y += 16) for (let x = 0; x < width; x += 16) {
    let count = 0;
    for (let py = y; py < Math.min(y + 16, height); py++) for (let px = x; px < Math.min(x + 16, width); px++) count += mask[py * width + px] === 1 ? 1 : 0;
    if (count / 256 >= 0.22) hot.set(`${x},${y}`, { x, y, count });
  }
  const blocks = [];
  while (hot.size) {
    const [key, first] = hot.entries().next().value, group = [first]; hot.delete(key);
    for (let i = 0; i < group.length; i++) for (const [id, cell] of hot) if (Math.abs(cell.x - group[i].x) <= 16 && Math.abs(cell.y - group[i].y) <= 16) { group.push(cell); hot.delete(id); }
    const diffPx = group.reduce((sum, cell) => sum + cell.count, 0);
    if (diffPx < 150) continue;
    const xs = group.map(cell => cell.x), ys = group.map(cell => cell.y), x = Math.min(...xs), y = Math.min(...ys);
    blocks.push({ x, y, w: Math.max(...xs) + 16 - x, h: Math.max(...ys) + 16 - y, diffPx });
  }
  return blocks.sort((a, b) => b.diffPx - a.diffPx);
}

const sha = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 16), files = [];
const fixtures = pairs.map(({ name, size: [width, height], a, b }) => {
  for (const [side, data] of [['a', a], ['b', b]]) {
    const png = encodePng(width, height, data), decoded = PNG.sync.read(png);
    assert.deepEqual([decoded.width, decoded.height, ...decoded.data], [width, height, ...data], `${name}.${side}: independent PNG round trip`);
    files.push([`${name}.${side}.png`, png]);
  }
  const image = new Uint8Array(a.length), mask = new Uint8Array(width * height);
  const mismatched = pixelmatch(a, b, image, width, height, { threshold: 0.1 });
  const allDifferences = pixelmatch(a, b, undefined, width, height, { threshold: 0.1, includeAA: true });
  for (let i = 0; i < mask.length; i++) if (image[i * 4] === 255 && image[i * 4 + 2] === 0) mask[i] = image[i * 4 + 1] === 0 ? 1 : 2;
  const aa = mask.filter(value => value === 2).length;
  assert.equal(mask.filter(value => value === 1).length, mismatched, `${name}: mismatch mask`);
  assert.equal(mismatched + aa, allDifferences, `${name}: independent AA count`);
  assert.ok(mismatched > 0, `${name}: real differences remain covered`);
  return { name, size: [width, height], mismatched, aa, imageSha256: sha(image), maskSha256: sha(mask), blocks: referenceBlocks(mask, width, height) };
});
assert.ok(fixtures.filter(f => f.aa > 0).length >= 4, 'At least four pairs exercise antialias detection');
assert.ok(fixtures.filter(f => f.blocks.length).length >= 2, 'Dense structural differences remain covered');
assert.ok(pairs.filter(p => [p.a, p.b].some(data => data.some((v, i) => i % 4 === 3 && v < 255))).length >= 4, 'At least four pairs exercise transparency');
for (const [name, bytes] of files) fs.writeFileSync(new URL(name, DIR), bytes);
fs.writeFileSync(new URL('expected.json', DIR), JSON.stringify({ generator: 'Synthetic RGBA geometry/glyphs; pixelmatch 7.2.0; independent grid reference', threshold: 0.1, fixtures }, null, 2) + '\n');
process.stdout.write(`Wrote ${files.length} synthetic PNGs and independent expectations for ${fixtures.length} cases.\n`);
