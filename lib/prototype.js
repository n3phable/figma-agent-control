/**
 * [INPUT]: Uses figma and target injected by run: Plugin API reactions and setReactionsAsync from ReactionMixin, PageNode.flowStartingPoints,
 *          read-only frame overlay settings, getMainComponentAsync and figma.variables variable types. Type checking uses ./env.d.ts and @figma/plugin-typings.
 * [OUTPUT]: Functions in the script's enclosing scope: readPrototype(root?) -> PrototypeSpec, applyPrototype(spec?, root?) -> { changes, prototype }, prototypeIssues(spec, root?) -> Issue[].
 * [POS]: Prototype library loaded by run --lib prototype, following motion.js's read-edit-write workflow. Encodes reactions as shorthand alongside flow starts, target names and frames,
 *        interaction edges and diagnostics in a round-trippable spec. Declarative writes validate everything first, update only changed nodes using actions, and roll back in reverse order on Figma rejection.
 *        Overlay settings are read-only in Plugin API and are never written. Section comments document observed host behavior. main.js has no knowledge of this library; writes retain run's write-ahead log, Undo boundaries and change set.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */

/**
 * @typedef {string | { url: string, newTab?: true } | { [verb: string]: unknown }} SpecAction  back, close, {url}, or {navigate|swap|overlay|scroll-to|change-to: targetID, transition?, position?, resetScroll?, resetComponents?, resetVideo?}; other actions retain the original object.
 * @typedef {{ on: string | object | null, do: SpecAction[] }} SpecReaction
 * @typedef {{ id: string, name?: string, frame?: string, reactions: SpecReaction[] }} SpecNode
 * @typedef {{ name: string, frame?: string, page?: string, missing?: true }} SpecTarget
 * @typedef {{ overlayPositionType: string, overlayBackground: unknown, overlayBackgroundInteraction: string }} SpecOverlay
 * @typedef {{ from: string, fromFrame?: string, on: SpecReaction['on'], nav: string, to: string, toFrame?: string }} SpecEdge
 * @typedef {{ rule: string, level: 'error' | 'warning', node?: string, message: string }} Issue
 * @typedef {{ root?: { id: string, name: string, type: string }, page?: string, flows?: { nodeId: string, name: string }[], nodes: SpecNode[],
 *   targets?: Record<string, SpecTarget>, frames?: Record<string, string>, overlays?: Record<string, SpecOverlay>, edges?: SpecEdge[], issues?: Issue[] }} PrototypeSpec
 */

// -- Caller stacks ------------------------------------------------------
// As in motion.js, QuickJS lacks async stacks. Public async functions capture the entry stack and append it to errors so traces reach the script. Each library has its own scope and helper copy.
/** @template {(...args: any[]) => Promise<any>} F @param {F} fn @returns {F} */
const traced = fn => /** @type {F} */ (async (/** @type {any[]} */ ...args) => {
  const caller = String(Error().stack ?? '').split('\n').filter(line => /^\s*at /.test(line)).slice(1).join('\n');
  try { return await fn(...args); }
  catch (error) { try { if (error instanceof Error && caller) error.stack = `${error.stack ?? ''}\n${caller}`; } catch (_) { /* Still throw if stack is read-only.*/ } throw error; }
});

/** @param {number} n */
const round = (n, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
/** @param {any} value @returns {any} */
const roundDeep = value => typeof value === 'number' ? round(value, 4) : Array.isArray(value) ? value.map(roundDeep)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)])) : value;
/** @param {unknown} value */
const canon = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);
/** @param {unknown} value @returns {any} */
const plain = value => JSON.parse(JSON.stringify(value));
/** @param {Record<string, string>} o */
const invert = o => /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k])));
/** @param {string} s */
const num = s => /^\d+(?:\.\d+)?$/.test(s ?? '') ? Number(s) : NaN;

// -- Notation -----------------------------------------------------------
// Triggers: click, hover, press, drag, media-end; timed forms use seconds, such as `after 0.8` or `mouse-enter 0.2` (observed API value 0.8 displays as 800ms in the Prototype panel;
// the official Trigger documentation incorrectly says milliseconds). Keys use `key KEYBOARD 16,65`. Omit deprecatedVersion for MOUSE_ENTER/LEAVE: typings include it, but runtime reports Unrecognized key.
const TRIGGERS = /** @type {Record<string, string>} */ ({ ON_CLICK: 'click', ON_HOVER: 'hover', ON_PRESS: 'press', ON_DRAG: 'drag', ON_MEDIA_END: 'media-end' });
const TRIGGER_TYPES = invert(TRIGGERS);
const TIMED = /** @type {Record<string, [string, string]>} */ ({ AFTER_TIMEOUT: ['after', 'timeout'], MOUSE_ENTER: ['mouse-enter', 'delay'], MOUSE_LEAVE: ['mouse-leave', 'delay'],
  MOUSE_UP: ['mouse-up', 'delay'], MOUSE_DOWN: ['mouse-down', 'delay'], ON_MEDIA_HIT: ['media-hit', 'mediaHitTime'] });
