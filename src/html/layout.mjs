/**
 * [INPUT]: Uses ./attrib.mjs frameBox; receives chrome launch().page() from check with optional cdp. Types use attrib Box/Rect, extract-contract ExtractNode and generate FontUse.
 * [OUTPUT]: BOX_TOL, BLOCKING, collect(page, ids) -> { facts, audit, dom }, upright(linear), findings(node, facts, opts) -> Finding[],
 *           fontRows(uses, audit) -> FontRow[], substitutedNodes(audit, rows) -> Set, and Facts/TextFacts/FontAudit/Finding/FontRow.
 * [POS]: Browser geometry/font facts for the checker. One FACTS page script after ranking collects main-element boxes, raw styles and coordinate-parent linear transforms for shift,
 *        text lines/ink, font declarations and usage, and the structure scan. CDP then samples actual fonts per face.
 *        Remaining checks are pure: findings compares extraction, fontRows compares generator declarations. check orchestrates it; summary also uses BLOCKING for guidance.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { frameBox } from './attrib.mjs';
/** @import { Box, Rect } from './attrib.mjs' */
/** @import { ExtractNode } from './extract-contract.js' */
/** @import { FontUse } from './generate.mjs' */
/**
 * @typedef {[a: number, b: number, c: number, d: number]} Linear
 * @typedef {{ lh: number | null, lines: number, firstTop: number, ink: Rect | null, linear: Linear }} TextFacts
 *   Coordinates are relative to #canvas. null lh means normal line height; ink intersects clipping ancestors; linear = chain * own transform's linear part, detecting text rotation/flips.
 * @typedef {{ found: false } | { found: true, box: Box, style: string, chain: Linear, text?: TextFacts }} Facts
 *   box bounds the main element. chain left-multiplies computed transforms from parent up to but excluding #canvas, matching the generator coordinate parent's frame-linear transform.
 * @typedef {{ faces: Record<string, { status: string, names: string[], chromeUsed?: string }>, uses: { node: string, face: string }[] }} FontAudit
 *   faces keys are generated @font-face families f0, f1, etc.; values contain FontFace.status, local() names and Chrome's sampled PostScript name.
 *   uses deduplicates (node, face) pairs for elements with text.
 * @typedef {{ kind: 'box', html: Box, figma: Box } | { kind: 'wrap', figma: number, html: number } | { kind: 'content-offset', dy: number }
 *   | { kind: 'overflow', html: number, figma: number } | { kind: 'ink-offset', dx: number, dy: number, dw: number, dh: number }} Finding  Numbers use two decimal places.
 * @typedef {{ family: string, style: string, postScriptName: string, source: FontUse['source'], face: string, status?: string, chromeUsed?: string,
 *   substituted: boolean }} FontRow
 */

// Geometry tolerance in CSS pixels. Blocking types affect only top nodes; focus/zoom do not influence verdict. ink-offset is advisory:
// canvas-estimated ink can differ by 1-3 px across weights/font versions, without indicating a fixable generation defect.
export const BOX_TOL = 0.5;
export const BLOCKING = new Set(['box', 'content-offset', 'wrap', 'overflow']);

