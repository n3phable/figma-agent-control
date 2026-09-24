/**
 * [INPUT]: Inputs and types declared below; no runtime package dependencies.
 * [OUTPUT]: Exports num, px, esc, cssStr, color, place, linearGradient, svgLinearGradient, paintLayer, radius, stroke, effects, backdrop, blend, lineHeight, baselineShift, postScriptGuess, segmentStyle, textBox, maskImage, VECTORS, vectorSvg, fillAlpha, bakeReason, paintsBackground.
 * [POS]: Pure conversion of Figma drawing properties into CSS and SVG fragments.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
/** @import { ExtractNode, TextSegment } from './extract-contract.js' */
/**
 * @typedef {Record<string, string>} Style  CSS property to value; insertion order determines output order.
 * @typedef {[a: number, b: number, c: number, d: number, e: number, f: number]} Matrix  CSS column order: x' = a*x + c*y + e, y' = b*x + d*y + f.
 * @typedef {Exclude<ExtractNode['fills'], 'MIXED' | undefined>[number]} Paint
 * @typedef {{ r: number, g: number, b: number, a?: number }} Color
 * @typedef {{ gradientTransform: ExtractNode['transform'], gradientStops: ReadonlyArray<{ position: number, color: Color }>, opacity?: number }} Gradient
 * @typedef {{ postScriptName: string, unitsPerEm: number, hhea: { ascender: number, descender: number, lineGap: number } }} FontMetrics  Font-file metrics structurally satisfied by fonts.mjs records.
 */

// -- Numbers, escaping and colors ---------------------------------------
// Route all numbers through num for fixed precision, trimmed zeros and normalized -0. Preserve NaN/Infinity for output-invariant checks instead of hiding them.
/** @param {number} v @param {number} [digits] */
export const num = (v, digits = 3) => Number.isFinite(v) ? String(Number(v.toFixed(digits)) || 0) : String(v);
/** @param {number} v */
export const px = v => num(v) + 'px';
// Shared attribute/text escaping; style attributes always use double quotes.
/** @param {unknown} s */
export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// CSS strings use single quotes so they cannot close style attributes. Escape <, double quotes and newlines so font-family content cannot escape a stylesheet through </style> or break strings;
// stylesheets also cannot produce attribute-like ` src="` sequences, allowing embed to replace placeholders only inside attributes.
/** @param {string} s */
export const cssStr = s => `'${s.replace(/[\\']/g, '\\$&').replace(/[<"\n\r\f]/g, c => `\\${c.charCodeAt(0).toString(16)} `)}'`;
// Non-finite channels use rgba so NaN survives for invariant checks; hexadecimal conversion would hide it as #NAN0000.
/** @param {Color} c @param {number} [alpha] Paint opacity multiplied into the color's own alpha. */
export function color(c, alpha = 1) {
  const a = (c.a ?? 1) * alpha, rgb = [c.r, c.g, c.b].map(v => Math.min(255, Math.max(0, Math.round(v * 255))));
  return a >= 0.999 && rgb.every(Number.isFinite) ? '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase() : `rgba(${rgb.join(',')},${num(a)})`;
}
// Use translate for translation-only matrices, otherwise matrix. Treat linear components within 1e-6 of identity as translation.
/** @param {Matrix} m */
export function place(m) {
  const pure = Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6;
  return pure ? `translate(${px(m[4])},${px(m[5])})` : `matrix(${m.map(v => num(v, 6)).join(',')})`;
}
// Visible paints/effects; TEXT fills may be 'MIXED', treated as absent.
/** @template T @param {ReadonlyArray<T> | string | undefined} list @returns {T[]} */
const shown = list => Array.isArray(list) ? list.filter(p => p?.visible !== false) : [];
// Blend modes that do not alter blending; omission defaults to PASS_THROUGH.
const PLAIN = new Set([undefined, 'PASS_THROUGH', 'NORMAL']);

