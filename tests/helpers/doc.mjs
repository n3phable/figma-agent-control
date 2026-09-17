/**
 * [INPUT]: Imports ../../src/png.mjs.
 * [OUTPUT]: Exports MIXED, T, extractDoc.
 * [POS]: Isolated test fixtures shared by the surrounding contract and integration suites.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { encodePng } from '../../src/png.mjs';

export const MIXED = Symbol('mixed');
export const T = (x, y, a = 1, b = 0, c = 0, d = 1) => [[a, c, x], [b, d, y]];
const SOLID = (r, g, b, extra = {}) => ({ type: 'SOLID', visible: true, opacity: 1, blendMode: 'NORMAL', color: { r, g, b }, ...extra });
const ALIAS = id => ({ type: 'VARIABLE_ALIAS', id });
const IMAGE = hash => ({ type: 'IMAGE', visible: true, opacity: 1, blendMode: 'NORMAL', imageHash: hash, scaleMode: 'FILL' });
const SQUARE = [{ windingRule: 'NONZERO', data: 'M0 0 L10 0 L10 10 L0 10 Z' }];
// Effects sampled from Figma: search-bar glass, a LINEAR_BURN inner shadow on a glass button, and progressive footer background blur.
const GLASS = { type: 'GLASS', visible: true, radius: 0, boundVariables: { radius: ALIAS('VariableID:dff432b8027f928b338e3c0e40c415c736dee8c8/377:218') }, refraction: 0, depth: 1, lightAngle: 0, lightIntensity: 0, dispersion: 0, splay: 0 };
const BURN_SHADOW = { type: 'INNER_SHADOW', visible: true, radius: 30, boundVariables: {}, color: { r: 0.902, g: 0.902, b: 0.902, a: 1 }, offset: { x: 0, y: 40 }, spread: -40, blendMode: 'LINEAR_BURN' };
const PROGRESSIVE_BLUR = { type: 'BACKGROUND_BLUR', visible: true, radius: 8, boundVariables: {}, blurType: 'PROGRESSIVE', startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 } };

export function extractDoc() {
  const all = new Map(), exports = [], listeners = new Set();
  const encoder = new TextEncoder();
  // Place nodes at frame coordinates (x, y); absoluteRenderBounds defaults to the transformed box, and null means no drawing.
  const node = (id, type, name, x, y, w, h, extra = {}) => {
    const n = { id, type, name, removed: false, visible: true, width: w, height: h, absoluteTransform: T(100 + x, 200 + y),
      absoluteRenderBounds: { x: 100 + x, y: 200 + y, width: w, height: h }, opacity: 1, blendMode: 'PASS_THROUGH', fills: [], strokes: [], effects: [], ...extra };
    n.exportAsync = async options => {
      exports.push({ id, ...options });
      if (options.format === 'SVG_STRING') return `<svg data-shape="${n.shapeKey ?? id}"/>`;
      if (options.format === 'SVG') return encoder.encode(`<svg data-node="${id}"/>`);
      if (options.format === 'JSON_REST_V1') return { document: rest(n) };
      const s = options.constraint?.value ?? 1, pw = Math.round(w * s), ph = Math.round(h * s);
      return encodePng(pw, ph, new Uint8Array(pw * ph * 4).fill(255));
    };
    all.set(id, n);
    return n;
  };
  const rest = n => ({ id: n.id, type: n.type, ...(n.rest ?? {}), ...(n.children ? { children: n.children.map(rest) } : {}) });
  const kids = (parent, list) => { parent.children = list; for (const child of list) child.parent = parent; return parent; };
  const vector = (id, name, x, y, extra = {}) => node(id, 'VECTOR', name, x, y, 10, 10, { fills: [SOLID(0, 0, 0)], fillGeometry: SQUARE, strokeGeometry: [], vectorPaths: SQUARE, ...extra });
  const text = (id, name, x, y, w, h, characters, segments, restStyle, extra = {}) => node(id, 'TEXT', name, x, y, w, h, { characters, fills: MIXED, hasMissingFont: false,
    textAutoResize: 'HEIGHT', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', getStyledTextSegments: () => segments, rest: restStyle, ...extra });

  const page = { id: '1:1', type: 'PAGE', name: '\u9875\u9762', removed: false, children: [],
    loadAsync: async () => {}, on: (type, fn) => { if (type === 'nodechange') listeners.add(fn); }, off: (type, fn) => { if (type === 'nodechange') listeners.delete(fn); } };
  all.set(page.id, page);
  const frame = node('1:2', 'FRAME', '\u753b\u677f', 0, 0, 160, 160, { clipsContent: true, fills: [SOLID(1, 1, 1), SOLID(1, 0, 0, { visible: false })] });
  kids(page, [frame]);

  // -- Row 1: transforms, masks, island deduplication, instances/slots, hidden layers --
  const flipped = vector('2:1', '\u7ffb\u8f6c\u77e2\u91cf', 5, 5, { absoluteTransform: T(115, 205, -1, 0, 0, 1), shapeKey: 'flip', boundVariables: { opacity: ALIAS('VariableID:node-level') },
    fills: [SOLID(0, 0, 0, { boundVariables: { color: ALIAS('VariableID:1:1') } })] });
  const maskGroup = kids(node('2:2', 'GROUP', '\u8499\u7248\u7ec4', 20, 0, 20, 20), [
    node('2:3', 'RECTANGLE', '\u8499\u7248', 20, 0, 20, 20, { isMask: true, maskType: 'ALPHA', absoluteRenderBounds: null, fills: [SOLID(0, 0, 0)], fillGeometry: [{ windingRule: 'NONZERO', data: 'M0 0 L20 0 L20 20 L0 20 Z' }] }),
    node('2:4', 'RECTANGLE', '\u7167\u7247', 20, 0, 20, 20, { fills: [IMAGE('h1')], cornerRadius: MIXED, topLeftRadius: 4, topRightRadius: 0, bottomRightRadius: 4, bottomLeftRadius: 0 })]);
  const icon = kids(node('2:5', 'GROUP', '\u56fe\u6807', 45, 0, 10, 10, { shapeKey: 'icon' }), [vector('2:6', '\u4e0a', 45, 0), vector('2:7', '\u4e0b', 45, 0)]);
  const iconCopy = kids(node('2:13', 'GROUP', '\u56fe\u6807\u526f\u672c', 60, 0, 10, 10, { shapeKey: 'icon' }), [vector('2:14', '\u4e0a', 60, 0)]);
  // Slot content IDs have the form I<instance>;<slot>;<content>; slots are traversed as containers and may themselves be islands.
  const slot = kids(node('I2:12;4:1', 'SLOT', '\u63d2\u69fd', 75, 0, 20, 20, { layoutMode: 'HORIZONTAL', itemSpacing: 0 }), [vector('I2:12;4:1;4:2', '\u63d2\u69fd\u56fe\u6807', 80, 5)]);
  const instance = kids(node('2:12', 'INSTANCE', '\u6309\u94ae', 75, 0, 20, 20, { fills: [IMAGE('h1')], componentProperties: { 'Label#1:2': { type: 'TEXT', value: 'OK' } },
    getMainComponentAsync: async () => ({ id: '9:1', name: 'State=Default', key: 'k1', remote: false, parent: { type: 'COMPONENT_SET', name: 'Button' } }) }), [slot]);
  const hidden = node('2:11', 'RECTANGLE', '\u9690\u85cf', 100, 0, 5, 5, { visible: false, fills: [IMAGE('h2')] });

  // -- Row 2: auto layout and segmented text. The real JSON_REST_V1-shaped override for 2:9 changes font and size, includes fontPostScriptName,
  //    and omits lineHeightPx; node style is the base style, so its 17.90 does not apply to overridden AUTO segments. --
  const label = text('2:9', '\u6807\u7b7e', 0, 30, 40, 20, 'Hi \u4f60\u597d', [
    { characters: 'Hi ', start: 0, end: 3, fontName: { family: 'SF Pro Text', style: 'Bold' }, fontSize: 14, lineHeight: { unit: 'AUTO' }, fills: [SOLID(1, 0, 0, { boundVariables: { color: ALIAS('VariableID:1:2') } })] },
    { characters: '\u4f60\u597d', start: 3, end: 5, fontName: { family: 'PingFang SC', style: 'Regular' }, fontSize: 12, lineHeight: { unit: 'PIXELS', value: 18 }, fills: [] }],
  { style: { fontFamily: 'SF Pro', fontPostScriptName: 'SFPro-Regular', fontStyle: 'Regular', fontSize: 15, lineHeightPx: 17.900390625 }, characterStyleOverrides: [1, 1, 1, 2, 2],
    styleOverrideTable: { 1: { fontFamily: 'SF Pro Text', fontPostScriptName: 'SFProText-Bold', fontStyle: 'Bold', fontWeight: 700, fontSize: 14 },
      2: { fontFamily: 'PingFang SC', fontPostScriptName: 'PingFangSC-Regular', fontStyle: 'Regular', fontWeight: 400, fontSize: 12 } } });
  const row = kids(node('2:8', 'FRAME', '\u884c', 0, 30, 60, 20, { layoutMode: 'HORIZONTAL', itemSpacing: 4, paddingLeft: 2, strokes: [SOLID(0, 0, 0)],
    strokeWeight: MIXED, strokeTopWeight: 1, strokeRightWeight: 0, strokeBottomWeight: 1, strokeLeftWeight: 0, strokeAlign: 'INSIDE' }),
  [label, vector('2:10', '\u7bad\u5934', 45, 30, { layoutSizingHorizontal: 'FIXED', shapeKey: 'chevron' })]);
  // Unoverridden characters use node values. Overrides changing style and weight without a PostScript name cannot resolve line height or font name.
  const footer = text('2:15', '\u9875\u811a', 0, 110, 120, 20, 'AB', [
    { characters: 'A', start: 0, end: 1, fontName: { family: 'Kanit', style: 'Light' }, fontSize: 13, lineHeight: { unit: 'AUTO' }, fills: [SOLID(0.45, 0.45, 0.45)] },
    { characters: 'B', start: 1, end: 2, fontName: { family: 'Kanit', style: 'Regular' }, fontSize: 13, lineHeight: { unit: 'AUTO' }, fills: [SOLID(0.05, 0.76, 0.76)] }],
  { style: { fontFamily: 'Kanit', fontPostScriptName: 'Kanit-Light', fontStyle: 'Light', fontSize: 13, lineHeightPx: 19.434999465942383 }, characterStyleOverrides: [0, 3],
    styleOverrideTable: { 3: { fontStyle: 'Regular', fontWeight: 400 } } });

  // -- Row 3: backdrop-dependent subtree (islandRule 2) and fully clipped vector --
  const glass = kids(node('3:1', 'GROUP', '\u73bb\u7483\u6309\u94ae', 0, 60, 20, 20, { effects: [GLASS] }), [vector('3:2', '\u8fd4\u56de\u7bad\u5934', 5, 65)]);
  const blends = kids(node('3:3', 'GROUP', '\u6df7\u5408\u56fe\u6807', 30, 60, 50, 10), [
    vector('3:4', '\u8282\u70b9\u6df7\u5408', 30, 60, { blendMode: 'LINEAR_BURN' }),
    vector('3:5', '\u586b\u5145\u6df7\u5408', 42, 60, { fills: [SOLID(0, 0, 0, { blendMode: 'MULTIPLY' })] }),
    vector('3:6', '\u6548\u679c\u6df7\u5408', 54, 60, { effects: [BURN_SHADOW] }),
    vector('3:7', '\u666e\u901a', 66, 60)]);
  const blur = kids(node('3:8', 'FRAME', '\u80cc\u666f\u6a21\u7cca', 90, 60, 30, 20, { effects: [PROGRESSIVE_BLUR] }), [vector('3:9', '\u6a21\u7cca\u4e0b\u7684\u56fe\u6807', 95, 65)]);
  const clipped = vector('3:10', '\u88c1\u5207', 170, 5, { absoluteRenderBounds: null });

  kids(frame, [flipped, maskGroup, icon, iconCopy, instance, hidden, row, footer, glass, blends, blur, clipped]);
  const bytes = encodePng(1, 1, new Uint8Array([0, 0, 0, 255]));
  const globals = { mixed: MIXED, skipInvisibleInstanceChildren: false, root: { type: 'DOCUMENT', documentColorProfile: 'SRGB' },
    getImageByHash: hash => ['h1', 'h2'].includes(hash) ? { getBytesAsync: async () => { exports.push({ image: hash }); return bytes; }, getSizeAsync: async () => ({ width: 1, height: 1 }) } : null };
  return { page, frame, all, exports, globals, emit: () => { for (const fn of listeners) fn({ nodeChanges: [] }); }, listeners };
}
