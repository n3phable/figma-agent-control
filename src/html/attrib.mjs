/**
 * [INPUT]: Uses ./css.mjs VECTORS and paintOrder, matching generator stacking. Types come from ./extract-contract.js LandedExtractOutput/ExtractNode and ./generate.mjs Approximation/OverrideEntry.
 * [OUTPUT]: TOP_N, GAP_PX, GAP_RATIO, raster(rects, width, height) -> per-pixel owner indices, frameBox(node) -> frame-coordinate bounds,
 *           inlinedIslands(output, approximations), figmaPainted(output, ctx), tally(owner, mask, n), boxes(painted), rank(input), and Box/Rect/Painted/Ranked types.
 * [POS]: Pure attribution for the html checker: assigns differing pixels to nodes. Both sides use raster; HTML rectangles come from the page's RECTS query,
 *        while Figma rectangles follow generator rules for masks, clips, islands and reference crops. check orchestrates it and shares Figma ownership with suggest. layout/zoom also use frameBox. No browser or file access.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { VECTORS, paintOrder } from './css.mjs';
/** @import { LandedExtractOutput, ExtractNode } from './extract-contract.js' */
/** @import { Approximation, OverrideEntry } from './generate.mjs' */
/**
 * @typedef {[x: number, y: number, w: number, h: number]} Box  Rectangle in frame coordinates, measured in CSS pixels.
 * @typedef {[x0: number, y0: number, x1: number, y1: number]} Rect  Half-open rectangle in pixel coordinates.
 * @typedef {{ ids: string[], names: string[], rects: number[] }} Painted  Flat rectangles [k, x, y, w, h, ...], with k indexing ids; matches the page RECTS shape.
 * @typedef {{ node: string, name: string, htmlPx: number, figmaPx: number, px: number, gap?: 'html-missing' | 'html-extra' }} Ranked
 */

// Diagnose the top TOP_N entries. Flag a gap when one side falls below GAP_RATIO of the other with at least GAP_PX total pixels. These constants are unmeasured heuristics reviewed against Now top results.
export const TOP_N = 5, GAP_PX = 50, GAP_RATIO = 0.2;

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

// -- Figma painted rectangles -------------------------------------------
// Transform (0, 0, w, h) through the frame matrix and return its bounding rectangle, using the same formula as offline island origins. Contract matrices are [[a, c, e], [b, d, f]].
/** @param {ExtractNode} node @returns {Box} */
export function frameBox({ transform: [[a, c, e], [b, d, f]], width: w, height: h }) {
  const xs = [0, a * w, c * h, a * w + c * h], ys = [0, b * w, d * h, b * w + d * h], x = Math.min(...xs), y = Math.min(...ys);
  return [e + x, f + y, Math.max(...xs) - x, Math.max(...ys) - y];
}

// Actually inlined SVG islands exclude generator fallbacks marked island-unavailable, island-vetoed or island-clipped on the island node.
// island-vetoed also applies to non-island BAKE nodes, so exclude only IDs already present in islands.
const FALLBACK = new Set(['island-unavailable', 'island-vetoed', 'island-clipped']);
/** @param {LandedExtractOutput} output @param {ReadonlyArray<Approximation>} approximations @returns {Set<string>} */
export function inlinedIslands(output, approximations) {
  const back = new Set(approximations.filter(a => FALLBACK.has(a.kind)).map(a => a.node));
  return new Set(Object.keys(output.islands).filter(id => !back.has(id)));
}

// Emit rectangles in paintOrder, including reversed auto-layout stacking, following generation: skip/unpainted (renderBounds null) subtrees paint nothing. Valid refs do not paint at their original positions,
// but paint last from reference rectangles. Masks themselves do not paint; intersect following same-parent siblings with the mask bounds. Inlined islands use renderBounds and stop traversal; vectors also stop traversal
// and use renderBounds for zero width/height because HTML gives SVG at least a 1 px viewport. clipsContent clips descendants. Root covers the full frame and #canvas always clips.
// Intersect each rectangle with current clipping and omit empty results. Rotated nodes and clips use bounding-box approximations. TEXT uses the node box containing its line boxes.
/**
 * @param {LandedExtractOutput} output
 * @param {{ overrides: Record<string, OverrideEntry>, inlined: Set<string>, refs: ReadonlyArray<{ node: string, rect: Rect }> }} ctx  refs are those actually painted by the page.
 * @returns {Painted}
 */
