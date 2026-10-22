/**
 * [INPUT]: Figma Plugin API and the run-injected script environment.
 * [OUTPUT]: Plugin task handling and serialized results.
 * [POS]: Plugin-side motion specification reader, reconciler, exporter and timeline diagnostics.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */

/**
 * @typedef {number | boolean | string | number[] | { type: string, value: unknown }} SpecValue  FLOAT uses a number, BOOL a boolean, VECTOR [x, y], COLOR #RRGGBB(AA); other types retain the original object.
 * @typedef {[number, SpecValue, (string | object)?]} SpecKey  [seconds, value, easing]; easing applies to the segment ending at this keyframe and defaults to Figma's cubic(0.5,0,0.5,1).
 * @typedef {{ base?: SpecValue, keys: SpecKey[] }} SpecTrack
 * @typedef {{ id?: string, preset?: string, style?: string, at?: number, dur?: number, easing?: string | object, props?: Record<string, unknown> }} SpecStyle
 * @typedef {{ id: string, name?: string, inherited?: true, tracks?: Record<string, SpecTrack>, styles?: SpecStyle[] }} SpecNode
 * @typedef {{ id: string, name?: string, duration?: number, nodes?: SpecNode[] }} SpecTimeline
 * @typedef {{ rule: string, timeline?: string, node?: string, message: string }} Issue
 * @typedef {{ timelines: SpecTimeline[], refs?: Record<string, string>, issues?: Issue[] }} MotionSpec
 */

// -- Caller stacks ------------------------------------------------------
// Figma's QuickJS has no async stacks: errors after await contain only library frames, hiding the script call site. Public async functions capture the stack synchronously on entry
// (excluding the wrapper's own frame) and append it to errors, so traces list the caller after library frames.
/** @template {(...args: any[]) => Promise<any>} F @param {F} fn @returns {F} */
const traced = fn => /** @type {F} */ (async (/** @type {any[]} */ ...args) => {
  const caller = String(Error().stack ?? '').split('\n').filter(line => /^\s*at /.test(line)).slice(1).join('\n');
  try { return await fn(...args); }
  catch (error) { try { if (error instanceof Error && caller) error.stack = `${error.stack ?? ''}\n${caller}`; } catch (_) { /* Still throw if stack is read-only.*/ } throw error; }
});

// -- Encoding and decoding ----------------------------------------------
// Easing shorthand uses lowercase hyphenated names, cubic(x1,y1,x2,y2), spring(bounce), $variableName for EASING variables, and @styleName for custom animation styles.
// spec.refs maps $ and @ tokens to IDs. Writes check it before looking up local variables or styles by name. Unknown easing objects round-trip unchanged.
const EASINGS = /** @type {Record<string, string>} */ ({ LINEAR: 'linear', EASE_IN: 'ease-in', EASE_OUT: 'ease-out', EASE_IN_AND_OUT: 'ease-in-out',
  EASE_IN_BACK: 'ease-in-back', EASE_OUT_BACK: 'ease-out-back', EASE_IN_AND_OUT_BACK: 'ease-in-out-back', HOLD: 'hold', GENTLE: 'gentle', QUICK: 'quick', BOUNCY: 'bouncy', SLOW: 'slow' });
const EASING_TYPES = Object.fromEntries(Object.entries(EASINGS).map(([type, short]) => [short, type]));
// Observed Figma default for manual keyframes without easing; omitted on read.
const DEFAULT_EASING = 'cubic(0.5,0,0.5,1)';
// Preset-driven properties: manual tracks for these properties on the same node, or overlapping presets of the same type, compete for the same property.
const PRESET_FIELDS = /** @type {Record<string, string[]>} */ ({ Opacity: ['OPACITY'], Position: ['TRANSLATION_X', 'TRANSLATION_Y', 'TRANSLATION_XY'],
  Scale: ['SCALE_X', 'SCALE_Y', 'SCALE_XY'], Rotation: ['ROTATION'], Size: ['WIDTH', 'HEIGHT'] });
const COLLECTIONS = ['fills', 'strokes', 'effects'], EPSILON = 0.0005;

/** @param {number} n */
const round = (n, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
/** @param {any} value @returns {any} */
const roundDeep = value => typeof value === 'number' ? round(value, 4) : Array.isArray(value) ? value.map(roundDeep)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)])) : value;
// Compare independently of key order: objects read from Figma and rewritten by an agent may order keys differently.
/** @param {unknown} value */
const canon = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);
/** @param {unknown} value */
const plain = value => JSON.parse(JSON.stringify(value));
/** @param {number} n */
const hex2 = n => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();