// Actions: encode NODE navigation as one verb key whose value is the target ID.
const NAVIGATIONS = /** @type {Record<string, string>} */ ({ NAVIGATE: 'navigate', SWAP: 'swap', OVERLAY: 'overlay', SCROLL_TO: 'scroll-to', CHANGE_TO: 'change-to' });
const NAVIGATION_TYPES = invert(NAVIGATIONS);
const FLAGS = /** @type {Record<string, string>} */ ({ resetScroll: 'resetScrollPosition', resetComponents: 'resetInteractiveComponents', resetVideo: 'resetVideoPosition' });
// Transitions: `smart-animate 0.3 ease-out`, `push left 0.3 spring(1,300,20) match` (match means matchLayers). Easing names match motion; prototype springs accept only
// {mass, stiffness, damping} (both initialVelocity from typings and Motion's {bounce} produce Unrecognized key in observed behavior), encoded as spring(mass,stiffness,damping).
const EASINGS = /** @type {Record<string, string>} */ ({ LINEAR: 'linear', EASE_IN: 'ease-in', EASE_OUT: 'ease-out', EASE_IN_AND_OUT: 'ease-in-out',
  EASE_IN_BACK: 'ease-in-back', EASE_OUT_BACK: 'ease-out-back', EASE_IN_AND_OUT_BACK: 'ease-in-out-back', GENTLE: 'gentle', QUICK: 'quick', BOUNCY: 'bouncy', SLOW: 'slow' });
const EASING_TYPES = invert(EASINGS);
const SIMPLE = ['DISSOLVE', 'SMART_ANIMATE', 'SCROLL_ANIMATE'], DIRECTIONAL = ['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'];
/** @param {string} s */
const kebab = s => s.toLowerCase().replace(/_/g, '-');

/** @param {Trigger | null} t @returns {SpecReaction['on']} */
function triggerOut(t) {
  if (!t) return null;
  if (TRIGGERS[t.type]) return TRIGGERS[t.type];
  const timed = TIMED[t.type];
  if (timed) return `${timed[0]} ${round(/** @type {any} */ (t)[timed[1]] ?? 0)}`;
  if (t.type === 'ON_KEY_DOWN') return `key ${t.device} ${t.keyCodes.join(',')}`;
  return plain(t);
}
/** @param {unknown} on @returns {Trigger | null} */
function triggerIn(on) {
  if (on === null || (on && typeof on === 'object')) return /** @type {Trigger | null} */ (on);
  if (typeof on === 'string') {
    const [word, a, b, ...rest] = on.trim().split(/\s+/);
    if (TRIGGER_TYPES[word] && a === undefined) return /** @type {Trigger} */ ({ type: TRIGGER_TYPES[word] });
    const timed = Object.entries(TIMED).find(([, [w]]) => w === word);
    if (timed && b === undefined && num(a) >= 0) return /** @type {Trigger} */ ({ type: timed[0], [timed[1][1]]: num(a) });
    const codes = (b ?? '').split(',').map(Number);
    if (word === 'key' && a && b && !rest.length && codes.every(Number.isInteger)) return /** @type {Trigger} */ ({ type: 'ON_KEY_DOWN', device: a, keyCodes: codes });
  }
  throw Error(`Unknown trigger: ${JSON.stringify(on)}; use ${Object.keys(TRIGGER_TYPES).join(', ')}, after <s>, mouse-enter|mouse-leave|mouse-up|mouse-down <s>, media-hit <s>, key KEYBOARD <code>,<code>`);
}

