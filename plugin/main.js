/**
 * [INPUT]: Figma Plugin API, bridge configuration and the sandbox/iframe message channel.
 * [OUTPUT]: Plugin task handling and serialized results.
 * [POS]: Figma sandbox executor for bound reads and trusted writes, with approval, checkpoints and Undo boundaries.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
/** @import { Bounds, ExtractImage, ExtractNode, ExtractRequest, ExtractStats, PluginExtractOutput, TextSegment } from '../src/html/extract-contract.js' */
// ui.html relays bridge-built jobs; /poll adds binding and the iframe adds channelNonce. Declare only fields read by the plugin.
/** @typedef {{ id: string, operation: string, channelNonce: string, binding: { fileKey: string, nodeId: string }, targetNodeId?: string, nodes?: string[],
 *   snapshotDepth?: number, scale?: number, islands?: string[], expect?: string, code: string, libs?: { name: string, code: string }[], data?: unknown,
 *   risk?: { level: string, reason?: string }, scriptHash?: string, cleanOnFail?: boolean }} Job */
/** @typedef {(message: Record<string, unknown>) => void} Send */
/** @typedef {{ id: string, channelNonce: string, finish(message: { ok?: unknown, approved?: unknown }): void }} Waiter */
figma.showUI(__html__, { width: 320, height: 200, themeColors: true });
let busy = false;
/** @type {Waiter | null} */
let checkpointWaiter = null;
/** @type {Waiter | null} */
let approvalWaiter = null;
// Web components often have nested wrappers; cover typical component trees without increasing the total node budget.
const SNAPSHOT_DEPTH = 32, NODE_BUDGET = 2000;
// Combined image/binary return limit, measured as base64.
const BINARY_LIMIT = 48 * 1024 * 1024;
const BINARY_KEY = '__figmaAgentControlBinary';

// -- Approval round trips -----------------------------------------------
// Called only when job.risk.level is high, so risk is present.
/** @param {Job & { risk: NonNullable<Job['risk']> }} job @param {Send} send @returns {Promise<void>} */
function requestApproval(job, send) {
  // Approval must become visible even when the panel is hidden; failure to show it keeps execution denied.
  figma.ui.show();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { approvalWaiter = null; reject(Error('High-risk approval timed out; the script did not run')); }, 300000);
    approvalWaiter = { id: job.id, channelNonce: job.channelNonce, finish(message) {
      clearTimeout(timer); approvalWaiter = null;
      if (message.approved === true) resolve();
      else reject(Error('High-risk operation was not approved; the script did not run'));
    } };
    const source = (job.libs || []).map(lib => `// lib: ${lib.name}\n${lib.code}`).concat(job.code).join('\n\n');
    send({ type: 'approval-request', id: job.id, reason: job.risk.reason, scriptHash: job.scriptHash, code: source,
      binding: { ...job.binding, nodeId: job.targetNodeId ?? job.binding.nodeId } });
  });
}
/** @param {Job} job @param {Snapshot} before @param {PageNode} page @param {Send} send @returns {Promise<void>} */
function saveCheckpoint(job, before, page, send) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { checkpointWaiter = null; reject(Error('Before-snapshot confirmation timed out; the script did not run')); }, 10000);
    checkpointWaiter = { id: job.id, channelNonce: job.channelNonce, finish(message) {
      clearTimeout(timer); checkpointWaiter = null;
      if (message.ok === true) resolve();
      else reject(Error('Failed to save the before-snapshot; the script did not run'));
    } };
    send({ type: 'checkpoint', id: job.id, before, bindingVerified: { fileKey: figma.fileKey, pageId: page.id, nodeId: before.id } });
  });
}

// -- Snapshots ----------------------------------------------------------
/** @typedef {{ id: string, name: string, type: string, truncated?: true, children?: Snapshot[], [key: string]: unknown }} Snapshot */
// JSON deep copy with figma.mixed encoded as 'MIXED'. Return type follows input; undefined is forbidden because it is not JSON and copy throws. This catches missing properties such as GROUP fillGeometry during type checking.
/** @template {{} | null} T @param {T} value @returns {T extends symbol ? 'MIXED' : T} */
const copy = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'symbol' ? 'MIXED' : item));
const KEYS = [
  'visible', 'locked', 'isMask', 'maskType', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'relativeTransform', 'absoluteBoundingBox',
  'layoutMode', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'layoutSizingHorizontal', 'layoutSizingVertical',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutAlign', 'layoutGrow', 'layoutPositioning', 'layoutWrap',
  'itemSpacing', 'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'constraints', 'clipsContent',
  'overflowDirection', 'numberOfFixedChildren', 'scrollBehavior', 'reactions', 'flowStartingPoints',
  'textAutoResize', 'textTruncation', 'maxLines', 'characters', 'fontSize', 'fontName', 'lineHeight', 'letterSpacing',
  'textAlignHorizontal', 'textAlignVertical', 'paragraphIndent', 'paragraphSpacing', 'hasMissingFont',
  'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'effects', 'cornerRadius',
  'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'cornerSmoothing',
  'textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'boundVariables', 'explicitVariableModes'
];
// Key tables span node types; callers first check key in node. Subsequent use constrains each value's shape, so the dynamic reader returns any.
/** @param {object} node @param {string} key @returns {any} */
const prop = (node, key) => /** @type {Record<string, unknown>} */ (node)[key];
/** @param {BaseNode} node @param {number} maxDepth @returns {Snapshot} */
function tree(node, maxDepth, depth = 0, budget = { count: 0 }) {
  if (++budget.count > NODE_BUDGET) throw Error(`Target exceeds the ${NODE_BUDGET}-node budget; narrow the target with --node, or add --depth for read-only jobs`);
  /** @type {Snapshot} */
  const value = { id: node.id, name: node.name, type: node.type };
  for (const key of KEYS) if (key in node && prop(node, key) !== undefined) value[key] = copy(prop(node, key));
  if ('children' in node) {
    if (depth >= maxDepth && node.children.length) value.truncated = true;
    else value.children = node.children.map(child => tree(child, maxDepth, depth + 1, budget));
  }
  return value;
}
/** @param {Snapshot} node @returns {boolean} */
const isTruncated = node => node.truncated === true || (node.children || []).some(isTruncated);
// Visibility chain above the target through its page: masks, visibility, opacity and fills explain whether writes can appear on screen (inspect only).
/** @param {BaseNode} node */
function ancestry(node) {
  const chain = [];
  for (let current = node.parent; current && !['PAGE', 'DOCUMENT'].includes(current.type) && chain.length < 20; current = current.parent) {
    /** @type {Record<string, unknown>} */
    const entry = { id: current.id, name: current.name, type: current.type };
    for (const key of ['visible', 'opacity', 'isMask', 'maskType', 'clipsContent', 'fills', 'fillStyleId']) if (key in current && prop(current, key) !== undefined) entry[key] = copy(prop(current, key));
    chain.unshift(entry);
  }
  return chain;
}
/** @param {BaseNode | null} node @param {string} rootId */
function within(node, rootId) {
  for (let current = node; current; current = current.parent) if (current.id === rootId) return true;
  return false;
}
/** @param {BaseNode | null} node @returns {PageNode | null} */
function pageOf(node) {
  while (node && node.type !== 'PAGE') node = node.parent;
  return node;
}