export function figmaPainted(output, { overrides, inlined, refs }) {
  const ids = /** @type {string[]} */ ([]), names = /** @type {string[]} */ ([]), rects = /** @type {number[]} */ ([]);
  const keys = /** @type {Map<string, number>} */ (new Map()), byId = /** @type {Map<string, ExtractNode>} */ (new Map()), baked = new Set(refs.map(r => r.node));
  /** @param {ExtractNode} n */
  const walk = n => { byId.set(n.id, n); for (const c of n.children ?? []) walk(c); };
  walk(output.root);
  /** @param {Rect} clip @param {Box} b @returns {Rect} */
  const cut = (clip, [x, y, w, h]) => [Math.max(clip[0], x), Math.max(clip[1], y), Math.min(clip[2], x + w), Math.min(clip[3], y + h)];
  /** @param {ExtractNode | undefined} n @param {Box} b @param {Rect} clip */
  const push = (n, b, clip) => {
    const [x0, y0, x1, y1] = cut(clip, b);
    if (!n || x1 <= x0 || y1 <= y0) return;
    let k = keys.get(n.id);
    if (k === undefined) { k = ids.push(n.id) - 1; names.push(n.name); keys.set(n.id, k); }
    rects.push(k, x0, y0, x1 - x0, y1 - y0);
  };
  /** @param {ExtractNode} n @param {Rect} clip */
  const visit = (n, clip) => {
    if (overrides[n.id]?.skip || n.renderBounds === null || baked.has(n.id)) return;
    const box = frameBox(n), rb = n.renderBounds;
    if (inlined.has(n.id)) return push(n, rb ?? box, clip);
    if (VECTORS.has(n.type)) return push(n, rb && (box[2] < 1 || box[3] < 1) ? rb : box, clip);
    push(n, box, clip);
    let inner = n.clipsContent ? cut(clip, box) : clip;
    for (const c of paintOrder(n)) {
      if (!c.isMask) visit(c, inner);
      else if (!overrides[c.id]?.skip) inner = cut(inner, frameBox(c));
    }
  };
  const root = frameBox(output.root);
  visit(output.root, [root[0], root[1], root[0] + root[2], root[1] + root[3]]);
  const all = /** @type {Rect} */ ([-Infinity, -Infinity, Infinity, Infinity]);
  for (const { node, rect: [x0, y0, x1, y1] } of refs) push(byId.get(node), [x0, y0, x1 - x0, y1 - y0], all);
  return { ids, names, rects };
}

// -- Counts and bounds --------------------------------------------------
// Count differing pixels (mask 1) per index for Figma only; check already counts HTML ownership in its pixel loop.
/** @param {Int32Array} owner @param {Uint8Array} mask @param {number} n @returns {Int32Array} */
export function tally(owner, mask, n) {
  const px = new Int32Array(n);
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0 && mask[i] === 1) px[owner[i]]++;
  return px;
}
// Bounding union of each node's rectangles, retaining floating-point coordinates.
/** @param {Painted} painted @returns {Map<string, Rect>} */
export function boxes({ ids, rects }) {
  const out = /** @type {Map<string, Rect>} */ (new Map());
  for (let i = 0; i < rects.length; i += 5) {
    const id = ids[rects[i]], x = rects[i + 1], y = rects[i + 2], r = out.get(id);
    out.set(id, r ? [Math.min(r[0], x), Math.min(r[1], y), Math.max(r[2], x + rects[i + 3]), Math.max(r[3], y + rects[i + 4])] : [x, y, x + rects[i + 3], y + rects[i + 4]]);
  }
  return out;
}

// -- Ranking ------------------------------------------------------------
// Merge both sides by node ID with px = max(htmlPx, figmaPx). HTML sees only current paint; Figma accounts for vacated or missing areas.
// Exclude root, ref nodes and zero counts. Sort descending by px, breaking ties by extract preorder; IDs absent from the tree come last in string order.
/**
 * @param {{ html: Painted, htmlPx: Int32Array, figma: Painted, figmaPx: Int32Array, order: Map<string, number>, exclude: Set<string> }} input
 * @returns {Ranked[]}
 */
export function rank({ html, htmlPx, figma, figmaPx, order, exclude }) {
  const rows = /** @type {Map<string, Ranked>} */ (new Map());
  /** @param {Painted} p @param {Int32Array} px @param {'htmlPx' | 'figmaPx'} side */
  const add = (p, px, side) => p.ids.forEach((id, k) => {
    const r = rows.get(id) ?? { node: id, name: p.names[k], htmlPx: 0, figmaPx: 0, px: 0 };
    r[side] = px[k]; r.px = Math.max(r.htmlPx, r.figmaPx); rows.set(id, r);
  });
  add(figma, figmaPx, 'figmaPx'); add(html, htmlPx, 'htmlPx');
  /** @param {string} id */
  const at = id => order.get(id) ?? Infinity;
  return [...rows.values()].filter(r => r.px && !exclude.has(r.node))
    .sort((p, q) => q.px - p.px || at(p.node) - at(q.node) || (p.node < q.node ? -1 : p.node > q.node ? 1 : 0))
    .map(r => r.px >= GAP_PX && Math.min(r.htmlPx, r.figmaPx) <= GAP_RATIO * r.px ? { ...r, gap: r.figmaPx > r.htmlPx ? 'html-missing' : 'html-extra' } : r);
}