/** @param {KeyframeValue} v @returns {SpecValue} */
function valueOut(v) {
  if (v.type === 'FLOAT') return round(v.value, 4);
  if (v.type === 'BOOL') return v.value;
  if (v.type === 'VECTOR') return [round(v.value.x, 4), round(v.value.y, 4)];
  if (v.type === 'COLOR') return '#' + [v.value.r, v.value.g, v.value.b].map(hex2).join('') + (v.value.a < 1 ? hex2(v.value.a) : '');
  return plain(v);
}
/** @param {unknown} v @returns {KeyframeValue} */
function valueIn(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return { type: 'FLOAT', value: v };
  if (typeof v === 'boolean') return { type: 'BOOL', value: v };
  if (Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number')) return { type: 'VECTOR', value: { x: v[0], y: v[1] } };
  if (typeof v === 'string' && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
    const [r, g, b, a = 255] = /** @type {RegExpMatchArray} */ (v.slice(1).match(/../g)).map(h => parseInt(h, 16));
    return { type: 'COLOR', value: { r: r / 255, g: g / 255, b: b / 255, a: a / 255 } };
  }
  if (v && typeof v === 'object' && typeof (/** @type {{ type?: unknown }} */ (v)).type === 'string') return /** @type {KeyframeValue} */ (v);
  throw Error(`Unrecognized keyframe value: ${JSON.stringify(v)}`);
}

// Track paths: plain property names (OPACITY), fills.0 or strokes.1 for paints, effects.0.RADIUS for effects, and fills.0.properties.<property ID> for component properties.
/** @param {string} path @returns {KeyframeField} */
function field(path) {
  const [head, index, kind, ...rest] = path.split('.');
  if (index === undefined && /^[A-Z_]+$/.test(head)) return /** @type {KeyframeField} */ ({ type: 'PROPERTY', name: head });
  if (COLLECTIONS.includes(head) && /^\d+$/.test(index ?? '')) {
    const item = { type: 'INDEXED_ITEM', collection: head, index: Number(index) };
    if (kind === 'properties' && rest.length) return /** @type {KeyframeField} */ ({ ...item, propertyId: rest.join('.') });
    if (kind === undefined && head !== 'effects') return /** @type {KeyframeField} */ (item);
    if (kind !== undefined && head === 'effects' && !rest.length) return /** @type {KeyframeField} */ ({ ...item, field: kind });
  }
  throw Error(`Unrecognized track: ${path}`);
}
/** @param {any} x @returns {x is ManualKeyframeBinding} */
const isBinding = x => !!x && Array.isArray(x.keyframes);
// Flatten nested manualKeyframeTracks records into [path, track] pairs.
/** @param {ManualKeyframeTracks} tracks @returns {[string, ManualKeyframeBinding][]} */
function flatten(tracks) {
  /** @type {[string, ManualKeyframeBinding][]} */
  const out = [];
  /** @param {string} prefix @param {any} value */
  const walk = (prefix, value) => {
    if (isBinding(value)) { out.push([prefix, value]); return; }
    if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) walk(`${prefix}.${key}`, inner);
  };
  for (const [key, value] of Object.entries(tracks)) walk(key, value);
  return out;
}