// -- Return values ------------------------------------------------------
// Return byte arrays separately for file persistence, leaving JSON placeholders. Plain integer arrays count as images only when they encode complete PNG/JPEG data,
// supporting Array.from(await node.exportAsync()).
const PNG_HEAD = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82], PNG_TAIL = [73, 69, 78, 68, 174, 66, 96, 130];
/** @param {number[]} a */
function wholeImage(a) {
  if (a.length >= 57 && PNG_HEAD.every((v, i) => a[i] === v) && PNG_TAIL.every((v, i) => a[a.length - 8 + i] === v)) return true;
  return a.length >= 128 && a[0] === 255 && a[1] === 216 && a[2] === 255 && (a[3] >= 0xE0 && a[3] <= 0xEF || [0xDB, 0xC0, 0xC4, 0xFE].includes(a[3])) && a[a.length - 2] === 255 && a[a.length - 1] === 217;
}
/** @param {unknown} output @param {{ size: number }} budget */
function serializeOutput(output, budget) {
  /** @type {string[]} */
  const binaries = [];
  // Read the original value: byte views with toJSON, such as Buffer, are converted before the replacer runs.
  const text = JSON.stringify(output, function (key, value) {
    if (typeof value === 'symbol') return 'MIXED';
    const original = this[key];
    if (original && typeof original === 'object' && !ArrayBuffer.isView(original) && Object.prototype.hasOwnProperty.call(original, BINARY_KEY)) throw Error(`Return value contains the reserved key ${BINARY_KEY}; the script ran, check the document, do not replay the script`);
    const encodedImage = Array.isArray(original) && wholeImage(original) && original.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
    if (!ArrayBuffer.isView(original) && !encodedImage) return value;
    // Here original is either an integer array recognized by encodedImage or a byte view.
    const view = /** @type {ArrayBufferView} */ (original);
    const bytes = encodedImage ? Uint8Array.from(original) : original instanceof Uint8Array ? original : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const encoded = figma.base64Encode(bytes);
    if (binaries.length >= 200 || (budget.size += encoded.length) > BINARY_LIMIT) throw Error('Binary return values exceed 200 items or 48 MB; the script ran, check the document, do not replay the script');
    binaries.push(encoded);
    return { [BINARY_KEY]: binaries.length - 1 };
  });
  return { output: text === undefined ? null : JSON.parse(text), binaries };
}
/** @param {ExportMixin} node @param {number | undefined} scale @param {{ size: number }} budget */
async function render(node, scale, budget) {
  const encoded = figma.base64Encode(await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale ?? 1 } }));
  if ((budget.size += encoded.length) > BINARY_LIMIT) throw Error('Exported images exceed 48 MB in total; lower --scale or export in batches');
  return encoded;
}

// -- Local variables ----------------------------------------------------
// Read-only collections, alias-resolved default-mode values, and binding counts within the target subtree.
// Variable aliases { type: 'VARIABLE_ALIAS', id } can occur in variable values and node boundVariables.
/** @param {unknown} value @returns {value is VariableAlias} */
const isAlias = value => !!value && typeof value === 'object' && prop(value, 'type') === 'VARIABLE_ALIAS' && typeof prop(value, 'id') === 'string';
/** @param {BaseNode} target */
async function localVariables(target) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync(), variables = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(variables.map(v => [v.id, v])), byCollection = new Map(collections.map(c => [c.id, c])), counts = /** @type {Map<string, number>} */ (new Map());
  let scanned = 0, truncated = false;
  /** @param {unknown} value */
  const count = value => {
    if (!value || typeof value !== 'object') return;
    if (isAlias(value)) { counts.set(value.id, (counts.get(value.id) || 0) + 1); return; }
    for (const item of Object.values(value)) count(item);
  };
  /** @param {BaseNode} node */
  const visit = node => {
    if (truncated || ++scanned > 50000) { truncated = true; return; }
    count('boundVariables' in node ? node.boundVariables : undefined);
    for (const child of ('children' in node && node.children) || []) visit(child);
  };
  visit(target);
  /** @param {Variable} v */
  const defaultValue = v => v.valuesByMode[byCollection.get(v.variableCollectionId)?.defaultModeId ?? Object.keys(v.valuesByMode)[0]];
  /** @param {Variable} variable @returns {VariableValue | undefined} */
  const resolve = (variable, depth = 0) => {
    const raw = defaultValue(variable);
    return isAlias(raw) && depth < 10 && byId.has(raw.id) ? resolve(/** @type {Variable} */ (byId.get(raw.id)), depth + 1) : raw;
  };
  // Color variables may be RGB, RGBA, aliases or composite colors. Convert only objects with numeric r to hex; otherwise interpret as arbitrary JSON.
  /** @param {any} value */
  const hex = value => value && typeof value.r === 'number' ? '#' + [value.r, value.g, value.b, value.a ?? 1].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase() : undefined;
  return {
    collections: collections.map(c => ({ id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId })),
    variables: variables.map(v => {
      const raw = defaultValue(v), value = resolve(v);
      return { id: v.id, name: v.name, collectionId: v.variableCollectionId, collection: byCollection.get(v.variableCollectionId)?.name ?? null, type: v.resolvedType,
        value: value ?? null, ...(v.resolvedType === 'COLOR' && hex(value) ? { hex: hex(value) } : {}), ...(isAlias(raw) ? { aliasOf: raw.id } : {}),
        scopes: v.scopes, bindings: counts.get(v.id) || 0 };
    }),
    bindingScope: { nodeId: target.id, scannedNodes: Math.min(scanned, 50000), truncated },
    limitation: 'Lists local variables only, with default-mode values (following aliases up to 10 levels); bindings counts only boundVariables on nodes in the target subtree'
  };
}

