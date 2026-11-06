/**
 * [INPUT]: Uses ./match.mjs match/blockscan/crop/upscale/stack, ./attrib.mjs attribution/ranking, ./shift.mjs search/local conversion,
 *          ./layout.mjs page facts/geometry/fonts, ./structure.mjs structure checks, ./suggest.mjs baking/seams, ./zoom.mjs zoom comparison,
 *          ../png.mjs pngSize/decodePng/encodePng, ../project.mjs hash/writeAtomic, node:fs and node:path.
 *          Receives a chrome launch().page() without starting a browser. CHECKER hashes diagnostic source dependencies, including shared css.mjs paint rules.
 * [OUTPUT]: LIMIT, CHECKER, BLOCK_IMAGES, check(page, { url, reference, expected, refs?, frame? }) -> { report, images? },
 *           re-exported raster, writeEvidence(dir, report, images?) for check.json/render.png/diff.png/block-<n>.png/zoom-<node>/, plus Page/Ref/Frame/TopEntry.
 * [POS]: Checker orchestration: validate sizes, render, compare, scan structural blocks, attribute HTML pixels and count baked refs; with frame context, attribute Figma pixels and rank both sides,
 *        collect page geometry/fonts/structure once, audit fonts, search/correct top/focus positions, check geometry/structure, suggest baking, measure seams, compare zoom, then produce verdict/evidence.
 *        Sibling modules own diagnostic rules; this file owns order, timing and verdict. Only top geometry affects verdict, never focus/zoom. Without frame (local regression), do only image matching, blocks, HTML attribution and ref counts.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { match, blockscan, crop, upscale, stack } from './match.mjs';
import { TOP_N, raster, inlinedIslands, figmaPainted, tally, boxes, rank } from './attrib.mjs';
import { region, search, advise } from './shift.mjs';
import { collect, findings, upright, fontRows, substitutedNodes, BLOCKING } from './layout.mjs';
import { structure } from './structure.mjs';
import { suggest, seams, hardEdge, seamLimit } from './suggest.mjs';
import { zoomCompare } from './zoom.mjs';
import { pngSize, decodePng, encodePng } from '../png.mjs';
import { hash, writeAtomic } from '../project.mjs';
/** @import { LandedExtractOutput, ExtractNode } from './extract-contract.js' */
/** @import { GenerateResult, OverrideEntry } from './generate.mjs' */
/** @import { Ranked } from './attrib.mjs' */
/** @import { Finding, FontRow } from './layout.mjs' */
/** @import { Structure } from './structure.mjs' */
/** @import { Suggestion, Cluster } from './suggest.mjs' */
/** @import { ZoomTarget, ZoomResult } from './zoom.mjs' */

// Fail above 2% full-frame differing pixels, matching ui2html acceptance with pixelmatch threshold 0.1 and antialiasing excluded.
export const LIMIT = 0.02;
// Hash matching, decoding, rendering, diagnostics and shared paint-rule source into CHECKER for check.json and verification records.
export const CHECKER = hash(['check.mjs', 'match.mjs', 'attrib.mjs', 'css.mjs', 'shift.mjs', 'layout.mjs', 'structure.mjs', 'suggest.mjs', 'zoom.mjs', 'chrome.mjs', '../png.mjs'].map(file => fs.readFileSync(new URL(file, import.meta.url))).join('\n')).slice(0, 12);
// Write crop evidence for the first BLOCK_IMAGES structural blocks.
export const BLOCK_IMAGES = 10;
export { raster };

