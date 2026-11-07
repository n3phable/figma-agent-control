/**
 * [INPUT]: No dependencies; accepts equally sized RGBA buffers from ../png.mjs decodePng.
 * [OUTPUT]: match(a, b, width, height, { threshold }) -> { mismatched, aa, mask, image }, blockscan(mask, width, height, opts) -> structural blocks,
 *           differing(a, b, width, height, rect, sx, sy, threshold?, limit?) -> shifted difference count, crop(rgba, width, [x0, y0, x1, y1]) -> cropped RGBA,
 *           upscale(rgba, width, height, f) -> nearest-neighbor RGBA, stack(parts, width) -> vertically combined RGBA.
 * [POS]: Visual similarity definition shared by check, shift and zoom. png.mjs diffPng instead measures whether an image changed, using zero threshold and premultiplied alpha for --expect/image-diff;
 *        never mix the two comparisons. differing cheaply scores shift candidates; page uses crop for baked references;
 *        upscale and stack assemble structural-block evidence crops.
 *
 * match is ported from pixelmatch 7.2.0 (https://github.com/mapbox/pixelmatch), preserving squared YIQ thresholds, antialias detection,
 * translucent blending over a checkerboard, and grayscale difference images (alpha 0.1, red differences, yellow antialiasing). Output centers on a mask: 0 equal, 1 different, 2 antialiased.
 * Original license:
 *
 *   ISC License
 *
 *   Copyright (c) 2025, Mapbox
 *
 *   Permission to use, copy, modify, and/or distribute this software for any purpose
 *   with or without fee is hereby granted, provided that the above copyright notice
 *   and this permission notice appear in all copies.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 *   REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 *   FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 *   INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 *   OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 *   TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 *   THIS SOFTWARE.
 *
 * blockscan uses ui2html tools/blockscan.mjs's algorithm (16 px grid, density 0.22, minimum 150 px), reading mask directly instead of detecting red pixels in a difference image.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */

// -- Image matching: pixelmatch 7.2.0 ------------------------------------
// 35215 is maximum squared YIQ distance; threshold 0.1 matches ui2html acceptance. Uint32 views require 4-byte alignment, so copy unaligned buffers first.
/** @param {Uint8Array} bytes */
const aligned = bytes => bytes.byteOffset % 4 ? new Uint8Array(bytes) : bytes;

/** @param {Uint8Array} a @param {Uint8Array} b @param {number} width @param {number} height @param {{ threshold?: number }} [options] */
export function match(a, b, width, height, { threshold = 0.1 } = {}) {
  const len = width * height;
  if (a.length !== len * 4 || b.length !== len * 4) throw Error('Image sizes differ');
  a = aligned(a); b = aligned(b);
  const a32 = new Uint32Array(a.buffer, a.byteOffset, len), b32 = new Uint32Array(b.buffer, b.byteOffset, len);
  const mask = new Uint8Array(len), image = new Uint8Array(len * 4), maxDelta = 35215 * threshold * threshold;
  let mismatched = 0, aa = 0;
  for (let i = 0, pos = 0; i < len; i++, pos += 4) {
    if (a32[i] === b32[i] || colorDelta(a, b, pos, pos, false) <= maxDelta) { gray(a, pos, image); continue; }
    const x = i % width, y = (i / width) | 0;
    if (antialiased(a, x, y, width, height, a32, b32) || antialiased(b, x, y, width, height, b32, a32)) { mask[i] = 2; aa++; paint(image, pos, 255, 255, 0); }
    else { mask[i] = 1; mismatched++; paint(image, pos, 255, 0, 0); }
  }
  return { mismatched, aa, mask, image };
}

