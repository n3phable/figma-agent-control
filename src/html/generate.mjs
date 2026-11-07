/**
 * [INPUT]: Uses ./css.mjs styling functions, VECTORS and FRAMES; node:fs/node:crypto only compute GENERATOR at module load.
 *          Accepts LandedExtractOutput from ./extract-contract.js, including same-shaped offline data where renderBounds may be absent.
 * [OUTPUT]: GENERATOR, generate(output, options) -> GenerateResult, fontRequests(output) -> FontRequest[], embed(html, uris) -> { html, missing },
 *           dataUri(type, bytes), and FontRequest/OverrideEntry/GenerateOptions/GenerateResult/RefPlacement/Approximation/Stale/FontUse types.
 * [POS]: Pure extraction-to-HTML assembly: nested DOM, matrix positions (left/top for escaping blends), mask wrappers, island inclusion/veto and bake decisions,
 *        fill/stroke layers, root opacity, reversed auto-layout paint order, box/content shadows, integer line heights and baseline compensation, font declarations, overrides/staleness, and baked-reference placeholders/refs after #canvas.
 *        Also owns the document template and output invariants. Callers supply parsed font metrics/SVG; bitmaps and reference crops remain fac-asset placeholders until embed replaces them with data URIs. css.mjs maps individual values.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { VECTORS, FRAMES, num, px, esc, cssStr, place, paintLayer, radius, stroke, effects, backdrop, blend, lineHeight, baselineShift, postScriptGuess,
  segmentStyle, textBox, maskImage, vectorSvg, fillAlpha, bakeReason, paintsBackground, painted, paintOrder } from './css.mjs';
/** @import { LandedExtractOutput, ExtractNode, TextSegment, BinaryFile } from './extract-contract.js' */
/** @import { Style, Matrix, Paint, FontMetrics } from './css.mjs' */
/**
 * @typedef {{ key: string, postScriptName?: string, family: string, style: string }} FontRequest
 * @typedef {{ style?: Record<string, string>, basis?: Record<string, string>, skip?: boolean, bake?: 'svg' | 'ref', note: string }} OverrideEntry
 * @typedef {{
 *   fonts?: Record<string, FontMetrics | null>,
 *   svgs?: Record<string, string>,
 *   overrides?: Record<string, OverrideEntry>,
 *   extract?: string,
 *   overridesHash?: string
 * }} GenerateOptions
 *   fonts maps fontRequests keys to caller-loaded metrics; svgs supplies explicit-island SVG text; overrides is the caller-validated group for this frame.
 * @typedef {{ node: string, kind: string, detail?: string }} Approximation
 * @typedef {{ node: string, kind: 'missing' | 'changed' | 'invalid', reason?: string }} Stale
 * @typedef {{ node: string, key: string, rect: [x0: number, y0: number, x1: number, y1: number], share: number, bakedOver: string[] }} RefPlacement
 *   Baked reference crop: key identifies fac-asset:<key>; rect is half-open in reference pixels; share is its reference-area ratio to four decimals.
 *   bakedOver lists outermost DOM-painted nodes covered by the crop in extract preorder, excluding ancestors, other ref subtrees, skipped nodes, masks and unpainted nodes.
 * @typedef {{ family: string, style: string, postScriptName: string, source: 'segment' | 'file' | 'guess', metrics: boolean, face: string }} FontUse
 * @typedef {{
 *   html: string,
 *   approximations: Approximation[],
 *   needsIsland: string[],
 *   refs: RefPlacement[],
 *   overrides: { applied: string[], stale: Stale[] },
 *   fonts: FontUse[],
 *   stats: { nodes: number, text: number, islands: number, masks: number, skipped: number, omitted: number },
 *   violations: string[]
 * }} GenerateResult  refs follows extract preorder, one-to-one with placeholders after #canvas.
 */

