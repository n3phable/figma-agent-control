/**
 * [INPUT]: Imports ./generate.mjs, ./attrib.mjs.
 * [OUTPUT]: Exports BACKGROUND, SPAN, SUGGEST_PX, SEAM_STEP, SEAM_MIN, SEAM_RATIO, suggest, seams, seamLimit, hardEdge.
 * [POS]: Derives reference-bake suggestions and measures seams from comparison evidence.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { generate } from './generate.mjs';
import { raster } from './attrib.mjs';
/** @import { LandedExtractOutput, ExtractNode } from './extract-contract.js' */
/** @import { Approximation, OverrideEntry } from './generate.mjs' */
/** @import { Rect } from './attrib.mjs' */
/**
 * @typedef {{ members: string[], kinds: string[], target: string, rect: Rect | null, ownPx: number, block: boolean, triggered: boolean,
 *   outcome: 'suggest' | 'root' | 'no-render-bounds' | 'span' | 'text-mismatch' | 'idle' }} Cluster  Merged by target; rect uses the local target-rectangle formula.
 * @typedef {{ node: string, name: string, entry: { bake: 'ref', note: string }, rect: Rect, share: number, textNodes: number, bakedOver: string[],
 *   members: string[], replaces: string[] }} Suggestion  replaces lists existing frame-group entries on the target or its descendants.
 * @typedef {{ edges: number, mean: number, hard: number, max: number }} Seam  edges counts sampled pairs; hard counts excess above SEAM_STEP; max is greatest excess.
 */

// Backdrop-dependent approximation kinds, in note order. isolation, mask-isolation and needs-island never join clusters.
export const BACKGROUND = ['glass', 'background-blur', 'blend-shadow', 'blend-mode', 'island-vetoed'];
// Limit target area to SPAN times the member union. Trigger above SUGGEST_PX differing target-rectangle pixels whose Figma owner is not TEXT, calibrated on three Now frames and the offline corpus.
export const SPAN = 4, SUGGEST_PX = 300;
// A seam pair is hard when the rendered edge jump exceeds the reference by more than SEAM_STEP. Warn when hard >= max(SEAM_MIN, ceil(SEAM_RATIO * edges)), normalizing by edge length with a minimum floor.
export const SEAM_STEP = 8, SEAM_MIN = 4, SEAM_RATIO = 0.02;
const E = 1e-3, COMPONENTS = new Set(['INSTANCE', 'COMPONENT']);

/** @param {Rect} a @param {Rect} b Test positive-area intersection. */
const meets = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/** @param {number[]} b [x, y, w, h] @returns {Rect} */
const corners = ([x, y, w, h]) => [x, y, x + w, y + h];
/** @param {Rect} r */
const area = r => (r[2] - r[0]) * (r[3] - r[1]);
/** @param {number} v */
const r2 = v => Number(v.toFixed(2)) || 0;

// -- Suggestions --------------------------------------------------------
// Members are BACKGROUND approximation nodes excluding TEXT (node-level blending is approximated by generation, and baking would only lose text semantics), non-array renderBounds,
// and nodes inside valid refs, including ref roots. Drop empty rectangles and connect intersecting bounds with union-find. Choose the nearest common ancestor, then promote to itself or the closest
// INSTANCE/COMPONENT below root. Baking only a GLASS layer could expose hard edges from sibling layers in the same component. Merge clusters sharing a target.
// Trigger when any member intersects a structural block or when differing, non-TEXT-owned pixels in the target rectangle exceed the threshold. Blocks alone miss scattered residual differences;
// excluding TEXT avoids baking regions with only text residuals. Triggered cases get hints instead of suggestions when the target is root, bounds are unavailable, subtree text differs from Figma,
// or target area exceeds SPAN times the union of member/target intersections. Text mismatch would freeze incorrect content into a bitmap. generate computes suggested rect/share/bakedOver
// after applying suggestions, matching html.json refs after an agent writes those overrides.
/**
 * @param {LandedExtractOutput} output
 * @param {{ approximations: ReadonlyArray<Approximation>, overrides: Record<string, OverrideEntry>, refs: ReadonlyArray<{ node: string }>, textMismatch: ReadonlySet<string> }} ctx
 *   refs are actually painted page refs; overrides is this frame's group.
 * @param {{ mask: Uint8Array, width: number, height: number, blocks: ReadonlyArray<{ x: number, y: number, w: number, h: number }>, figma: { owner: Int32Array, ids: string[] } }} diff
 * @param {number} [threshold]
 * @returns {{ suggest: Suggestion[], hints: string[], clusters: Cluster[] }}
 */