// -- Gradients ----------------------------------------------------------
// gradientTransform's first row (a, b, c) gives t = a*u + b*v + c at normalized coordinates; pixel-space gradient is (a/w, b/h).
// The CSS gradient line crosses box center with length L = w*|sinA| + h*|cosA|, directed along that gradient. Equal-color lines are perpendicular; handle direction differs when width and height differ.
// Stop s sits L/2 + (s - t_c)/|gradient| from the line start, with t_c evaluated at box center. Compute in the node's local, untransformed box.
/** @param {Gradient} paint @param {number} w @param {number} h */
export function linearGradient(paint, w, h) {
  const [[a, b, c]] = paint.gradientTransform, gx = w ? a / w : 0, gy = h ? b / h : 0, len = Math.hypot(gx, gy);
  let A = Math.atan2(gx, -gy) * 180 / Math.PI;
  if (A < 0) A += 360;
  const rad = A * Math.PI / 180, L = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)), tc = (a + b) / 2 + c;
  /** @param {number} s */
  const at = s => len && L ? (L / 2 + (s - tc) / len) / L * 100 : s * 100;
  return `linear-gradient(${num(A)}deg,${paint.gradientStops.map(s => `${color(s.color, paint.opacity ?? 1)} ${num(at(s.position))}%`).join(',')})`;
}
// SVG paints x from 0 to 1 in gradient space, then maps through inverse gradientTransform and box size into node pixels, matching Figma's equal-color lines exactly.
// Return '' for singular gradientTransform; callers approximate with the first stop's solid color.
/** @param {Gradient} paint @param {number} w @param {number} h @param {string} id */
export function svgLinearGradient(paint, w, h, id) {
  const [[a, b, c], [d, e, f]] = paint.gradientTransform, k = a * e - b * d;
  if (!k) return '';
  const m = [e / k * w, -d / k * h, -b / k * w, a / k * h, (b * f - e * c) / k * w, (d * c - a * f) / k * h];
  const stops = paint.gradientStops.map(s => `<stop offset="${num(s.position)}" stop-color="${color(s.color, paint.opacity ?? 1)}"/>`).join('');
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0" gradientTransform="matrix(${m.map(v => num(v, 6)).join(' ')})">${stops}</linearGradient>`;
}

// -- Fills --------------------------------------------------------------
// One background layer. SOLID/gradient opacity is already included in colors; callers apply image-paint opacity through element opacity or a fill layer.
// Images use placeholder URLs; null image means unavailable bitmap and no paint. CROP imageTransform maps normalized node coordinates into normalized image coordinates.
const FIT = /** @type {Record<string, string>} */ ({ FILL: 'cover', FIT: 'contain' });
/** @param {Paint} paint @param {number} w @param {number} h @param {{ url: string, width: number, height: number } | null} image @returns {{ css: string, approx?: string, detail?: string }} */
export function paintLayer(paint, w, h, image) {
  if (paint.type === 'SOLID') { const c = color(paint.color, paint.opacity ?? 1); return { css: `linear-gradient(${c},${c})` }; }
  if (paint.type === 'GRADIENT_LINEAR') return { css: linearGradient(paint, w, h) };
  if ('gradientStops' in paint) { const c = color(paint.gradientStops[0]?.color ?? { r: 0, g: 0, b: 0, a: 0 }, paint.opacity ?? 1); return { css: `linear-gradient(${c},${c})`, approx: 'paint-unsupported', detail: paint.type }; }
  if (paint.type !== 'IMAGE') return { css: '', approx: 'paint-unsupported', detail: paint.type };
  if (!image) return { css: '', approx: 'image-unavailable' };
  const url = `url("${image.url}")`;
  if (paint.scaleMode === 'TILE') {
    const f = paint.scalingFactor ?? 1, known = image.width > 0 && image.height > 0;
    return { css: `${url} 0 0/${known ? `${px(image.width * f)} ${px(image.height * f)}` : 'auto'} repeat`, ...(known ? {} : { approx: 'paint-unsupported', detail: 'TILE' }) };
  }
  if (paint.scaleMode === 'CROP') {
    // Rotated transforms (nonzero b/c) require Figma rendering; this path uses only the axis-aligned portion.
    const [[a, , tx], [, d, ty]] = paint.imageTransform ?? [[1, 0, 0], [0, 1, 0]];
    return { css: `${url} ${px(-tx * w / a)} ${px(-ty * h / d)}/${px(w / a)} ${px(h / d)} no-repeat` };
  }
  return { css: `${url} center/${FIT[paint.scaleMode] ?? 'cover'} no-repeat` };
}
/** @param {ExtractNode} node */
export function radius(node) {
  if (node.type === 'ELLIPSE') return '50%';
  if (node.cornerRadius === 'MIXED') return [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius].map(r => px(r ?? 0)).join(' ');
  return node.cornerRadius ? px(node.cornerRadius) : '';
}