// Fingerprint this file and css source into HTML metadata so verification records distinguish generator versions.
export const GENERATOR = crypto.createHash('sha256').update(['css.mjs', 'generate.mjs'].map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n'))
  .digest('hex').slice(0, 12);

// -- Matrices -----------------------------------------------------------
// Contract transforms are [[a, c, tx], [b, d, ty]] in target coordinates. Local matrix = inverse(coordinate parent) * self.
/** @param {ExtractNode['transform']} t @returns {Matrix} */
const frameOf = t => [t[0][0], t[1][0], t[0][1], t[1][1], t[0][2], t[1][2]];
/** @param {Matrix} p @param {Matrix} q @returns {Matrix} */
const mul = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
/** @param {Matrix} m @returns {Matrix} */
const inv = ([a, b, c, d, e, f]) => { const k = a * d - b * c; return [d / k, -b / k, -c / k, a / k, (c * f - d * e) / k, (b * e - a * f) / k]; };
/** @param {Matrix} P @param {Matrix} M */
const local = (P, M) => place(mul(inv(P), M));
// Transform (0, 0, w, h) through M and return bounding [x, y, w, h], defining island origins for offline data without renderBounds.
/** @param {ExtractNode} node @returns {[number, number, number, number]} */
function aabb(node) {
  const [a, b, c, d, e, f] = frameOf(node.transform), w = node.width, h = node.height;
  const xs = [0, a * w, c * h, a * w + c * h], ys = [0, b * w, d * h, b * w + d * h], x = Math.min(...xs), y = Math.min(...ys);
  return [e + x, f + y, Math.max(...xs) - x, Math.max(...ys) - y];
}

// -- Utilities ----------------------------------------------------------
// Serialize styles in insertion order, omitting undefined values removed by overrides.
// flat writes pure translation as left/top. Observed Chromium transform stacking contexts isolate descendant mix-blend-mode inside the container,
// turning glass-button fills opaque gray. Flatten only nodes whose blending must escape, as determined by preprocessing; keep transforms elsewhere for fractional-position antialiasing.
// Styles still represent this as transform, so overrides style/basis read and write transform normally.
/** @param {Style} s @param {boolean} [flat] */
const css = (s, flat = false) => esc(Object.entries(s).filter(([, v]) => v !== undefined).map(([k, v]) => {
  const t = flat && k === 'transform' && /^translate\(([^,]+),([^)]+)\)$/.exec(v);
  return t ? `left:${t[1]};top:${t[2]}` : `${k}:${v}`;
}).join(';'));
/** @param {ExtractNode} n */
const attrs = n => `data-node="${esc(n.id)}" data-name="${esc(n.name)}"`;
/** @template T @param {ReadonlyArray<T> | string | undefined} list @returns {T[]} */
const shown = list => Array.isArray(list) ? list.filter(p => p?.visible !== false) : [];
/** @param {TextSegment} s */
const fontKey = s => JSON.stringify([s.fontPostScriptName ?? null, s.fontName.family, s.fontName.style]);
/** @param {FontMetrics | null} a @param {FontMetrics | null} b */
const sameMetrics = (a, b) => !!a && !!b && a.unitsPerEm === b.unitsPerEm && a.hhea.ascender === b.hhea.ascender && a.hhea.descender === b.hhea.descender
  && a.hhea.lineGap === b.hhea.lineGap;