// -- Context: variables, presets and custom styles -----------------------
/** @param {Record<string, string>} [refs] */
async function context(refs = {}) {
  const available = figma.motion.figmaAnimationStyles();
  const easingVars = await figma.variables.getLocalVariablesAsync('EASING');
  const customStyles = await figma.getLocalCustomAnimationStylesAsync();
  /** @type {Record<string, string>} */
  const out = {};
  /** @type {Map<string, string>} */
  const names = new Map();
  // Disambiguate duplicate tokens (such as local and library variables sharing a name) with IDs, preventing incorrect bindings on write.
  /** @param {string} sign @param {string} name @param {string} id */
  const token = (sign, name, id) => {
    let t = sign + name;
    if (out[t] !== undefined && out[t] !== id) t = `${sign}${name}#${id}`;
    out[t] = id; return t;
  };
  return {
    refs: out,
    easingTokens: easingVars.map(v => '$' + v.name),
    /** @param {string} id */
    async variable(id) {
      if (!names.has(id)) names.set(id, (await figma.variables.getVariableByIdAsync(id))?.name ?? id);
      return token('$', /** @type {string} */ (names.get(id)), id);
    },
    /** @param {string} name @param {string} id */
    style: (name, id) => token('@', name, id),
    /** @param {string} name Name of an applied style, such as motion.preset_name.opacity. */
    presetOf: name => available.find(s => s.name === name)?.styleId ?? name,
    /** @param {string} preset @returns {Record<string, unknown>} Preset parameter defaults parsed from "// default: ..." in the description string. */
    defaults(preset) {
      /** @type {Record<string, unknown>} */
      const d = {};
      for (const [key, text] of Object.entries(available.find(s => s.styleId === preset)?.props ?? {})) {
        const m = /\/\/ default: (?:'([^']*)'|"([^"]*)"|(true|false)|(-?\d+(?:\.\d+)?))/.exec(text);
        if (m) d[key] = m[1] ?? m[2] ?? (m[3] ? m[3] === 'true' : Number(m[4]));
      }
      return d;
    },
    /** @param {string} preset */
    presetId(preset) {
      if (!available.some(s => s.styleId === preset)) throw Error(`No preset named ${preset}; available: ${available.map(s => s.styleId).join(', ')}`);
      return preset;
    },
    /** @param {string} t $variableName */
    variableId(t) {
      const id = refs[t] ?? easingVars.find(v => '$' + v.name === t)?.id;
      if (!id) throw Error(`EASING variable ${t} not found: it is not in spec.refs, and no local variable has that name`);
      return id;
    },
    /** @param {string} t @styleName */
    styleId(t) {
      const id = refs[t] ?? customStyles.find(s => '@' + s.name === t)?.id;
      if (!id) throw Error(`Custom animation style ${t} not found: it is not in spec.refs, and no local style has that name`);
      return id;
    }
  };
}
/** @typedef {Awaited<ReturnType<typeof context>>} Context */

/** @param {any} e @param {Context} ctx @returns {Promise<string | object | undefined>} */
async function easingOut(e, ctx) {
  if (!e) return undefined;
  if (e.type === 'VARIABLE_ALIAS') return ctx.variable(e.id);
  if (e.type === 'CUSTOM_CUBIC_BEZIER' && e.easingFunctionCubicBezier) {
    const b = e.easingFunctionCubicBezier;
    return `cubic(${[b.x1, b.y1, b.x2, b.y2].map(n => round(n)).join(',')})`;
  }
  if (e.type === 'CUSTOM_SPRING' && e.easingFunctionSpring) return `spring(${round(e.easingFunctionSpring.bounce)})`;
  return EASINGS[e.type] ?? plain(e);
}
/** @param {unknown} e @param {Context} ctx @returns {any} */
function easingIn(e, ctx) {
  if (typeof e !== 'string') { if (e && typeof e === 'object') return e; throw Error(`Unrecognized easing: ${JSON.stringify(e)}`); }
  const s = e.replace(/\s+/g, '');
  if (s.startsWith('$')) return { type: 'VARIABLE_ALIAS', id: ctx.variableId(e) };
  const cubic = /^cubic\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)$/.exec(s);
  if (cubic) { const [x1, y1, x2, y2] = cubic.slice(1).map(Number); return { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1, y1, x2, y2 } }; }
  const spring = /^spring\(([\d.]+)\)$/.exec(s);
  if (spring) return { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: Number(spring[1]) } };
  if (EASING_TYPES[s]) return { type: EASING_TYPES[s] };
  throw Error(`Unrecognized easing: ${e}; available: ${Object.keys(EASING_TYPES).join(', ')}, cubic(x1,y1,x2,y2), spring(0-1), $variableName`);
}