// -- HTML painted rectangles --------------------------------------------
// Collect page rectangles once: element boxes, including SVG/img, and Range line boxes for text. Attribute to the nearest [data-node] ancestor, or leave unowned.
// Intersect each rectangle with every clipping ancestor's box (non-visible overflow, clip-path or mask-image). DOM order is paint order because generate uses no z-index.
// Do not descend into SVG: defs/clipPath boxes have no painted meaning; the SVG's own box represents the whole image.
// Exclude final stroke layers (data-layer="stroke", inset 0), which paint edges only, and data-mask wrappers, which only clip following siblings:
// counting their boxes would overwrite earlier sibling/child ownership with the container, unlike Figma attribution. Still count wrapper descendants and apply wrapper clipping.
const RECTS = `(() => {
  const SVG = 'http://www.w3.org/2000/svg', NONE = [-Infinity, -Infinity, Infinity, Infinity];
  const ids = [], names = [], keys = new Map(), clips = new Map(), rects = [];
  // Index by node ID, merging counts when one node paints through multiple elements.
  const owner = el => {
    const n = el.closest('[data-node]'); if (!n) return -1;
    let k = keys.get(n.dataset.node);
    if (k === undefined) { k = ids.push(n.dataset.node) - 1; names.push(n.dataset.name ?? ''); keys.set(n.dataset.node, k); }
    return k;
  };
  // Clip element content by ancestors and, when clipping, its own box. Ignore html/body overflow because it applies to the viewport.
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
    if (getComputedStyle(el).visibility !== 'visible' || el.dataset.layer === 'stroke' || el.dataset.mask !== undefined) continue;
    if (n.nodeType === 1) { push(owner(el), el.getBoundingClientRect(), clipOf(el.parentElement)); continue; }
    if (!n.data.trim()) continue;
    range.selectNodeContents(n);
    const k = owner(el), c = clipOf(el);
    for (const r of range.getClientRects()) push(k, r, c);
  }
  return { ids, names, rects };
})()`;

// -- Checking -----------------------------------------------------------
// Callers provide expected dimensions (page.expectedSize from extraction for html/html-check, frame.json for regression). Require positive integers; missing/NaN values throw,
// preventing silent bypass of size checks. Reference differences above 1 px yield unchecked/REFERENCE_SIZE; 1 px differences from fractional origins compare at reference size and mark fractional.
// Rendering or later page-collection timeouts yield unchecked/RENDER_TIMEOUT; callers should continue with a fresh page. Other errors propagate.
// Only these page methods are required from chrome launch().page(). Page scripts determine evaluate shapes; mocks without cdp skip actual-font lookup.
/** @typedef {{ browser: unknown, open(url: string, width: number, height: number, dsf?: number): Promise<void>, shot(clip?: object): Promise<Buffer>,
 *   evaluate(expression: string): Promise<any>, cdp?(method: string, params?: object): Promise<any> }} Page */
// refs are generator reference crops with half-open pixel rectangles [x0, y0, x1, y1); preserve all other fields in the report.
/** @typedef {{ node: string, rect: [x0: number, y0: number, x1: number, y1: number] }} Ref */
// frame contains the generating extract tree/islands, generation approximations/fonts/overrides.applied and this frame's overrides. focus adds explicitly requested diagnostic nodes;
// zoom supplies its target and extract --scale k reference. With frame context, always take refs from input.refs, the page's actual paint.
/** @typedef {{ output: LandedExtractOutput, result: GenerateResult, overrides: Record<string, OverrideEntry>, focus?: string[],
 *   zoom?: { target: ZoomTarget, extract: string, reference: Buffer } }} Frame */
/**
 * @typedef {Ranked & { shift?: { dx: number, dy: number, before: number, after: number }, fix?: { style: { transform: string }, basis?: { transform: string } },
 *   flat?: true, layout?: Finding[], fonts?: { postScriptName: string, chromeUsed?: string, status?: string }[], approximations?: string[], hint?: string }} TopEntry
 *   shift gives the requested CSS-pixel move and regional before/after differences. layout exists only when an element is present, possibly empty; fonts lists substituted fonts used by the node.
 *   hint order: attribution gap, shift or omission reason, left/top or singular-matrix explanation, absent element, rotated/flipped text.
 */
