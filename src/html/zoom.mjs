/**
 * [INPUT]: Uses ./match.mjs match/crop, ./shift.mjs region/search/advise, ./attrib.mjs frameBox, ./page.mjs expectedSize/pageFile,
 *          ../png.mjs pngSize/decodePng and a chrome launch().page() injected by check. Types come from extract-contract, attrib and shift.
 * [OUTPUT]: zoomTarget(frame, zoom) -> { node, k, box, expected, warnings }, renderZoom(page, url, target, size) -> PNG, zoomCompare(page, input) -> { result, images? }, and ZoomTarget/ZoomResult.
 * [POS]: Checker zoom comparison: render one page node at extract --scale k, compare with Figma's single-node export, and search shifts at 1/k CSS px resolution.
 *        Preflight is pure and runs before Chrome starts. Rendering isolates the target subtree and neutralizes ancestors; match/shift perform all post-screenshot computation. Orchestrated by check.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { match, crop } from './match.mjs';
import { region, search, advise } from './shift.mjs';
import { frameBox } from './attrib.mjs';
import { expectedSize, pageFile } from './page.mjs';
import { pngSize, decodePng } from '../png.mjs';
/** @import { LandedExtractOutput, ExtractNode } from './extract-contract.js' */
/** @import { Box } from './attrib.mjs' */
/** @import { Placement } from './shift.mjs' */
/**
 * @typedef {{ node: string, k: number, box: Box, expected: { width: number, height: number }, warnings: string[] }} ZoomTarget
 *   box is frame-coordinate node bounds, matching Figma useAbsoluteBounds exports; expected is the zoom reference's expected size.
 * @typedef {{ node: string, extract: string, scale: number, size: [number, number], expected?: [number, number], dir: string,
 *   reason?: 'REFERENCE_SIZE' | 'NOT_RENDERED' | 'IN_REF' | 'RENDER_TIMEOUT', error?: string, sizeNote?: 'fractional', mismatched?: number, aa?: number, diffRatio?: number,
 *   shift?: { dx: number, dy: number, before: number, after: number }, fix?: { style: { transform: string }, basis?: { transform: string } }, flat?: true, hint?: string,
 *   warnings?: string[] }} ZoomResult  size is reference pixels, with expected on REFERENCE_SIZE; dir is zoom-<node part> beneath the evidence directory; shifts use CSS pixels.
 */

// -- Preflight ----------------------------------------------------------
// Scale must be in (1, 4]. The zoom extract root must belong to the page's extracted frame and have no frame-coordinate rotation; flips are allowed. useAbsoluteBounds exports a bounding rectangle,
// whose shape differs from a rotated node's box. Warn only if node size changed between extractions.
/** @param {LandedExtractOutput} frame @param {LandedExtractOutput} zoom @returns {ZoomTarget} */
export function zoomTarget(frame, zoom) {
  const k = zoom.scale, node = zoom.root.id;
  if (!(k > 1 && k <= 4)) throw Error(`--zoom needs an extract job with --scale greater than 1 (at most 4), got ${k}`);
  /** @param {ExtractNode} n @returns {ExtractNode | undefined} */
  const find = n => { if (n.id === node) return n; for (const c of n.children ?? []) { const hit = find(c); if (hit) return hit; } return undefined; };
  const x = find(frame.root);
  if (!x) throw Error(`--zoom node ${node} is not inside any page's frame`);
  if (Math.abs(x.transform[1][0]) >= 1e-6 || Math.abs(x.transform[0][1]) >= 1e-6) throw Error(`Zoom comparison does not support rotated nodes: ${node}`);
  const warnings = Math.abs(x.width - zoom.root.width) > 0.01 || Math.abs(x.height - zoom.root.height) > 0.01
    ? [`Node size changed between the two extracts: ${x.width}x${x.height} in the frame, ${zoom.root.width}x${zoom.root.height} in the zoom job`] : [];
  return { node, k, box: frameBox(x), expected: expectedSize(zoom), warnings };
}

// -- Rendering ----------------------------------------------------------
// Show only the target's main/background-blur elements, excluding ref containers; descendants inherit visibility. On ancestors, mask wrappers and #canvas, neutralize opacity, filters,
// backdrop blur, masks, clipping, blending and overflow with !important. Ancestor paint/strokes and siblings remain hidden while target effects remain. #canvas is already position:relative;
// use left/top to move target origin to viewport origin without creating a stacking context. Wait two frames before capture. It is inferred that Figma single-node exports omit ancestor effects.
/** @param {string} id @param {Box} box */
const ISOLATE = (id, [x, y]) => `(() => {
  const id = ${JSON.stringify(id)}, canvas = document.getElementById('canvas'), done = new Set();
  const NEUTRAL = { opacity: '1', filter: 'none', 'backdrop-filter': 'none', 'mask-image': 'none', '-webkit-mask-image': 'none', 'clip-path': 'none', 'mix-blend-mode': 'normal', overflow: 'visible' };
  document.body.style.visibility = 'hidden';
  for (const el of document.querySelectorAll('[data-node]')) {
    if (el.dataset.node !== id || el.hasAttribute('data-bake')) continue;
    el.style.setProperty('visibility', 'visible', 'important');
    for (let p = el.parentElement; p && p !== document.body && !done.has(p); p = p.parentElement) {
      done.add(p);
      for (const [k, v] of Object.entries(NEUTRAL)) p.style.setProperty(k, v, 'important');
    }
  }
  canvas.style.setProperty('left', ${-x} + 'px'); canvas.style.setProperty('top', ${-y} + 'px');
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
})()`;
/**
 * Viewport: ceil(RW/k) by ceil(RH/k), dsf = k; screenshot clip is reference size divided by k, where RW/RH are zoom-reference pixel dimensions.
 * @param {{ open(url: string, width: number, height: number, dsf?: number): Promise<void>, shot(clip?: object): Promise<Buffer>, evaluate(expression: string): Promise<any> }} page
 * @param {string} url @param {{ node: string, k: number, box: Box }} target @param {{ width: number, height: number }} size @returns {Promise<Buffer>}
 */