/** @param {ManualKeyframeBinding} b @param {Context} ctx @returns {Promise<SpecTrack>} */
async function trackOut(b, ctx) {
  const keys = await Promise.all(b.keyframes.map(async k => {
    const e = await easingOut(k.easing, ctx), at = round(k.timelinePosition), value = valueOut(k.value);
    return /** @type {SpecKey} */ (e === undefined || e === DEFAULT_EASING ? [at, value] : [at, value, e]);
  }));
  return { base: valueOut(b.baseValue), keys };
}
/** @param {SpecTrack} t @param {string} path @param {Context} ctx @returns {ManualKeyframeTrackInput} */
function trackIn(t, path, ctx) {
  if (!t || !Array.isArray(t.keys)) throw Error(`Track ${path} requires a keys array`);
  const keyframes = t.keys.map(key => {
    if (!Array.isArray(key) || typeof key[0] !== 'number' || !(key[0] >= 0)) throw Error(`Keyframes of track ${path} must be [seconds, value, easing?] with seconds >= 0: ${JSON.stringify(key)}`);
    return { timelinePosition: key[0], value: valueIn(key[1]), ...(key[2] !== undefined ? { easing: easingIn(key[2], ctx) } : {}) };
  });
  return { ...(t.base !== undefined ? { baseValue: valueIn(t.base) } : {}), keyframes };
}

/** @param {AppliedAnimationStyle} s @param {Context} ctx @returns {Promise<SpecStyle>} */
async function styleOut(s, ctx) {
  const at = round(s.timelineOffset ?? 0);
  if (s.type === 'CUSTOM') return { id: s.id, style: ctx.style(s.name, s.styleId), at };
  const preset = ctx.presetOf(s.name), props = /** @type {Record<string, unknown>} */ ({ ...(s.props ?? {}) }), defaults = ctx.defaults(preset);
  const easing = await easingOut(props.easing, ctx);
  delete props.easing;
  // Preset delay follows timelineOffset in observed behavior, already represented by at.
  if (typeof props.delay === 'number' && round(props.delay) === at) delete props.delay;
  for (const [key, value] of Object.entries(props)) if (key in defaults && canon(roundDeep(value)) === canon(defaults[key])) delete props[key];
  return { id: s.id, preset, at, dur: round(s.duration ?? 0), ...(easing !== undefined ? { easing } : {}), ...(Object.keys(props).length ? { props: roundDeep(props) } : {}) };
}
/** @param {SpecStyle} s @param {Context} ctx @returns {[string, AnimationStyleConfiguration]} */
function styleIn(s, ctx) {
  const at = s.at ?? 0;
  if (!(at >= 0)) throw Error(`Animation style "at" must be >= 0: ${JSON.stringify(s)}`);
  if (s.style !== undefined) return [ctx.styleId(s.style), { type: 'CUSTOM', timelineOffset: at }];
  if (typeof s.preset !== 'string' || !(typeof s.dur === 'number' && s.dur >= 0)) throw Error(`A preset requires preset and a dur >= 0: ${JSON.stringify(s)}`);
  const props = /** @type {Record<string, any>} */ ({ ...(s.props ?? {}) });
  if (s.easing !== undefined) props.easing = easingIn(s.easing, ctx);
  return [ctx.presetId(s.preset), { duration: s.dur, timelineOffset: at, ...(Object.keys(props).length ? { props } : {}) }];
}
/** @param {SpecStyle} s Shape without ID, used for comparison. */
const styleShape = ({ id: _, ...rest }) => canon({ at: 0, ...rest });

// -- Reading ------------------------------------------------------------
// Motion for one node: include tracks or styles only when present. Shared by readMotion and applyMotion's instance-layer validation.
/** @param {SceneNode} node @param {Context} ctx @returns {Promise<Pick<SpecNode, 'tracks' | 'styles'>>} */
async function motionOf(node, ctx) {
  const tracks = flatten(node.manualKeyframeTracks), styles = node.animationStyles;
  return { ...(tracks.length ? { tracks: Object.fromEntries(await Promise.all(tracks.map(async ([path, b]) => [path, await trackOut(b, ctx)]))) } : {}),
    ...(styles.length ? { styles: await Promise.all(styles.map(s => styleOut(s, ctx))) } : {}) };
}
/** @param {Pick<SpecNode, 'tracks' | 'styles'>} m */
const motionShape = m => canon({ tracks: m.tracks ?? {}, styles: m.styles ?? [] });