/** @param {Page} page @param {{ url: string, reference: Buffer, expected: { width: number, height: number }, refs?: ReadonlyArray<Ref>, frame?: Frame }} input */
export async function check(page, { url, reference, expected, refs = [], frame }) {
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
  // which may exceed blockscan diffPx that counts only hot cells. The first BLOCK_IMAGES include crop filenames written by writeEvidence.
  const blocks = found.map((b, seq) => {
    const counts = new Map(); let total = 0;
    for (let y = b.y; y < Math.min(height, b.y + b.h); y++) for (let x = b.x; x < Math.min(width, b.x + b.w); x++) {
      const i = y * width + x;
      if (m.mask[i] !== 1) continue;
      total++;
      if (owner[i] >= 0) counts.set(owner[i], (counts.get(owner[i]) ?? 0) + 1);
    }
    return { ...b, bboxPx: total, nodes: [...counts].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([k, n]) => ({ ...node(k), px: n, share: Number((n / total).toFixed(3)) })),
      ...(seq < BLOCK_IMAGES ? { image: `block-${seq + 1}.png` } : {}) };
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

  // -- Frame-based attribution, fonts, top nodes, structure, baking and zoom --
  // Derive Figma rectangles from extraction with the same raster as HTML. Merge by node and select TOP_N top entries plus named focus entries without consuming top slots.
  // Collect geometry/fonts/structure once, with zoom-only nodes needing placement. Audit fonts per frame; set cause when nodes using substituted faces account for over half the frame's HTML-owned differences.
  // Then search shifts, reporting nonzero best shifts and local-transform fixes when improvement qualifies; check geometry, followed by page/tree structure.
  // Reuse Figma ownership for baking suggestions; text-mismatched subtrees get hints only. Measure each ref seam. Zoom runs last because it reopens the page; its timeouts remain inside zoom.
  /** @type {{ top: TopEntry[], focus: TopEntry[], fonts: FontRow[], cause: boolean, structure: Structure, suggest: Suggestion[], clusters: Cluster[], hints: string[],
   *   seams: import('./suggest.mjs').Seam[], zoom?: ZoomResult } | null} */
  let diag = null;
  /** @type {{ dir: string, figma: Buffer, html: Buffer, diff: Uint8Array, width: number, height: number } | undefined} */
  let zoomed;
  if (frame) {
    const { output, result, overrides } = frame, tree = /** @type {Map<string, ExtractNode>} */ (new Map()), parent = /** @type {Map<string, string>} */ (new Map());
    /** @param {ExtractNode} n */
    const walk = n => { tree.set(n.id, n); for (const c of n.children ?? []) { parent.set(c.id, n.id); walk(c); } };
    walk(output.root);
    const inlined = inlinedIslands(output, result.approximations), figma = figmaPainted(output, { overrides, inlined, refs });
    const fOwner = raster(figma.rects, width, height), order = new Map([...tree.keys()].map((id, i) => [id, i]));
    const ranked = rank({ html: painted, htmlPx: px, figma, figmaPx: tally(fOwner, m.mask, figma.ids.length), order, exclude: new Set([output.root.id, ...refs.map(r => r.node)]) });
    const heads = ranked.slice(0, TOP_N), named = (frame.focus ?? []).map(id => ranked.find(r => r.node === id) ?? { node: id, name: tree.get(id)?.name ?? '', htmlPx: 0, figmaPx: 0, px: 0 });
    lap('figma');
    let got;
    const zid = frame.zoom?.target.node;
    try { got = await collect(page, [...new Set([...heads, ...named].map(r => r.node).concat(zid ?? []))]); } catch (error) { return timeout(error); }
    const { facts, audit } = got;
    lap('facts');
    const fonts = fontRows(result.fonts, audit), bad = substitutedNodes(audit, fonts);
    let lost = 0;
    painted.ids.forEach((id, k) => { if (bad.has(id)) lost += px[k]; });
    lap('fonts');
    const hk = new Map(painted.ids.map((id, k) => [id, k])), fk = new Map(figma.ids.map((id, k) => [id, k])), hb = boxes(painted), fb = boxes(figma);
    const applied = new Set(result.overrides.applied);
    // Applied style on a node or ancestor means placement was intentionally changed; suppress box-offset findings.
    /** @param {string} id */
    const adjusted = id => { for (let p = /** @type {string | undefined} */ (id); p; p = parent.get(p)) if (applied.has(p) && overrides[p]?.style) return true; return false; };
    // basis must match pre-override generated values: if an applied entry changes transform, use its basis or omit it when absent; otherwise use current page style.
    /** @param {string} id */
    const basisOf = id => applied.has(id) && overrides[id]?.style?.transform !== undefined ? overrides[id].basis?.transform ?? null : undefined;
    /** @param {Ranked} r @returns {TopEntry} */
    const diagnose = r => {
      const id = r.node, f = facts[id], node = tree.get(id), e = /** @type {TopEntry} */ ({ ...r }), hints = [];
      const kinds = [...new Set(result.approximations.filter(a => a.node === id).map(a => a.kind))];
      if (kinds.length) e.approximations = kinds;
      if (f?.found && node) e.layout = findings(node, f, { island: inlined.has(id), moved: adjusted(id), approx: kinds });
      if (bad.has(id)) {
        const used = new Set(audit.uses.filter(u => u.node === id).map(u => u.face));
        e.fonts = fonts.filter(row => row.substituted && used.has(row.face)).map(({ postScriptName, chromeUsed, status }) =>
          ({ postScriptName, ...(chromeUsed !== undefined ? { chromeUsed } : {}), ...(status !== undefined ? { status } : {}) }));
      }
      if (r.gap) hints.push(r.gap === 'html-missing' ? `Figma side ${r.figmaPx} px, HTML side ${r.htmlPx}: HTML missing or misplaced` : `HTML side ${r.htmlPx} px, Figma side ${r.figmaPx}: HTML draws extra or is misplaced`);
      if (!f?.found) hints.push('No element for this node in the page');
      else {
        const h = hk.get(id) ?? -1, g = fk.get(id) ?? -1;
        const rect = region([hb.get(id), fb.get(id)].filter(b => b !== undefined), i => (h >= 0 && owner[i] === h) || (g >= 0 && fOwner[i] === g), m.mask, width, height);
        const { hints: said, ...got } = advise(typeof rect === 'string' ? rect : search(ref, act, rect), 1, f, basisOf(id));
        Object.assign(e, got); hints.push(...said);
      }
      if (f?.found && f.text && !upright(f.text.linear)) hints.push('Rotated or flipped text skips line-box and ink checks');
      if (hints.length) e.hint = hints.join('. ');
      return e;
    };
    const top = heads.map(diagnose), focus = named.map(diagnose);
    lap('top');
    const st = structure(output, { overrides, refs, inlined }, got.dom);
    lap('structure');
    const sg = suggest(output, { approximations: result.approximations, overrides, refs, textMismatch: new Set(st.textMismatch.map(x => x.node)) },
      { mask: m.mask, width, height, blocks: found, figma: { owner: fOwner, ids: figma.ids } });
    const seam = seams(ref.data, act.data, width, height, refs);
    refs.forEach((r, i) => { if (hardEdge(seam[i])) sg.hints.push(`ref ${r.node} has hard edges on its rectangle border (hard ${seam[i].hard}/${seam[i].edges}, `
      + `threshold ${seamLimit(seam[i].edges)}): the target may cover only part of a component; use a component-level target`); });
    lap('suggest');
    diag = { top, focus, fonts, cause: m.mismatched > 0 && lost >= 0.5 * m.mismatched, structure: st, ...sg, seams: seam };
    if (frame.zoom && zid) {
      const sub = new Set();
      /** @param {ExtractNode} n */
      const under = n => { sub.add(n.id); for (const c of n.children ?? []) under(c); };
      if (tree.has(zid)) under(/** @type {ExtractNode} */ (tree.get(zid)));
      const f = facts[zid], z = await zoomCompare(page, { url, ...frame.zoom, placement: f?.found ? f : undefined, basis: basisOf(zid), inRef: refs.some(r => sub.has(r.node)) });
      diag.zoom = z.result; zoomed = z.images;
      lap('zoom');
    }
  }

  // clean requires no structural blocks, refs, substituted fonts, blocking top-node geometry, structure discrepancies or triggered clusters, including hint-only clusters;
  // focus and zoom do not affect verdict.
  const diffRatio = m.mismatched / (width * height), st = diag?.structure;
  const flagged = blocks.length || refs.length || diag?.fonts.some(r => r.substituted) || diag?.top.some(e => e.layout?.some(f => BLOCKING.has(f.kind)))
    || st?.untracked.length || st?.missing.length || st?.textMismatch.length || diag?.clusters.some(c => c.triggered);
  const verdict = diffRatio > LIMIT ? 'fail' : flagged ? 'pass-with-findings' : 'clean';
  return {
    report: { verdict, ...(dw || dh ? { sizeNote: 'fractional' } : {}), ...sizes, mismatched: m.mismatched, aa: m.aa, diffRatio,
      blocks, nodes, unattributed, ...(refs.length ? { refs: diag ? inside.map((r, i) => ({ ...r, seam: diag?.seams[i] })) : inside, bakedShare: Number((baked / (width * height)).toFixed(4)) } : {}),
      ...(diag ? { top: diag.top, ...(frame?.focus?.length ? { focus: diag.focus } : {}), fonts: diag.fonts, ...(diag.cause ? { cause: 'font-substitution' } : {}),
        ...diag.structure, suggest: diag.suggest, clusters: diag.clusters, hints: diag.hints, ...(diag.zoom ? { zoom: diag.zoom } : {}) } : {}), browser: page.browser, checker: CHECKER, ms },
    images: { width, height, render: shot, diff: m.image, ref: ref.data, act: act.data, ...(zoomed ? { zoom: zoomed } : {}) }
  };
}

// Always write check.json. When images exist, write render/diff (gray background, red differences, yellow antialiasing) and image-marked block crops of the same reference/render/diff rectangle,
// clamped to image bounds, nearest-neighbor enlarged by integer 1-8 to roughly 480 px on the long side, then stacked into block-<n>.png. Remove existing block-*.png first:
// repeated checks overwrite evidence, and fewer blocks must not leave stale images. Zoom writes zoom-<node>/{figma,html,diff}.png, preserving original zoom-reference bytes in figma.png;
// write these only for zoom comparisons; later ordinary checks do not remove them.
/** @param {string} dir @param {{ blocks?: ReadonlyArray<{ x: number, y: number, w: number, h: number, image?: string }> }} report
 *  @param {{ width: number, height: number, render: Buffer, diff: Uint8Array, ref: Uint8Array, act: Uint8Array,
 *    zoom?: { dir: string, figma: Buffer, html: Buffer, diff: Uint8Array, width: number, height: number } }} [images] */
export async function writeEvidence(dir, report, images) {
  await writeAtomic(path.join(dir, 'check.json'), JSON.stringify(report, null, 2) + '\n');
  for (const name of await fs.promises.readdir(dir)) if (/^block-\d+\.png$/.test(name)) await fs.promises.rm(path.join(dir, name), { force: true });
  if (!images) return;
  const { width, height } = images;
  await writeAtomic(path.join(dir, 'render.png'), images.render);
  await writeAtomic(path.join(dir, 'diff.png'), encodePng(width, height, images.diff));
  for (const b of report.blocks ?? []) {
    if (!b.image) continue;
    const rect = /** @type {[number, number, number, number]} */ ([b.x, b.y, Math.min(width, b.x + b.w), Math.min(height, b.y + b.h)]), w = rect[2] - rect[0], h = rect[3] - rect[1];
    const f = Math.max(1, Math.min(8, Math.floor(480 / Math.max(w, h)))), data = stack([images.ref, images.act, images.diff].map(img => upscale(crop(img, width, rect), w, h, f)), w * f);
    await writeAtomic(path.join(dir, b.image), encodePng(w * f, data.length / (w * f * 4), data));
  }
  const z = images.zoom;
  if (z) for (const [name, bytes] of /** @type {const} */ ([['figma', z.figma], ['html', z.html], ['diff', encodePng(z.width, z.height, z.diff)]]))
    await writeAtomic(path.join(dir, z.dir, `${name}.png`), bytes);
}