// Squared YIQ distance between pixel offsets k in p and m in q; yOnly returns luminance difference Y for antialias detection.
// Blend translucent pixels over a checkerboard determined by k, matching pixelmatch: k is divisible by 4, so the red channel is always 48.
// pixelmatch uses sign for lighter/darker diffColorAlt; only magnitude matters here. Per-pixel scalar computation allocates nothing.
/** @param {Uint8Array} p @param {Uint8Array} q @param {number} k @param {number} m @param {boolean} yOnly */
function colorDelta(p, q, k, m, yOnly) {
  const a1 = p[k + 3], a2 = q[m + 3];
  let dr = p[k] - q[m], dg = p[k + 1] - q[m + 1], db = p[k + 2] - q[m + 2];
  if (a1 < 255 || a2 < 255) {
    const da = a1 - a2, rb = 48 + 159 * (k % 2), gb = 48 + 159 * ((k / 1.618033988749895 | 0) % 2), bb = 48 + 159 * ((k / 2.618033988749895 | 0) % 2);
    dr = (p[k] * a1 - q[m] * a2 - rb * da) / 255; dg = (p[k + 1] * a1 - q[m + 1] * a2 - gb * da) / 255; db = (p[k + 2] * a1 - q[m + 2] * a2 - bb * da) / 255;
  }
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  if (yOnly) return y;
  const i = dr * 0.59597799 - dg * 0.27417610 - db * 0.32180189, v = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * v * v;
}

// Antialias detection (Vysniauskas 2009): the center's eight neighbors include both lighter/darker pixels, and the brightest or darkest has at least three equal-color neighbors in both images.
// Preserve x-outer/y-inner traversal and strict comparisons: they determine which tied extreme wins.
/** @param {Uint8Array} img @param {number} x1 @param {number} y1 @param {number} width @param {number} height @param {Uint32Array} a32 @param {Uint32Array} b32 */
function antialiased(img, x1, y1, width, height, a32, b32) {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1), pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0, min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let x = x0; x <= x2; x++) for (let y = y0; y <= y2; y++) {
    if (x === x1 && y === y1) continue;
    const m = (y * width + x) * 4;
    const delta = img[pos] === img[m] && img[pos + 1] === img[m + 1] && img[pos + 2] === img[m + 2] && img[pos + 3] === img[m + 3] ? 0 : colorDelta(img, img, pos, m, true);
    if (delta === 0) { if (++zeroes > 2) return false; }
    else if (delta < min) { min = delta; minX = x; minY = y; }
    else if (delta > max) { max = delta; maxX = x; maxY = y; }
  }
  if (min === 0 || max === 0) return false;
  return (siblings(a32, minX, minY, width, height) && siblings(b32, minX, minY, width, height)) || (siblings(a32, maxX, maxY, width, height) && siblings(b32, maxX, maxY, width, height));
}
/** @param {Uint32Array} img @param {number} x1 @param {number} y1 @param {number} width @param {number} height */
function siblings(img, x1, y1, width, height) {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1), v = img[y1 * width + x1];
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  for (let x = x0; x <= x2; x++) for (let y = y0; y <= y2; y++) {
    if (x === x1 && y === y1) continue;
    if (v === img[y * width + x] && ++zeroes > 2) return true;
  }
  return false;
}
/** @param {Uint8Array} out @param {number} i @param {number} r @param {number} g @param {number} b */
const paint = (out, i, r, g, b) => { out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; };
// Draw equal pixels as grayscale blended with white at alpha 0.1. Uint8Array truncation keeps the difference image byte-identical to pixelmatch.
/** @param {Uint8Array} img @param {number} i @param {Uint8Array} out */
function gray(img, i, out) {
  const v = 255 + (img[i] * 0.29889531 + img[i + 1] * 0.58662247 + img[i + 2] * 0.11448223 - 255) * 0.1 * img[i + 3] / 255;
  paint(out, i, v, v, v);
}

// -- Structural blocks --------------------------------------------------
// Count mask-1 differences, excluding antialiasing, per cell. Merge cells with density >= minDensity by eight-way connectivity and report blocks with at least minPixels differences;
// catch local damage hidden by a passing whole-frame ratio, such as missing headings or overlapping flags. Parameters are calibrated at 1x; callers scale them for other resolutions.
/** @param {Uint8Array} mask @param {number} width @param {number} height @param {{ cell?: number, minDensity?: number, minPixels?: number }} [options] */
export function blockscan(mask, width, height, { cell = 16, minDensity = 0.22, minPixels = 150 } = {}) {
  const cw = Math.ceil(width / cell), ch = Math.ceil(height / cell), cells = new Float32Array(cw * ch);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x] === 1) cells[((y / cell) | 0) * cw + ((x / cell) | 0)]++;
  const hot = cells.map(n => n / (cell * cell) >= minDensity ? 1 : 0), seen = new Uint8Array(cw * ch), regions = [];
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    if (!hot[cy * cw + cx] || seen[cy * cw + cx]) continue;
    /** @type {[number, number][]} */
    const stack = [[cx, cy]]; seen[cy * cw + cx] = 1;
    let x0 = cx, x1 = cx, y0 = cy, y1 = cy, px = 0;
    while (stack.length) {
      // The while condition guarantees a nonempty stack.
      const [x, y] = /** @type {[number, number]} */ (stack.pop()); px += cells[y * cw + x];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx, ny = y + dy, ni = ny * cw + nx;
        if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && hot[ni] && !seen[ni]) { seen[ni] = 1; stack.push([nx, ny]); }
      }
    }
    if (px >= minPixels) regions.push({ x: x0 * cell, y: y0 * cell, w: (x1 - x0 + 1) * cell, h: (y1 - y0 + 1) * cell, diffPx: Math.round(px) });
  }
  return regions.sort((p, q) => q.diffPx - p.diffPx);
}