// pre-wrap does not break on U+2028/U+2029; emit them as newlines.
/** @param {string} s */
const plain = s => esc(s.replace(/[\u2028\u2029]/g, '\n'));
/** @param {ExtractNode} n @param {(n: ExtractNode) => void} fn */
const walk = (n, fn) => { fn(n); for (const c of n.children ?? []) walk(c, fn); };
// Container node types; generate other types as containers and record node-type.
const CONTAINERS = new Set(['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'SLOT', 'RECTANGLE', 'ELLIPSE']);
// With multiple text segments, the container inherits only these first-segment strut properties. Put color, decoration, spacing and case on spans to prevent leakage between segments.
const STRUT = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height'];
const PLAIN = new Set([undefined, 'PASS_THROUGH', 'NORMAL']);

// -- Font requests ------------------------------------------------------
// Each segment key is [PostScript name or null, family, style]. Callers look up font files and return metrics under the same key.
/** @param {LandedExtractOutput} output @returns {FontRequest[]} */
export function fontRequests(output) {
  const found = /** @type {Map<string, FontRequest>} */ (new Map());
  walk(output.root, n => {
    for (const s of n.segments ?? []) {
      const key = fontKey(s);
      if (!found.has(key)) found.set(key, { key, ...(s.fontPostScriptName ? { postScriptName: s.fontPostScriptName } : {}), family: s.fontName.family, style: s.fontName.style });
    }
  });
  return [...found.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// -- Generation ---------------------------------------------------------
/** @param {LandedExtractOutput} output @param {GenerateOptions} [options] @returns {GenerateResult} */
export function generate(output, { fonts = {}, svgs = {}, overrides = {}, extract = 'none', overridesHash = 'none' } = {}) {
  const root = output.root, stats = { nodes: 0, text: 0, islands: 0, masks: 0, skipped: 0, omitted: 0 };
  const approximations = /** @type {Approximation[]} */ ([]), noted = new Set(), needsIsland = /** @type {string[]} */ ([]), applied = /** @type {string[]} */ ([]);
  const handled = new Set(), changed = /** @type {Map<string, string>} */ (new Map()), faces = /** @type {Map<string, string>} */ (new Map()), rules = /** @type {string[]} */ ([]);
  const uses = /** @type {Map<string, FontUse>} */ (new Map());
  let islandSeq = 0;
  const byId = /** @type {Map<string, ExtractNode>} */ (new Map()), parent = /** @type {Map<ExtractNode, ExtractNode>} */ (new Map());
  walk(root, n => { byId.set(n.id, n); for (const c of n.children ?? []) parent.set(c, n); });
  /** @param {ExtractNode} node @param {string | undefined} kind @param {string} [detail] */
  const approx = (node, kind, detail) => {
    const key = JSON.stringify([node.id, kind, detail]);
    if (kind && !noted.has(key)) { noted.add(key); approximations.push({ node: node.id, kind, ...(detail ? { detail } : {}) }); }
  };
  /** @param {string} id */
  const apply = id => { handled.add(id); if (!applied.includes(id)) applied.push(id); };

  // -- Baked reference crops: bake:"ref" --
  // Valid entries suppress node/subtree DOM and place a cropped-reference bitmap after #canvas, using fac-asset:ref<n> for caller cropping and data-URI embedding.
  // Scale renderBounds, round outward to whole pixels and clamp to reference dimensions. Epsilon absorbs floating-point noise so 55.00000000000023 does not cross pixel 55.
  // Invalid reasons: root target, missing/empty-clamped renderBounds (no-render-bounds), or reference dimensions inconsistent with extraction (reference-size), making coordinates unreliable.
  // Refs still emit inside islands, skipped subtrees or other refs because their output is independent of traversal.
  const scale = output.scale, E = 1e-3, picture = output.reference, RW = 'sha256' in picture ? picture.width ?? 0 : 0, RH = 'sha256' in picture ? picture.height ?? 0 : 0;
  const offSize = Math.abs(RW - Math.round(root.width * scale)) > 1 || Math.abs(RH - Math.round(root.height * scale)) > 1 || !RW || !RH;
  const refs = /** @type {RefPlacement[]} */ ([]), refWhy = /** @type {Map<string, string>} */ (new Map()), baked = new Set();
  walk(root, n => {
    if (overrides[n.id]?.bake !== 'ref') return;
    const rb = n.renderBounds, rect = /** @type {RefPlacement['rect']} */ (rb ? [Math.max(0, Math.floor(rb[0] * scale + E)), Math.max(0, Math.floor(rb[1] * scale + E)),
      Math.min(RW, Math.ceil((rb[0] + rb[2]) * scale - E)), Math.min(RH, Math.ceil((rb[1] + rb[3]) * scale - E))] : [0, 0, 0, 0]);
    const why = n === root ? 'root' : !rb ? 'no-render-bounds' : offSize ? 'reference-size' : rect[2] <= rect[0] || rect[3] <= rect[1] ? 'no-render-bounds' : '';
    if (why) { refWhy.set(n.id, why); return; }
    baked.add(n.id);
    refs.push({ node: n.id, key: 'ref' + refs.length, rect, share: Number(((rect[2] - rect[0]) * (rect[3] - rect[1]) / (RW * RH)).toFixed(4)), bakedOver: [] });
  });
  // Suppress descendants of refs, excluding each ref root itself; other overrides targeting them become inside-ref.
  const frozen = new Set();
  for (const id of baked) for (const c of byId.get(id)?.children ?? []) walk(c, d => frozen.add(d.id));
  // bakedOver reports outermost DOM nodes covered by a reference rectangle. Skip masks, skip entries, unpainted nodes and valid refs
  // with their subtrees, excluding content already frozen by other refs. Ancestors are not covered; continue into them.
  for (const r of refs) {
    const target = /** @type {ExtractNode} */ (byId.get(r.node)), line = new Set(), [x0, y0, x1, y1] = r.rect.map(v => v / scale);
    for (let p = parent.get(target); p; p = parent.get(p)) line.add(p);
    /** @param {ExtractNode} n */
    const visit = n => {
      if (n.isMask || overrides[n.id]?.skip || n.renderBounds === null || baked.has(n.id)) return;
      const b = n.renderBounds;
      if (!line.has(n) && b && b[0] < x1 && b[0] + b[2] > x0 && b[1] < y1 && b[1] + b[3] > y0) { r.bakedOver.push(n.id); return; }
      for (const c of n.children ?? []) visit(c);
    };
    visit(root);
  }

  // -- Island eligibility and node effects: shared by preprocessing/generation --
  /** @param {string} svg */
  const svgSize = svg => {
    const tag = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '', w = /\swidth="([\d.]+)(?:px)?"/.exec(tag), h = /\sheight="([\d.]+)(?:px)?"/.exec(tag);
    return w && h ? [Number(w[1]), Number(h[1])] : null;
  };
  /** @param {ExtractNode} node @param {string} svg With renderBounds present, SVG size differing from ceil(width/height - 1e-3) indicates ancestor clipping and cannot represent the entire node. */
  const clipped = (node, svg) => { const rb = node.renderBounds, size = svgSize(svg); return !!rb && !!size && (size[0] !== Math.ceil(rb[2] - 1e-3) || size[1] !== Math.ceil(rb[3] - 1e-3)); };
  // Fall back to DOM when SVG is unavailable, backdrop-dependent without explicit bake:"svg", or clipped. why records the reason; bg must already include this node before calling.
  /** @param {ExtractNode} node @param {string} key @returns {{ svg: string | undefined, why: string }} */
  const islandOf = (node, key) => {
    const raw = output.svgs[key], svg = typeof raw === 'string' ? raw : svgs[key];
    return { svg, why: svg === undefined ? 'island-unavailable' : bg.has(node) && overrides[node.id]?.bake !== 'svg' ? 'island-vetoed' : clipped(node, svg) ? 'island-clipped' : '' };
  };
  // Effect targets: text for TEXT; content shape/filter for vectors, image-only fills, or unfilled nodes with children/strokes; box otherwise. Empty containers without fill/stroke/children cast no shadow.
  // Count only positive-opacity painted fills: Figma excludes zero-opacity fills from silhouettes, so stroke-only nodes shadow just the stroke ring;
  // Figma still cuts shadows out of that fill area, while drop-shadow shows through the transparent box, requiring an approximation warning.
  // Observed unclipped frames shadow the combined fill/stroke/child geometry, excluding child shadows and unaffected by fill translucency.
  // Switch to content-shaped shadows only when painted children (visible fills/strokes, excluding masks; recurse into unclipped containers) protrude beyond the box, fill is opaque and there is one drop shadow;
  // drop-shadow uses element alpha, so translucent fills weaken/show shadows through themselves, and multiple drop-shadows compound earlier shadows. Otherwise keep box shadows and mark approximation.
  // Effect-free leaves use renderBounds, already mask-clipped and including strokes/rotation. Other nodes use transformed boxes because their renderBounds includes shadows.
  // drop-shadow also includes descendant shadows in its silhouette, so mark descendant-shadow cases approximate.
  // ponytail: Bounding-box comparison can miss protrusions on rotated frames and fall back to box shadows; compare in frame-local coordinates if exact handling becomes necessary.
  /** @param {ExtractNode} node */
  const spills = node => {
    if (!FRAMES.has(node.type) || node.clipsContent || !node.children?.length) return false;
    const [x, y, w, h] = aabb(node);
    /** @param {ExtractNode} c @returns {boolean} */
    const out = c => {
      if (c.renderBounds === null || c.isMask) return false;
      const [cx, cy, cw, ch] = c.children?.length || shown(c.effects).length ? aabb(c) : c.renderBounds ?? aabb(c);
      const draws = painted(c.fills).length > 0 || shown(c.strokes).length > 0;
      return (draws && (cx < x - 0.01 || cy < y - 0.01 || cx + cw > x + w + 0.01 || cy + ch > y + h + 0.01)) || (!c.clipsContent && !!c.children?.some(out));
    };
    return node.children.some(out);
  };
  /** @param {ExtractNode} n @returns {boolean} */
  const dropsBelow = n => !!n.children?.some(c => shown(c.effects).some(e => e.type === 'DROP_SHADOW') || dropsBelow(c));
  /** @param {ExtractNode} node */
  const fxOf = node => {
    const fills = painted(node.fills), strokes = shown(node.strokes).length > 0, drops = shown(node.effects).filter(e => e.type === 'DROP_SHADOW').length;
    const spill = drops && fills.length > 0 && spills(node);
    if (node.type === 'TEXT') return effects(node, 'text');
    if (VECTORS.has(node.type) || (fills.length === 1 && fills[0].type === 'IMAGE') || (!fills.length && (node.children?.length || strokes)) || (spill && drops === 1 && fillAlpha(node) === 1)) {
      const fx = effects(node, 'image');
      if (!VECTORS.has(node.type) && drops && dropsBelow(node)) fx.approx.push('shadow-children');
      if (drops && shown(node.fills).length > fills.length) fx.approx.push('shadow-knockout');
      return fx;
    }
    if (!fills.length) return { style: /** @type {Style} */ ({}), approx: /** @type {string[]} */ ([]) };
    const fx = effects(node, 'box');
    if (spill) fx.approx.push('shadow-spill');
    return fx;
  };

  // Postorder preprocessing computes backdrop-dependent subtrees, including root for vetoes, and flat nodes written as left/top. Ref subtrees become reference images and do not participate.
  // transform creates an isolated stacking context: descendants blend only with its contents, while an element's own transform does not affect its own blending.
  // Flatten when blending must escape: nodes with blended fill-layer children, plus ancestors of blended nodes up to the isolation boundary.
  // Figma also isolates NORMAL containers, translucent nodes and nodes with their own blending. CSS filter elements, including layer blur/content shadows,
  // also isolate, so flattening cannot pass through them. Mark descendant blending as isolation approximations in emit/container; the boundary and ancestors need no flattening.
  const bg = /** @type {Set<ExtractNode>} */ (new Set()), flat = /** @type {Set<ExtractNode>} */ (new Set());
  /** @param {ExtractNode} n @returns {boolean} Whether the parent must let this node's blending pass through. */
  const scan = n => {
    if (baked.has(n.id)) return false;
    let b = paintsBackground(n), up = false;
    for (const c of n.children ?? []) { up = scan(c) || up; b = b || bg.has(c); }
    if (b) bg.add(n);
    // Internal blending comes from forced-bake SVG's own blend modes for inlined islands; otherwise inspect container fill layers, including DOM fallback islands. Vector/text paint blending is unsupported.
    const key = output.islands[n.id], inline = key !== undefined && !islandOf(n, key).why;
    const own = !PLAIN.has(n.blendMode), inner = inline ? overrides[n.id]?.bake === 'svg' && paintsBackground(n)
      : !VECTORS.has(n.type) && n.type !== 'TEXT' && shown(n.fills).some(p => !PLAIN.has(p.blendMode));
    const isolated = own || (n.blendMode === 'NORMAL' && !!n.children?.length) || (n.opacity ?? 1) < 0.999 || (!inline && !!fxOf(n).style.filter);
    if (!isolated && (inner || up)) flat.add(n);
    return own || (!isolated && (inner || up));
  };
  scan(root);
  if (output.colorProfile === 'DISPLAY_P3') approx(root, 'color-profile');

  // Apply overrides over generated styles. Compare every basis value, treating absent values as ''; mismatch rejects the whole entry. style replaces named properties, with '' deleting them.
  /** @param {ExtractNode} node @param {Style} s */
  const finish = (node, s) => {
    const o = overrides[node.id];
    if (!o) return s;
    handled.add(node.id);
    const diff = Object.keys(o.basis ?? {}).filter(k => (s[k] ?? '') !== o.basis?.[k]);
    if (diff.length) { changed.set(node.id, diff.join(',')); return s; }
    if (o.style) { for (const [k, v] of Object.entries(o.style)) if (v === '') delete s[k]; else s[k] = v; apply(node.id); }
    return s;
  };
  /** @param {Paint} p */
  const imageOf = p => {
    const image = p.type === 'IMAGE' && p.imageHash ? output.images[p.imageHash] : undefined;
    return image && 'sha256' in image.bytes ? { url: 'fac-asset:' + image.bytes.sha256, width: image.width, height: image.height } : null;
  };

  // Background blur/GLASS use a preceding sibling layer, taking position, size and radii after node overrides.
  /** @param {ExtractNode} node @param {Style} s */
  const backdropLayer = (node, s) => {
    const b = backdrop(node);
    if (!b) return '';
    for (const k of b.approx) approx(node, k);
    if (!b.style['backdrop-filter']) return '';
    const layer = /** @type {Style} */ ({});
    for (const k of ['transform', 'width', 'height', 'border-radius']) if (s[k] !== undefined) layer[k] = s[k];
    return `<div class="n" data-node="${esc(node.id)}" data-layer="backdrop" style="${css({ ...layer, ...b.style })}"></div>`;
  };

  // Shared root/container fills, radii, strokes, shadows and clipping; return fill/stroke layer HTML for the container's first/last positions.
  // For image-only fill without strokes, effects or children, multiply paint opacity into element opacity. If fills blend or images are translucent,
  // emit individual fill layers at the container start with per-paint blend/opacity; otherwise reverse into CSS backgrounds, since Figma's last paint is topmost but CSS's first layer is topmost.
  // Put strokes after children/fill layers because Chromium outline/inset shadows paint below positioned children, while Figma strokes paint above content;
  // keep outward strokes on clipping containers themselves, or their own overflow would clip them.
  // fxOf chooses content-shaped drop-shadow or box-shadow.
  /** @param {ExtractNode} node @param {Style} s @param {number} opacity @returns {{ fill: string, stroke: string }} */
  const surface = (node, s, opacity) => {
    const fills = shown(node.fills), w = node.width, h = node.height;
    const lone = fills.length === 1 && fills[0].type === 'IMAGE' && (fills[0].opacity ?? 1) < 1 && !shown(node.strokes).length && !shown(node.effects).length && !node.children?.length;
    const op = opacity * (lone ? fills[0].opacity ?? 1 : 1);
    if (op < 0.999) s.opacity = num(op);
    const layered = fills.some(p => !PLAIN.has(p.blendMode) || (!lone && p.type === 'IMAGE' && (p.opacity ?? 1) < 1));
    let layers = '';
    const backgrounds = [];
    for (const p of fills) {
      const l = paintLayer(p, w, h, imageOf(p));
      approx(node, l.approx, l.detail);
      if (!l.css) continue;
      if (!layered) { backgrounds.unshift(l.css); continue; }
      const b = blend(p.blendMode), ls = /** @type {Style} */ ({ position: 'absolute', inset: '0', 'border-radius': 'inherit', background: l.css });
      if (b.value) ls['mix-blend-mode'] = b.value;
      approx(node, b.approx);
      if (p.type === 'IMAGE' && (p.opacity ?? 1) < 1) ls.opacity = num(p.opacity ?? 1);
      layers += `<div data-layer="fill" style="${css(ls)}"></div>`;
    }
    if (backgrounds.length) s.background = backgrounds.join(',');
    const r = radius(node), kids = !!node.children?.length;
    if (r) s['border-radius'] = r;
    if (r && node.cornerSmoothing) approx(node, 'corner-smoothing');
    const st = stroke(node), fx = fxOf(node);
    for (const k of [...st.approx, ...fx.approx]) approx(node, k);
    const lift = (kids || layers !== '') && !(node.clipsContent && 'outline' in st.style && node.strokeAlign !== 'INSIDE');
    Object.assign(s, lift ? {} : st.style, fx.style);
    if (!lift && st.style['box-shadow'] && fx.style['box-shadow']) s['box-shadow'] = `${st.style['box-shadow']},${fx.style['box-shadow']}`;
    if (node.clipsContent) s.overflow = 'hidden';
    const edge = lift && Object.keys(st.style).length ? `<div data-layer="stroke" style="${css({ position: 'absolute', inset: '0', 'border-radius': 'inherit', ...st.style })}"></div>` : '';
    return { fill: layers, stroke: edge };
  };
  // Shared node positioning, dimensions, opacity and blending for containers/text/vectors; islands omit the last three because SVG already contains them.
  /** @param {ExtractNode} node @param {Matrix} P @param {boolean} [own] Whether the caller writes opacity. */
  const base = (node, P, own = false) => {
    const s = /** @type {Style} */ ({ transform: local(P, frameOf(node.transform)), width: px(node.width), height: px(node.height) }), b = blend(node.blendMode);
    if (!own && (node.opacity ?? 1) < 0.999) s.opacity = num(node.opacity ?? 1);
    if (b.value) s['mix-blend-mode'] = b.value;
    approx(node, b.approx);
    return s;
  };

  // Per node: omit skip/unpainted; suppress valid bake:"ref" DOM because references paint after #canvas; inline islands unless unavailable, backdrop-dependent or clipped;
  // for bake:"svg" or BAKE reasons, veto backdrop-dependent baking or record outermost needsIsland; finally emit type-specific DOM.
  // iso describes ancestor opacity/filter isolation of blending and backdrop-filter in CSS; backdrop-dependent nodes then see only group contents and are approximate.
  /** @param {ExtractNode} node @param {Matrix} P Frame matrix of the coordinate parent (parent node or preceding mask). @param {boolean} listed Whether an ancestor is already in needsIsland. @param {string} iso */
  function emit(node, P, listed, iso) {
    const o = overrides[node.id];
    if (o?.skip) { stats.skipped++; apply(node.id); return ''; }
    if (node.renderBounds === null) { stats.omitted++; return ''; }
    if (baked.has(node.id)) return '';
    if (iso && paintsBackground(node)) approx(node, 'isolation', iso);
    const key = output.islands[node.id];
    if (key !== undefined) {
      const { svg, why } = islandOf(node, key);
      if (!why) { if (o?.bake === 'svg') apply(node.id); return island(node, P, /** @type {string} */ (svg)); }
      approx(node, why);
    } else if (!listed) {
      const why = o?.bake === 'svg' ? 'override' : bakeReason(node);
      if (why && why !== 'override' && bg.has(node)) approx(node, 'island-vetoed', why);
      else if (why) { needsIsland.push(node.id); approx(node, 'needs-island', why); listed = true; if (o?.bake === 'svg') apply(node.id); }
    }
    if (node.type === 'TEXT') return text(node, P);
    if (VECTORS.has(node.type)) return vector(node, P);
    return container(node, P, listed, iso);
  }

  // -- Islands --
  // Local matrix is inverse(P) * translation(origin), using renderBounds top-left or transformed-box bounds for offline data without it. Dimensions come from SVG.
  // SVG already includes transform, opacity and blending; do not apply them twice. Prefix IDs/references by occurrence order to prevent collisions when reusing SVG.
  /** @param {ExtractNode} node @param {Matrix} P @param {string} raw */
  function island(node, P, raw) {
    const svg = raw.replace(/^\s*<\?xml[^>]*\?>\s*/, ''), [x, y, w, h] = node.renderBounds ?? aabb(node), size = svgSize(svg) ?? [w, h], k = `i${islandSeq++}-`;
    const s = finish(node, { transform: local(P, [1, 0, 0, 1, x, y]), width: px(size[0]), height: px(size[1]) });
    stats.nodes++; stats.islands++;
    const body = svg.replace(/(\s)id="([^"]*)"/g, `$1id="${k}$2"`).replace(/url\(#/g, `url(#${k}`).replace(/href="#/g, `href="#${k}`);
    return `<div class="n" ${attrs(node)} style="${css(s, flat.has(node))}">${body}</div>`;
  }

  // -- Containers and vectors --
  /** @param {ExtractNode} node @param {Matrix} P @param {boolean} listed @param {string} iso */
  function container(node, P, listed, iso) {
    if (!CONTAINERS.has(node.type)) approx(node, 'node-type', node.type);
    const s = base(node, P, true), layers = surface(node, s, node.opacity ?? 1);
    if (node.blendMode === 'NORMAL' && node.children?.length) s.isolation = 'isolate';
    stats.nodes++;
    const done = finish(node, s), inner = iso || (done.opacity ? 'opacity' : done.filter ? 'filter' : '');
    // A node's own filter isolates fill-layer blending inside it; preprocessing does not flatten that boundary.
    if (done.filter && shown(node.fills).some(p => !PLAIN.has(p.blendMode))) approx(node, 'isolation', 'filter');
    return backdropLayer(node, done) + `<div class="n" ${attrs(node)} style="${css(done, flat.has(node))}">${layers.fill}${children(node, frameOf(node.transform), listed, inner)}${layers.stroke}</div>`;
  }
  // Do not traverse vector children (boolean operands); cast shadows from transparent-pixel silhouettes.
  /** @param {ExtractNode} node @param {Matrix} P */
  function vector(node, P) {
    const s = base(node, P), fx = fxOf(node), v = vectorSvg(node);
    for (const k of [...fx.approx, ...v.approx]) approx(node, k);
    stats.nodes++;
    const done = finish(node, Object.assign(s, fx.style));
    return backdropLayer(node, done) + `<div class="n" ${attrs(node)} style="${css(done, flat.has(node))}">${v.svg}</div>`;
  }

  // -- Masks --
  // Masks do not paint; they clip following siblings. Open a wrapper sized to the mask's local box, using its frame matrix as coordinate parent until the parent ends.
  // A later sibling mask does not close the prior wrapper; nest masks in encounter order for intersection. Wrappers lack data-node, assigning their pixels to the parent.
  /** @param {ExtractNode} mask */
  const maskAlpha = mask => {
    if (!mask.fillGeometry?.length && mask.type !== 'RECTANGLE' && mask.type !== 'ELLIPSE') approx(mask, 'mask-shape', 'no-geometry');
    if (mask.maskType === 'VECTOR') return 1;
    if (mask.maskType === 'LUMINANCE') { approx(mask, 'mask-shape', 'luminance'); return 1; }
    const a = fillAlpha(mask);
    if (a !== null) return a * (mask.opacity ?? 1);
    approx(mask, 'mask-shape', shown(mask.fills).at(-1)?.type.toLowerCase() ?? 'no-fill');
    return mask.opacity ?? 1;
  };
  /** @param {ExtractNode} node @param {Matrix} M @param {boolean} listed @param {string} iso */
  function children(node, M, listed, iso) {
    let out = '', P = M, open = 0, mask = /** @type {ExtractNode | null} */ (null);
    for (const c of paintOrder(node)) {
      if (!c.isMask) {
        if (mask && bg.has(c)) approx(mask, 'mask-isolation');
        out += emit(c, P, listed, iso);
        continue;
      }
      if (overrides[c.id]?.skip) { stats.skipped++; apply(c.id); continue; }
      const Mc = frameOf(c.transform), s = finish(c, { transform: local(P, Mc), width: px(c.width), height: px(c.height), ...maskImage(c, maskAlpha(c)) });
      if (open) approx(c, 'multi-mask');
      out += `<div class="n" data-mask="${esc(c.id)}" data-name="${esc(c.name)}" style="${css(s)}">`;
      open++; stats.masks++; P = Mc; mask = c;
    }
    return out + '</div>'.repeat(open);
  }

  // -- Text --
  // Choose each segment's local font name from PostScript name, matched font record, then family/style guess. Include both first choices when available but different.
  // Emit one @font-face per distinct local-name/weight/italic tuple, numbered by first use; fallback to family, system-ui, sans-serif.
  /** @param {TextSegment} seg @param {FontMetrics | null} rec */
  const face = (seg, rec) => {
    const { family, style } = seg.fontName, ps = seg.fontPostScriptName, names = ps ? [ps] : [];
    if (rec?.postScriptName && rec.postScriptName !== ps) names.push(rec.postScriptName);
    if (!names.length) names.push(postScriptGuess(family, style));
    const weight = seg.fontWeight, italic = /italic|oblique/i.test(style), key = JSON.stringify([names, weight ?? null, italic]);
    let name = faces.get(key);
    if (!name) {
      name = 'f' + faces.size; faces.set(key, name);
      rules.push(`@font-face{font-family:'${name}';src:${names.map(n => `local(${cssStr(n)})`).join(',')}${weight === undefined ? '' : `;font-weight:${weight}`};font-style:${italic ? 'italic' : 'normal'}}`);
    }
    const use = JSON.stringify([family, style, names[0]]);
    if (!uses.has(use)) uses.set(use, { family, style, postScriptName: names[0], source: ps ? 'segment' : rec?.postScriptName ? 'file' : 'guess', metrics: !!rec, face: name });
    return { name, family, weight, italic };
  };
  /** @param {ExtractNode} node @param {Matrix} P */
  function text(node, P) {
    const segs = node.segments ?? [], box = textBox(node), size = /** @type {[number, number]} */ ([node.width, node.height]);
    const metrics = segs.map(seg => fonts[fontKey(seg)] ?? null), lhs = segs.map((seg, i) => lineHeight(seg, node, metrics[i])), l0 = lhs[0]?.px;
    // Round AUTO line height from segment/file metrics only when every segment shares size and line height. Figma uses integer line height for uniform metrics but not mixed-metric lines.
    const whole = l0 != null && lhs.every((l, i) => 'from' in l && (l.from === 'segment' || l.from === 'metrics') && segs[i].fontSize === segs[0].fontSize && Math.abs(l.px - l0) < 1e-3);
    const pxs = lhs.map(l => l.px === null ? null : whole ? Math.round(l.px) : l.px);
    const styles = segs.map((seg, i) => segmentStyle(seg, face(seg, metrics[i]), pxs[i], size));
    for (const l of lhs) if (l.px === null) approx(node, l.approx);
    for (const k of [...box.approx, ...stroke(node).approx]) approx(node, k);
    if ((node.leadingTrim && node.leadingTrim !== 'NONE') || segs.some(g => (g.listOptions && g.listOptions.type !== 'NONE') || (g.paragraphSpacing ?? 0) > 0)) approx(node, 'text-layout');
    // Paint only the top text fill. Mark multiple visible fills or segmented gradients as text-paint; unsupported types such as images become paint-unsupported.
    for (const g of segs) {
      const f = shown(g.fills), top = f.at(-1);
      if (f.length > 1 || (segs.length > 1 && top?.type === 'GRADIENT_LINEAR')) approx(node, 'text-paint');
      if (top && top.type !== 'SOLID' && top.type !== 'GRADIENT_LINEAR') approx(node, 'paint-unsupported', top.type);
    }
    if (segs.some(g => shown(g.fills).some(p => !PLAIN.has(p.blendMode)))) approx(node, 'blend-mode', 'paint');
    const fx = fxOf(node), first = styles[0] ?? {}, s = base(node, P);
    for (const k of fx.approx) approx(node, k);
    Object.assign(s, box.style, segs.length > 1 ? Object.fromEntries(STRUT.filter(k => k in first).map(k => [k, first[k]])) : first, fx.style);
    // Compensate Chromium baseline rounding by translating the whole text-body block by integer pixels only when segment size, line height and metrics match. Keep container transforms unchanged so overrides/geometry use Figma coordinates.
    const m = metrics[0], lh = pxs[0], same = !!m && lh != null && segs.every((g, i) => g.fontSize === segs[0].fontSize && Math.abs((pxs[i] ?? NaN) - lh) < 1e-6 && sameMetrics(metrics[i], m));
    const shift = same ? baselineShift(/** @type {FontMetrics} */ (m), segs[0].fontSize, /** @type {number} */ (lh)) : 0;
    let body = segs.length > 1 ? segs.map((g, i) => `<span style="${css(styles[i])}">${plain(g.characters)}</span>`).join('') : plain(node.characters ?? segs[0]?.characters ?? '');
    if (box.wrap || shift) body = `<div${shift ? ` style="position:relative;top:${shift}px"` : ''}>${body}</div>`;
    stats.nodes++; stats.text++;
    const done = finish(node, s);
    return backdropLayer(node, done) + `<div class="n t${box.nowrap ? ' nw' : ''}" ${attrs(node)} style="${css(done, flat.has(node))}">${body}</div>`;
  }

  // -- Document --
  // Root fills, strokes, radii and effects paint on #canvas without a root transform; descendants start from root coordinates.
  const canvas = /** @type {Style} */ ({}), layers = surface(root, canvas, root.opacity ?? 1);
  stats.nodes++;
  finish(root, canvas);
  const kids = children(root, [1, 0, 0, 1, 0, 0], false, canvas.opacity ? 'opacity' : canvas.filter ? 'filter' : '');
  // References are already final composites, so paint refs after #canvas at body end in extract preorder. Do not reapply ancestor/node opacity, blending or effects,
  // nor root effects/overrides applied to #canvas.
  const top = refs.map(r => {
    const n = /** @type {ExtractNode} */ (byId.get(r.node)), [x0, y0, x1, y1] = r.rect;
    apply(n.id);
    return `<div class="n" ${attrs(n)} data-bake="ref" style="${css({ transform: place([1, 0, 0, 1, x0 / scale, y0 / scale]), width: px((x1 - x0) / scale), height: px((y1 - y0) / scale) })}">`
      + `<img src="fac-asset:${r.key}" alt="" style="width:100%;height:100%"></div>`;
  }).join('');
  const html = ['<!doctype html>', `<html><head><meta charset="utf-8"><title>${esc(root.name)}</title>`,
    `<meta name="figma-agent-control" content="${esc(`extract=${extract}; node=${root.id}; scale=${num(output.scale)}; overrides=${overridesHash}; generator=${GENERATOR}`)}">`,
    '<style>html,body{margin:0;padding:0}',
    `#canvas{position:relative;width:${px(root.width)};height:${px(root.height)};overflow:hidden;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}`,
    '.n{position:absolute;left:0;top:0;margin:0;padding:0;box-sizing:border-box;transform-origin:0 0}', '.n>svg,.n>img{display:block}',
    '.t{white-space:pre-wrap;font-kerning:normal}.t.nw{white-space:pre}', ...rules].join('\n')
    + `</style>\n</head><body><div id="canvas" ${attrs(root)} style="${css(canvas)}">${layers.fill}${kids}${layers.stroke}</div>${top}</body></html>\n`;

  // Evaluate stale overrides in key order. Invalid refs include reasons; other entries inside ref subtrees cannot apply and become inside-ref;
  // style/basis on visible-tree nodes without emitted elements (unpainted or inside island/skip subtrees) become not-emitted.
  const stale = /** @type {Stale[]} */ ([]);
  for (const [id, o] of Object.entries(overrides)) {
    if (!byId.has(id)) stale.push({ node: id, kind: 'missing' });
    else if (refWhy.has(id)) stale.push({ node: id, kind: 'invalid', reason: refWhy.get(id) });
    else if (frozen.has(id) && o.bake !== 'ref') stale.push({ node: id, kind: 'invalid', reason: 'inside-ref' });
    else if (changed.has(id)) stale.push({ node: id, kind: 'changed', reason: changed.get(id) });
    else if (!handled.has(id)) stale.push({ node: id, kind: 'invalid', reason: 'not-emitted' });
  }
  return { html, approximations, needsIsland, refs, overrides: { applied, stale }, fonts: [...uses.values()], stats, violations: invariants(html) };
}

// -- Output invariants --------------------------------------------------
// Remove titles, data-name, text content from the Figma document, and inline-SVG base64 payloads before checking;
// remaining HTML must contain no null, undefined, NaN, Infinity or empty d. Require only a leading word boundary to catch NaNpx/undefinedpx.
// In head, remove only title; still check canvas/font stylesheets. Report up to 20 violations with 40 characters of surrounding context.
/** @param {string} html */
function invariants(html) {
  const at = html.indexOf('<body>'), head = html.slice(0, at).replace(/<title>[\s\S]*?<\/title>/, '');
  const scrubbed = head + html.slice(at).replace(/\sdata-name="[^"]*"/g, '').replace(/>[^<]*</g, '><').replace(/;base64,[A-Za-z0-9+/=]*/g, ';base64,');
  return [...scrubbed.matchAll(/\b(?:null|undefined)|NaN|Infinity|\bd=""/g)].slice(0, 20).map(m => scrubbed.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40));
}

// -- Bitmap placeholders ------------------------------------------------
// Generate fac-asset:<key> only inside style url("...") values for SHA-256 bitmaps (escaped as url(&quot;...) or img src="..." for ref<n> crops.
// Callers read bytes and embed data URIs only in style/src attribute values. esc protects text, names and titles; cssStr protects stylesheet font names,
// so none can produce ` style="` or ` src="` and incidental placeholder-like text stays unchanged. missing lists unresolved keys.
/** @param {string} html @param {Record<string, string>} uris */
export function embed(html, uris) {
  const missing = new Set();
  const out = html.replace(/ (?:style|src)="[^"]*"/g, attr => attr.replace(/(url\(&quot;|src=")fac-asset:([0-9a-z]+)/g, (m, at, k) => Object.hasOwn(uris, k) ? at + uris[k] : (missing.add(k), m)));
  return { html: out, missing: [...missing] };
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', bin: 'application/octet-stream' };
/** @param {BinaryFile['type']} type Use the bridge-persisted type without sniffing bytes again. @param {Uint8Array} bytes */
export const dataUri = (type, bytes) => `data:${MIME[type]};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`;