// -- Extraction ---------------------------------------------------------
// Built-in read-only extraction executes no user script. Serialize the target subtree in target coordinates, preserving layers, masks, clipping, visible paints and effects;
// deep copies retain boundVariables inside paints and effects. The host decides approximation and baking. Reference images, original bitmap bytes and explicit islands use the binary channel;
// automatic island SVG strings deduplicate by content. Only read/export APIs are called; finally restores the sole modified plugin state, skipInvisibleInstanceChildren.
// Traverse SLOT as a container like FRAME, without special handling.
const EXTRACT_NODES = 10000, EXTRACT_BYTES = 12e6, ISLAND_RULE = 2;
const SHAPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE']);
// Emit only non-default keys, except renderBounds. Strokes, corner radii, per-side strokes and auto layout are conditionally emitted as groups.
// Constant key tables use contract field names, checked by ExtractNode when assigned; segment fields are checked against Plugin API StyledTextSegment.
const DEFAULTS = /** @type {Record<string, unknown>} */ ({ opacity: 1, blendMode: 'PASS_THROUGH', isMask: false, clipsContent: false, cornerRadius: 0, cornerSmoothing: 0, layoutMode: 'NONE' });
const NODE_KEYS = /** @type {const} */ (['opacity', 'blendMode', 'isMask', 'clipsContent', 'fills', 'effects', 'cornerRadius', 'cornerSmoothing', 'booleanOperation', 'arcData', 'layoutMode']);
const STROKE_KEYS = /** @type {const} */ (['strokes', 'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern']);
const SIDES = /** @type {const} */ (['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight']);
const CORNERS = /** @type {const} */ (['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius']);
const LAYOUT_KEYS = /** @type {const} */ (['layoutWrap', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'itemSpacing', 'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemReverseZIndex', 'strokesIncludedInLayout']);
const CHILD_LAYOUT_KEYS = /** @type {const} */ (['layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutGrow', 'layoutAlign']);
const TEXT_KEYS = /** @type {const} */ (['characters', 'textAutoResize', 'textAlignHorizontal', 'textAlignVertical', 'textTruncation', 'maxLines', 'leadingTrim', 'hasMissingFont']);
/** @typedef {Exclude<keyof StyledTextSegment, 'characters' | 'start' | 'end'>} SegmentField */
/** @type {SegmentField[]} */
const SEGMENT_FIELDS = ['fontName', 'fontSize', 'fontWeight', 'fontStyle', 'fills', 'textDecoration', 'textDecorationStyle', 'textDecorationOffset', 'textDecorationThickness',
  'textDecorationColor', 'textDecorationSkipInk', 'textCase', 'lineHeight', 'letterSpacing', 'openTypeFeatures', 'listOptions', 'indentation', 'listSpacing', 'paragraphIndent', 'paragraphSpacing'];
/** @type {SegmentField[]} */
const BASE_SEGMENT_FIELDS = ['fontName', 'fontSize', 'fills', 'textDecoration', 'textCase', 'lineHeight', 'letterSpacing'];
/** @param {unknown} value */
const visible = value => Array.isArray(value) ? value.filter(item => item?.visible !== false) : value;
// Key-based reads have shapes determined by the key. Assigning o[key] in a table loop requires the intersection of field types, so any is necessary; key names are contract-checked, but dynamically read values are not.
/** @param {object} node @param {string} key @returns {any} */
const read = (node, key) => visible(copy(prop(node, key)));
/** @param {Transform} m @param {Transform} n @returns {Transform} */
const mul = (m, n) => /** @type {Transform} */ ([0, 1].map(r => [m[r][0] * n[0][0] + m[r][1] * n[1][0], m[r][0] * n[0][1] + m[r][1] * n[1][1], m[r][0] * n[0][2] + m[r][1] * n[1][2] + m[r][2]]));
/** @param {Transform} m @param {Rect} r @returns {Bounds} */
function box(m, r) {
  const p = [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]].map(([x, y]) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]]);
  const xs = p.map(q => q[0]), ys = p.map(q => q[1]), x = Math.min(...xs), y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}
// Painted ink bounds. SECTION and FigJam/Slides-only nodes lack absoluteRenderBounds in plugin typings; treat them like undefined, with no painted area.
/** @param {SceneNode | undefined} n */
const renderBounds = n => n && 'absoluteRenderBounds' in n ? n.absoluteRenderBounds : null;
/** @param {ArcData} arc */
const partialArc = arc => !!arc && (arc.innerRadius > 0 || Math.abs(arc.endingAngle - arc.startingAngle - 2 * Math.PI) > 1e-3);
/** @param {ExtractNode} o */
const imagePaints = o => /** @type {Paint[]} */ ([]).concat(Array.isArray(o.fills) ? o.fills : [], o.strokes || [])
  .filter(/** @returns {p is ImagePaint & { imageHash: string }} */ p => p.type === 'IMAGE' && !!p.imageHash);
// Backdrop dependencies include GLASS, background blur and blend modes other than PASS_THROUGH/NORMAL on nodes, paints or effects. SVG omits the backdrop, so baking such subtrees silently loses the effect.
const PLAIN_BLENDS = new Set([undefined, 'PASS_THROUGH', 'NORMAL']);
// Blur, GLASS and similar effects lack blendMode; treat them as normal blending.
/** @param {ExtractNode} o */
const backdrop = o => !PLAIN_BLENDS.has(o.blendMode) || [o.fills, o.strokes, o.effects].some(list => Array.isArray(list)
  && list.some(p => p.type === 'GLASS' || p.type === 'BACKGROUND_BLUR' || ('blendMode' in p && !PLAIN_BLENDS.has(p.blendMode))));
