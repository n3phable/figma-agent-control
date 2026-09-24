/**
 * [INPUT]: Imports node:fs, node:path, ./match.mjs, ../png.mjs, ../project.mjs.
 * [OUTPUT]: Exports LIMIT, CHECKER, raster, check, writeEvidence.
 * [POS]: Coordinates reference rendering, pixel comparison and evidence production.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { match, blockscan } from './match.mjs';
import { pngSize, decodePng, encodePng } from '../png.mjs';
import { hash, writeAtomic } from '../project.mjs';

// Fail above 2% full-frame differing pixels, matching ui2html acceptance with pixelmatch threshold 0.1 and antialiasing excluded.
export const LIMIT = 0.02;
// Checker fingerprint: comparison, decoding, rendering, and this module's source; persisted in check.json for verification records.
export const CHECKER = hash(['check.mjs', 'match.mjs', 'chrome.mjs', '../png.mjs'].map(file => fs.readFileSync(new URL(file, import.meta.url))).join('\n')).slice(0, 12);

// -- Rasterization ------------------------------------------------------
// rects is a flat [k, x, y, w, h, ...] array in paint order. Later rectangles overwrite earlier ones, yielding per-pixel node indices; -1 means unowned.
// Round outward to include partially covered pixels. Fill TypedArrays by row; cost depends on total rectangle area, not differing-pixel count.
/** @param {number[]} rects @param {number} width @param {number} height */
export function raster(rects, width, height) {
  const owner = new Int32Array(width * height).fill(-1);
  for (let i = 0; i < rects.length; i += 5) {
    const x0 = Math.max(0, Math.floor(rects[i + 1])), y0 = Math.max(0, Math.floor(rects[i + 2]));
    const x1 = Math.min(width, Math.ceil(rects[i + 1] + rects[i + 3])), y1 = Math.min(height, Math.ceil(rects[i + 2] + rects[i + 4]));
    if (x1 > x0) for (let y = y0; y < y1; y++) owner.fill(rects[i], y * width + x0, y * width + x1);
  }
  return owner;
}

// -- HTML painted rectangles --------------------------------------------
// Collect page rectangles once: element boxes, including SVG/img, and Range line boxes for text. Attribute to the nearest [data-node] ancestor, or leave unowned.
// Intersect each rectangle with every clipping ancestor's box (non-visible overflow, clip-path or mask-image). DOM order is paint order because generate uses no z-index.
// Do not descend into SVG: defs/clipPath boxes have no painted meaning; the SVG's own box represents the whole image.
const RECTS = `(() => {
  const SVG = 'http://www.w3.org/2000/svg', NONE = [-Infinity, -Infinity, Infinity, Infinity];
  const ids = [], names = [], keys = new Map(), clips = new Map(), rects = [];
  // Assign indexes by node ID, merging counts when a node is drawn as several elements.
  const owner = el => {
    const n = el.closest('[data-node]'); if (!n) return -1;
    let k = keys.get(n.dataset.node);
    if (k === undefined) { k = ids.push(n.dataset.node) - 1; names.push(n.dataset.name ?? ''); keys.set(n.dataset.node, k); }
    return k;
  };
  // Clip content against ancestor bounds and the element itself when clipping. Exclude html/body overflow, which affects the viewport.
  const clipOf = el => {
    if (!el || el === document.body || el === document.documentElement) return NONE;
    let c = clips.get(el);
    if (c) return c;
    c = clipOf(el.parentElement);
    const s = getComputedStyle(el);
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none' || s.maskImage !== 'none') {
      const r = el.getBoundingClientRect();
      c = [Math.max(c[0], r.left), Math.max(c[1], r.top), Math.min(c[2], r.right), Math.min(c[3], r.bottom)];
    }
    clips.set(el, c);
    return c;
  };
  const push = (k, r, c) => {
    const x0 = Math.max(r.left, c[0]), y0 = Math.max(r.top, c[1]), x1 = Math.min(r.right, c[2]), y1 = Math.min(r.bottom, c[3]);
    if (k >= 0 && x1 > x0 && y1 > y0) rects.push(k, x0, y0, x1 - x0, y1 - y0);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    { acceptNode: n => n.parentNode.namespaceURI === SVG ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.nodeType === 1 ? n : n.parentElement;
    if (getComputedStyle(el).visibility !== 'visible') continue;
    if (n.nodeType === 1) { push(owner(el), el.getBoundingClientRect(), clipOf(el.parentElement)); continue; }
    if (!n.data.trim()) continue;
    range.selectNodeContents(n);
    const k = owner(el), c = clipOf(el);
    for (const r of range.getClientRects()) push(k, r, c);
  }
  return { ids, names, rects };
})()`;