export function suggest(output, { approximations, overrides, refs, textMismatch }, { mask, width, height, blocks, figma }, threshold = SUGGEST_PX) {
  const root = output.root, s = output.scale, byId = /** @type {Map<string, ExtractNode>} */ (new Map()), parent = /** @type {Map<string, string>} */ (new Map());
  const order = /** @type {Map<string, number>} */ (new Map());
  /** @param {ExtractNode} n */
  const walk = n => { order.set(n.id, order.size); byId.set(n.id, n); for (const c of n.children ?? []) { parent.set(c.id, n.id); walk(c); } };
  walk(root);
  /** Self and all ancestors, nearest first. @param {string} id */
  const line = id => { const out = [id]; for (let p = parent.get(id); p; p = parent.get(p)) out.push(p); return out; };
  /** Match generation: scale renderBounds, round outward and clamp to reference dimensions; return null when empty. @param {number[]} rb @returns {Rect | null} */
  const rectOf = rb => {
    const r = /** @type {Rect} */ ([Math.max(0, Math.floor(rb[0] * s + E)), Math.max(0, Math.floor(rb[1] * s + E)), Math.min(width, Math.ceil((rb[0] + rb[2]) * s - E)),
      Math.min(height, Math.ceil((rb[1] + rb[3]) * s - E))]);
    return r[2] > r[0] && r[3] > r[1] ? r : null;
  };
  /** @param {string} p @param {string} q */
  const pre = (p, q) => /** @type {number} */ (order.get(p)) - /** @type {number} */ (order.get(q));
  /** @param {string} id */
  const bounds = id => /** @type {number[]} */ (byId.get(id)?.renderBounds);

  // -- Members and clustering --
  const baked = new Set(refs.map(r => r.node)), kinds = /** @type {Map<string, Set<string>>} */ (new Map());
  for (const a of approximations) {
    const n = byId.get(a.node);
    if (!BACKGROUND.includes(a.kind) || !n || n.type === 'TEXT' || !Array.isArray(n.renderBounds) || !rectOf(n.renderBounds) || line(n.id).some(p => baked.has(p))) continue;
    if (!kinds.has(n.id)) kinds.set(n.id, new Set());
    kinds.get(n.id)?.add(a.kind);
  }
  const members = [...kinds.keys()].sort(pre), link = members.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const find = i => link[i] === i ? i : (link[i] = find(link[i]));
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++)
    if (meets(corners(bounds(members[i])), corners(bounds(members[j])))) link[find(i)] = find(j);
  const groups = /** @type {Map<number, string[]>} */ (new Map());
  members.forEach((id, i) => groups.set(find(i), [...groups.get(find(i)) ?? [], id]));

  // -- Targets and merging --
  /** @param {string[]} ids */
  const targetOf = ids => {
    const paths = ids.map(id => line(id).reverse());
    let i = 0;
    while (paths.every(p => i < p.length && p[i] === paths[0][i])) i++;
    const lca = paths[0][i - 1];
    return line(lca).find(p => p !== root.id && COMPONENTS.has(/** @type {ExtractNode} */ (byId.get(p)).type)) ?? lca;
  };
  const merged = /** @type {Map<string, Set<string>>} */ (new Map());
  for (const ids of groups.values()) {
    const t = targetOf(ids);
    merged.set(t, new Set([...merged.get(t) ?? [], ...ids]));
  }

  // -- Triggers and outcomes --
  const clusters = /** @type {Cluster[]} */ ([]), hints = /** @type {string[]} */ ([]), chosen = /** @type {{ target: string, note: string, members: string[], replaces: string[] }[]} */ ([]);
  const boxes = blocks.map(b => /** @type {Rect} */ ([b.x, b.y, b.x + b.w, b.y + b.h]));
  for (const target of [...merged.keys()].sort(pre)) {
    const ids = [...(/** @type {Set<string>} */ (merged.get(target)))].sort(pre), node = /** @type {ExtractNode} */ (byId.get(target));
    const ks = BACKGROUND.filter(k => ids.some(id => kinds.get(id)?.has(k))), parts = ids.map(id => /** @type {Rect} */ (rectOf(bounds(id))));
    const rect = /** @type {Rect | null} */ (target !== root.id && Array.isArray(node.renderBounds) ? rectOf(node.renderBounds) : null), block = parts.some(r => boxes.some(b => meets(r, b)));
    let ownPx = 0;
    const [x0, y0, x1, y1] = rect ?? [0, 0, 0, 0];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * width + x, k = figma.owner[i];
      if (mask[i] === 1 && !(k >= 0 && byId.get(figma.ids[k])?.type === 'TEXT')) ownPx++;
    }
    const triggered = block || ownPx > threshold, wrong = [...textMismatch].filter(id => line(id).includes(target)), what = `Approximations ${ks.join(',')} (${ids.length} node(s), e.g. ${ids[0]})`;
    // Intersect member rectangles with target before unioning: ancestor clipping can make members extend outside the target and overestimate coverage. Rasterize only within the target, without full-frame allocation.
    let covered = 0;
    if (rect) for (const k of raster(parts.flatMap(r => [0, r[0] - rect[0], r[1] - rect[1], r[2] - r[0], r[3] - r[1]]), rect[2] - rect[0], rect[3] - rect[1])) if (k >= 0) covered++;
    /** @type {Cluster['outcome']} */
    const outcome = !triggered ? 'idle' : target === root.id ? 'root' : !rect ? 'no-render-bounds' : wrong.length ? 'text-mismatch'
      : area(rect) > SPAN * covered ? 'span' : 'suggest';
    clusters.push({ members: ids, kinds: ks, target, rect, ownPx, block, triggered, outcome });
    if (outcome === 'root') hints.push(`${what}: common ancestor is the root node; bake:"ref" not suggested`);
    else if (outcome === 'no-render-bounds') hints.push(`${what}: target ${target} has no usable renderBounds; bake:"ref" not suggested`);
    else if (outcome === 'text-mismatch') hints.push(`Text in the subtree of ${target} differs from Figma (${wrong.slice(0, 3).join(', ')}): act on the structure check report first; baking would freeze the wrong text into the bitmap and the structure check would stop reporting it`);
    else if (outcome === 'span' && rect) hints.push(`${what}: target ${target} rectangle covers ${r2(area(rect) / (width * height) * 100)}% of the canvas, `
      + `${r2(area(rect) / covered)}x the union of member rectangles (limit ${SPAN}x); bake:"ref" not suggested`);
    else if (outcome === 'suggest') {
      const replaces = Object.keys(overrides).filter(id => line(id).includes(target));
      chosen.push({ target, note: ks.join(','), members: ids, replaces });
      if (replaces.length) hints.push(`Before writing bake:"ref" for ${target}, delete or rewrite these entries: ${replaces.join(', ')}; subtree style, skip and bake:"svg" entries would become invalid inside-ref entries (exit code 1) `
        + 'and subtree bake:"ref" entries redundant');
    }
  }
  if (!chosen.length) return { suggest: [], hints, clusters };

  // -- Rectangles and bakedOver: compute after all suggestions through generate, excluding mutual suggestions from bakedOver --
  const placed = generate(output, { overrides: { ...overrides, ...Object.fromEntries(chosen.map(c => [c.target, { bake: /** @type {const} */ ('ref'), note: 'suggest' }])) } }).refs;
  const suggestions = chosen.map(({ target, note, members, replaces }) => {
    const p = /** @type {import('./generate.mjs').RefPlacement} */ (placed.find(r => r.node === target)), frame = /** @type {Rect} */ (p.rect.map(v => v / s));
    // Count visible TEXT nodes inside the rectangle, including non-descendants, as the cost of freezing.
    const textNodes = [...byId.values()].filter(n => n.type === 'TEXT' && Array.isArray(n.renderBounds) && meets(corners(n.renderBounds), frame)).length;
    return { node: target, name: /** @type {ExtractNode} */ (byId.get(target)).name, entry: { bake: /** @type {const} */ ('ref'), note }, rect: p.rect, share: p.share, textNodes,
      bakedOver: p.bakedOver, members, replaces };
  });
  return { suggest: suggestions, hints, clusters };
}