// -- Strokes ------------------------------------------------------------
// Use only the top visible stroke. Equal-width sides use outline, avoiding layout effects and self-overflow clipping; alignment differs only in outline-offset.
// Unequal sides use one inset box-shadow per edge, supporting inside only and marking other alignments approximate. Gradient strokes use the first solid stop. Omit text strokes.
// Chromium paints both forms beneath absolutely positioned children, so callers place them in a final stroke layer when children/fill layers exist.
/** @param {ExtractNode} node @returns {{ style: Style, approx: string[] }} */
export function stroke(node) {
  const s = shown(node.strokes).at(-1), style = /** @type {Style} */ ({}), approx = /** @type {string[]} */ ([]);
  if (!s) return { style, approx };
  if (node.type === 'TEXT') return { style, approx: ['text-effect'] };
  let c;
  if (s.type === 'SOLID') c = color(s.color, s.opacity ?? 1);
  else if ('gradientStops' in s) { c = color(s.gradientStops[0]?.color ?? { r: 0, g: 0, b: 0, a: 0 }, s.opacity ?? 1); approx.push('gradient-stroke'); }
  else return { style, approx: ['paint-unsupported'] };
  const w = node.strokeWeight;
  if (w === 'MIXED') {
    const sides = /** @type {[number | undefined, (v: number) => string][]} */ ([[node.strokeTopWeight, v => `0 ${px(v)}`], [node.strokeRightWeight, v => `${px(-v)} 0`],
      [node.strokeBottomWeight, v => `0 ${px(-v)}`], [node.strokeLeftWeight, v => `${px(v)} 0`]]);
    const shadows = sides.filter(([v]) => v).map(([v, at]) => `inset ${at(/** @type {number} */ (v))} 0 0 ${c}`);
    if (shadows.length) style['box-shadow'] = shadows.join(',');
    if (node.strokeAlign !== 'INSIDE') approx.push('stroke-sides');
  } else if (w) {
    style.outline = `${px(w)} solid ${c}`;
    style['outline-offset'] = px(node.strokeAlign === 'INSIDE' ? -w : node.strokeAlign === 'CENTER' ? -w / 2 : 0);
  }
  return { style, approx };
}

// -- Effects ------------------------------------------------------------
// target: box uses box-shadow with spread and inset for inner shadows; CSS does not draw it behind the box, so showShadowBehindNode=true records an approximation;
// text uses text-shadow without spread or inner shadows; image uses filter:drop-shadow following alpha/child silhouettes, with blur r/2.
// Omit blended shadows because box-shadow cannot blend. backdrop handles background blur/GLASS; NOISE, TEXTURE and SHADER require Figma rendering and do not paint in DOM.
/** @param {ExtractNode} node @param {'box' | 'text' | 'image'} target @returns {{ style: Style, approx: string[] }} */
export function effects(node, target) {
  const style = /** @type {Style} */ ({}), approx = /** @type {string[]} */ ([]), shadows = [], filters = [];
  for (const e of shown(node.effects)) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      if (e.blendMode && e.blendMode !== 'NORMAL') { approx.push('blend-shadow'); continue; }
      const inner = e.type === 'INNER_SHADOW', xy = `${px(e.offset.x)} ${px(e.offset.y)}`, c = color(e.color);
      if (!inner && target === 'box' && e.showShadowBehindNode) approx.push('shadow-behind');
      if (target === 'text') { if (inner) approx.push('text-effect'); else shadows.push(`${xy} ${px(e.radius)} ${c}`); }
      else if (target === 'image' && !inner) filters.push(`drop-shadow(${xy} ${px(e.radius / 2)} ${c})`);
      else shadows.push(`${inner ? 'inset ' : ''}${xy} ${px(e.radius)}${e.spread ? ' ' + px(e.spread) : ''} ${c}`);
    } else if (e.type === 'LAYER_BLUR') filters.push(`blur(${px(e.radius / 2)})`);
  }
  if (shadows.length) style[target === 'text' ? 'text-shadow' : 'box-shadow'] = shadows.join(',');
  if (filters.length) style.filter = filters.join(' ');
  return { style, approx };
}
// Background blur/GLASS use a preceding sibling layer; putting progressive blur's mask-image on the node would also mask its own fill.
// Map progressive-blur masks from startOffset to endOffset within the box using the linear-gradient formula; treat startRadius as zero.
// Zero GLASS radius is the all-default state before library data loads; add no blur. Return null when neither effect exists.
/** @param {ExtractNode} node @returns {{ style: Style, approx: string[] } | null} */
export function backdrop(node) {
  const style = /** @type {Style} */ ({}), approx = [], w = node.width, h = node.height;
  for (const e of shown(node.effects)) {
    if (e.type === 'BACKGROUND_BLUR') {
      style['backdrop-filter'] = `blur(${px(e.radius / 2)})`;
      approx.push('background-blur');
      if (e.blurType !== 'PROGRESSIVE') continue;
      const { x: sx, y: sy } = e.startOffset, dx = (e.endOffset.x - sx) * w, dy = (e.endOffset.y - sy) * h, dd = dx * dx + dy * dy;
      if (!dd) continue;
      const a = dx * w / dd, b = dy * h / dd;
      style['mask-image'] = linearGradient({ gradientTransform: [[a, b, -a * sx - b * sy], [0, 0, 0]],
        gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 0 } }, { position: 1, color: { r: 0, g: 0, b: 0 } }] }, w, h);
    } else if (e.type === 'GLASS') {
      if (e.radius > 0) style['backdrop-filter'] = `blur(${px(e.radius / 2)})`;
      approx.push('glass');
    }
  }
  return approx.length ? { style, approx } : null;
}
// Fifteen modes map directly; Chromium lacks LINEAR_BURN/LINEAR_DODGE equivalents, so use nearest modes and mark approximations.
const BLENDS = new Set(['MULTIPLY', 'SCREEN', 'OVERLAY', 'DARKEN', 'LIGHTEN', 'COLOR_DODGE', 'COLOR_BURN', 'HARD_LIGHT', 'SOFT_LIGHT', 'DIFFERENCE', 'EXCLUSION',
  'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']);