// -- Shifted comparison -------------------------------------------------
// Count pixels in [x0, x1) by [y0, y1) whose a(x, y) and b(x + sx, y + sy) squared YIQ distance exceeds threshold. Out-of-bounds b is transparent, using colorDelta's translucent-blending formula.
// Skip antialias detection and allocations; return at limit, allowing shift search to prune most candidates with the current best score. At (0, 0), count equals match mismatched + aa.
const CLEAR = new Uint8Array(4);
/** @param {Uint8Array} a @param {Uint8Array} b @param {number} width @param {number} height @param {[x0: number, y0: number, x1: number, y1: number]} rect
 *  @param {number} sx @param {number} sy @param {number} [threshold] @param {number} [limit] */
export function differing(a, b, width, height, [x0, y0, x1, y1], sx, sy, threshold = 0.1, limit = Infinity) {
  a = aligned(a); b = aligned(b);
  const a32 = new Uint32Array(a.buffer, a.byteOffset, width * height), b32 = new Uint32Array(b.buffer, b.byteOffset, width * height), maxDelta = 35215 * threshold * threshold;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const by = y + sy, row = by >= 0 && by < height;
    for (let x = x0; x < x1; x++) {
      const i = y * width + x, bx = x + sx, j = by * width + bx;
      if (row && bx >= 0 && bx < width ? a32[i] !== b32[j] && colorDelta(a, b, i * 4, j * 4, false) > maxDelta : colorDelta(a, CLEAR, i * 4, 0, false) > maxDelta)
        if (++n >= limit) return n;
    }
  }
  return n;
}

// -- RGBA cropping ------------------------------------------------------
// Copy a half-open integer rectangle from width-wide RGBA into compact rows. Require a nonempty in-bounds rectangle and throw otherwise,
// preventing subarray from silently truncating data.
/** @param {Uint8Array} rgba @param {number} width @param {[x0: number, y0: number, x1: number, y1: number]} rect */
export function crop(rgba, width, [x0, y0, x1, y1]) {
  if (![x0, y0, x1, y1].every(Number.isInteger) || x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > width || y1 * width * 4 > rgba.length) throw Error(`Crop rectangle is outside the image: ${[x0, y0, x1, y1]}`);
  const w = x1 - x0, out = new Uint8Array(w * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) out.set(rgba.subarray((y * width + x0) * 4, (y * width + x1) * 4), (y - y0) * w * 4);
  return out;
}

// -- Scaling and stacking -----------------------------------------------
// Enlarge structural-block evidence by integer f using nearest-neighbor sampling to preserve crisp pixel boundaries; stack vertically with gap transparent rows.
/** @param {Uint8Array} rgba @param {number} width @param {number} height @param {number} f Positive integer. */
export function upscale(rgba, width, height, f) {
  const a = aligned(rgba), src = new Uint32Array(a.buffer, a.byteOffset, width * height), W = width * f, out = new Uint32Array(W * height * f);
  for (let y = 0; y < height * f; y++) for (let x = 0; x < W; x++) out[y * W + x] = src[((y / f) | 0) * width + ((x / f) | 0)];
  return new Uint8Array(out.buffer);
}
/** @param {ReadonlyArray<Uint8Array>} parts Equal-width RGBA images. @param {number} width @param {number} [gap] */
export function stack(parts, width, gap = 4) {
  const row = width * 4, out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0) + Math.max(0, parts.length - 1) * gap * row);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length + gap * row; }
  return out;
}