// Group animated nodes in root and its subtree by timeline. Layers inside instances are marked inherited: their motion comes from the corresponding main-component layer and cannot be edited inside the instance.
const readMotion = traced(/** @param {BaseNode} [root] @param {{ durationRange?: [number, number] | null }} [options] @returns {Promise<MotionSpec>} */ async function readMotion(root = target, options = {}) {
  const ctx = await context();
  /** @type {Map<string, SpecTimeline & { nodes: SpecNode[] }>} */
  const groups = new Map();
  /** @param {Timeline} t */
  const group = t => {
    let g = groups.get(t.id);
    if (!g) groups.set(t.id, g = { id: t.id, duration: round(t.duration), nodes: [] });
    return g;
  };
  if ('timelines' in root && root.timelines[0]) group(root.timelines[0]);
  for (const node of [root, ...('findAll' in root ? root.findAll() : [])]) {
    if (!('manualKeyframeTracks' in node) || !node.timelines[0]) continue;
    const motion = await motionOf(node, ctx);
    if (motion.tracks || motion.styles) group(node.timelines[0]).nodes.push({ id: node.id, name: node.name, ...(node.id.startsWith('I') ? { inherited: /** @type {true} */ (true) } : {}), ...motion });
  }
  const timelines = await Promise.all([...groups.values()].map(async g => ({ id: g.id, name: (await figma.getNodeByIdAsync(g.id))?.name, duration: g.duration, nodes: g.nodes })));
  /** @type {MotionSpec} */
  const spec = { timelines, ...(Object.keys(ctx.refs).length ? { refs: ctx.refs } : {}) };
  spec.issues = motionIssues(spec, { easingTokens: ctx.easingTokens, ...options });
  return spec;
});

