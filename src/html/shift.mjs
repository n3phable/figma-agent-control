/**
 * [INPUT]: Uses ./match.mjs match/differing/crop and ./css.mjs num/place, with Rect from attrib and Matrix from css.
 * [OUTPUT]: SHIFT, region(boxes, own, mask, width, height, pad?) -> search area or reason, search(ref, act, rect, k?) -> { s, before, after },
 *           worth(r, k?), relocate(placement, dx, dy, basis?) -> { fix?, flat, hint? }, advise(r, k, placement, basis?) -> { shift?, fix?, flat?, hints }, moved(dx, dy), and Placement.
 * [POS]: Pure checker corrections: finds alignment shifts and converts them to local CSS coordinates. 1x top diagnostics and zoom share search/advise with scale k.
 *        match owns counts (differing ranks candidates, match measures before/after); css.place serializes transforms consistently with generation. No browser or file access.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { match, differing, crop } from './match.mjs';
import { num, place } from './css.mjs';
/** @import { Rect } from './attrib.mjs' */
/** @import { Matrix } from './css.mjs' */
/** @typedef {{ style: string, chain: [a: number, b: number, c: number, d: number] }} Placement  Main-element style text and the coordinate parent's accumulated linear transform. */

// Search radius 3 px at roughly 1 CSS px steps. Pad the union of both bounds by 2 px, capped at 200,000 px. Offer fixes only with at least 50 original differences and 30% improvement.
export const SHIFT = { radius: 3, pad: 2, area: 200_000, minPx: 50, minDrop: 0.3 };

// -- Search regions -----------------------------------------------------
// Union boxes, expand by pad, round outward and clamp to the image. Above the area limit, fall back to the padded bounds of differing pixels owned by this node.
// Return an explanatory reason when no search is possible: no in-image rectangle, no owned differences within an oversized region, or difference bounds still too large.
/** @param {ReadonlyArray<Rect>} boxes @param {(i: number) => boolean} own @param {Uint8Array} mask @param {number} width @param {number} height @param {number} [pad]
 *  @returns {Rect | string} */
export function region(boxes, own, mask, width, height, pad = SHIFT.pad) {
  /** @param {number[]} r @returns {Rect} */
  const grow = r => [Math.max(0, Math.floor(r[0] - pad)), Math.max(0, Math.floor(r[1] - pad)), Math.min(width, Math.ceil(r[2] + pad)), Math.min(height, Math.ceil(r[3] + pad))];
  /** @param {Rect} r */
  const fits = r => (r[2] - r[0]) * (r[3] - r[1]) <= SHIFT.area;
  const none = 'No painted rectangle for this node in the image; shift search skipped';
  if (!boxes.length) return none;
  const r = grow([0, 1, 2, 3].map(i => (i < 2 ? Math.min : Math.max)(...boxes.map(b => b[i]))));
  if (r[2] <= r[0] || r[3] <= r[1]) return none;
  if (fits(r)) return r;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) {
    const i = y * width + x;
    if (mask[i] === 1 && own(i)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  if (x1 < x0) return 'Search region exceeds the area limit and has no differing pixels of this node; shift search skipped';
  const t = grow([x0, y0, x1 + 1, y1 + 1]);
  return fits(t) ? t : 'Differences are spread too widely; shift search skipped';
}

// -- Search -------------------------------------------------------------
// Candidates form a square around center with radius and step. Visit center first, then increasing |sx|+|sy|, sy and sx relative to center, favoring smaller shifts on ties.
/** @param {number} radius @param {number} step @param {[number, number]} center @returns {[number, number][]} */
function shifts(radius, step, [cx, cy]) {
  const out = /** @type {[number, number][]} */ ([]);
  for (let y = -radius; y <= radius; y += step) for (let x = -radius; x <= radius; x += step) out.push([x, y]);
  return out.sort((p, q) => Math.abs(p[0]) + Math.abs(p[1]) - Math.abs(q[0]) - Math.abs(q[1]) || p[1] - q[1] || p[0] - q[0]).map(([x, y]) => [cx + x, cy + y]);
}
// Extract a rectangle from width*height RGBA, filling out-of-bounds regions transparent; regular crop rejects bounds that shifted rectangles may exceed.
/** @param {Uint8Array} rgba @param {number} width @param {number} height @param {Rect} rect */
function cropPad(rgba, width, height, [x0, y0, x1, y1]) {
  const w = x1 - x0, out = new Uint8Array(w * (y1 - y0) * 4), a = Math.max(0, x0), b = Math.min(width, x1);
  if (b > a) for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) out.set(rgba.subarray((y * width + a) * 4, (y * width + b) * 4), ((y - y0) * w + a - x0) * 4);
  return out;
}
// Shift s means rendered content lies at reference position +s: compare ref(x, y) with act(x + sx, y + sy), in device pixels. Let K = round(k); coarse search uses shifts(3K, K)
// at roughly 1 CSS px per step (49 shifts when K = 1), then K > 1 refines around the best candidate in device-pixel steps. differing counts candidates, using the current best count as an early limit;
// select the first minimum. match computes before/after on crops with identical semantics, though translucent pixels may differ slightly from full-frame mismatch counts.
/** @param {{ data: Uint8Array, width: number, height: number }} ref @param {{ data: Uint8Array }} act @param {Rect} rect @param {number} [k]
 *  @returns {{ s: [number, number], before: number, after: number }} */