// -- Seams --------------------------------------------------------------
// Sample pixel pairs along each ref's four edges, one pixel inside/outside. Skip outside-image samples and those inside any ref. Edge jump is the maximum premultiplied RGBA channel difference
// because fully transparent RGB is arbitrary and would otherwise create false jumps. Excess e = rendered jump minus reference jump; mean = sum(max(0, e)) / edges,
// hard counts e > SEAM_STEP, and max = max(0, greatest e). pixelmatch sees few pixels outside the rectangle, so these measures reveal hard seams.
/** @param {Uint8Array} ref @param {Uint8Array} act @param {number} width @param {number} height @param {ReadonlyArray<{ rect: Rect }>} refs @returns {Seam[]} */
export function seams(ref, act, width, height, refs) {
  /** @param {number} x @param {number} y */
  const off = (x, y) => x < 0 || y < 0 || x >= width || y >= height;
  /** @param {Uint8Array} img @param {number} p @param {number} q */
  const jump = (img, p, q) => {
    const a = img[p + 3], b = img[q + 3];
    return Math.max(Math.abs(img[p] * a - img[q] * b) / 255, Math.abs(img[p + 1] * a - img[q + 1] * b) / 255, Math.abs(img[p + 2] * a - img[q + 2] * b) / 255, Math.abs(a - b));
  };
  return refs.map(({ rect: [x0, y0, x1, y1] }) => {
    let edges = 0, sum = 0, hard = 0, max = 0;
    /** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
    const pair = (ax, ay, bx, by) => {
      if (off(ax, ay) || off(bx, by) || refs.some(({ rect: r }) => bx >= r[0] && bx < r[2] && by >= r[1] && by < r[3])) return;
      const p = (ay * width + ax) * 4, q = (by * width + bx) * 4, e = jump(act, p, q) - jump(ref, p, q);
      edges++; sum += Math.max(0, e); max = Math.max(max, e);
      if (e > SEAM_STEP) hard++;
    };
    for (let x = x0; x < x1; x++) { pair(x, y0, x, y0 - 1); pair(x, y1 - 1, x, y1); }
    for (let y = y0; y < y1; y++) { pair(x0, y, x0 - 1, y); pair(x1 - 1, y, x1, y); }
    return { edges, mean: edges ? r2(sum / edges) : 0, hard, max: r2(max) };
  });
}
// Warn when hard reaches this edge-normalized threshold with a minimum floor; mean/max are reported but do not affect the verdict.
/** @param {number} edges @param {number} [min] @param {number} [ratio] */
export const seamLimit = (edges, min = SEAM_MIN, ratio = SEAM_RATIO) => Math.max(min, Math.ceil(ratio * edges));
/** @param {Seam} s @param {number} [min] @param {number} [ratio] */
export const hardEdge = (s, min = SEAM_MIN, ratio = SEAM_RATIO) => s.edges > 0 && s.hard >= seamLimit(s.edges, min, ratio);
