/**
 * [INPUT]: Uses module-scoped @figma/plugin-typings types from plugin-api-standalone (Paint, Effect, StyledTextSegment and others), without figma globals or Node types.
 * [OUTPUT]: ExtractRequest, ExtractNode, TextSegment, Bounds, ExtractStats, ExtractImage, ExtractOutput<B>, Mixed, ExtractEffect and ExtractComponentProperties;
 *           binary forms Uint8Array / BinaryPlaceholder / LandedBinary (BinaryFile or binaryUnavailable), corresponding PluginExtractOutput/LandedExtractOutput, and ExtractResult for result.json.
 * [POS]: Type-only extraction contract shared by plugin and host. plugin/extract.js produces it; bridge replaces binary values during persistence; record and html modules consume it.
 *        tests/contract-samples.mjs checks real Figma result.json evidence against it. Shared type environments permit only ES built-ins and module-scoped Figma types.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import type {
  ArcData, AutoLayoutChildrenMixin, AutoLayoutMixin, BaseFrameMixin, BlendMixin, BooleanOperationNode, ComponentProperties, CornerMixin, DocumentNode, Effect,
  GeometryMixin, GlassEffect, IndividualStrokesMixin, LayoutMixin, MaskType, MinimalBlendMixin, MinimalFillsMixin, RectangleCornerMixin, SceneNode,
  StyledTextSegment, TextNode, Transform, VectorPaths
} from '@figma/plugin-typings/plugin-api-standalone.js';

// -- Read conventions ---------------------------------------------------
// Plugin copy() reads through a JSON round trip, encoding the figma.mixed symbol as 'MIXED'.
export type Mixed = 'MIXED';
type Copied<T> = T extends symbol ? Mixed : T;
// Key-table fields are emitted only when non-default, so all are optional; value types follow Plugin API.
type Fields<T, K extends keyof T> = { -readonly [P in K]?: Copied<T[P]> };

// -- Observed shapes differing from plugin-typings 1.141.0 ----------------
// Checked against 13 real extract result.json samples in the local corpus; widen only to shapes actually observed in Figma.
/** Observed GLASS includes splay, such as 0.2, absent from typings. */
export type ExtractEffect = Exclude<Effect, GlassEffect> | (GlassEffect & { readonly splay?: number });
/** Observed SLOT component properties have type and preferredValues but no value; typings require value. */
export type ExtractComponentProperties = Record<string, Omit<ComponentProperties[string], 'value'> & Partial<Pick<ComponentProperties[string], 'value'>>>;

// -- Requests -----------------------------------------------------------
export interface ExtractRequest {
  operation: 'extract';
  /** Frame or any layer, never a page; defaults to the binding node. */
  targetNodeId?: string;
  /** Range 0.1-4, default 1; affects only the reference image. */
  scale?: number;
  /** 1-500 distinct node IDs exported in addition to automatic islands. */
  islands?: string[];
  requestId?: string;
  label?: string;
}

// -- Nodes: field semantics are documented below -------------------------
/** [x, y, width, height] in target coordinates. */
export type Bounds = [x: number, y: number, width: number, height: number];

export type TextSegment =
  // If full segment fields are unsupported, the entire task falls back to basic fields with a warning; only basic fields are required.
  Pick<StyledTextSegment, 'characters' | 'start' | 'end' | 'fontName' | 'fontSize' | 'fills' | 'textDecoration' | 'textCase' | 'lineHeight' | 'letterSpacing'>
  & Partial<Pick<StyledTextSegment, 'fontWeight' | 'textDecorationStyle' | 'textDecorationOffset' | 'textDecorationThickness' | 'textDecorationColor'
    | 'textDecorationSkipInk' | 'listOptions' | 'indentation' | 'listSpacing' | 'paragraphIndent' | 'paragraphSpacing'>>
  & {
    /** Observed uppercase weight names ('REGULAR', 'MEDIUM', 'LIGHT'); absent for variable fonts such as SF Pro Semibold with fontName.variationSettings. Typings specify 'REGULAR' | 'ITALIC'. */
    fontStyle?: string;
    /** Observed output lists only explicitly set features, such as {} or { LIGA: false, CLIG: false }; typings require a full feature record. */
    openTypeFeatures?: Partial<StyledTextSegment['openTypeFeatures']>;
    /** PIXELS uses value; PERCENT uses fontSize * value / 100. AUTO reads REST only after alignment validation and without metric-affecting overrides. Omission increments stats.lineHeightMissing. */
    lineHeightPx?: number;
    /** Read from JSON_REST_V1 overrides mapped by code point; omission increments stats.postScriptMissing. */
    fontPostScriptName?: string;
  };