// UTF-8 upper bound: count every non-ASCII code unit as 3 bytes (surrogate pairs count as 6 rather than 4), matching ui.html's 16 MB fallback unit.
/** @param {string} text */
function utf8Upper(text) {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) bytes += 2;
  return bytes;
}
// Plugin API omits AUTO line-height pixels and PostScript names; read segment REST fields from JSON_REST_V1's per-character overrides
// (characterStyleOverrides -> styleOverrideTable). Override arrays count code points, while segment start/end use UTF-16 code units; convert first.
// Observed example: two U+1F600 emoji followed by AB produce four override entries, with B at index 3. Entries contain only explicitly set keys, even if equal to the base style; observed entries omit lineHeightPx.
// Use an entry's key when present. If related keys exist without the requested key, its value is unavailable; otherwise use node style (no override or changes only to color/font size). Return undefined for inconsistent or unavailable segment values.
const METRIC = /^(font|lineHeight|italic|semantic)/, FACE = /^(font(Family|Style|Weight|PostScriptName)|italic|semantic)/;
// JSON_REST_V1 text nodes have REST API shape, but Plugin API types them only as Object. Declare only fields read here.
/** @typedef {{ fontFamily?: string, fontStyle?: string, fontSize?: number, fontPostScriptName?: string | null, lineHeightPx?: number, [key: string]: unknown }} RestStyle */
/** @typedef {{ id: string, type: string, style?: RestStyle, characterStyleOverrides?: number[], styleOverrideTable?: Record<string, RestStyle>, children?: RestNode[] }} RestNode */
// Override entry for code point i: index 0 or beyond the array uses base style ({}); IDs absent from the table return undefined.
/** @param {RestNode} rest @param {number} i @returns {RestStyle | undefined} */
const entryAt = (rest, i) => { const id = rest.characterStyleOverrides?.[i] ?? 0; return id ? rest.styleOverrideTable?.[id] : {}; };
/** @overload @param {RestNode} rest @param {number} from @param {number} to @param {'lineHeightPx'} key @param {RegExp} related @returns {number | undefined} */
/** @overload @param {RestNode} rest @param {number} from @param {number} to @param {'fontPostScriptName'} key @param {RegExp} related @returns {string | undefined} */
/** @param {RestNode} rest @param {number} from @param {number} to @param {'lineHeightPx' | 'fontPostScriptName'} key @param {RegExp} related */
function restValue(rest, from, to, key, related) {
  let value;
  for (let i = from; i < to; i++) {
    const entry = entryAt(rest, i), v = entry && (entry[key] ?? (Object.keys(entry).some(k => related.test(k)) ? undefined : rest.style?.[key]));
    if (v == null || (value !== undefined && v !== value)) return undefined;
    value = v;
  }
  return value;
}
// Alignment checks: code-point mapping was verified only on basic emoji; counting of skin-tone sequences, flags and ZWJ grapheme clusters is unknown. Compare each effective REST family, style and size
// with the segment's Plugin API values. If any differ, discard all REST values for that segment: missing data is safer than an incorrect PostScript name, which font diagnostics cannot detect.
/** @param {RestNode} rest @param {number} from @param {number} to @param {TextSegment} segment */
function aligned(rest, from, to, segment) {
  for (let i = from; i < to; i++) {
    // get is called only when entry exists, via the short-circuit expression below.
    const entry = entryAt(rest, i), get = (/** @type {string} */ key) => entry?.[key] ?? rest.style?.[key];
    if (!entry || get('fontFamily') !== segment.fontName?.family || get('fontStyle') !== segment.fontName?.style || get('fontSize') !== segment.fontSize) return false;
  }
  return true;
}
// at[i] gives the code-point index containing UTF-16 unit i (both surrogate units share an index); at[length] is total code points.
/** @param {string} text */
function codePointIndex(text) {
  /** @type {number[]} */
  const at = [];
  let n = 0;
  for (const ch of text) { at.push(n); if (ch.length > 1) at.push(n); n++; }
  return at.concat(n);
}
// Line height: PIXELS uses its value; PERCENT is inferred to use font-size percentage. Neither needs REST. AUTO uses node style.lineHeightPx only when segment/override alignment succeeds and no character overrides affect metrics; undefined rest means unavailable.
/** @param {TextSegment} segment @param {RestNode | undefined} rest @param {number} from @param {number} to */
function segmentLineHeight(segment, rest, from, to) {
  const lh = segment.lineHeight;
  if (lh?.unit === 'PIXELS') return lh.value;
  if (lh?.unit === 'PERCENT') return segment.fontSize * lh.value / 100;
  return rest && restValue(rest, from, to, 'lineHeightPx', METRIC);
}