/** @param {Easing | undefined} e @returns {string | undefined} */
function easingOut(e) {
  if (!e) return undefined;
  if (e.type === 'CUSTOM_CUBIC_BEZIER' && e.easingFunctionCubicBezier) { const b = e.easingFunctionCubicBezier; return `cubic(${[b.x1, b.y1, b.x2, b.y2].map(n => round(n)).join(',')})`; }
  if (e.type === 'CUSTOM_SPRING' && e.easingFunctionSpring) { const s = e.easingFunctionSpring; return `spring(${[s.mass, s.stiffness, s.damping].map(n => round(n)).join(',')})`; }
  return EASINGS[e.type];
}
/** @param {string} s @returns {Easing} */
function easingIn(s) {
  const cubic = /^cubic\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)$/.exec(s);
  if (cubic) { const [x1, y1, x2, y2] = cubic.slice(1).map(Number); return { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1, y1, x2, y2 } }; }
  const spring = /^spring\(([\d.]+),([\d.]+),([\d.]+)\)$/.exec(s);
  if (spring) { const [mass, stiffness, damping] = spring.slice(1).map(Number); return /** @type {Easing} */ ({ type: 'CUSTOM_SPRING', easingFunctionSpring: { mass, stiffness, damping } }); }
  if (EASING_TYPES[s]) return /** @type {Easing} */ ({ type: EASING_TYPES[s] });
  throw Error(`Unknown easing: ${s}; use ${Object.keys(EASING_TYPES).join(', ')}, cubic(x1,y1,x2,y2), spring(mass,stiffness,damping)`);
}
/** @param {Transition} t @returns {string | object} */
function transitionOut(t) {
  const easing = easingOut(t.easing);
  if (!easing || ![...SIMPLE, ...DIRECTIONAL].includes(t.type)) return plain(t);
  const dir = 'direction' in t ? ` ${t.direction.toLowerCase()}` : '';
  return `${kebab(t.type)}${dir} ${round(t.duration)} ${easing}${'matchLayers' in t && t.matchLayers ? ' match' : ''}`;
}
/** @param {unknown} s @returns {Transition} */
function transitionIn(s) {
  if (s && typeof s === 'object') return /** @type {Transition} */ (s);
  const parts = typeof s === 'string' ? s.trim().replace(/\s*([(),])\s*/g, '$1').split(/\s+/) : [];
  const type = (parts[0] ?? '').toUpperCase().replace(/-/g, '_');
  if (SIMPLE.includes(type) && parts.length === 3 && num(parts[1]) >= 0) return /** @type {Transition} */ ({ type, easing: easingIn(parts[2]), duration: num(parts[1]) });
  const direction = (parts[1] ?? '').toUpperCase();
  if (DIRECTIONAL.includes(type) && ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'].includes(direction) && num(parts[2]) >= 0 && (parts.length === 4 || (parts.length === 5 && parts[4] === 'match')))
    return /** @type {Transition} */ ({ type, direction, matchLayers: parts[4] === 'match', easing: easingIn(parts[3]), duration: num(parts[2]) });
  throw Error(`Unknown transition: ${JSON.stringify(s)}; write "<type> <s> <easing>" (${SIMPLE.map(kebab).join(', ')}) or "<type> <direction> <s> <easing> [match]" (${DIRECTIONAL.map(kebab).join(', ')})`);
}

/** @param {Action} a @returns {SpecAction} */
function actionOut(a) {
  if (a.type === 'BACK' || a.type === 'CLOSE') return a.type.toLowerCase();
  if (a.type === 'URL') return { url: a.url, ...(a.openInNewTab ? { newTab: /** @type {true} */ (true) } : {}) };
  if (a.type === 'NODE' && NAVIGATIONS[a.navigation]) {
    /** @type {Record<string, unknown>} */
    const out = { [NAVIGATIONS[a.navigation]]: a.destinationId };
    if (a.transition) out.transition = transitionOut(a.transition);
    if (a.overlayRelativePosition) out.position = [round(a.overlayRelativePosition.x, 4), round(a.overlayRelativePosition.y, 4)];
    // Reads always include resetVideoPosition: false; retain only enabled flags.
    for (const [short, key] of Object.entries(FLAGS)) if (/** @type {any} */ (a)[key]) out[short] = true;
    return out;
  }
  return roundDeep(plain(a));
}
/** @param {unknown} x @returns {Action} */
function actionIn(x) {
  if (x === 'back' || x === 'close') return { type: x === 'back' ? 'BACK' : 'CLOSE' };
  if (x && typeof x === 'object') {
    const o = /** @type {Record<string, any>} */ (x), verbs = Object.keys(o).filter(k => NAVIGATION_TYPES[k]);
    if ('url' in o && typeof o.url === 'string' && Object.keys(o).every(k => k === 'url' || k === 'newTab')) return { type: 'URL', url: o.url, ...(o.newTab ? { openInNewTab: true } : {}) };
    if (verbs.length === 1) {
      const extra = Object.keys(o).filter(k => k !== verbs[0] && k !== 'transition' && k !== 'position' && !FLAGS[k]);
      if (extra.length) throw Error(`Unknown action key ${extra.join(', ')}: ${JSON.stringify(x)}`);
      const position = o.position;
      if (position !== undefined && !(Array.isArray(position) && position.length === 2 && position.every(n => typeof n === 'number'))) throw Error(`position must be [x, y]: ${JSON.stringify(x)}`);
      return /** @type {Action} */ ({ type: 'NODE', destinationId: o[verbs[0]], navigation: NAVIGATION_TYPES[verbs[0]], transition: o.transition === undefined ? null : transitionIn(o.transition),
        ...(position ? { overlayRelativePosition: { x: position[0], y: position[1] } } : {}),
        ...Object.fromEntries(Object.entries(FLAGS).filter(([short]) => o[short] !== undefined).map(([short, key]) => [key, !!o[short]])) });
    }
    if (typeof o.type === 'string' && !verbs.length) return /** @type {Action} */ (o);
  }
  throw Error(`Unknown action: ${JSON.stringify(x)}; use back, close, {url, newTab?}, {${Object.keys(NAVIGATION_TYPES).join('|')}: targetId, transition?}, or a raw action object with type`);
}

// Figma returns both deprecated action (= actions[0]) and actions. Writing only action is rejected; when both are written, actions wins. Read and write actions exclusively.
/** @param {Reaction} r @returns {SpecReaction} */
const reactionOut = r => ({ on: triggerOut(r.trigger), do: (r.actions ?? (r.action ? [r.action] : [])).map(actionOut) });
/** @param {unknown} r @returns {Reaction} */
function reactionIn(r) {
  const o = /** @type {any} */ (r);
  if (!o || typeof o !== 'object' || !('on' in o) || !Array.isArray(o.do)) throw Error(`A reaction must be { on, do: [...] }: ${JSON.stringify(r)}`);
  return { trigger: triggerIn(o.on), actions: o.do.map(actionIn) };
}
// Comparison shape: values are stored as float32 (0.3 reads back as 0.30000001192092896). Rounded values round-trip equally in observed behavior, so compare shorthand to four decimal places.
/** @param {ReadonlyArray<Reaction>} list */
const shape = list => canon(roundDeep(list.map(reactionOut)));
/** @param {Reaction} r @returns {Reaction} */
const writable = ({ action: _, ...rest }) => /** @type {Reaction} */ (plain(rest));
// CONDITIONAL branches contain nested actions that must appear in the interaction graph and diagnostics.
/** @param {ReadonlyArray<Action>} actions @returns {Action[]} */
const flatActions = actions => actions.flatMap(a => a.type === 'CONDITIONAL' ? [a, ...flatActions(a.conditionalBlocks.flatMap(b => b.actions))] : [a]);

// -- Tree ---------------------------------------------------------------
// Prototype "top-level frames" are direct children of a page or Section (Section frames work as NAVIGATE targets in observed behavior). Follow parent links without relying on getTopLevelFrame.
/** @param {BaseNode | null} n */
const holdsScreens = n => !!n && (n.type === 'PAGE' || n.type === 'SECTION');
/** @param {BaseNode} node @returns {BaseNode | null} */
function screenOf(node) {
  let n = node;
  while (n.parent && !holdsScreens(n.parent)) n = n.parent;
  return n.parent ? n : null;
}
/** @param {BaseNode} node @returns {BaseNode | null} */
function pageOf(node) {
  let n = /** @type {BaseNode | null} */ (node);
  while (n && n.type !== 'PAGE') n = n.parent;
  return n;
}
/** @param {BaseNode} n */
const isScreen = n => n.type === 'FRAME' && holdsScreens(n.parent);
/** @param {BaseNode} n @returns {SpecOverlay | null} */
const overlayOf = n => 'overlayPositionType' in n ? roundDeep({ overlayPositionType: n.overlayPositionType, overlayBackground: plain(n.overlayBackground), overlayBackgroundInteraction: n.overlayBackgroundInteraction }) : null;

// -- Reading ------------------------------------------------------------
// Read nodes with reactions in root and its subtree, plus page flow starts, target names and frames, interaction edges and diagnostics. Instance layers return their corresponding main-component reactions;
// include them normally because instance-layer writes create overrides (merged by trigger with the main component in observed behavior). Plugin API overlay settings silently ignore writes; read them only for OVERLAY and SWAP targets.
const readPrototype = traced(/** @param {BaseNode} [root] @returns {Promise<PrototypeSpec>} */ async function readPrototype(root = target) {
  const page = /** @type {PageNode | null} */ (pageOf(root));
  /** @type {SpecNode[]} */
  const nodes = [];
  /** @type {Record<string, string>} */
  const frames = {};
  /** @type {{ from: BaseNode, screen: BaseNode | null, on: SpecReaction['on'], action: Action }[]} */
  const links = [];
  for (const node of [root, ...('findAll' in root ? root.findAll() : [])]) {
    if (!('reactions' in node) || !node.reactions.length) continue;
    const screen = screenOf(node);
    if (screen) frames[screen.id] = screen.name;
    nodes.push({ id: node.id, name: node.name, ...(screen ? { frame: screen.id } : {}), reactions: node.reactions.map(reactionOut) });
    for (const r of node.reactions) for (const action of flatActions(r.actions ?? (r.action ? [r.action] : []))) if (action.type === 'NODE' && action.destinationId) links.push({ from: node, screen, on: triggerOut(r.trigger), action });
  }
  /** @type {Record<string, SpecTarget>} */
  const targets = {};
  /** @type {Record<string, SpecOverlay>} */
  const overlays = {};
  for (const { action } of links) {
    if (action.type !== 'NODE' || !action.destinationId || targets[action.destinationId]) continue;
    const id = action.destinationId, dest = await figma.getNodeByIdAsync(id), destPage = dest && pageOf(dest);
    if (!dest) { targets[id] = { name: id, missing: true }; continue; }
    if (destPage !== page) { targets[id] = { name: dest.name, page: destPage?.name ?? '' }; continue; }
    const screen = screenOf(dest);
    if (screen) frames[screen.id] = screen.name;
    targets[id] = { name: dest.name, ...(screen ? { frame: screen.id } : {}) };
    const overlay = (action.navigation === 'OVERLAY' || action.navigation === 'SWAP') && overlayOf(dest);
    if (overlay) overlays[id] = overlay;
  }
  const edges = links.map(({ from, screen, on, action }) => {
    const to = /** @type {string} */ (/** @type {any} */ (action).destinationId);
    return { from: from.id, ...(screen ? { fromFrame: screen.id } : {}), on, nav: NAVIGATIONS[/** @type {any} */ (action).navigation] ?? /** @type {any} */ (action).navigation, to, ...(targets[to]?.frame ? { toFrame: targets[to].frame } : {}) };
  });
  /** @type {PrototypeSpec} */
  const spec = { root: { id: root.id, name: root.name, type: root.type }, ...(page ? { page: page.id, flows: plain(page.flowStartingPoints) } : {}),
    nodes, targets, frames, ...(Object.keys(overlays).length ? { overlays } : {}), edges };
  spec.issues = await prototypeIssues(spec, root);
  return spec;
});

// -- Writing ------------------------------------------------------------
// Declarative writes: synchronize reactions on listed nodes, with [] clearing them; leave unlisted nodes alone. Supplied flows replace page flow starts; omitted flows leave them unchanged.
// Parse and validate everything first, then call setReactionsAsync only for changed nodes. Figma rejection throws without clearing the target; partial failures restore original values in reverse order.
// Figma automatically adds a Flow N start when a top-level frame gains its first outgoing connection. Write flow starts after reactions; when flows is omitted, include automatic additions in changes.
const applyPrototype = traced(/** @param {PrototypeSpec} [spec] @param {BaseNode} [root] */ async function applyPrototype(spec = data, root = target) {
  if (!spec || !Array.isArray(spec.nodes)) throw Error('applyPrototype needs a spec shaped like readPrototype output: { nodes: [...] }');
  const page = /** @type {PageNode | null} */ (pageOf(root));
  if (!page) throw Error(`${root.name} (${root.id}) is not on a page`);
  /** @type {{ node: SceneNode & ReactionMixin, reactions: Reaction[], old: Reaction[] }[]} */
  const plan = [];
  for (const entry of spec.nodes) {
    if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.reactions)) throw Error(`A node entry must be { id, reactions: [...] }: ${JSON.stringify(entry)}`);
    const node = await figma.getNodeByIdAsync(entry.id);
    if (!node) throw Error(`Node not found: ${entry.id}`);
    if (plan.some(p => p.node.id === node.id) || spec.nodes.filter(e => e?.id === node.id).length > 1) throw Error(`${node.name} (${node.id}) is listed twice in the spec: put all reactions of a node in one entry`);
    // Observed Section and component-set nodes have neither reactions nor setReactionsAsync. Components, variants, instances and instance layers are writable.
    if (!('setReactionsAsync' in node)) throw Error(`${node.name} (${node.id}) is a ${node.type} and cannot have prototype reactions (sections and component sets have none): add them to a frame, variant or layer inside it`);
    const reactions = entry.reactions.map((r, i) => { try { return reactionIn(r); } catch (e) { throw Error(`${node.name} (${node.id}) reaction ${i + 1}: ${e.message}`); } });
    if (shape(reactions) !== shape(node.reactions)) plan.push({ node: /** @type {SceneNode & ReactionMixin} */ (node), reactions, old: node.reactions.map(writable) });
  }
  for (const [id, want] of Object.entries(spec.overlays ?? {})) {
    const node = await figma.getNodeByIdAsync(id), have = node && overlayOf(node);
    if (!node || !have) continue;
    for (const key of /** @type {(keyof SpecOverlay)[]} */ (Object.keys(want))) if (canon(roundDeep(want[key])) !== canon(have[key]))
      throw Error(`${node.name} (${id}): ${key} is read-only in the plugin API, so applyPrototype does not write overlay settings: change it in the Figma Prototype panel (select the frame, then set position, background and close-on-click-outside under Overlay), or set it back to ${JSON.stringify(have[key])} in the spec`);
  }
  /** @type {{ nodeId: string, name: string }[] | null} */
  let flows = null;
  if (spec.flows !== undefined) {
    if (!Array.isArray(spec.flows) || !spec.flows.every(f => f && typeof f.nodeId === 'string' && typeof f.name === 'string' && f.name))
      throw Error('flows must be [{ nodeId, name }] with a non-empty name (Figma requires it)');
    flows = spec.flows.map(f => ({ nodeId: f.nodeId, name: f.name }));
  }
  // Block only errors relevant to this write: those on nodes being written, plus flow-start errors when flow starts are being written.
  const changed = new Set(plan.map(p => p.node.id)), writesFlows = flows && canon(flows) !== canon(plain(page.flowStartingPoints));
  const blocking = (await prototypeIssues(spec, root)).filter(i => i.level === 'error' && ((i.node && changed.has(i.node)) || (writesFlows && i.rule === 'flow-invalid')));
  if (blocking.length) throw Error(`Pre-write check found ${blocking.length} error(s); nothing was written: ${blocking.slice(0, 5).map(i => i.message).join('; ')}${blocking.length > 5 ? '; ...' : ''}`);

  const flowsBefore = /** @type {{ nodeId: string, name: string }[]} */ (plain(page.flowStartingPoints));
  const changes = { nodes: 0, flows: 0, flowsAdded: /** @type {{ nodeId: string, name: string }[]} */ ([]) }, undo = /** @type {(() => Promise<void> | void)[]} */ ([]);
  let at = '';
  try {
    for (const { node, reactions, old } of plan) {
      at = `${node.name} (${node.id})`;
      await node.setReactionsAsync(reactions); changes.nodes++;
      undo.push(() => node.setReactionsAsync(old));
    }
    const now = /** @type {{ nodeId: string, name: string }[]} */ (plain(page.flowStartingPoints));
    if (flows && canon(flows) !== canon(now)) { at = 'flow starting points'; page.flowStartingPoints = flows; changes.flows++; }
    if (!flows) changes.flowsAdded = now.filter(f => !flowsBefore.some(b => b.nodeId === f.nodeId));
  } catch (error) {
    const failed = /** @type {string[]} */ ([]);
    for (const step of undo.reverse()) try { await step(); } catch (e) { failed.push(String(e?.message ?? e)); }
    // Figma's automatically added flow starts survive reaction rollback, so restore them too.
    try { if (canon(plain(page.flowStartingPoints)) !== canon(flowsBefore)) page.flowStartingPoints = flowsBefore; } catch (e) { failed.push(`flow starting points: ${e?.message ?? e}`); }
    const message = String(error?.message ?? error);
    // Observed combinations for which Figma reports only "Reaction at index N was invalid".
    // In observed behavior, setReactionsAsync fails to connect to Figma after 10 s in a background window, despite working network access; foregrounding the window restores it.
    const hint = /was invalid$/.test(message) ? ' (known rejected combinations: drag only accepts a smart-animate transition; url only accepts click and after triggers; the trigger cannot be empty)'
      : /Unable to establish connection/.test(message) ? ' (this happens while the Figma window is in the background: ask the user to bring Figma to the front, check the file is online, then rerun)' : '';
    const rollback = !undo.length ? 'nothing was written before it' : failed.length ? `rolled back ${undo.length - failed.length} write(s), ${failed.length} rollback(s) failed (${failed[0]}); check with readPrototype` : `rolled back ${undo.length} earlier write(s)`;
    throw Error(`Figma rejected the write to ${at}: ${message}${hint}; ${rollback}`);
  }
  return { changes, prototype: await readPrototype(root) };
});