export type ExtractNode = {
  id: string;
  name: string;
  type: SceneNode['type'];
  /** [[a, c, tx], [b, d, ty]] in target coordinates; the root uses the identity matrix. */
  transform: Transform;
  width: number;
  height: number;
  /**
   * Painted ink bounds after ancestor clipping and masks, including stroke/shadow overflow. extract emits this key for every node; null means no painted content.
   * Only offline-adapted input can omit it, meaning the source provides no bounds and the value is unknown.
   */
  renderBounds?: Bounds | null;
  /** Required when isMask is true. */
  maskType?: MaskType;
  /** Emitted for masks, vector-like nodes and cornerSmoothing > 0 when geometry exists. GROUP has no geometry, including when used as a mask. */
  fillGeometry?: VectorPaths;
  /** Vector-like nodes with visible strokes. */
  strokeGeometry?: VectorPaths;
  /** VECTOR */
  vectorPaths?: VectorPaths;
  /** TEXT */
  segments?: TextSegment[];
  /** INSTANCE provenance; failed reads provide only componentError. */
  component?: { id: string; name: string; key: string; remote: boolean; set?: string };
  componentProperties?: ExtractComponentProperties;
  componentError?: string;
  /** Visible children in original order. Earlier siblings usually paint below later ones; auto-layout itemReverseZIndex reverses paint order. */
  children?: ExtractNode[];
}
  & Fields<MinimalBlendMixin, 'opacity' | 'blendMode'> & Fields<BlendMixin, 'isMask'> & { effects?: ReadonlyArray<ExtractEffect> } & Fields<BaseFrameMixin, 'clipsContent'>
  & Fields<MinimalFillsMixin, 'fills'> & Fields<CornerMixin, 'cornerRadius' | 'cornerSmoothing'>
  & Fields<BooleanOperationNode, 'booleanOperation'> & { arcData?: ArcData }
  // Emit the full group for visible strokes; MIXED strokeWeight/cornerRadius also supplies individual sides/corners.
  & Fields<GeometryMixin, 'strokes' | 'strokeWeight' | 'strokeAlign' | 'strokeCap' | 'strokeJoin' | 'strokeMiterLimit' | 'dashPattern'>
  & Fields<IndividualStrokesMixin, 'strokeTopWeight' | 'strokeRightWeight' | 'strokeBottomWeight' | 'strokeLeftWeight'>
  & Fields<RectangleCornerMixin, 'topLeftRadius' | 'topRightRadius' | 'bottomRightRadius' | 'bottomLeftRadius'>
  // Auto layout is provenance only; generation positions nodes from matrices.
  & Fields<AutoLayoutMixin, 'layoutMode' | 'layoutWrap' | 'primaryAxisAlignItems' | 'counterAxisAlignItems' | 'itemSpacing' | 'counterAxisSpacing'
    | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft' | 'itemReverseZIndex' | 'strokesIncludedInLayout'>
  & Fields<AutoLayoutChildrenMixin, 'layoutPositioning' | 'layoutGrow' | 'layoutAlign'> & Fields<LayoutMixin, 'layoutSizingHorizontal' | 'layoutSizingVertical'>
  // TEXT styles come only from segments; these are the only node-level text fields.
  & Fields<TextNode, 'characters' | 'textAutoResize' | 'textAlignHorizontal' | 'textAlignVertical' | 'textTruncation' | 'maxLines' | 'leadingTrim' | 'hasMissingFont'>;