export async function renderZoom(page, url, { node, k, box }, { width, height }) {
  await page.open(url, Math.ceil(width / k), Math.ceil(height / k), k);
  await page.evaluate(ISOLATE(node, box));
  return page.shot({ x: 0, y: 0, width: width / k, height: height / k });
}

// -- Comparison ---------------------------------------------------------
// Skip comparison when reference dimensions differ from expectation by over 1 px (REFERENCE_SIZE), or the target is/contains ref (IN_REF: ref containers follow #canvas and do not move with it),
// or the page has no target element (NOT_RENDERED: mask, skipped node, island/ref descendant). These cases never open a page. Crop screenshot/reference to their shared size when dimensions differ by at most 1 px and mark fractional;
// larger differences are errors. Identical images need no search; otherwise search the full zoom image, falling back to padded difference bounds (2k) above the area limit. Device-pixel shift s implies node movement -s/k CSS px.
// Fix thresholds use device pixels through worth multiplied by k squared. Convert with page-collected Placement; callers select basis from overrides. Rendering timeouts only set reason, letting callers retire the page.
/**
 * @param {Parameters<typeof renderZoom>[0]} page
 * @param {{ url: string, target: ZoomTarget, extract: string, reference: Buffer, placement?: Placement, basis?: string | null, inRef: boolean }} input
 *   Missing placement means the target has no page element; basis follows shift.relocate semantics.
 * @returns {Promise<{ result: ZoomResult, images?: { dir: string, figma: Buffer, html: Buffer, diff: Uint8Array, width: number, height: number } }>}
 */
export async function zoomCompare(page, { url, target, extract, reference, placement, basis, inRef }) {
  const { node, k, expected, warnings } = target, size = pngSize(reference), dir = 'zoom-' + pageFile('', node).slice('frame__'.length, -'.html'.length);
  /** @type {ZoomResult} */
  const result = { node, extract, scale: k, size: [size.width, size.height], dir, ...(warnings.length ? { warnings } : {}) };
  if (Math.abs(size.width - expected.width) > 1 || Math.abs(size.height - expected.height) > 1) return { result: { ...result, expected: [expected.width, expected.height], reason: 'REFERENCE_SIZE' } };
  if (inRef) return { result: { ...result, reason: 'IN_REF' } };
  if (!placement) return { result: { ...result, reason: 'NOT_RENDERED' } };
  let shot;
  try { shot = await renderZoom(page, url, target, size); } catch (error) { if (error.code !== 'RENDER_TIMEOUT') throw error; return { result: { ...result, reason: 'RENDER_TIMEOUT' } }; }
  const ref = decodePng(reference), act = decodePng(shot);
  if (Math.abs(act.width - ref.width) > 1 || Math.abs(act.height - ref.height) > 1) return { result: { ...result, error: `Screenshot ${act.width}x${act.height} differs from the zoom reference image ${ref.width}x${ref.height} by more than 1 px` } };
  const w = Math.min(ref.width, act.width), h = Math.min(ref.height, act.height);
  /** @param {{ data: Uint8Array, width: number, height: number }} img */
  const fit = img => img.width === w && img.height === h ? img.data : crop(img.data, img.width, [0, 0, w, h]);
  const a = fit(ref), b = fit(act), m = match(a, b, w, h);
  Object.assign(result, w !== ref.width || h !== ref.height || w !== act.width || h !== act.height ? { sizeNote: 'fractional' } : {}, { mismatched: m.mismatched, aa: m.aa, diffRatio: m.mismatched / (w * h) });
  if (m.mismatched) {
    const rect = region([[0, 0, w, h]], () => true, m.mask, w, h, 2 * k);
    const { hints, ...got } = advise(typeof rect === 'string' ? rect : search({ data: a, width: w, height: h }, { data: b }, rect, k), k, placement, basis);
    Object.assign(result, got, hints.length ? { hint: hints.join('; ') } : {});
  }
  return { result, images: { dir, figma: reference, html: shot, diff: m.image, width: w, height: h } };
}