// -- Checking -----------------------------------------------------------
// The caller supplies expected size (HTML derives round(w * s) by round(h * s) from the extract; regression uses frame.json). Require positive integers and reject missing fields or NaN;
// preventing silent bypass of size checks. Reference differences above 1 px yield unchecked/REFERENCE_SIZE; 1 px differences from fractional origins compare at reference size and mark fractional.
// Render timeout yields unchecked/RENDER_TIMEOUT; the caller should use a new page before continuing. Other errors propagate.
// Only the page methods below are used, as provided by chrome.mjs launch().page(); evaluated page scripts determine their result shapes.
/** @typedef {{ browser: unknown, open(url: string, width: number, height: number): Promise<void>, shot(): Promise<Buffer>, evaluate(expression: string): Promise<any> }} Page */
// refs are generator reference crops with half-open pixel rectangles [x0, y0, x1, y1); preserve all other fields in the report.
/** @typedef {{ node: string, rect: [x0: number, y0: number, x1: number, y1: number] }} Ref */
/** @param {Page} page @param {{ url: string, reference: Buffer, expected: { width: number, height: number }, refs?: ReadonlyArray<Ref> }} input */
export async function check(page, { url, reference, expected, refs = [] }) {
  if (![expected?.width, expected?.height].every(v => Number.isInteger(v) && v > 0)) throw Error(`Expected size must be positive integers: ${JSON.stringify(expected)}`);
  const size = pngSize(reference), sizes = { expected, reference: size };
  const dw = Math.abs(size.width - expected.width), dh = Math.abs(size.height - expected.height);
  if (dw > 1 || dh > 1) return { report: { verdict: 'unchecked', reason: 'REFERENCE_SIZE', ...sizes } };
  const { width, height } = size, ms = /** @type {Record<string, number>} */ ({});
  let t = performance.now();
  /** @param {string} key */
  const lap = key => { const now = performance.now(); ms[key] = Math.round(now - t); t = now; };
  /** @param {Error & { code?: string }} error */
  const timeout = error => { if (error.code !== 'RENDER_TIMEOUT') throw error; return { report: { verdict: 'unchecked', reason: 'RENDER_TIMEOUT', ...sizes, error: error.message } }; };

  let shot;
  try { await page.open(url, width, height); shot = await page.shot(); } catch (error) { return timeout(error); }
  lap('render');
  const ref = decodePng(reference), act = decodePng(shot);
  if (act.width !== width || act.height !== height) throw Error(`Screenshot size ${act.width}x${act.height} does not match the requested ${width}x${height}`);
  lap('decode');
  const m = match(ref.data, act.data, width, height);
  lap('match');
  const found = blockscan(m.mask, width, height);
  lap('blocks');

  /** @type {{ ids: string[], names: string[], rects: number[] }} */
  let painted;
  try { painted = await page.evaluate(RECTS); } catch (error) { return timeout(error); }
  const owner = raster(painted.rects, width, height), px = new Int32Array(painted.ids.length), area = new Int32Array(painted.ids.length);
  let unattributed = 0;
  for (let i = 0; i < owner.length; i++) {
    const k = owner[i];
    if (k < 0) { if (m.mask[i] === 1) unattributed++; continue; }
    area[k]++;
    if (m.mask[i] === 1) px[k]++;
  }
  /** @param {number} k */
  const node = k => ({ node: painted.ids[k], name: painted.names[k] });
  const nodes = [...px.keys()].filter(k => px[k]).sort((p, q) => px[q] - px[p]).map(k => ({ ...node(k), px: px[k], area: area[k] }));
  // Count ownership within each structural-block bounding box and list the top three nodes. share divides by bboxPx, all differing pixels in the box including unowned pixels,
  // This can exceed blockscan diffPx, which counts only hot cells.
  const blocks = found.map(b => {
    const counts = new Map(); let total = 0;
    for (let y = b.y; y < Math.min(height, b.y + b.h); y++) for (let x = b.x; x < Math.min(width, b.x + b.w); x++) {
      const i = y * width + x;
      if (m.mask[i] !== 1) continue;
      total++;
      if (owner[i] >= 0) counts.set(owner[i], (counts.get(owner[i]) ?? 0) + 1);
    }
    return { ...b, bboxPx: total, nodes: [...counts].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([k, n]) => ({ ...node(k), px: n, share: Number((n / total).toFixed(3)) })) };
  });
  lap('attrib');

  // Baked references compare the reference against itself within their rectangles, so they do not measure reproduction accuracy. Report each crop's differing px, ideally zero;
  // bakedShare is the union-area fraction of the canvas. Any ref caps the verdict at pass-with-findings.
  let baked = 0;
  if (refs.length) for (const k of raster(refs.flatMap(r => [0, r.rect[0], r.rect[1], r.rect[2] - r.rect[0], r.rect[3] - r.rect[1]]), width, height)) if (k >= 0) baked++;
  const inside = refs.map(r => {
    let px = 0;
    for (let y = Math.max(0, r.rect[1]); y < Math.min(height, r.rect[3]); y++) for (let x = Math.max(0, r.rect[0]); x < Math.min(width, r.rect[2]); x++) if (m.mask[y * width + x] === 1) px++;
    return { ...r, px };
  });

  const diffRatio = m.mismatched / (width * height);
  const verdict = diffRatio > LIMIT ? 'fail' : blocks.length || refs.length ? 'pass-with-findings' : 'clean';
  return {
    report: { verdict, ...(dw || dh ? { sizeNote: 'fractional' } : {}), ...sizes, mismatched: m.mismatched, aa: m.aa, diffRatio,
      blocks, nodes, unattributed, ...(refs.length ? { refs: inside, bakedShare: Number((baked / (width * height)).toFixed(4)) } : {}), browser: page.browser, checker: CHECKER, ms },
    images: { width, height, render: shot, diff: m.image }
  };
}

// Evidence always includes check.json; when available, save render and diff images with gray background, red differences, and yellow antialiasing.
/** @param {string} dir @param {object} report @param {{ width: number, height: number, render: Buffer, diff: Uint8Array }} [images] */
export async function writeEvidence(dir, report, images) {
  await writeAtomic(path.join(dir, 'check.json'), JSON.stringify(report, null, 2) + '\n');
  if (!images) return;
  await writeAtomic(path.join(dir, 'render.png'), images.render);
  await writeAtomic(path.join(dir, 'diff.png'), encodePng(images.width, images.height, images.diff));
}