// -- Output -------------------------------------------------------------
export interface ExtractStats {
  nodes: number;
  islands: number;
  svgs: number;
  images: number;
  svgMs: number;
  componentMs: number;
  /** Every exported SVG used sRGB. */
  svgSrgb: boolean;
  lineHeightMissing: number;
  /** Added without a schema bump; evidence from plugin version 2a3b2154e96d2114 or earlier lacks this key. */
  postScriptMissing?: number;
}

export interface ExtractImage<B> {
  /** Original PNG, JPEG, GIF or WebP bytes, without Figma re-encoding. */
  bytes: B;
  /** Original pixel dimensions from Image.getSizeAsync(). */
  width: number;
  height: number;
}

/** B represents binary data at each stage: Uint8Array in the plugin, placeholders in transit, and file descriptors after persistence. */
export interface ExtractOutput<B> {
  schema: 1;
  /** Automatic-island rule version, currently 2; replay uses this value to identify historical rules. */
  islandRule: number;
  root: ExtractNode;
  /** figma.root.documentColorProfile; interpret LEGACY values as sRGB. */
  colorProfile: DocumentNode['documentColorProfile'] | null;
  scale: number;
  /** Reference PNG exported with sRGB, useAbsoluteBounds and the requested scale. */
  reference: B;
  /** Deduplicated by imageHash; unavailable bitmaps only warn and are absent, so lookup may return undefined. */
  images: Partial<Record<string, ExtractImage<B>>>;
  /** Node ID to svgs key; non-island nodes are absent. */
  islands: Partial<Record<string, string>>;
  /** s<n>: content-deduplicated automatic-island SVG strings. b<n>: explicit-island SVG bytes using the binary channel, without deduplication. */
  svgs: Record<string, string | B>;
  /** IDs of requested explicit islands without results; warnings explain why. */
  islandsSkipped: string[];
  stats: ExtractStats;
  warnings: string[];
}

// -- Three binary representations ---------------------------------------
/** Inside the plugin: extract() return value. */
export type PluginExtractOutput = ExtractOutput<Uint8Array>;

/** In transit: main.js serializeOutput replaces bytes with indexed placeholders; bytes travel separately in binaries. */
export interface BinaryPlaceholder { __figmaAgentControlBinary: number }

/** After persistence: bridge writes runs/<taskID>/files/output-<n>.<type> and replaces placeholders with descriptors; PNG also includes dimensions. */
export interface BinaryFile {
  /** Path relative to the task directory. */
  file: string;
  bytes: number;
  sha256: string;
  type: 'png' | 'jpg' | 'gif' | 'webp' | 'pdf' | 'svg' | 'mp4' | 'webm' | 'bin';
  width?: number;
  height?: number;
}
/** For invalid placeholders, bridge writes { binaryUnavailable: true } and explains the issue in result.json binaryErrors. */
export type LandedBinary = BinaryFile | { binaryUnavailable: true };
export type LandedExtractOutput = ExtractOutput<LandedBinary>;

// -- result.json for extract tasks ---------------------------------------
export type ExtractResult = {
  id: string;
  ok: true;
  output: LandedExtractOutput;
  bindingVerified: { fileKey: string; pageId: string; nodeId: string };
  pluginMs: number;
  finishedAt: string;
  /** Present only on binary persistence errors; CLI exits 1 and suggests resubmission. */
  binaryErrors?: string[];
} | {
  id: string;
  ok: false;
  /** extract is read-only; all failures report unexecuted. */
  executionStarted: false;
  error: string;
  recovery?: string;
  /** Above roughly 16 MB of structured output, ui.html compactFailure replaces success with failure while retaining plugin verification fields. */
  bindingVerified?: { fileKey: string; pageId: string; nodeId: string };
  pluginMs?: number;
  finishedAt: string;
};