// -- Writing ------------------------------------------------------------
// Declarative writes: when a listed node supplies tracks, synchronize them (delete extras, rewrite changes, leave equal tracks); styles work likewise, matched by ID, replacing changed parameters and assigning no ID to new applications.
// Omitted keys and unlisted nodes are untouched. Instance layers (marked inherited by readMotion), components and component sets are skipped if unchanged and rejected only if edited, allowing a full read spec to round-trip.
// Parse all nodes and parameters before writing, rejecting invalid input first. Observed Figma behavior forbids plugin motion writes on components, component sets and instance layers, including newly created components.
// Component child layers and instances themselves are writable; instance children inherit their main-component motion. The unwritable categories above are rejected before mutation. These Beta rules may change,
// so every write still records an inverse operation; Figma rejection rolls back completed writes in reverse order, leaving no partial motion. Reread and return root after writing.
const applyMotion = traced(/** @param {MotionSpec} [spec] @param {BaseNode} [root] */ async function applyMotion(spec = data, root = target) {
  if (!spec || !Array.isArray(spec.timelines)) throw Error('applyMotion requires a spec shaped like readMotion output: { timelines: [...] }');
  const ctx = await context(spec.refs);
  const plan = [], durations = [];
  for (const timeline of spec.timelines) {
    for (const entry of timeline.nodes ?? []) {
      const node = await figma.getNodeByIdAsync(entry.id);
      if (!node || !('manualKeyframeTracks' in node)) throw Error(`Node does not exist or does not support motion: ${entry.id}`);
      const locked = node.id.startsWith('I') ? `${node.name} (${node.id}) is inside an instance; its motion is inherited from the matching layer in the main component, and Figma does not allow editing it in the instance: edit that layer in the main component (all instances inherit it), or, to change only this one, detach the instance into plain layers and then write`
        : node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' ? `${node.name} (${node.id}) is a ${node.type === 'COMPONENT' ? 'component' : 'component set'} itself, and Figma does not allow plugins to write motion to it: write to its child layers (instances inherit them) or to the instance itself` : '';
      if (locked) {
        if (motionShape(await motionOf(node, ctx)) === motionShape(entry)) continue;
        throw Error(locked);
      }
      const tracks = entry.tracks && Object.entries(entry.tracks).map(([path, t]) => /** @type {const} */ ([path, field(path), trackIn(t, path, ctx), canon(t)]));
      const styles = entry.styles && entry.styles.map(s => /** @type {const} */ ([s, styleIn(s, ctx)]));
      plan.push({ node, tracks, styles });
    }
    if (timeline.duration !== undefined) {
      if (!(typeof timeline.duration === 'number' && timeline.duration > 0)) throw Error(`Timeline ${timeline.id} duration must be > 0`);
      const owner = await figma.getNodeByIdAsync(timeline.id) ?? plan.find(p => p.node.timelines[0]?.id === timeline.id)?.node;
      if (!owner || !('setTimelineDuration' in owner)) throw Error(`Cannot find the node that owns timeline ${timeline.id}`);
      durations.push(/** @type {const} */ ([owner, timeline.id, timeline.duration]));
    }
  }
  const changes = { tracksWritten: 0, tracksRemoved: 0, stylesApplied: 0, stylesRemoved: 0, durations: 0 }, undo = /** @type {(() => void)[]} */ ([]);
  let at = '';
  try {
    for (const { node, tracks, styles } of plan) {
      at = `${node.name} (${node.id})`;
      if (tracks) {
        const current = new Map(await Promise.all(flatten(node.manualKeyframeTracks).map(async ([path, b]) => /** @type {const} */ ([path, await trackOut(b, ctx)]))));
        /** @param {string} path State before writing or deletion. */
        const restore = path => { const old = current.get(path); return old ? () => node.applyManualKeyframeTrack(field(path), trackIn(old, path, ctx)) : () => node.removeManualKeyframeTrack(field(path)); };
        for (const path of current.keys()) if (!tracks.some(([p]) => p === path)) { node.removeManualKeyframeTrack(field(path)); undo.push(restore(path)); changes.tracksRemoved++; }
        for (const [path, f, input, shape] of tracks) {
          const old = current.get(path);
          if (old && canon(old) === shape) continue;
          node.applyManualKeyframeTrack(f, input); undo.push(restore(path)); changes.tracksWritten++;
        }
      }
      if (styles) {
        const before = await Promise.all(node.animationStyles.map(s => styleOut(s, ctx)));
        const kept = new Set(styles.filter(([s]) => s.id !== undefined && before.some(b => b.id === s.id && styleShape(b) === styleShape(s))).map(([s]) => s.id));
        for (const old of before) if (!kept.has(old.id)) {
          node.removeAnimationStyle(/** @type {string} */ (old.id)); changes.stylesRemoved++;
          undo.push(() => node.applyAnimationStyle(...styleIn(old, ctx)));
        }
        for (const [s, [id, config]] of styles) if (!kept.has(s.id)) {
          const had = new Set(node.animationStyles.map(a => a.id));
          node.applyAnimationStyle(id, config); changes.stylesApplied++;
          const added = node.animationStyles.find(a => !had.has(a.id))?.id;
          if (added) undo.push(() => node.removeAnimationStyle(added));
        }
      }
    }
    for (const [owner, id, duration] of durations) {
      const old = owner.timelines.find(t => t.id === id)?.duration;
      if (round(old ?? -1) === round(duration)) continue;
      at = `timeline (${id})`;
      owner.setTimelineDuration(id, duration); changes.durations++;
      if (old !== undefined) undo.push(() => owner.setTimelineDuration(id, old));
    }
  } catch (error) {
    const failed = /** @type {string[]} */ ([]);
    for (const step of undo.reverse()) try { step(); } catch (e) { failed.push(String(e?.message ?? e)); }
    const message = String(error?.message ?? error);
    const hint = /product components|instance sublayers/.test(message) ? ' (plugins cannot write motion to components, component sets themselves, or layers inside instances: write to the child layers of the component or to the instance itself)' : '';
    const rollback = !undo.length ? 'nothing had been written before' : failed.length ? `rolled back ${undo.length - failed.length} change(s), ${failed.length} rollback(s) failed (${failed[0]}); verify with readMotion first` : `rolled back ${undo.length} earlier change(s)`;
    throw Error(`Figma rejected the write to ${at}: ${message}${hint}; ${rollback}`);
  }
  return { changes, motion: await readMotion(root) };
});