/** @param {BaseNode} target @param {Pick<ExtractRequest, 'islands' | 'scale'>} job @param {PageNode} page @returns {Promise<PluginExtractOutput>} */
async function extract(target, job, page) {
  if (!('absoluteTransform' in target)) throw Error('Extract target must be a layer or frame, not a page');
  const [[a, c, e], [b, d, f]] = target.absoluteTransform, k = a * d - b * c;
  /** @type {Transform} */
  const local = [[d / k, -c / k, (c * f - d * e) / k], [-b / k, a / k, (b * e - a * f) / k]];
  const nodes = /** @type {Map<string, SceneNode>} */ (new Map()), hashes = /** @type {Set<string>} */ (new Set()), warnings = /** @type {string[]} */ ([]);
  /** @type {(ExtractNode & { segments: TextSegment[] })[]} */
  const texts = [];
  let segmentFields = SEGMENT_FIELDS, componentMs = 0;
  // Returns { o, text, image, shape, backdrop, candidates }. candidates contains maximal purely graphical subtrees, the automatic islands of islandRule 2:
  // no text or visible bitmaps, at least one vector, and no backdrop dependency; the root paints (non-null absoluteRenderBounds), is not a mask and is not the target. Otherwise continue searching descendants.
  /** @typedef {{ o: ExtractNode, text: boolean, image: boolean, shape: boolean, backdrop: boolean, candidates: string[] }} Visit */
  /** @param {SceneNode} n @param {boolean} parentLayout @returns {Promise<Visit | null>} */
  const visit = async (n, parentLayout) => {
    if (n.visible === false) return null;
    if (nodes.size >= EXTRACT_NODES) throw Error(`Extract exceeds ${EXTRACT_NODES} visible nodes: narrow the target with --node`);
    nodes.set(n.id, n);
    const bounds = renderBounds(n);
    // Emit renderBounds for every node: null means no paint (mask itself, zero opacity or fully clipped), distinct from an absent key meaning the source provides no data.
    /** @type {ExtractNode & { renderBounds: Bounds | null }} */
    const o = { id: n.id, name: n.name, type: n.type, transform: mul(local, n.absoluteTransform), width: n.width, height: n.height, renderBounds: bounds ? box(local, bounds) : null };
    for (const key of NODE_KEYS) if (key in n && prop(n, key) !== DEFAULTS[key]) { const v = read(n, key); if (!(Array.isArray(v) && !v.length)) o[key] = v; }
    if (o.isMask && 'maskType' in n) o.maskType = n.maskType;
    if (o.cornerRadius === 'MIXED') for (const key of CORNERS) o[key] = prop(n, key);
    if ('strokes' in n && read(n, 'strokes').length) {
      for (const key of STROKE_KEYS) if (key in n) o[key] = read(n, key);
      if (o.strokeWeight === 'MIXED') for (const key of SIDES) o[key] = prop(n, key);
    }
    if (o.layoutMode) for (const key of LAYOUT_KEYS) if (key in n) o[key] = read(n, key);
    if (parentLayout) for (const key of CHILD_LAYOUT_KEYS) if (key in n) o[key] = read(n, key);
    const shape = SHAPES.has(n.type) || (n.type === 'ELLIPSE' && partialArc(n.arcData));
    // Emit mask geometry for host mask-image construction; rectangle/ellipse masks need no shape reconstruction. GROUP lacks fillGeometry, so the host handles its children. Do not guard strokeGeometry with in: shape nodes have GeometryMixin, and missing geometry should fail the frame through copy instead of silently disappearing.
    if ((shape || o.cornerSmoothing || o.isMask) && 'fillGeometry' in n && n.fillGeometry) o.fillGeometry = copy(n.fillGeometry);
    if (shape && o.strokes) o.strokeGeometry = copy(/** @type {GeometryMixin} */ (n).strokeGeometry);
    if (n.type === 'VECTOR') o.vectorPaths = copy(n.vectorPaths);
    if (n.type === 'TEXT') {
      for (const key of TEXT_KEYS) if (key in n) o[key] = read(n, key);
      try { o.segments = copy(n.getStyledTextSegments(segmentFields)); }
      catch (error) { segmentFields = BASE_SEGMENT_FIELDS; warnings.push('Some text segment fields are unavailable; fell back to base fields: ' + String(error)); o.segments = copy(n.getStyledTextSegments(segmentFields)); }
      texts.push(/** @type {ExtractNode & { segments: TextSegment[] }} */ (o));
    }
    if (n.type === 'INSTANCE') {
      const started = Date.now();
      // Provenance fields are diagnostic only; read failures set componentError without failing the frame.
      try {
        const main = await n.getMainComponentAsync();
        if (main) o.component = { id: main.id, name: main.name, key: main.key, remote: main.remote, ...(main.parent?.type === 'COMPONENT_SET' ? { set: main.parent.name } : {}) };
        o.componentProperties = copy(n.componentProperties);
      } catch (error) { o.componentError = String(error); }
      componentMs += Date.now() - started;
    }
    for (const p of imagePaints(o)) hashes.add(p.imageHash);
    // TEXT_PATH also counts as text: islands export with svgOutlineText:false and must contain no text.
    /** @type {Visit} */
    const r = { o, text: n.type === 'TEXT' || n.type === 'TEXT_PATH', image: imagePaints(o).length > 0, shape, backdrop: backdrop(o), candidates: [] };
    for (const child of 'children' in n ? n.children : []) {
      const c = await visit(child, !!o.layoutMode);
      if (!c) continue;
      (o.children ??= []).push(c.o);
      r.text ||= c.text; r.image ||= c.image; r.shape ||= c.shape; r.backdrop ||= c.backdrop; r.candidates.push(...c.candidates);
    }
    if (!r.text && !r.image && r.shape && !r.backdrop && bounds && !o.isMask && n.id !== target.id) r.candidates = [n.id];
    return r;
  };
  const previous = figma.skipInvisibleInstanceChildren;
  // Many awaits allow user edits during extraction. Warn on nodechange; do not promise the tree, reference and islands represent the same instant.
  // Listener registration failure becomes a warning. Restore the state flag before unregistering so an unregister error cannot leave it true.
  let changed = false, listening = false;
  const onChange = () => { changed = true; };
  figma.skipInvisibleInstanceChildren = true;
  try {
    try { page.on('nodechange', onChange); listening = true; }
    catch (error) { warnings.push('nodechange listener unavailable; changes during extract cannot be detected: ' + String(error)); }
    const root = await visit(target, false);
    if (!root) throw Error('Extract target is not visible');
    const islands = /** @type {Record<string, string>} */ ({}), svgs = /** @type {Record<string, string | Uint8Array>} */ ({}), keys = /** @type {Map<string, string>} */ (new Map());
    const islandsSkipped = /** @type {string[]} */ ([]), blobs = /** @type {Uint8Array[]} */ ([]), auto = new Set(root.candidates);
    let svgSrgb = true, svgMs = 0;
    const svgSettings = { svgOutlineText: false, svgSimplifyStroke: false, svgIdAttribute: false };
    // Export in sRGB; disable it only when export fails with the option but succeeds without it. If both fail, propagate the node error without changing the global flag.
    // exportAsync overloads depend on format (SVG_STRING returns text, SVG returns bytes); the 'SVG' | 'SVG_STRING' union matches no single overload, so exportSvg passes it as any.
    // island infers place's value type from the supplied format, catching format/result misuse.
    /** @param {SceneNode} node @param {any} format @returns {Promise<any>} */
    const exportSvg = async (node, format) => {
      if (!svgSrgb) return node.exportAsync({ format, ...svgSettings });
      try { return await node.exportAsync({ format, ...svgSettings, colorProfile: 'SRGB' }); }
      catch (error) {
        const svg = await node.exportAsync({ format, ...svgSettings });
        svgSrgb = false; warnings.push('SVG export in sRGB failed; used the document color profile: ' + String(error));
        return svg;
      }
    };
    // IDs come from automatic candidates or validated painted explicit islands, all already present in nodes.
    /** @template {'SVG' | 'SVG_STRING'} F @param {string} id @param {F} format @param {(result: F extends 'SVG' ? Uint8Array : string) => void} place */
    const island = async (id, format, place) => {
      const started = Date.now();
      try { place(await exportSvg(/** @type {SceneNode} */ (nodes.get(id)), format)); }
      catch (error) { warnings.push(`Island ${id} export failed: ${String(error)}`); }
      svgMs += Date.now() - started;
    };
    for (const id of auto) await island(id, 'SVG_STRING', svg => {
      if (!keys.has(svg)) { keys.set(svg, 's' + keys.size); svgs['s' + (keys.size - 1)] = svg; }
      islands[id] = /** @type {string} */ (keys.get(svg));
    });
    // Append explicit islands after automatic ones, skipping previously exported IDs. Bytes use the binary channel because they often contain bitmaps and should not consume structured-output budget; do not deduplicate them.
    // Requested islands that are invisible/out of subtree, unpainted or fail export enter islandsSkipped with warning reasons; the task still completes.
    for (const id of job.islands || []) {
      if (Object.hasOwn(islands, id)) continue;
      if (!renderBounds(nodes.get(id))) {
        islandsSkipped.push(id);
        warnings.push(`${nodes.has(id) ? 'Island node has no rendered content (fully clipped, a mask, or opacity 0)' : 'Island node is not in the visible subtree of the target'}; skipped: ${id}`);
        continue;
      }
      await island(id, 'SVG', bytes => { islands[id] = 'b' + blobs.length; svgs[islands[id]] = bytes; blobs.push(bytes); });
      if (!Object.hasOwn(islands, id)) islandsSkipped.push(id);
    }
    /** @type {ExportSettingsImage} */
    const png = { format: 'PNG', constraint: { type: 'SCALE', value: job.scale ?? 1 }, useAbsoluteBounds: true };
    let reference;
    try { reference = await target.exportAsync({ ...png, colorProfile: 'SRGB' }); }
    catch (error) { reference = await target.exportAsync(png); warnings.push('Reference image export in sRGB failed; used the document color profile: ' + String(error)); }
    // Missing bitmaps (empty handles, pending downloads or rejected reads) are skipped with warnings, allowing host DOM fallback. Only budget violations fail the frame.
    const images = /** @type {Record<string, ExtractImage<Uint8Array>>} */ ({});
    for (const hash of hashes) {
      try {
        const image = figma.getImageByHash(hash);
        if (!image) throw Error('getImageByHash returned null');
        images[hash] = { bytes: await image.getBytesAsync(), ...await image.getSizeAsync() };
      } catch (error) { warnings.push(`Bitmap unavailable: ${hash}: ${String(error)}`); }
    }
    let lineHeightMissing = 0, postScriptMissing = 0, misaligned = 0;
    if (texts.length) {
      const rest = /** @type {Map<string, RestNode>} */ (new Map()), index = /** @type {(n: RestNode) => void} */ (n => { if (n.type === 'TEXT') rest.set(n.id, n); (n.children || []).forEach(index); });
      try { const json = /** @type {RestNode & { document?: RestNode }} */ (await target.exportAsync({ format: 'JSON_REST_V1' })); index(json.document ?? json); }
      catch (error) { warnings.push('JSON_REST_V1 export failed; segments with AUTO line height have no lineHeightPx, and no segment has fontPostScriptName: ' + String(error)); }
      for (const o of texts) {
        const r = rest.get(o.id), at = codePointIndex(o.characters ?? '');
        for (const segment of o.segments) {
          const from = at[segment.start], to = at[segment.end], ref = r && aligned(r, from, to, segment) ? r : undefined;
          if (r && !ref) misaligned++;
          const px = segmentLineHeight(segment, ref, from, to), ps = ref && restValue(ref, from, to, 'fontPostScriptName', FACE);
          if (px === undefined) lineHeightMissing++; else segment.lineHeightPx = px;
          if (ps === undefined) postScriptMissing++; else segment.fontPostScriptName = ps;
        }
      }
      if (misaligned) warnings.push(`${misaligned} text segment(s) do not match the JSON_REST_V1 override table in family, style or size (the table may not count by code point); REST values are not used for these segments`);
      if (lineHeightMissing) warnings.push(`${lineHeightMissing} text segment(s) have no lineHeightPx (AUTO line height with override entries carrying font or line-height keys, a mismatch with the override table, or a node missing from JSON_REST_V1); the host applies its fallback chain`);
      if (postScriptMissing) warnings.push(`${postScriptMissing} text segment(s) have no fontPostScriptName (override entries carry font keys but not this one, values differ within the segment, a mismatch with the override table, or a node missing from JSON_REST_V1); the host composes it from family and style`);
    }
    // Preflight binary limits with extraction-specific guidance; serializeOutput's equivalent check is worded for run.
    const binaries = [reference, ...Object.values(images).map(image => image.bytes), ...blobs];
    if (binaries.length > 200 || binaries.reduce((n, bytes) => n + Math.ceil(bytes.length / 3) * 4, 0) > BINARY_LIMIT) throw Error('Reference image, bitmaps and explicit islands exceed 200 items or 48 MB: narrow the target with --node or lower --scale');
    if (changed) warnings.push('documentChangedDuringExtract: the document changed during extract; the tree, reference image and islands may not reflect the same moment');
    return { schema: 1, islandRule: ISLAND_RULE, root: root.o, colorProfile: figma.root?.documentColorProfile ?? null, scale: job.scale ?? 1, reference, images, islands, svgs, islandsSkipped,
      stats: /** @satisfies {Required<ExtractStats>} */ ({ nodes: nodes.size, islands: Object.keys(islands).length, svgs: Object.keys(svgs).length, images: Object.keys(images).length, svgMs, componentMs, svgSrgb, lineHeightMissing, postScriptMissing }), warnings };
  } finally {
    figma.skipInvisibleInstanceChildren = previous;
    if (listening) try { page.off('nodechange', onChange); } catch (_) {}
  }
}