// -- Page script --------------------------------------------------------
// The main element is the first matching data-node without data-layer (background blur) or data-bake (reference). Its parent may be a container or mask wrapper,
// exactly the generator's coordinate parent. Ancestors using left/top translate only and do not affect the linear transform.
// For class-t text, the body is the generated vertical-alignment/baseline div, or the element itself. Remove baseline compensation's intentional top translation from first-line position;
// cluster character Range rectangles into lines by midpoint, within half a line height. Consecutive same-line characters under one parent form runs, trimming leading whitespace. Use canvas measureText per run
// to estimate ink: baseline = first-character top + round(fontBoundingBoxAscent), matching Chromium's rounded ascent layout. Union runs and intersect clipping using RECTS rules.
// Fonts combine document.fonts status and stylesheet @font-face local() names. For each .t/descendant, collect owning node, first computed family and direct-text character count,
// in document order matching CDP DOM.querySelectorAll. Structure scans deduplicate all data-node IDs in document order and keep the first class-t textContent per ID.
/** @param {string[]} ids */
const FACTS = ids => String.raw`(() => {
  const want = new Set(${JSON.stringify(ids)}), canvas = document.getElementById('canvas'), o = canvas.getBoundingClientRect();
  const NONE = [-Infinity, -Infinity, Infinity, Infinity], clips = new Map(), range = document.createRange(), pen = document.createElement('canvas').getContext('2d');
  const unquote = s => s.trim().replace(/^(["'])(.*)\1$/, '$2');
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
  const text = (el, chain) => {
    const s = getComputedStyle(el), lh = parseFloat(s.lineHeight), L = chain.multiply(new DOMMatrix(s.transform));
    const first = el.firstElementChild, block = first && first.tagName === 'DIV' ? first : el;
    const tol = Number.isFinite(lh) ? lh / 2 : 1, rows = [], runs = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let run = null;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) for (let i = 0; i < t.data.length; i++) {
      range.setStart(t, i); range.setEnd(t, i + 1);
      const r = range.getClientRects()[0];
      if (!r) continue;
      const mid = r.top + r.height / 2;
      let row = rows.findIndex(y => Math.abs(y - mid) < tol);
      if (row < 0) row = rows.push(mid) - 1;
      if (run && run.row === row && run.el === t.parentElement) run.text += t.data[i];
      else if (/\s/.test(t.data[i])) run = null;
      else runs.push(run = { el: t.parentElement, row, text: t.data[i], left: r.left, top: r.top });
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of runs) {
      const cs = getComputedStyle(g.el);
      pen.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      pen.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
      const k = pen.measureText(cs.textTransform === 'uppercase' ? g.text.toUpperCase() : cs.textTransform === 'lowercase' ? g.text.toLowerCase() : g.text);
      const base = g.top + Math.round(k.fontBoundingBoxAscent);
      x0 = Math.min(x0, g.left - k.actualBoundingBoxLeft); x1 = Math.max(x1, g.left + k.actualBoundingBoxRight);
      y0 = Math.min(y0, base - k.actualBoundingBoxAscent); y1 = Math.max(y1, base + k.actualBoundingBoxDescent);
    }
    const c = clipOf(el), ink = [Math.max(x0, c[0]), Math.max(y0, c[1]), Math.min(x1, c[2]), Math.min(y1, c[3])];
    const top = block.getBoundingClientRect().top - (block === el ? 0 : parseFloat(block.style.top) || 0);
    return { lh: Number.isFinite(lh) ? lh : null, lines: rows.length, firstTop: top - o.top, linear: [L.a, L.b, L.c, L.d],
      ink: ink[2] > ink[0] && ink[3] > ink[1] ? [ink[0] - o.left, ink[1] - o.top, ink[2] - o.left, ink[3] - o.top] : null };
  };
  const facts = {};
  for (const el of document.querySelectorAll('[data-node]')) {
    const id = el.dataset.node;
    if (!want.has(id) || Object.hasOwn(facts, id) || el.hasAttribute('data-layer') || el.hasAttribute('data-bake')) continue;
    let m = new DOMMatrix();
    for (let p = el.parentElement; p && p !== canvas; p = p.parentElement) m = new DOMMatrix(getComputedStyle(p).transform).multiply(m);
    const r = el.getBoundingClientRect();
    facts[id] = { found: true, box: [r.left - o.left, r.top - o.top, r.width, r.height], style: el.getAttribute('style') ?? '', chain: [m.a, m.b, m.c, m.d],
      ...(el.classList.contains('t') ? { text: text(el, m) } : {}) };
  }
  for (const id of want) if (!Object.hasOwn(facts, id)) facts[id] = { found: false };
  const faces = {};
  for (const f of document.fonts) faces[unquote(f.family)] = { status: f.status, names: [] };
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = sheet.cssRules; } catch {}   // Cross-origin stylesheets are unreadable; only manually edited pages have them.
    for (const rule of rules) if (rule instanceof CSSFontFaceRule) {
      const names = [...rule.style.getPropertyValue('src').matchAll(/local\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/g)];
      (faces[unquote(rule.style.getPropertyValue('font-family'))] ??= { status: 'unloaded', names: [] }).names.push(...names.map(m => (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, '$1')));
    }
  }
  const els = [...document.querySelectorAll('.t, .t *')].map(el => ({ node: el.closest('[data-node]')?.dataset.node ?? '',
    face: unquote(getComputedStyle(el).fontFamily.split(',')[0]), chars: [...el.childNodes].reduce((n, c) => n + (c.nodeType === 3 ? c.data.replace(/\s+/g, '').length : 0), 0) }));
  const texts = {};
  for (const el of document.querySelectorAll('.t[data-node]')) texts[el.dataset.node] ??= el.textContent;
  return { facts, faces, els, nodes: [...new Set([...document.querySelectorAll('[data-node]')].map(el => el.dataset.node))], texts };
})()`;

