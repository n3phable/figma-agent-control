/**
 * [INPUT]: Figma Plugin API, bridge configuration and the sandbox/iframe message channel.
 * [OUTPUT]: Plugin task handling and serialized results.
 * [POS]: Read-only extraction of scene geometry, text and render assets for HTML export.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
/** @import { Bounds, ExtractImage, ExtractNode, ExtractRequest, ExtractStats, PluginExtractOutput, TextSegment } from '../src/html/extract-contract.js' */

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