/** @param {string | undefined} mode @returns {{ value: string, approx?: string }} */
export function blend(mode) {
  if (!mode || mode === 'PASS_THROUGH' || mode === 'NORMAL') return { value: '' };
  if (BLENDS.has(mode)) return { value: mode.toLowerCase().replace(/_/g, '-') };
  return { value: mode === 'LINEAR_BURN' ? 'multiply' : mode === 'LINEAR_DODGE' ? 'plus-lighter' : '', approx: 'blend-mode' };
}

// -- Text ---------------------------------------------------------------
// AUTO line-height fallback: segment lineHeightPx -> font (asc - desc + gap) / upm * size -> node height for single-line text -> normal with approximation.
// The first two return unrounded values; callers round when all segments share metrics, matching Figma's integer line-height layout for uniform text.
// Multiline means characters contain a newline, U+2028/U+2029, or node height >= 1.8 times the largest segment size. Never use full node height as multiline line height, which would push the second line out of view.
/** @param {TextSegment} seg @param {ExtractNode} node @param {FontMetrics | null} metrics @returns {{ px: number, from: 'value' | 'segment' | 'metrics' | 'height' } | { px: null, approx: 'line-height-normal' }} */
export function lineHeight(seg, node, metrics) {
  const lh = seg.lineHeight;
  if (lh.unit === 'PIXELS') return { px: lh.value, from: 'value' };
  if (lh.unit === 'PERCENT') return { px: seg.fontSize * lh.value / 100, from: 'value' };
  if (seg.lineHeightPx !== undefined) return { px: seg.lineHeightPx, from: 'segment' };
  if (metrics) { const { ascender, descender, lineGap } = metrics.hhea; return { px: (ascender - descender + lineGap) / metrics.unitsPerEm * seg.fontSize, from: 'metrics' }; }
  const multiline = /[\n\u2028\u2029]/.test(node.characters ?? '') || node.height >= 1.8 * Math.max(...(node.segments ?? []).map(s => s.fontSize));
  return multiline ? { px: null, approx: 'line-height-normal' } : { px: node.height, from: 'height' };
}
// Chromium baseline compensation: it rounds ascent/descent separately, then floors half-leading; Figma does not.
// Return round(Figma baseline) minus Chromium baseline. At exact half-pixels, either rounding leaves equal error, so do not move; truncate toward zero with 1e-6 floating-point tolerance.
/** @param {FontMetrics} m @param {number} fontSize @param {number} lh */
export function baselineShift(m, fontSize, lh) {
  const k = fontSize / m.unitsPerEm, asc = m.hhea.ascender * k, dsc = -m.hhea.descender * k, gap = m.hhea.lineGap * k;
  const d = lh / 2 - (asc + dsc + gap) / 2 + asc - (Math.round(asc) + Math.floor((lh - Math.round(asc) - Math.round(dsc)) / 2));
  return Math.sign(d) * Math.round(Math.abs(d) - 1e-6) || 0;
}
// Guess PostScript names only when neither segment nor font lookup supplies one, using conventions such as Light Italic -> Kanit-LightItalic.
/** @param {string} family @param {string} style */
export const postScriptGuess = (family, style) => `${family.replace(/\s/g, '')}-${style.replace(/\s/g, '')}`;
const CASES = /** @type {Record<string, [string, string]>} */ ({ UPPER: ['text-transform', 'uppercase'], LOWER: ['text-transform', 'lowercase'], TITLE: ['text-transform', 'capitalize'],
  SMALL_CAPS: ['font-variant-caps', 'small-caps'], SMALL_CAPS_FORCED: ['font-variant-caps', 'all-small-caps'] });