// -- Collection ---------------------------------------------------------
// Evaluate once, then sample the text-richest element per face, with first occurrence breaking ties, through CSS.getPlatformFontsForNode. The most-used glyph count selects chromeUsed PostScript name.
// Mocks without cdp omit chromeUsed. Individual CDP failures affect only that face; render timeouts and Chrome failures propagate for frame-level handling.
// Malformed page-script results throw normally rather than silently falling back to empty data.
/** @param {Error & { code?: string }} error @returns {undefined} */
const soft = error => { if (error.code === 'RENDER_TIMEOUT' || /^CHROME_/.test(error.code ?? '')) throw error; };
/** @param {unknown} v */
const isMap = v => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * @param {{ evaluate(expression: string): Promise<any>, cdp?(method: string, params?: object): Promise<any> }} page @param {string[]} ids Union of top, focus and zoom nodes.
 * @returns {Promise<{ facts: Record<string, Facts>, audit: FontAudit, dom: { nodes: string[], texts: Record<string, string> } }>}
 */
export async function collect(page, ids) {
  const r = await page.evaluate(FACTS(ids));
  if (!isMap(r) || ![r.facts, r.faces, r.texts].every(isMap) || !Array.isArray(r.els) || !Array.isArray(r.nodes)) throw Error(`Page data collection returned an unexpected shape: ${String(JSON.stringify(r)).slice(0, 200)}`);
  /** @type {{ node: string, face: string, chars: number }[]} */
  const els = r.els;
  /** @type {FontAudit['faces']} */
  const faces = r.faces;
  const uses = /** @type {FontAudit['uses']} */ ([]), seen = new Set(), sample = /** @type {Map<string, number>} */ (new Map());
  els.forEach((e, i) => {
    if (!(e.chars > 0)) return;
    const key = JSON.stringify([e.node, e.face]), at = sample.get(e.face);
    if (!seen.has(key)) { seen.add(key); uses.push({ node: e.node, face: e.face }); }
    if (at === undefined || e.chars > els[at].chars) sample.set(e.face, i);
  });
  if (page.cdp && sample.size) {
    const cdp = page.cdp.bind(page);
    const list = await (async () => {
      await cdp('DOM.enable'); await cdp('CSS.enable');
      const { root } = await cdp('DOM.getDocument', { depth: 0 });
      return /** @type {number[]} */ ((await cdp('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '.t, .t *' })).nodeIds);
    })().catch(soft);
    if (list) for (const [face, i] of sample) {
      /** @type {{ fonts?: { postScriptName: string, glyphCount: number }[] } | undefined} */
      const got = await cdp('CSS.getPlatformFontsForNode', { nodeId: list[i] }).catch(soft);
      const [used] = [...got?.fonts ?? []].sort((a, b) => b.glyphCount - a.glyphCount);
      if (used && faces[face]) faces[face].chromeUsed = used.postScriptName;
    }
  }
  return { facts: r.facts, audit: { faces, uses }, dom: { nodes: r.nodes, texts: r.texts } };
}

// -- Geometry findings --------------------------------------------------
/** @param {number} v */
const r2 = v => Number(v.toFixed(2)) || 0;
// Compare line counts, first-line top and ink in canvas coordinates only when text's linear transform is positive diagonal, with no rotation or flips.
/** @param {Linear} linear */
export const upright = ([a, b, c, d]) => Math.abs(b) <= 1e-6 && Math.abs(c) <= 1e-6 && a > 0 && d > 0;
// Maximum ink protrusion beyond the node box across all four edges, or zero when contained.
/** @param {Rect} ink @param {Box} box */
const outside = ([x0, y0, x1, y1], [x, y, w, h]) => Math.max(0, x - x0, y - y0, x1 - x - w, y1 - y - h);

// Compare every node's box: Figma islands use renderBounds plus SVG sizing conventions; others use frame bounds. Suppress findings when an applied style on self/ancestor intentionally changes placement.
// For page-supplied text facts without rotation/flips:
// - wrap: auto-height Figma line count rounds H/lh when nearly integral; compare with HTML lines, using min(lines, maxLines) for ENDING truncation because hidden lines still lay out.
// - content-offset: compare first-line top with vertical alignment's expected box-top plus 0, (H - n*lh)/2 or H - n*lh, using Figma line count when available, otherwise HTML count.
//   Skip both checks for text-layout approximations (leadingTrim, paragraph spacing, lists, or vertical alignment plus truncation), where H differs from n*lh.
// - overflow: HTML ink protrudes more than Figma by BOX_TOL. ink-offset reports the four ink/renderBounds component differences without blocking clean.
/**
 * @param {ExtractNode} node @param {Facts} facts
 * @param {{ island: boolean, moved: boolean, approx: ReadonlyArray<string> }} opts  island means actually inlined; moved means applied style on self/ancestor; approx lists this node's approximation kinds.
 * @returns {Finding[]}
 */
export function findings(node, facts, { island, moved, approx }) {
  if (!facts.found) return [];
  const out = /** @type {Finding[]} */ ([]), rb = node.renderBounds, html = facts.box;
  const figma = /** @type {Box} */ (island && rb ? [rb[0], rb[1], Math.ceil(rb[2] - 1e-3), Math.ceil(rb[3] - 1e-3)] : frameBox(node));
  if (!moved && html.some((v, i) => Math.abs(v - figma[i]) >= BOX_TOL)) out.push({ kind: 'box', html: /** @type {Box} */ (html.map(r2)), figma: /** @type {Box} */ (figma.map(r2)) });
  const t = facts.text;
  if (!t || !upright(t.linear)) return out;
  const H = node.height, lh = t.lh, laid = !approx.includes('text-layout');
  const lines = node.textTruncation === 'ENDING' && node.maxLines ? Math.min(t.lines, node.maxLines) : t.lines;
  const q = lh ? H / lh : NaN, figmaLines = Math.abs(q - Math.round(q)) < 0.05 ? Math.round(q) : null;
  if (laid && lh && (node.textAutoResize === 'HEIGHT' || node.textAutoResize === 'WIDTH_AND_HEIGHT') && figmaLines !== null && figmaLines !== lines)
    out.push({ kind: 'wrap', figma: figmaLines, html: lines });
  if (laid && lh) {
    const free = H - (figmaLines ?? lines) * lh, v = node.textAlignVertical, dy = t.firstTop - html[1] - (v === 'CENTER' ? free / 2 : v === 'BOTTOM' ? free : 0);
    if (Math.abs(dy) >= BOX_TOL) out.push({ kind: 'content-offset', dy: r2(dy) });
  }
  if (!t.ink || !rb) return out;
  const mine = outside(t.ink, html), theirs = outside([rb[0], rb[1], rb[0] + rb[2], rb[1] + rb[3]], frameBox(node));
  if (mine - theirs >= BOX_TOL) out.push({ kind: 'overflow', html: r2(mine), figma: r2(theirs) });
  const d = [t.ink[0] - rb[0], t.ink[1] - rb[1], t.ink[2] - t.ink[0] - rb[2], t.ink[3] - t.ink[1] - rb[3]];
  if (d.some(v => Math.abs(v) >= BOX_TOL)) out.push({ kind: 'ink-offset', dx: r2(d[0]), dy: r2(d[1]), dw: r2(d[2]), dh: r2(d[3]) });
  return out;
}

// -- Font findings ------------------------------------------------------
// Each FontUse maps to its generated face. Ignore unused faces. Otherwise substitution means FontFace is not loaded (failed local() may fall back to a same-named system family,
// so chromeUsed can still match the declared name), or the actual font is absent from local() names, including a wrong weight within the correct family.
// For named variable-font instances, Chrome reports the default face plus non-default axes, such as SFPro-Regular_wdth_opsz110000_wght24E0000, without identifying the named instance;
// compare only the family prefix before '-' and rely on status for instance selection.
const VARIABLE = /(?:_[A-Za-z]{4}[0-9A-F]*)+$/;
/** @param {string} name */
const stem = name => name.replace(VARIABLE, '').split('-')[0];
/** @param {ReadonlyArray<FontUse>} uses @param {FontAudit} audit @returns {FontRow[]} */
export function fontRows(uses, { faces, uses: used }) {
  const live = new Set(used.map(u => u.face));
  return uses.map(({ family, style, postScriptName, source, face }) => {
    if (!live.has(face)) return { family, style, postScriptName, source, face, substituted: false };
    const f = faces[face], chromeUsed = f?.chromeUsed;
    const named = chromeUsed === undefined || !!f?.names.includes(chromeUsed) || (VARIABLE.test(chromeUsed) && !!f?.names.some(n => stem(n) === stem(chromeUsed)));
    return { family, style, postScriptName, source, face, ...(f ? { status: f.status } : {}), ...(chromeUsed !== undefined ? { chromeUsed } : {}),
      substituted: f?.status !== 'loaded' || !named };
  });
}
// Nodes using substituted faces.
/** @param {FontAudit} audit @param {ReadonlyArray<FontRow>} rows */
export function substitutedNodes(audit, rows) {
  const bad = new Set(rows.filter(r => r.substituted).map(r => r.face));
  return new Set(audit.uses.filter(u => bad.has(u.face)).map(u => u.node));
}