// -- Exporting ----------------------------------------------------------
// Video export requires a top-level frame (children report Cannot export node as video in observed behavior), so resolve it first. Figma video export can lag document changes:
// new frames initially report Video export failed, while edited frames may export byte-identical stale video. Updates can appear immediately or take minutes; the trigger is unknown.
// Retry Video export failed at intervals. When differentFrom contains pre-edit bytes, also retry identical exports until the change appears. Exceeding waitSeconds throws an explanatory error.
// Default to low-quality WebM: fastest, decodable by Chrome, and suitable for frames extraction.
const exportMotion = traced(/** @param {BaseNode} [node] @param {ExportSettingsMP4 | ExportSettingsGIF | ExportSettingsWEBM} [settings] @param {{ waitSeconds?: number, intervalMs?: number, differentFrom?: Uint8Array }} [options] */ async function exportMotion(node = target, settings = { format: 'WEBM', quality: 'LOW' }, { waitSeconds = 60, intervalMs = 3000, differentFrom } = {}) {
  const frame = node.parent?.type === 'PAGE' && node.type === 'FRAME' ? node : 'getTopLevelFrame' in node ? node.getTopLevelFrame() : undefined;
  if (!frame) throw Error(`${node.name} (${node.id}) is not inside a top-level frame: video can only be exported from frames placed directly on a page`);
  const started = Date.now(), seconds = () => Math.round((Date.now() - started) / 1000);
  for (let attempts = 1; ; attempts++) {
    const late = Date.now() - started + intervalMs > waitSeconds * 1000;
    let video;
    try { video = await frame.exportAsync(settings); }
    catch (error) {
      const message = String(error?.message ?? error);
      if (!/Video export failed/.test(message)) throw error;
      if (late) throw Error(`Figma refused to export video (${message}) after ${attempts} attempt(s) over ${seconds()} s: a newly created frame can be exported only after Figma has processed it, which took 15 s to over 2 min in tests. Call exportMotion again on the same frame later; do not recreate the frame`);
    }
    if (video && !(differentFrom && video.length === differentFrom.length && video.every((byte, i) => byte === differentFrom[i])))
      return { frame: frame.id, video, attempts, waitedMs: Date.now() - started };
    if (video && late) throw Error(`Exported video is byte-identical to differentFrom after ${attempts} attempt(s) over ${seconds()} s: Figma video export lags behind changes (up to several minutes in tests), or this change does not alter the visuals. Export again later to verify`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
});

// -- Diagnostics --------------------------------------------------------
// Report issues without changing data. beyond-timeline and first-key-easing reflect observed pitfalls; durationRange overrides the common interaction-duration range, or null disables it. Other checks concern consistency.
/** @param {MotionSpec} spec @param {{ durationRange?: [number, number] | null, easingTokens?: string[] }} [options] @returns {Issue[]} */
function motionIssues(spec, { durationRange = [0.1, 0.5], easingTokens = [] } = {}) {
  /** @type {Issue[]} */
  const issues = [];
  for (const tl of spec.timelines ?? []) {
    const duration = tl.duration ?? Infinity, presets = /** @type {{ node: SpecNode, style: SpecStyle }[]} */ ([]);
    let raw = 0;
    /** @type {string[]} */
    const outOfRange = [];
    /** @param {string} rule @param {SpecNode | null} node @param {string} message */
    const add = (rule, node, message) => issues.push({ rule, timeline: tl.id, ...(node ? { node: node.id } : {}), message });
    /** @param {SpecNode} node @param {string} what @param {number} start @param {number} end */
    const range = (node, what, start, end) => {
      const d = end - start;
      if (durationRange && (d < durationRange[0] - EPSILON || d > durationRange[1] + EPSILON)) outOfRange.push(`${what} on ${node.name ?? node.id}: ${round(d)} s from ${round(start)} s`);
    };
    for (const node of tl.nodes ?? []) {
      const label = node.name ?? node.id, tracks = Object.entries(node.tracks ?? {});
      for (const [path, t] of tracks) {
        const keys = t.keys ?? [], first = keys[0], last = keys[keys.length - 1];
        if (keys.length < 2) add('static-track', node, `${path} on ${label} has only ${keys.length} keyframe(s) and will not animate`);
        // Constant-value segments (pauses) and hold easing (steps) are not motion. They divide tracks into animation segments whose durations and easing are checked separately.
        const moving = keys.map((k, i) => i > 0 && canon(k[1]) !== canon(keys[i - 1][1]) && k[2] !== 'hold');
        for (let i = 1; i < keys.length; i++) if (moving[i] && !moving[i + 1]) {
          let j = i; while (moving[j - 1]) j--;
          range(node, path, keys[j - 1][0], keys[i][0]);
        }
        if (last && last[0] > duration + EPSILON) add('beyond-timeline', node, `${path} on ${label} has a keyframe at ${last[0]} s, beyond the ${duration} s timeline: the excess does not play and is cut off on export`);
        if (first && first[2] !== undefined) add('first-key-easing', node, `${path} on ${label}: first-keyframe easing ${JSON.stringify(first[2])} has no effect; easing applies to the segment ending at that keyframe, so set the first segment's easing on the second keyframe`);
        raw += keys.filter((k, i) => moving[i] && !(typeof k[2] === 'string' && k[2].startsWith('$'))).length;
      }
      for (const style of node.styles ?? []) {
        if (style.style !== undefined) continue;
        presets.push({ node, style });
        const end = (style.at ?? 0) + (style.dur ?? 0);
        if (end > duration + EPSILON) add('beyond-timeline', node, `${style.preset} preset on ${label} ends at ${round(end)} s, beyond the ${duration} s timeline`);
        range(node, `${style.preset} preset`, style.at ?? 0, end);
        if (style.easing !== 'hold' && !(typeof style.easing === 'string' && style.easing.startsWith('$'))) raw++;
        const fields = PRESET_FIELDS[style.preset ?? ''] ?? [], clash = tracks.map(([path]) => path).filter(path => fields.includes(path));
        if (clash.length) add('track-conflict', node, `${style.preset} preset on ${label} and manual track(s) ${clash.join(', ')} drive the same property`);
      }
      const own = presets.filter(p => p.node === node);
      for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) {
        const a = own[i].style, b = own[j].style;
        if (a.preset === b.preset && (a.at ?? 0) < (b.at ?? 0) + (b.dur ?? 0) - EPSILON && (b.at ?? 0) < (a.at ?? 0) + (a.dur ?? 0) - EPSILON)
          add('track-conflict', node, `${label} has two ${a.preset} presets that overlap in time`);
      }
    }
    // Duration ranges are advisory; aggregate them per timeline to avoid burying other issues.
    if (outOfRange.length) add('duration-range', null, `${tl.name ?? tl.id} has ${outOfRange.length} animation segment(s) outside the common interaction motion duration of ${durationRange?.[0]}-${durationRange?.[1]} s: ${outOfRange.slice(0, 8).join(', ')}${outOfRange.length > 8 ? ', ...' : ''}`);
    // Trailing idle time leaves a long still frame after animation ends during looping and export. Skip this check when custom styles are present because their duration cannot be read.
    const ends = (tl.nodes ?? []).flatMap(n => [...Object.values(n.tracks ?? {}).map(t => t.keys?.[t.keys.length - 1]?.[0] ?? 0), ...(n.styles ?? []).map(s => s.style !== undefined ? Infinity : (s.at ?? 0) + (s.dur ?? 0))]);
    const end = Math.max(...ends), tail = duration - end;
    if (ends.length && Number.isFinite(end) && tail > 0.5 && tail > duration * 0.25) add('idle-tail', null, `${tl.name ?? tl.id} animation ends at ${round(end)} s, leaving ${round(tail)} s of static timeline; if no hold is needed, set the duration to ${round(end)} s`);
    if (easingTokens.length && raw) add('raw-easing', null, `${tl.name ?? tl.id} has ${raw} easing(s) not bound to an EASING variable (linear for constant rotation and similar is a valid choice; decide by intent); the file has: ${easingTokens.slice(0, 5).join(', ')}${easingTokens.length > 5 ? ', ...' : ''}`);
    // The same preset and type imply the same role and should use consistent easing; three or more equal-duration nodes are treated as a staggered sequence and should have even spacing.
    /** @type {Map<string, typeof presets>} */
    const roles = new Map();
    for (const p of presets) { const key = `${p.style.preset}|${String(p.style.props?.type ?? '')}`; roles.set(key, [...(roles.get(key) ?? []), p]); }
    for (const [key, list] of roles) {
      const easings = [...new Set(list.map(p => JSON.stringify(p.style.easing ?? null)))];
      if (easings.length > 1) add('inconsistent-easing', null, `${key.replace(/\|$/, '')} preset uses ${easings.length} different easings: ${easings.join(', ')}`);
      /** @type {Map<number, number[]>} */
      const byDur = new Map();
      for (const p of list) byDur.set(p.style.dur ?? 0, [...(byDur.get(p.style.dur ?? 0) ?? []), p.style.at ?? 0]);
      for (const offsets of byDur.values()) {
        if (offsets.length < 3) continue;
        const sorted = [...offsets].sort((a, b) => a - b), gaps = sorted.slice(1).map((t, i) => round(t - sorted[i]));
        if (Math.max(...gaps) > 0 && Math.max(...gaps) - Math.min(...gaps) > 0.01) add('irregular-stagger', null, `${key.replace(/\|$/, '')} preset staggers ${offsets.length} nodes at uneven intervals: ${gaps.join(', ')} s`);
      }
    }
  }
  return issues;
}