// Complete segment styling. face.name is the unique @font-face family; weight/italic match descriptors so Chrome does not synthesize bold.
// Map gradient text using node-box size; span boxes differ from the node box, so callers mark segmented gradients approximate.
/** @param {TextSegment} seg @param {{ name: string, family: string, weight?: number, italic: boolean }} face @param {number | null} lh @param {[w: number, h: number]} size @returns {Style} */
export function segmentStyle(seg, face, lh, size) {
  const s = /** @type {Style} */ ({ 'font-family': `${cssStr(face.name)},${cssStr(face.family)},system-ui,sans-serif`, 'font-size': px(seg.fontSize) });
  if (face.weight !== undefined) s['font-weight'] = String(face.weight);
  s['font-style'] = face.italic ? 'italic' : 'normal';
  s['line-height'] = lh === null ? 'normal' : px(lh);
  const ls = seg.letterSpacing, spacing = !ls ? 0 : ls.unit === 'PERCENT' ? seg.fontSize * ls.value / 100 : ls.value;
  if (spacing) s['letter-spacing'] = px(spacing);
  const fill = shown(seg.fills).at(-1);
  if (fill?.type === 'SOLID') s.color = color(fill.color, fill.opacity ?? 1);
  else if (fill?.type === 'GRADIENT_LINEAR') Object.assign(s, { background: linearGradient(fill, ...size), '-webkit-background-clip': 'text', 'background-clip': 'text', color: 'transparent' });
  else s.color = fill && 'gradientStops' in fill && fill.gradientStops[0] ? color(fill.gradientStops[0].color, fill.opacity ?? 1) : 'transparent';
  if (seg.textDecoration === 'UNDERLINE') {
    const t = seg.textDecorationThickness, o = seg.textDecorationOffset;
    Object.assign(s, { 'text-decoration': 'underline', 'text-decoration-skip-ink': seg.textDecorationSkipInk ? 'auto' : 'none',
      'text-decoration-thickness': t?.unit === 'PIXELS' ? px(t.value) : '1px', 'text-underline-offset': o?.unit === 'PIXELS' ? px(o.value) : '2.5px' });
  } else if (seg.textDecoration === 'STRIKETHROUGH') s['text-decoration'] = 'line-through';
  // Decoration color defaults to text color (observed { value: 'AUTO' }); explicit solid paint gets its own color. Default decoration style is solid.
  const dc = /** @type {{ value?: { color?: Color, opacity?: number } | string } | string | null | undefined} */ (seg.textDecorationColor), ds = seg.textDecorationStyle;
  const dv = typeof dc === 'object' ? dc?.value : undefined;
  if (s['text-decoration'] && typeof dv === 'object' && dv.color) s['text-decoration-color'] = color(dv.color, dv.opacity ?? 1);
  if (s['text-decoration'] && (ds === 'WAVY' || ds === 'DOTTED')) s['text-decoration-style'] = ds.toLowerCase();
  const kase = CASES[seg.textCase];
  if (kase) s[kase[0]] = kase[1];
  if (seg.openTypeFeatures?.LIGA === false || seg.openTypeFeatures?.CLIG === false) s['font-variant-ligatures'] = 'none';
  return s;
}
// Text-box layout handles horizontal/vertical alignment, truncation and wrapping. Vertical flex-column alignment needs a body block so each span does not become a separate flex item.
/** @param {ExtractNode} node @returns {{ style: Style, nowrap: boolean, wrap: boolean, approx: string[] }} */
export function textBox(node) {
  const style = /** @type {Style} */ ({}), approx = [], v = node.textAlignVertical, valign = v === 'CENTER' || v === 'BOTTOM';
  const h = /** @type {Record<string, string>} */ ({ CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' })[node.textAlignHorizontal ?? 'LEFT'];
  if (h) style['text-align'] = h;
  const ending = node.textTruncation === 'ENDING', clamp = ending && node.maxLines ? node.maxLines : 0;
  if (clamp) {
    Object.assign(style, { display: '-webkit-box', '-webkit-box-orient': 'vertical', '-webkit-line-clamp': String(clamp) });
    if (valign) approx.push('text-layout');
  } else if (valign) Object.assign(style, { display: 'flex', 'flex-direction': 'column', 'justify-content': v === 'CENTER' ? 'center' : 'flex-end' });
  if (ending) Object.assign(style, { overflow: 'hidden', 'text-overflow': 'ellipsis' });
  return { style, nowrap: node.textAutoResize === 'WIDTH_AND_HEIGHT', wrap: valign && !clamp, approx };
}

// -- Masks and vectors --------------------------------------------------
// Mask-wrapper mask-image is inline SVG in mask-local coordinates; absent geometry falls back to ellipse/rounded rectangle. Callers supply alpha according to mask type.
/** @param {ExtractNode} mask @param {number} alpha @returns {Style} */
export function maskImage(mask, alpha) {
  const w = num(mask.width), h = num(mask.height), geometry = (mask.fillGeometry ?? []).filter(g => g.data);
  const shape = geometry.length ? geometry.map(g => `<path d="${g.data}" fill-rule="${g.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero'}"/>`).join('')
    : mask.type === 'ELLIPSE' ? `<ellipse cx="${num(mask.width / 2)}" cy="${num(mask.height / 2)}" rx="${num(mask.width / 2)}" ry="${num(mask.height / 2)}"/>`
    : `<rect width="${w}" height="${h}" rx="${num(typeof mask.cornerRadius === 'number' ? mask.cornerRadius : 0)}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill-opacity="${num(alpha)}">${shape}</g></svg>`;
  return { 'mask-image': `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, 'mask-size': '100% 100%', 'mask-repeat': 'no-repeat' };
}
export const VECTORS = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE']);
// Non-island vectors paint fillGeometry with fills and strokeGeometry outlines with stroke paints, using local-pixel coordinates without viewBox.
// LINE ignores fills; omit empty paths. Paint blending is unsupported and approximate. Chromium draws nothing for zero-width/height SVG even with overflow:visible, so require at least a 1 px viewport.
/** @param {ExtractNode} node @returns {{ svg: string, approx: string[] }} */
export function vectorSvg(node) {
  const approx = /** @type {string[]} */ ([]), defs = /** @type {string[]} */ ([]), id = esc('v' + node.id.replace(/:/g, '-').replace(/;/g, '_'));
  /** @param {Paint | undefined} p @param {string} key */
  const fill = (p, key) => {
    if (!p) return '';
    if (!PLAIN.has(p.blendMode)) approx.push('blend-mode');
    if (p.type === 'SOLID') return color(p.color, p.opacity ?? 1);
    const def = p.type === 'GRADIENT_LINEAR' ? svgLinearGradient(p, node.width, node.height, id + key) : '';
    if (def) { defs.push(def); return `url(#${id + key})`; }
    approx.push('paint-unsupported');
    return 'gradientStops' in p && p.gradientStops[0] ? color(p.gradientStops[0].color, p.opacity ?? 1) : '';
  };
  /** @param {ExtractNode['fillGeometry']} geometry @param {Paint | undefined} p @param {string} key */
  const paths = (geometry, p, key) => {
    const list = (geometry ?? []).filter(g => g.data), f = list.length ? fill(p, key) : '';
    return f ? list.map(g => `<path d="${esc(g.data)}" fill-rule="${g.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero'}" fill="${f}"/>`).join('') : '';
  };
  const body = paths(node.type === 'LINE' ? [] : node.fillGeometry, shown(node.fills).at(-1), 'f') + paths(node.strokeGeometry, shown(node.strokes).at(-1), 's');
  const svg = `<svg width="${num(Math.max(1, node.width))}" height="${num(Math.max(1, node.height))}" overflow="visible">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${body}</svg>`;
  return { svg, approx };
}

// Uniform fill alpha for ALPHA masks: SOLID uses color alpha times paint opacity; gradients use a common stop alpha when all match.
// Composite layers as 1 - product(1 - alpha); any opaque layer yields 1. Return null for no visible fill, images or nonuniform gradients unless an opaque layer makes the result known.
/** @param {ExtractNode} node @returns {number | null} */
export function fillAlpha(node) {
  const fills = shown(node.fills);
  let clear = 1, uneven = !fills.length;
  for (const p of fills) {
    const op = p.opacity ?? 1, list = p.type === 'SOLID' ? [(/** @type {Color} */ (p.color).a ?? 1) * op] : 'gradientStops' in p ? p.gradientStops.map(s => (s.color.a ?? 1) * op) : [NaN];
    const a = Math.min(...list);
    if (a >= 0.999) return 1;
    if (!(a >= 0) || Math.max(...list) - a > 1e-3) uneven = true; else clear *= 1 - a;
  }
  return uneven ? null : 1 - clear;
}

// -- Figma baking and backdrop dependencies ------------------------------
// Return the first reason CSS cannot represent a node and Figma should export an island, or null. Collect text paints from segments because node fills may be MIXED.
// Child ALPHA masks not uniformly opaque, LUMINANCE masks, and non-shape masks lacking geometry require baking the parent as one group.
/** @param {ExtractNode} node @returns {string | null} */
export function bakeReason(node) {
  if (VECTORS.has(node.type)) return 'vector';
  const text = node.type === 'TEXT', fills = text ? (node.segments ?? []).flatMap(g => shown(g.fills)) : shown(node.fills), top = shown(node.strokes).at(-1);
  for (const p of fills) if (p.type !== 'SOLID' && p.type !== 'GRADIENT_LINEAR' && (text || p.type !== 'IMAGE')) return 'gradientStops' in p ? 'gradient-' + p.type.slice(9).toLowerCase() : 'paint-' + p.type.toLowerCase();
  if (top && 'gradientStops' in top) return 'gradient-stroke';
  if (node.dashPattern?.length) return 'dash';
  for (const p of fills) if (p.type === 'IMAGE') {
    const t = p.imageTransform;
    if (p.rotation || (p.scaleMode === 'CROP' && t && (t[0][1] || t[1][0]))) return 'image-transform';
    if (p.filters && Object.values(p.filters).some(Boolean)) return 'image-filter';
  }
  for (const c of node.children ?? []) {
    if (!c.isMask) continue;
    if ((c.maskType ?? 'ALPHA') === 'ALPHA' && !((fillAlpha(c) ?? 0) >= 0.999)) return 'mask-alpha';
    if (c.maskType === 'LUMINANCE') return 'mask-luminance';
    if (!c.fillGeometry?.length && c.type !== 'RECTANGLE' && c.type !== 'ELLIPSE') return 'mask-shape';
  }
  const arc = node.arcData;
  if (node.type === 'ELLIPSE' && arc && (arc.innerRadius > 1e-6 || Math.abs(arc.endingAngle - arc.startingAngle - 2 * Math.PI) > 1e-6)) return 'arc';
  for (const e of shown(node.effects)) if (e.type === 'NOISE' || e.type === 'TEXTURE' || e.type === 'SHADER') return 'effect-' + e.type.toLowerCase();
  return null;
}
// A node depends on backdrop when it, a visible paint or an effect blends beyond PASS_THROUGH/NORMAL, or has GLASS/background blur.
// SVG export omits backdrop, so baking those subtrees silently loses effects; generate aggregates subtree dependencies.
/** @param {ExtractNode} node */
export const paintsBackground = node => !PLAIN.has(node.blendMode) || [...shown(node.fills), ...shown(node.strokes)].some(p => !PLAIN.has(p.blendMode))
  || shown(node.effects).some(e => e.type === 'GLASS' || e.type === 'BACKGROUND_BLUR' || ('blendMode' in e && !PLAIN.has(e.blendMode)));
