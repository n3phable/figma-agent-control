/**
 * [INPUT]: src/png encodePng.
 * [OUTPUT]: Exports extractDoc() with page, frame, all, exports, globals, emit, and listeners; MIXED; and the 2x3 matrix constructor T.
 * [POS]: Mock Plugin API document shared by extract and generator tests; run/preview use harness createDoc instead. Page 1:1 contains independent 160x160 frames 1:2 and 1:3 at (100,200). Real VM extraction of 1:2 anchors the extract contract, while generator tests extract both frames so contract drift fails both layers. Frame 1:3 covers nested masks, rotated islands, gradient/image modes, and typography without changing frame 1:2 expectations. globals supplements fakeFigma; exports records export arguments and emit sends nodechange.
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
const STOPS = [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }];
const GRADIENT = (type, m) => ({ type, visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: m, gradientStops: STOPS });
// Figma-exported SVG gradients start their defs IDs at paint0 in each file; inlining two on one page requires renaming.
const ISLAND_SVG = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 H 10 V 10 H 0 Z" fill="url(#paint0)"/>'
  + '<defs><linearGradient id="paint0" x1="0" y1="0" x2="10" y2="10" gradientUnits="userSpaceOnUse"><stop stop-color="#FF0000"/><stop offset="1" stop-color="#0000FF"/></linearGradient></defs></svg>';

export function extractDoc() {
  const all = new Map(), exports = [], listeners = new Set();
  const encoder = new TextEncoder();
  // Place nodes at frame coordinates (x, y); absoluteRenderBounds defaults to the transformed box, and null means no drawing.
  const node = (id, type, name, x, y, w, h, extra = {}) => {
    const n = { id, type, name, removed: false, visible: true, width: w, height: h, absoluteTransform: T(100 + x, 200 + y),
      absoluteRenderBounds: { x: 100 + x, y: 200 + y, width: w, height: h }, opacity: 1, blendMode: 'PASS_THROUGH', fills: [], strokes: [], effects: [], ...extra };
    n.exportAsync = async options => {
      exports.push({ id, ...options });
      if (options.format === 'SVG_STRING') return n.svg ?? `<svg data-shape="${n.shapeKey ?? id}"/>`;
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

  // -- Frame 1:3: generator features -----------------------------------------
  // Rotation matrix at frame coordinates (x, y) by deg; (lx, ly) offsets within the rotated local system. absoluteRenderBounds is the enclosing rectangle.
  const turned = (x, y, deg, w, h, lx = 0, ly = 0) => {
    const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), ox = 100 + x + c * lx - s * ly, oy = 200 + y + s * lx + c * ly;
    const xs = [0, c * w, -s * h, c * w - s * h], ys = [0, s * w, c * h, s * w + c * h];
    return { absoluteTransform: T(ox, oy, c, s, -s, c),
      absoluteRenderBounds: { x: ox + Math.min(...xs), y: oy + Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
  };
  const SHADOW = { type: 'DROP_SHADOW', visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, spread: 2, blendMode: 'NORMAL', showShadowBehindNode: false };
  const segment = (characters, family, style, fontSize, lineHeight, fills, extra = {}) => ({ characters, start: 0, end: characters.length, fontName: { family, style }, fontSize,
    lineHeight, letterSpacing: { unit: 'PIXELS', value: 0 }, textDecoration: 'NONE', textCase: 'ORIGINAL', fills, ...extra });
  const gen = node('1:3', 'FRAME', '\u751f\u6210\u5668\u753b\u677f', 0, 0, 160, 160, { clipsContent: true, fills: [SOLID(0.98, 0.98, 0.99)] });
  // Row 1: sibling translucent-circle and rounded-rectangle masks clip a rotated block; a rounded clipping frame has overflowing children; a translucent group rotated 30 degrees contains a photo and island.
  const masks = kids(node('4:1', 'GROUP', '\u53cc\u8499\u7248', 0, 0, 40, 40), [
    node('4:2', 'ELLIPSE', '\u5706\u5f62\u8499\u7248', 0, 0, 40, 40, { isMask: true, maskType: 'ALPHA', absoluteRenderBounds: null, fills: [SOLID(0, 0, 0, { opacity: 0.5 })] }),
    node('4:3', 'RECTANGLE', '\u5706\u89d2\u8499\u7248', 5, 5, 30, 30, { isMask: true, maskType: 'VECTOR', absoluteRenderBounds: null, cornerRadius: 4, fills: [SOLID(0, 0, 0)] }),
    node('4:4', 'RECTANGLE', '\u65cb\u8f6c\u5757', 20, 4, 20, 20, { ...turned(20, 4, 45, 20, 20), fills: [SOLID(0, 0, 1)] })]);
  const clip = kids(node('4:5', 'FRAME', '\u5706\u89d2\u88c1\u5207', 45, 0, 40, 40, { clipsContent: true, cornerRadius: 8, fills: [SOLID(0.9, 0.9, 0.9)] }), [
    node('4:6', 'RECTANGLE', '\u6ea2\u51fa', 65, 20, 30, 30, { fills: [SOLID(1, 0, 0)], strokes: [SOLID(0, 0, 0)], strokeWeight: 2, strokeAlign: 'CENTER' })]);
  const rotated = kids(node('4:7', 'GROUP', '\u65cb\u8f6c\u7ec4', 100, 2, 40, 30, { ...turned(100, 2, 30, 40, 30), opacity: 0.5, blendMode: 'NORMAL' }), [
    node('4:8', 'RECTANGLE', '\u7ec4\u5185\u7167\u7247', 100, 2, 20, 20, { ...turned(100, 2, 30, 20, 20), fills: [IMAGE('h1')] }),
    vector('4:9', '\u7ec4\u5185\u56fe\u6807', 100, 2, turned(100, 2, 30, 10, 10, 25, 10))]);
  // Row 2: blended LINE (not an island; fills and empty paths draw nothing); two islands sharing one SVG; diagonal gradient; radial gradient inside a dashed frame (nested BAKE).
  const line = node('4:10', 'LINE', '\u5206\u9694\u7ebf', 0, 45, 40, 0, { blendMode: 'MULTIPLY', absoluteRenderBounds: { x: 100, y: 244.5, width: 40, height: 1 }, fills: [SOLID(1, 0, 0)],
    strokes: [SOLID(0, 0, 0)], strokeWeight: 1, strokeAlign: 'CENTER', fillGeometry: [{ windingRule: 'NONZERO', data: '' }],
    strokeGeometry: [{ windingRule: 'NONZERO', data: 'M 0 -0.5 L 40 -0.5 L 40 0.5 L 0 0.5 Z' }] });
  const twins = [vector('4:11', '\u540c\u540d\u5b64\u5c9b\u7532', 45, 45, { svg: ISLAND_SVG }), vector('4:12', '\u540c\u540d\u5b64\u5c9b\u4e59', 60, 45, { svg: ISLAND_SVG })];
  const diagonal = node('4:13', 'RECTANGLE', '\u5bf9\u89d2\u6e10\u53d8', 75, 45, 40, 20, { fills: [GRADIENT('GRADIENT_LINEAR', [[0.5, 0.5, 0], [-0.5, 0.5, 0.5]])] });
  const dashed = kids(node('4:15', 'FRAME', '\u865a\u7ebf\u6846', 120, 45, 30, 30, { strokes: [SOLID(0, 0, 0)], strokeWeight: 1, strokeAlign: 'INSIDE', dashPattern: [2, 2] }), [
    node('4:14', 'RECTANGLE', '\u5f84\u5411\u6e10\u53d8', 125, 50, 20, 20, { fills: [GRADIENT('GRADIENT_RADIAL', [[1, 0, 0], [0, 1, 0]])] })]);
  // Row 3: image-filled half-circle arc (not an island); FILL, FIT, CROP, TILE; one translucent image.
  const arc = node('4:16', 'ELLIPSE', '\u534a\u5706', 0, 60, 20, 20, { arcData: { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 }, fills: [IMAGE('h1')] });
  const photos = [['4:17', '\u586b\u5145\u56fe', { scaleMode: 'FILL' }], ['4:18', '\u9002\u5e94\u56fe', { scaleMode: 'FIT' }], ['4:19', '\u88c1\u526a\u56fe', { scaleMode: 'CROP', imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]] }],
    ['4:20', '\u5e73\u94fa\u56fe', { scaleMode: 'TILE', scalingFactor: 2 }]].map(([id, name, mode], i) => node(id, 'RECTANGLE', name, 25 + 25 * i, 60, 20, 20, { fills: [{ ...IMAGE('h3'), ...mode }] }));
  const faded = node('4:21', 'RECTANGLE', '\u534a\u900f\u660e\u56fe', 125, 60, 20, 20, { fills: [{ ...IMAGE('h1'), opacity: 0.5 }] });
  // Row 4: solid + gradient + translucent image; GLASS radius 6; spread shadow with OUTSIDE stroke; a group containing a LUMINANCE mask.
  const layered = node('4:22', 'RECTANGLE', '\u591a\u91cd\u586b\u5145', 0, 85, 30, 20, { fills: [SOLID(1, 1, 1), GRADIENT('GRADIENT_LINEAR', [[1, 0, 0], [0, 1, 0]]), { ...IMAGE('h3'), opacity: 0.5 }] });
  const pane = node('4:23', 'RECTANGLE', '\u73bb\u7483', 35, 85, 30, 20, { cornerRadius: 10, fills: [SOLID(1, 1, 1, { opacity: 0.2 })], effects: [{ ...GLASS, radius: 6 }] });
  const card = node('4:24', 'RECTANGLE', '\u6295\u5f71', 70, 85, 20, 20, { fills: [SOLID(1, 1, 1)], effects: [SHADOW], strokes: [SOLID(0, 0, 0)], strokeWeight: 1, strokeAlign: 'OUTSIDE' });
  const luminance = kids(node('4:28', 'GROUP', '\u4eae\u5ea6\u8499\u7248\u7ec4', 95, 85, 20, 20), [
    node('4:29', 'RECTANGLE', '\u4eae\u5ea6\u8499\u7248', 95, 85, 20, 20, { isMask: true, maskType: 'LUMINANCE', absoluteRenderBounds: null, fills: [GRADIENT('GRADIENT_LINEAR', [[1, 0, 0], [0, 1, 0]])] }),
    node('4:30', 'RECTANGLE', '\u88ab\u4eae\u5ea6\u88c1\u5207', 95, 85, 20, 20, { fills: [SOLID(0, 0.5, 0)] })]);
  // Text: apostrophe in family name; quote, <, and & in node name; uppercase, ligatures, percentage spacing, no wrapping, single-line AUTO without metrics; multiline AUTO without metrics and two-line truncation;
  // centered Kanit Light 14/18 gradient text with a PostScript name from REST.
  const upper = text('4:25', '\u540d"<&', 0, 112, 40, 12, 'Upper', [segment('Upper', "O'Font", 'Medium', 10, { unit: 'AUTO' }, [SOLID(0, 0, 0)],
    { fontWeight: 500, letterSpacing: { unit: 'PERCENT', value: 5 }, textCase: 'UPPER', openTypeFeatures: { LIGA: false } })], undefined, { textAutoResize: 'WIDTH_AND_HEIGHT' });
  const clamp = text('4:26', '\u622a\u65ad', 45, 110, 50, 30, 'line1\nline2', [segment('line1\nline2', 'Missing Sans', 'Regular', 10, { unit: 'AUTO' }, [SOLID(0, 0, 0)])], undefined,
    { textTruncation: 'ENDING', maxLines: 2 });
  const shiny = text('4:27', '\u6e10\u53d8\u5b57', 100, 110, 60, 30, 'Kanit', [segment('Kanit', 'Kanit', 'Light', 14, { unit: 'PIXELS', value: 18 }, [GRADIENT('GRADIENT_LINEAR', [[1, 0, 0], [0, 1, 0]])],
    { fontWeight: 300 })], { style: { fontFamily: 'Kanit', fontPostScriptName: 'Kanit-Light', fontStyle: 'Light', fontSize: 14 } }, { textAlignHorizontal: 'CENTER', textAlignVertical: 'CENTER' });
  kids(gen, [masks, clip, rotated, line, ...twins, diagonal, dashed, arc, ...photos, faded, layered, pane, card, luminance, upper, clamp, shiny]);
  kids(page, [frame, gen]);

  const bytes = encodePng(1, 1, new Uint8Array([0, 0, 0, 255]));
  const quad = encodePng(2, 2, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
  const images = { h1: [bytes, 1], h2: [bytes, 1], h3: [quad, 2] };
  const globals = { mixed: MIXED, skipInvisibleInstanceChildren: false, root: { type: 'DOCUMENT', documentColorProfile: 'SRGB' },
    getImageByHash: hash => images[hash] ? { getBytesAsync: async () => { exports.push({ image: hash }); return images[hash][0]; }, getSizeAsync: async () => ({ width: images[hash][1], height: images[hash][1] }) } : null };
  return { page, frame, all, exports, globals, emit: () => { for (const fn of listeners) fn({ nodeChanges: [] }); }, listeners };
}