export function search(ref, act, rect, k = 1) {
  const { width, height } = ref, K = Math.round(k);
  /** @param {[number, number][]} candidates */
  const pick = candidates => {
    let best = candidates[0], min = Infinity;
    for (const s of candidates) { const n = differing(ref.data, act.data, width, height, rect, s[0], s[1], 0.1, min); if (n < min) { min = n; best = s; } }
    return best;
  };
  let s = pick(shifts(3 * K, K, [0, 0]));
  if (K > 1) s = pick(shifts(K - 1, 1, s));
  const w = rect[2] - rect[0], h = rect[3] - rect[1], base = crop(ref.data, width, rect);
  /** @param {[number, number]} d */
  const count = ([sx, sy]) => match(base, cropPad(act.data, width, height, [rect[0] + sx, rect[1] + sy, rect[2] + sx, rect[3] + sy]), w, h).mismatched;
  const before = count([0, 0]);
  return { s, before, after: s[0] || s[1] ? count(s) : before };
}
// Counts use device pixels, so zoom thresholds multiply by k squared.
/** @param {{ before: number, after: number }} r @param {number} [k] */
export const worth = (r, k = 1) => r.before >= SHIFT.minPx * k * k && r.before - r.after >= SHIFT.minDrop * r.before;

// -- Local-coordinate conversion ----------------------------------------
// Convert canvas displacement (dx, dy) to local transform translation with inv(L)*(dx, dy), where L is the coordinate parent's linear chain. Preserve the linear component and serialize with css.place,
// matching generation. Nodes whose blending must escape transforms use left/top (flat); reconstruct their original translation before splitting and always express fixes as transform.
// basis defaults to current style. null omits basis when an applied entry originally lacked it; a string preserves the original entry's basis verbatim.
/** @param {string} style @param {string} key */
const prop = (style, key) => new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([^;]+)`).exec(style)?.[1].trim();
/** @param {string} t @returns {Matrix | null} */
function parse(t) {
  const tr = /^translate\(\s*(-?[\d.e+-]+)(?:px)?\s*,\s*(-?[\d.e+-]+)(?:px)?\s*\)$/.exec(t);
  const v = tr ? [1, 0, 0, 1, Number(tr[1]), Number(tr[2])] : /^matrix\(([^)]*)\)$/.exec(t)?.[1].split(',').map(Number);
  return v?.length === 6 && v.every(Number.isFinite) ? /** @type {Matrix} */ (v) : null;
}
/** @param {Placement} placement @param {number} dx @param {number} dy @param {string | null} [basis]
 *  @returns {{ fix?: { style: { transform: string }, basis?: { transform: string } }, flat: boolean, hint?: string }} */
export function relocate({ style, chain: [a, b, c, d] }, dx, dy, basis) {
  const t = prop(style, 'transform'), left = prop(style, 'left'), top = prop(style, 'top'), flat = !t && left !== undefined && top !== undefined;
  const current = t ?? (flat ? `translate(${left},${top})` : ''), m = parse(current), det = a * d - b * c;
  if (!m) return { flat, hint: 'Node style in the page has no convertible transform or left/top; no fix given' };
  if (Math.abs(det) < 1e-9) return { flat, hint: 'Coordinate parent matrix is not invertible; cannot convert to a local offset' };
  m[4] += (d * dx - c * dy) / det; m[5] += (a * dy - b * dx) / det;
  const fix = { style: { transform: place(m) }, ...(basis === null ? {} : { basis: { transform: basis ?? current } }) };
  return { fix, flat, ...(flat ? { hint: 'Node is written as left/top in the page; still write overrides as transform' } : {}) };
}
// Direction text puts x first, as in "up 2px" or "right 1px, up 0.5px".
/** @param {number} dx @param {number} dy */
export const moved = (dx, dy) => [dx ? `${dx > 0 ? 'right' : 'left'} ${num(Math.abs(dx))}px` : '', dy ? `${dy > 0 ? 'down' : 'up'} ${num(Math.abs(dy))}px` : ''].filter(Boolean).join(', ');

// -- Advice -------------------------------------------------------------
// Convert search results into shift/fix/hints, shared by 1x top/focus and zoom. A string r explains why no search occurred; a zero best shift emits nothing.
// Since s locates rendered content at reference +s, move the node by -s/k CSS px, normalizing negative zero. Sufficient improvement yields a local-transform fix.
/**
 * @param {{ s: [number, number], before: number, after: number } | string} r @param {number} k @param {Placement} placement @param {string | null} [basis] Same semantics as relocate.
 * @returns {{ shift?: { dx: number, dy: number, before: number, after: number }, fix?: { style: { transform: string }, basis?: { transform: string } }, flat?: true, hints: string[] }}
 */
export function advise(r, k, placement, basis) {
  if (typeof r === 'string') return { hints: [r] };
  if (!r.s[0] && !r.s[1]) return { hints: [] };
  const dx = -r.s[0] / k || 0, dy = -r.s[1] / k || 0, shift = { dx, dy, before: r.before, after: r.after }, hints = [`After moving ${moved(dx, dy)}: differing pixels ${r.before}->${r.after}`];
  if (!worth(r, k)) return { shift, hints: [...hints, 'Reduction too small; no fix given'] };
  const p = relocate(placement, dx, dy, basis);
  return { shift, ...(p.fix ? { fix: p.fix, ...(p.flat ? { flat: /** @type {const} */ (true) } : {}) } : {}), hints: p.hint ? [...hints, p.hint] : hints };
}