// -- Script compilation -------------------------------------------------
// Nest each library and the body in its own function scope: earlier libraries are outermost, with the body inside and able to call their functions directly;
// duplicate names shadow outer declarations instead of causing redeclaration errors. Library top-level code evaluates with the body inside Undo boundaries.
/** @param {Job} job */
function compile(job) {
  const body = (job.libs || []).reduceRight((inner, lib) => `${lib.code}\nreturn (async () => {\n${inner}\n})();`, job.code);
  return new Function('figma', 'target', 'data', `return (async () => {\n${body}\n})();`);
}

// -- Failure evidence: newly created nodes -------------------------------
// Listen to target-page nodechange during execution, collecting CREATE only. Nested creation reports the highest parent; exclude REMOTE collaborator changes.
// Avoid figma.on('documentchange'), which requires loadAllPagesAsync under dynamic-page. Consequently, nodes created after the script switches to another page are outside coverage.
// Events arrive asynchronously in batches. After script failure, wait for 50 ms without new events, capped at about 500 ms wall time; throttling can add one interval.
// Real-device verification is still needed for Figma event delivery timing and whether plugin timers throttle when Figma moves to the background.
/** @param {() => number} count */
async function settleEvents(count) {
  const end = Date.now() + 500;
  for (let seen = -1; seen !== count() && Date.now() < end;) { seen = count(); await new Promise(resolve => setTimeout(resolve, 50)); }
}
// Listener registration failure only warns; stop is idempotent. created returns surviving nodes without a newly created ancestor, or null when listening is unavailable.
/** @param {PageNode} page @param {string[]} warnings */
function watchCreated(page, warnings) {
  const ids = /** @type {Set<string>} */ (new Set());
  /** @param {NodeChangeEvent} event */
  const onChange = event => { for (const change of event.nodeChanges) if (change.type === 'CREATE' && change.origin !== 'REMOTE') ids.add(change.id); };
  let listening = false;
  try { page.on('nodechange', onChange); listening = true; }
  catch (error) { warnings.push('nodechange listener unavailable; created nodes cannot be listed if the script fails: ' + String(error)); }
  return {
    stop() { if (listening) try { page.off('nodechange', onChange); } catch (_) {} listening = false; },
    async created() {
      if (!listening) return null;
      await settleEvents(() => ids.size);
      const nodes = /** @type {BaseNode[]} */ ([]);
      for (const id of ids) { const node = await figma.getNodeByIdAsync(id); if (node && !node.removed) nodes.push(node); }
      const found = new Set(nodes.map(node => node.id));
      return nodes.filter(node => { for (let up = node.parent; up; up = up.parent) if (found.has(up.id)) return false; return true; });
    }
  };
}