// -- Diagnostics --------------------------------------------------------
// Report without mutating. Errors represent observed Figma write rejections and let applyPrototype reject before writing; warnings depend on design intent.
// Reachability and exits require the whole page's connections, so check only when root is a page.
const prototypeIssues = traced(/** @param {PrototypeSpec} spec @param {BaseNode} [root] @returns {Promise<Issue[]>} */ async function prototypeIssues(spec, root = target) {
  /** @type {Issue[]} */
  const issues = [];
  /** @param {string} rule @param {Issue['level']} level @param {string | null} node @param {string} message */
  const add = (rule, level, node, message) => issues.push({ rule, level, ...(node ? { node } : {}), message });
  const page = pageOf(root);
  /** @type {Map<string, BaseNode | null>} */
  const cache = new Map();
  /** @param {string} id */
  const get = async id => { if (!cache.has(id)) cache.set(id, await figma.getNodeByIdAsync(id)); return /** @type {BaseNode | null} */ (cache.get(id)); };
  /** @param {BaseNode} n */
  const label = n => `${n.name} (${n.id})`;
  /** @type {Map<string, Set<string>>} */
  const layerPaths = new Map();
  // Smart Animate pairs layers by name and hierarchy path.
  /** @param {BaseNode} n */
  const pathsOf = n => {
    let set = layerPaths.get(n.id);
    if (!set) {
      const out = new Set(/** @type {string[]} */ ([]));
      /** @param {BaseNode} p @param {string} prefix */
      const walk = (p, prefix) => { for (const c of 'children' in p ? p.children : []) { const path = prefix ? `${prefix}/${c.name}` : c.name; out.add(path); walk(c, path); } };
      walk(n, ''); layerPaths.set(n.id, set = out);
    }
    return set;
  };
  /** @param {BaseNode} source @returns {Promise<{ set: BaseNode, variant: BaseNode } | null>} */
  const variantOf = async source => {
    for (let n = /** @type {BaseNode | null} */ (source); n; n = n.parent) {
      if (n.type === 'COMPONENT' && n.parent?.type === 'COMPONENT_SET') return { set: n.parent, variant: n };
      if (n.type === 'INSTANCE') { const main = await n.getMainComponentAsync(); if (main?.parent?.type === 'COMPONENT_SET') return { set: main.parent, variant: n }; }
    }
    return null;
  };
  /** @type {Map<string, Set<string>>} */
  const graph = new Map();
  const exits = new Set(/** @type {string[]} */ ([])), overlaid = new Set(/** @type {string[]} */ ([]));
  for (const entry of spec.nodes ?? []) {
    const source = await get(entry.id);
    if (!source) { add('target-missing', 'error', entry.id, `Source node ${entry.id} not found`); continue; }
    const screen = screenOf(source);
    for (const reaction of entry.reactions ?? []) {
      for (const action of flatActions(reactionIn(reaction).actions ?? [])) {
        if (action.type === 'BACK' || action.type === 'CLOSE' || action.type === 'URL') { if (screen) exits.add(screen.id); continue; }
        if (action.type === 'SET_VARIABLE') {
          const variable = action.variableId ? await figma.variables.getVariableByIdAsync(action.variableId) : null;
          const v = /** @type {any} */ (action.variableValue), given = v?.resolvedType ?? (v?.type && !['EXPRESSION', 'VARIABLE_ALIAS'].includes(v.type) ? v.type : undefined)
            ?? ({ boolean: 'BOOLEAN', number: 'FLOAT', string: 'STRING' })[/** @type {'boolean'} */ (typeof v?.value)] ?? (v?.value && typeof v.value.r === 'number' ? 'COLOR' : undefined);
          if (!variable) add('variable-type', 'error', source.id, `${label(source)} sets variable ${action.variableId}, which does not exist`);
          else if (given && given !== variable.resolvedType) add('variable-type', 'error', source.id, `${label(source)} sets a ${given} value on ${variable.resolvedType} variable ${variable.name}`);
          continue;
        }
        if (action.type !== 'NODE' || !action.destinationId) continue;
        const dest = await get(action.destinationId), nav = action.navigation, verb = NAVIGATIONS[nav] ?? nav;
        if (!dest) { add('target-missing', 'error', source.id, `${label(source)}: ${verb} target ${action.destinationId} was deleted or does not exist`); continue; }
        if (page && pageOf(dest) !== page) { add('target-other-page', 'error', source.id, `${label(source)}: ${verb} target ${label(dest)} is on another page; Figma only accepts targets on the same page`); continue; }
        const destScreen = screenOf(dest);
        if (nav === 'NAVIGATE' || nav === 'SWAP' || nav === 'OVERLAY') {
          if (!isScreen(dest)) add('not-top-level', 'error', source.id, `${label(source)}: ${verb} target ${label(dest)} is not a top-level frame (${dest.type} in ${destScreen ? label(destScreen) : 'the page'}): the target must be a frame placed directly on the page or in a section`);
          else if (nav === 'NAVIGATE' && destScreen === screen) add('not-top-level', 'error', source.id, `${label(source)} navigates to its own frame ${label(dest)}; Figma only accepts another top-level frame`);
          if (screen && destScreen) { graph.set(screen.id, (graph.get(screen.id) ?? new Set()).add(destScreen.id)); exits.add(screen.id); }
          if (nav === 'OVERLAY' && destScreen) overlaid.add(destScreen.id);
          if (action.overlayRelativePosition && 'overlayPositionType' in dest && dest.overlayPositionType !== 'MANUAL')
            add('overlay-position', 'error', source.id, `${label(source)} sets position for overlay ${label(dest)}, but its overlay position is ${dest.overlayPositionType}: only MANUAL accepts position; change the overlay position in the Figma Prototype panel`);
        } else if (nav === 'SCROLL_TO') {
          if (!screen || destScreen !== screen || dest === screen) add('scroll-outside', 'error', source.id, `${label(source)}: scroll-to target ${label(dest)} is not inside its own frame${screen ? ` ${label(screen)}` : ''}`);
        } else if (nav === 'CHANGE_TO') {
          const own = await variantOf(source);
          if (!own || dest.type !== 'COMPONENT' || dest.parent?.id !== own.set.id) add('change-to-not-variant', 'error', source.id, `${label(source)}: change-to target ${label(dest)} is not ${own ? `a variant in component set ${label(own.set)}` : 'a variant reachable from here: the source must be inside a variant or an instance of one'}`);
        }
        const t = action.transition, smart = !!t && (t.type === 'SMART_ANIMATE' || ('matchLayers' in t && t.matchLayers));
        const from = nav === 'CHANGE_TO' ? (await variantOf(source))?.variant : screen;
        if (smart && from && from !== dest && nav !== 'SCROLL_TO') {
          const a = pathsOf(from), b = pathsOf(dest), matched = [...a].filter(p => b.has(p)).length;
          if (a.size && matched < a.size / 2) add('smart-animate-unmatched', 'warning', source.id,
            `${label(source)} uses Smart Animate from ${label(from)} to ${label(dest)}, but only ${matched} of ${a.size} layers match by name and layer path; the rest only fade: ${[...a].filter(p => !b.has(p)).slice(0, 5).join(', ')}`);
        }
      }
    }
  }
  const flows = spec.flows ?? [];
  const seen = new Set(/** @type {string[]} */ ([]));
  for (const flow of flows) {
    const start = await get(flow.nodeId);
    if (!start) add('flow-invalid', 'error', null, `Flow starting point "${flow.name}": ${flow.nodeId} was deleted or does not exist`);
    else if ((page && pageOf(start) !== page) || !holdsScreens(start.parent)) add('flow-invalid', 'error', null, `Flow starting point "${flow.name}": ${label(start)} is not a top-level frame on this page`);
    else if (seen.has(start.id)) add('flow-invalid', 'error', null, `Flow starting point ${label(start)} is duplicated; Figma rejects duplicate starting points`);
    seen.add(flow.nodeId);
  }
  if (root.type === 'PAGE' && graph.size) {
    const involved = new Set([...graph.keys(), ...[...graph.values()].flatMap(s => [...s])]), reached = new Set(flows.map(f => f.nodeId)), queue = [...reached];
    while (queue.length) for (const next of graph.get(/** @type {string} */ (queue.shift())) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
    /** @param {string[]} ids */
    const names = async ids => (await Promise.all(ids.slice(0, 8).map(async id => (await get(id))?.name ?? id))).join(', ') + (ids.length > 8 ? ', ...' : '');
    const unreached = [...involved].filter(id => !reached.has(id));
    if (unreached.length) add('unreachable', 'warning', null, `${unreached.length} frame(s) cannot be reached ${flows.length ? 'from the flow starting points' : 'in presentation: the page has no flow starting point'}: ${await names(unreached)}`);
    // An overlay configured to close on outside clicks is not trapped even without an outgoing connection.
    const closable = async (/** @type {string} */ id) => overlaid.has(id) && (/** @type {any} */ (await get(id)))?.overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE';
    const dead = [];
    for (const id of new Set([...involved, ...reached])) if (!exits.has(id) && !(await closable(id))) dead.push(id);
    if (dead.length) add('dead-end', 'warning', null, `${dead.length} frame(s) have no way out (no navigate, overlay, back, close or link): ${await names(dead)}; ignore this for end screens`);
  }
  return issues;
});