// -- Target guidance ----------------------------------------------------
// The panel answers whether the currently open file and page match the bound target.
/** @param {{ fileKey: string, nodeId: string } | undefined} binding */
async function checkTarget(binding) {
  if (!figma.fileKey) return { name: '', issue: "The plugin cannot read this file's fileKey. Use Figma Desktop and the development plugin installed by figma-agent-control connect." };
  if (!binding || binding.fileKey !== figma.fileKey) return { name: '', issue: "This is not the bound file. Open the file used by the agent and run the plugin again." };
  const node = await figma.getNodeByIdAsync(binding.nodeId);
  if (!node || node.removed) return { name: '', issue: "The bound target no longer exists. Ask the agent to bind it again." };
  return { name: node.name, issue: null };
}

figma.ui.onmessage = async job => {
  // At UI startup, request the current file so the bridge lets only instances in the bound file claim work.
  if (job?.type === 'hello') { figma.ui.postMessage({ type: 'file', fileKey: figma.fileKey || '' }); return; }
  if (job?.type === 'check-target') {
    let info;
    try { info = await checkTarget(job.binding); } catch { info = { name: '', issue: "The target is temporarily unavailable." }; }
    figma.ui.postMessage({ type: 'target-info', ...info });
    return;
  }
  if (job?.type === 'hide-ui') { figma.ui.hide(); return; }
  // Check for a waiter first: when a reply lacks id, optional chains can both equal undefined, then reading fields from null would throw.
  if (job?.type === 'approval-ack') {
    if (approvalWaiter && approvalWaiter.id === job.id && approvalWaiter.channelNonce === job.channelNonce) approvalWaiter.finish(job);
    return;
  }
  if (job?.type === 'checkpoint-ack') {
    if (checkpointWaiter && checkpointWaiter.id === job.id && checkpointWaiter.channelNonce === job.channelNonce) checkpointWaiter.finish(job);
    return;
  }
  if (!job || !job.id || busy) return;
  busy = true;
  const receivedAt = Date.now();
  let approvalMs = 0;
  /** @type {Send} */
  const send = message => {
    // Final results include plugin duration, covering snapshots and exports but excluding user approval time.
    const final = message.id === job.id && typeof message.ok === 'boolean';
    const payload = { ...message, ...(final ? { pluginMs: Date.now() - receivedAt - approvalMs, ...(approvalMs ? { approvalMs } : {}) } : {}), channelNonce: job.channelNonce };
    const serialized = JSON.stringify(payload);
    // Cross-host conversion of many numbers is expensive. Serialize task messages (result, checkpoint, approval-request) as one string above 65536 JS characters, not bytes.
    figma.ui.postMessage(serialized.length > 65536 ? { type: 'serialized-result', id: job.id, channelNonce: job.channelNonce, serialized } : payload);
  };
  // target is an in-scope node with a page (page or layer). DocumentNode pageOf returns null and validation throws immediately after assignment.
  let before, target = /** @type {SceneNode | PageNode | null} */ (null), page = /** @type {PageNode | null} */ (null), executionStarted = false, ancestors = /** @type {Record<string, unknown>[] | null} */ (null);
  const run = job.operation === 'run';
  const declaredDepth = ['run', 'inspect'].includes(job.operation) && Number.isInteger(job.snapshotDepth) && job.snapshotDepth >= 1 && job.snapshotDepth < SNAPSHOT_DEPTH ? job.snapshotDepth : null;
  // preview, variables and extract snapshot only the root; inspect defaults to one level for pages; all others default to a full snapshot.
  // Call only after target assignment, inside try or catch after executionStarted.
  const snapshot = () => { const node = /** @type {SceneNode | PageNode} */ (target); return tree(node, ['preview', 'variables', 'extract'].includes(job.operation) ? 0 : declaredDepth ?? (job.operation === 'inspect' && node.type === 'PAGE' ? 1 : SNAPSHOT_DEPTH)); };
  /** @type {{ before: string, after: string, clean?: string }} */
  const undoBoundaries = { before: 'not-run', after: 'not-run' };
  const budget = { size: 0 }, warnings = /** @type {string[]} */ ([]);
  // Return failed-script evidence: created, plus cleaned/cleanFailed when cleanOnFail is enabled.
  let watch = /** @type {ReturnType<typeof watchCreated> | null} */ (null), leftovers = /** @type {Record<string, unknown>} */ ({});
  try {
    if (!figma.fileKey) throw Error('Cannot verify the file key; use the development plugin with the private API enabled');
    if (figma.fileKey !== job.binding.fileKey) throw Error('The current file does not match the binding');
    if (figma.editorType !== 'figma' || figma.mode !== 'default') throw Error('Run the plugin in Figma Design edit mode');
    // Compile first: syntax errors return before snapshots, approval or writes, preserving executionStarted false.
    const program = run ? compile(job) : null;
    const candidate = await figma.getNodeByIdAsync(job.targetNodeId ?? job.binding.nodeId);
    if (candidate === null && job.operation === 'inspect') {
      send({ id: job.id, ok: false, executionStarted: false, targetMissing: true, missingNodeId: job.targetNodeId ?? job.binding.nodeId, fileVerified: figma.fileKey,
        error: 'Queried the original target in the bound file; the node no longer exists. Verify against the original job and the canvas', recovery: 'Keep the missing-node evidence; do not replay the original script' });
      return;
    }
    if (!candidate || !within(candidate, job.binding.nodeId)) throw Error('The local target does not exist or is outside the binding scope');
    target = /** @type {SceneNode | PageNode} */ (candidate);
    page = pageOf(target);
    if (!page) throw Error('Target is not inside a page');
    await page.loadAsync();
    // extract loads pages without switching: html may submit up to 100 extracts, which must not repeatedly move the user's view.
    if (job.operation !== 'extract') await figma.setCurrentPageAsync(page);
    before = snapshot();
    let output;
    if (job.operation === 'inspect') { output = before; ancestors = ancestry(target); }
    else if (job.operation === 'variables') output = await localVariables(target);
    else if (job.operation === 'extract') output = await extract(target, job, page);
    else if (job.operation === 'preview') {
      // Validate binding scope for every batch export; any out-of-scope node fails the entire job.
      const images = [];
      for (const id of Array.isArray(job.nodes) ? job.nodes : [target.id]) {
        const node = id === target.id ? target : await figma.getNodeByIdAsync(id);
        if (!node || !within(node, job.binding.nodeId)) throw Error('Preview node does not exist or is outside the binding scope: ' + id);
        images.push({ nodeId: node.id, name: node.name, base64: await render(/** @type {SceneNode | PageNode} */ (node), job.scale, budget) });
      }
      send({ id: job.id, ok: true, images, bindingVerified: { fileKey: figma.fileKey, pageId: page.id, nodeId: target.id } });
      return;
    } else if (run) {
      if (declaredDepth === null && isTruncated(before)) throw Error('Before-snapshot truncated; the script did not run. Narrow the target with --node');
      if (job.risk?.level === 'high') {
        const asked = Date.now();
        try { await requestApproval(job, send); } finally { approvalMs = Date.now() - asked; }
      }
      await saveCheckpoint(job, before, page, send);
      const currentPage = pageOf(target);
      if (figma.fileKey !== job.binding.fileKey || target.removed || !within(target, job.binding.nodeId) || currentPage?.id !== page.id || JSON.stringify(snapshot()) !== JSON.stringify(before)) throw Error('Target changed while waiting for the snapshot; the script did not run. Run inspect again');
      // Export the before image outside the Undo boundary. Export is read-only, and failure means the script has not executed.
      /** @type {{ before: string, after?: string, error?: string } | null} */
      const renders = job.expect ? { before: await render(target, job.scale, budget) } : null;
      // cleanOnFail records existing target-page IDs before the boundary. Preserve new nodes that are themselves preexisting or contain existing layers, such as figma.group results, to avoid deleting original content.
      // Covers only the target page; existing nodes moved from other pages into new nodes are absent from the protection list.
      const existing = job.cleanOnFail ? new Set(page.findAll().map(node => node.id)) : null;
      if (typeof figma.commitUndo !== 'function') throw Error('This environment does not support Undo boundaries; the script did not run');
      const commitUndo = figma.commitUndo.bind(figma);
      try { commitUndo(); undoBoundaries.before = 'committed'; }
      catch (error) { undoBoundaries.before = 'failed'; throw error; }
      watch = watchCreated(page, warnings);
      executionStarted = true;
      let scriptFailure, boundaryFailure;
      try { output = await /** @type {Function} */ (program)(figma, target, job.data ?? null); }
      catch (error) { scriptFailure = { error }; }
      // Create history boundaries for success and partial failure alike; never trigger global Undo automatically.
      try { commitUndo(); undoBoundaries.after = 'committed'; }
      catch (error) {
        undoBoundaries.after = 'failed';
        boundaryFailure = Error(`${scriptFailure ? `Script error: ${String(scriptFailure.error)}; ` : ''}Failed to commit the closing Undo boundary: ${String(error)}; verify the document, do not auto-undo or replay the script`);
      }
      if (scriptFailure) {
        // Default to reporting only. cleanOnFail deletes highest-level new nodes and commits another boundary, making cleanup a separate Undo step. Existing modifications remain, so execution is not atomic.
        // If the ending boundary fails, cleanup cannot be a separate step, so report without deletion. Preserve new nodes that are or contain preexisting nodes, recording cleanFailed.
        // Evidence/cleanup errors only warn; keep the original script error. Read names and types before deletion because removed-node properties are inaccessible.
        try {
          const nodes = await watch.created();
          if (nodes) {
            const created = nodes.map(node => ({ id: node.id, name: node.name, type: node.type }));
            leftovers.created = created;
            if (existing && boundaryFailure) warnings.push('Closing Undo boundary failed to commit; created nodes were not deleted');
            else if (existing) {
              const cleaned = /** @type {typeof created} */ ([]), cleanFailed = /** @type {(typeof created[0] & { reason: string })[]} */ ([]);
              nodes.forEach((node, i) => {
                try {
                  const kept = existing.has(node.id) ? node : 'findOne' in node ? node.findOne(child => existing.has(child.id)) : null;
                  if (kept) cleanFailed.push({ ...created[i], reason: kept === node ? 'Already on the target page before execution; not deleted' : `Contains node ${kept.id} that existed before execution; not deleted` });
                  else { node.remove(); cleaned.push(created[i]); }
                } catch (error) { cleanFailed.push({ ...created[i], reason: String(error) }); }
              });
              Object.assign(leftovers, { cleaned, cleanFailed });
              if (cleaned.length) try { commitUndo(); undoBoundaries.clean = 'committed'; }
              catch (error) { undoBoundaries.clean = 'failed'; warnings.push('Undo boundary after cleanup failed to commit; this deletion will merge into the next Undo step: ' + String(error)); }
            }
          }
        } catch (error) { warnings.push('Failed to list or clean up created nodes: ' + String(error)); }
      }
      if (boundaryFailure) throw boundaryFailure;
      if (scriptFailure) throw scriptFailure.error;
      // Failed after-image export does not invalidate script success: mark the visual verdict unavailable and still return output.
      if (renders) {
        try { if (target.removed) throw Error('Target was deleted by the script'); renders.after = await render(target, job.scale, budget); }
        catch (error) { renders.error = String(error); }
      }
      // An over-budget after snapshot only makes the change set unavailable; it does not invalidate successful execution or output.
      let after, afterError;
      try { after = target.removed ? null : snapshot(); } catch (error) { afterError = String(error); }
      let serialized;
      try { serialized = serializeOutput(output, budget); }
      catch (error) { throw String(error).includes('do not replay the script') ? error : Error('Return value cannot be converted to JSON; the script ran, check the document, do not replay the script'); }
      send({ id: job.id, ok: true, output: serialized.output, ...(serialized.binaries.length ? { binaries: serialized.binaries } : {}), ...(renders ? { renders } : {}),
        before, ...(afterError ? { afterError } : { after }), bindingVerified: { fileKey: figma.fileKey, pageId: page.id, nodeId: before.id }, undoBoundaries });
      return;
    } else throw Error('Unknown operation');
    const serialized = serializeOutput(output, budget);
    if (job.operation === 'extract' && utf8Upper(JSON.stringify(serialized.output)) > EXTRACT_BYTES) throw Error('Extract result exceeds 12 MB (UTF-8 estimate): narrow the target with --node');
    send({ id: job.id, ok: true, output: serialized.output, ...(serialized.binaries.length ? { binaries: serialized.binaries } : {}), ...(ancestors ? { ancestors } : {}),
      bindingVerified: { fileKey: figma.fileKey, pageId: page.id, nodeId: before.id } });
  } catch (e) {
    let after;
    if (executionStarted) { try { after = /** @type {SceneNode | PageNode} */ (target).removed ? null : snapshot(); } catch (_) {} }
    send({ id: job.id, ok: false, error: String(e), executionStarted, ...(after !== undefined ? { before, after } : {}), ...(ancestors ? { ancestors } : {}),
      recovery: executionStarted ? 'The script started running; keep the current state, verify with inspect first, do not replay the script' : 'The script did not run; fix it and resubmit', ...(run ? { undoBoundaries } : {}),
      ...leftovers, ...(warnings.length ? { warnings } : {}) });
  } finally {
    watch?.stop();
    busy = false;
  }
};
