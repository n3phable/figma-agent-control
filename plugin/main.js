/**
 * [INPUT]: Figma Plugin API, bridge configuration and the sandbox/iframe message channel.
 * [OUTPUT]: Plugin task handling and serialized results.
 * [POS]: Figma sandbox executor for bound reads and trusted writes, with approval, checkpoints and Undo boundaries.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
// ui.html relays bridge-built jobs; /poll adds binding and the iframe adds channelNonce. Declare only fields read by the plugin.
/** @typedef {{ id: string, operation: string, channelNonce: string, binding: { fileKey: string, nodeId: string }, targetNodeId?: string, nodes?: string[], names?: string[],
 *   snapshotDepth?: number, scale?: number, islands?: string[], expect?: string, code: string, libs?: { name: string, code: string }[], data?: unknown,
 *   risk?: { level: string, reason?: string }, scriptHash?: string, cleanOnFail?: boolean }} Job */
/** @typedef {(message: Record<string, unknown>) => void} Send */
/** @typedef {{ id: string, channelNonce: string, finish(message: { ok?: unknown, approved?: unknown }): void }} Waiter */
figma.showUI(__html__, { width: 320, height: 240, themeColors: true });
let busy = false;
// Last successfully validated binding node, used to focus the canvas when its panel name is clicked; cleared on validation failure.
/** @type {string | null} */
let boundNodeId = null;
/** @type {Waiter | null} */
let checkpointWaiter = null;
/** @type {Waiter | null} */
let approvalWaiter = null;
// The currently executing run: cancellation must match its task ID and channelNonce.
/** @type {{ id: string, channelNonce: string, cancel(): void } | null} */
let execution = null;
// Web components often have nested wrappers; cover typical component trees without increasing the total node budget.
const SNAPSHOT_DEPTH = 32, NODE_BUDGET = 2000;
// If snapshots exceed budget, trade depth for scope on writes. Shrinking the target outside the written area would make change sets, write-ahead evidence and final checks describe unrelated nodes.
const SCOPE_HINT = 'for write jobs, target the ancestor that covers all writes (usually the page or a Section) and add --depth (2 for page -> Section -> frame); do not retarget a small node outside the write scope, or the change set will be empty; when the target is a page, omit --expect and do the visual check with preview on specific frames';
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
  'overflowDirection', 'numberOfFixedChildren', 'reactions', 'flowStartingPoints',
  'textAutoResize', 'textTruncation', 'maxLines', 'characters', 'fontSize', 'fontName', 'lineHeight', 'letterSpacing',
  'textAlignHorizontal', 'textAlignVertical', 'paragraphIndent', 'paragraphSpacing', 'hasMissingFont',
  'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'effects', 'cornerRadius',
  'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'cornerSmoothing',
  'textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'boundVariables', 'explicitVariableModes'
];
// Motion (Beta): scene nodes expose these fields as []/{} when empty; record only nonempty values. Observed reads of 1000 nodes take about 20 ms without errors;
// Figma versions without Motion access may throw, so skip those reads. timelines describes the owning top-level frame and is recorded only there (timeline ID equals frame ID), preventing one duration change from marking every descendant updated.
// Do not read animations: observed output omits style-generated tracks, while manual tracks already appear in manualKeyframeTracks.
const MOTION_KEYS = ['animationStyles', 'manualKeyframeTracks', 'timelines'];
// Key tables span node types; callers first check key in node. Subsequent use constrains each value's shape, so the dynamic reader returns any.
/** @param {object} node @param {string} key @returns {any} */
const prop = (node, key) => /** @type {Record<string, unknown>} */ (node)[key];
/** @param {BaseNode} node @param {number} maxDepth @returns {Snapshot} */
function tree(node, maxDepth, depth = 0, budget = { count: 0 }) {
  if (++budget.count > NODE_BUDGET) throw Error(`Target exceeds the ${NODE_BUDGET}-node budget: ${SCOPE_HINT}; for read-only jobs, add --depth or narrow with --node`);
  /** @type {Snapshot} */
  const value = { id: node.id, name: node.name, type: node.type };
  for (const key of KEYS) if (key in node && prop(node, key) !== undefined) value[key] = copy(prop(node, key));
  for (const key of MOTION_KEYS) {
    try {
      const raw = key in node ? prop(node, key) : null;
      const motion = key === 'timelines' && raw ? raw.filter((/** @type {Timeline} */ timeline) => timeline.id === node.id) : raw;
      if (motion && Object.keys(motion).length) value[key] = copy(motion);
    } catch { /* Motion is unavailable.*/ }
  }
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
// Distinguish missing nodes from out-of-scope nodes: scripts may recreate by name and change IDs. A missing binding itself requires a separate error because target relocation cannot proceed.
/** @param {BaseNode | null} node @param {string} id @param {string} rootId @returns {BaseNode} */
function inBinding(node, id, rootId) {
  if (!node) throw Error(id === rootId ? `Bound node ${id} does not exist; it may have been deleted. Restore it in Figma, or run init again in a new project directory` : `Local target ${id} does not exist; it may have been deleted or recreated. Locate it again`);
  if (!within(node, rootId)) throw Error(`Local target ${id} is outside the binding scope`);
  return node;
}

// -- Preview targets by name --------------------------------------------
// Search binding children and descend only through SECTION nodes. Repeated layer names inside frames, components, instances and groups are excluded.
// Resolve every exact name before exporting anything; missing or ambiguous names fail without falling back to the binding. Return IDs, then apply normal scope checks for each export.
/** @param {SceneNode | PageNode} root @param {string[]} names @returns {string[]} */
function idsByName(root, names) {
  const scope = /** @type {{ node: SceneNode, at: string }[]} */ ([]);
  /** @param {SceneNode | PageNode} parent @param {string} at */
  const visit = (parent, at) => { if ('children' in parent) for (const node of parent.children) { scope.push({ node, at }); if (node.type === 'SECTION') visit(node, `Section "${node.name}"`); } };
  visit(root, 'bound node root');
  const list = (/** @type {string[]} */ items) => items.slice(0, 20).join(', ') + (items.length > 20 ? `, ... (${items.length} total)` : '');
  return names.map(name => {
    const found = scope.filter(entry => entry.node.name === name);
    if (found.length === 1) return found[0].node.id;
    if (found.length) throw Error(`Name "${name}" has ${found.length} matches: ${list(found.map(entry => `${entry.node.id} (${entry.at})`))}; remove the duplicate names first, or use --node instead`);
    throw Error(`Name "${name}" not found among the children and Sections of the bound node; names in scope: ${list([...new Set(scope.map(entry => entry.node.name))]) || 'none'}`);
  });
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
// Read-only collections, alias-resolved default-mode values and reference counts within the target subtree. Node boundVariables count as bindings; reaction references count as prototypeRefs:
// bindings affect rendered appearance, while prototype references apply only during presentation. Separate counts clarify whether a variable is safe to delete.
// Variable aliases { type: 'VARIABLE_ALIAS', id } occur in variable values, node boundVariables, conditions and reaction values; SET_VARIABLE actions refer through variableId.
/** @param {unknown} value @returns {value is VariableAlias} */
const isAlias = value => !!value && typeof value === 'object' && prop(value, 'type') === 'VARIABLE_ALIAS' && typeof prop(value, 'id') === 'string';
/** @param {BaseNode} target */
async function localVariables(target) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync(), variables = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(variables.map(v => [v.id, v])), byCollection = new Map(collections.map(c => [c.id, c]));
  const counts = /** @type {Map<string, number>} */ (new Map()), prototypeRefs = /** @type {Map<string, number>} */ (new Map());
  let scanned = 0, truncated = false;
  /** @param {unknown} value @param {Map<string, number>} into */
  const count = (value, into) => {
    if (!value || typeof value !== 'object') return;
    /** @param {string} id */
    const add = id => into.set(id, (into.get(id) || 0) + 1);
    if (isAlias(value)) { add(value.id); return; }
    if (prop(value, 'type') === 'SET_VARIABLE' && typeof prop(value, 'variableId') === 'string') add(prop(value, 'variableId'));
    // Returned reactions include deprecated action (= actions[0]) and actions. Count actions only to avoid duplicate references.
    for (const [key, item] of Object.entries(value)) if (key !== 'action') count(item, into);
  };
  /** @param {BaseNode} node */
  const visit = node => {
    if (truncated || ++scanned > 50000) { truncated = true; return; }
    count('boundVariables' in node ? node.boundVariables : undefined, counts);
    count('reactions' in node ? node.reactions : undefined, prototypeRefs);
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
        scopes: v.scopes, bindings: counts.get(v.id) || 0, prototypeRefs: prototypeRefs.get(v.id) || 0 };
    }),
    bindingScope: { nodeId: target.id, scannedNodes: Math.min(scanned, 50000), truncated },
    limitation: 'Local variables only, using default-mode values with aliases followed up to 10 levels; bindings counts target-subtree boundVariables, while prototypeRefs counts references in target-subtree reactions'
  };
}

// -- Script compilation -------------------------------------------------
// Nest each library and the body in its own function scope: earlier libraries are outermost, with the body inside and able to call their functions directly;
// duplicate names shadow outer declarations instead of causing redeclaration errors. Library top-level code evaluates with the body inside Undo boundaries.
/** @param {Job} job */
function compile(job) {
  const body = (job.libs || []).reduceRight((inner, lib) => `${lib.code}\nreturn (async () => {\n${inner}\n})();`, job.code);
  return new Function('figma', 'target', 'data', `return (async () => {\n${body}\n})();`);
}
// Scripts can throw any value. String() may itself throw for prototype-less objects or proxies with throwing getters, so reporting must remain robust and never leave the task pending.
/** @param {unknown} value */
const describe = value => { try { return String(value); } catch (_) { return `The value thrown by the script cannot be converted to text (${typeof value})`; } };

// -- Failure evidence: newly created nodes -------------------------------
// Listen to target-page nodechange during execution, collecting CREATE and DELETE (typings report only the highest nested creation/deletion), excluding REMOTE collaborator changes.
// Avoid figma.on('documentchange'), which requires loadAllPagesAsync under dynamic-page. Consequently, nodes created after the script switches to another page are outside coverage.
// Events arrive only after the script yields, batched roughly every 100 ms. Observed delays after creating 1, 20 and 300 nodes were 99, 87 and 16 ms.
// After failure, wait at least 200 ms (two delivery cycles), then stop after 120 ms without new events, capped at 1 s wall-clock. Poll every 40 ms; throttled timers can add one interval.
/** @param {() => number} count */
async function settleEvents(count) {
  const start = Date.now();
  for (let now = start, seen = count(), last = start; now - start < 1000 && (now - start < 200 || now - last < 120);) {
    await new Promise(resolve => setTimeout(resolve, 40));
    now = Date.now();
    if (count() !== seen) { seen = count(); last = now; }
  }
}
// Registration failure only warns; stop is idempotent. activity feeds progress. created returns surviving nodes without a newly created ancestor, or null when listening is unavailable.
// Call deletedFrom after created, once events settle: count preexisting nodes with DELETE events that no longer exist. Nodes moved to another page still exist and do not count.
// detachInstance and flatten replace existing content with new IDs, emitting CREATE for replacements in observed behavior. Cleanup would treat them as new and remove them; this count supports the warning.
// Observed createComponent and createComponentFromNode results emit no CREATE, so they do not enter created and are not deleted.
/** @param {PageNode} page @param {string[]} warnings */
function watchCreated(page, warnings) {
  const ids = /** @type {Set<string>} */ (new Set()), deleted = /** @type {Set<string>} */ (new Set()), activity = { changes: 0, lastChangeAt: 0 };
  /** @param {NodeChangeEvent} event */
  const onChange = event => {
    for (const change of event.nodeChanges) if (change.origin !== 'REMOTE') {
      activity.changes++; activity.lastChangeAt = Date.now();
      if (change.type === 'CREATE') ids.add(change.id); if (change.type === 'DELETE') deleted.add(change.id);
    }
  };
  let listening = false;
  try { page.on('nodechange', onChange); listening = true; }
  catch (error) { warnings.push('nodechange listener unavailable; created nodes cannot be listed if the script fails: ' + String(error)); }
  return {
    stop() { if (listening) try { page.off('nodechange', onChange); } catch (_) {} listening = false; },
    // Progress reports this run's target-page change count and last-change time; unavailable listening leaves the count at zero.
    activity: () => activity,
    /** @param {Set<string>} existing */
    async deletedFrom(existing) { let n = 0; for (const id of deleted) if (existing.has(id)) { const node = await figma.getNodeByIdAsync(id); if (!node || node.removed) n++; } return n; },
    async created() {
      if (!listening) return null;
      await settleEvents(() => ids.size + deleted.size);
      const nodes = /** @type {BaseNode[]} */ ([]);
      for (const id of ids) { const node = await figma.getNodeByIdAsync(id); if (node && !node.removed) nodes.push(node); }
      const found = new Set(nodes.map(node => node.id));
      return nodes.filter(node => { for (let up = node.parent; up; up = up.parent) if (found.has(up.id)) return false; return true; });
    }
  };
}

// -- Failure evidence: new variables and styles ---------------------------
// Collections, variables and styles are not nodes and do not emit nodechange. Record local IDs before execution and report additions as createdAssets on failure. Never delete them; clean handles nodes only.
// Custom animation-style reads belong to Motion (Beta); skip when the API is unavailable.
async function localAssets() {
  const motion = 'getLocalCustomAnimationStylesAsync' in figma ? [figma.getLocalCustomAnimationStylesAsync()] : [];
  const [collections, variables, ...styles] = await Promise.all([figma.variables.getLocalVariableCollectionsAsync(), figma.variables.getLocalVariablesAsync(),
    figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync(), ...motion]);
  const brief = (/** @type {{ id: string, name: string }[]} */ list) => list.map(({ id, name }) => ({ id, name }));
  return { collections: brief(collections), variables: brief(variables), styles: brief(styles.flat()) };
}
/** @typedef {Awaited<ReturnType<typeof localAssets>>} Assets */
/** @param {Assets} before @param {Assets} after */
const newAssets = (before, after) => Object.fromEntries(Object.entries(after)
  .map(([kind, list]) => { const had = new Set(before[/** @type {keyof Assets} */ (kind)].map(a => a.id)); return /** @type {const} */ ([kind, list.filter(a => !had.has(a.id))]); })
  .filter(([, list]) => list.length));
// Post-failure evidence also uses async Figma APIs. If cancellation followed a stalled Figma call, these may stall too; bound them with timeouts and warn on expiry.
/** @template T @param {Promise<T>} promise @param {string} what @returns {Promise<T>} */
const timed = (promise, what) => {
  let timer = 0;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${what} did not finish within 15 s`)), 15000); })]).finally(() => clearTimeout(timer));
};

// -- Execution progress and cancellation --------------------------------
// Scripts can stall in calls that never return (two observed stalls lasted about 27 minutes). Agents need a visible call site and cancellation. Scripts and libraries receive a figma proxy that records pending
// *Async calls, start times and call-site stacks for bridge source mapping, alongside target-page activity. After roughly five hidden minutes, plugin timers throttle to about one minute and progress becomes less frequent.
// The proxy targets an empty object and forwards reads/writes to real figma, avoiding invariants imposed by figma property descriptors. Bind methods back to figma and wrap only namespaces with frequent async calls.
// Return nodes unchanged because API arguments require the original objects; node-owned async methods such as exportAsync are therefore not tracked.
// Cancellation immediately rejects the execution race. The failure path still records created and performs cleanOnFail; the error stack uses the oldest pending call's origin.
// Suspended scripts cannot be externally terminated. Future figma-proxy access throws, but writes through previously obtained nodes cannot be blocked; disclose this in the result.
// Hidden-window loadFontAsync calls can take roughly a minute even for already loaded fonts. Loading per text node can therefore take tens of minutes; one successful load per plugin session is sufficient,
// so return immediately for cached fonts. Do not cache failures; later calls retry normally.
const FIRST_PROGRESS_MS = 1000, PROGRESS_MS = 2000, TRACKED = new Set(['variables', 'motion', 'teamLibrary', 'clientStorage', 'annotations']), loadedFonts = new Set();
function watchExecution() {
  const pending = /** @type {Map<number, { call: string, at: number, stack: string }>} */ (new Map());
  let seq = 0, stopped = '', reject = /** @type {(error: unknown) => void} */ (() => {});
  const cancelled = /** @type {Promise<never>} */ (new Promise((_, no) => { reject = no; }));
  /** @param {any} real @param {string} prefix @returns {any} */
  const wrap = (real, prefix) => {
    const namespaces = /** @type {Map<string, unknown>} */ (new Map());
    return new Proxy(Object.create(null), {
      get(_, key) {
        if (stopped) throw Error(stopped);
        const value = real[key];
        if (typeof key !== 'string') return value;
        if (prefix === 'figma' && TRACKED.has(key) && value && typeof value === 'object') { if (!namespaces.has(key)) namespaces.set(key, wrap(value, `figma.${key}`)); return namespaces.get(key); }
        if (typeof value !== 'function') return value;
        if (!key.endsWith('Async')) return value.bind(real);
        const call = (/** @type {unknown[]} */ ...args) => {
          const id = ++seq, done = () => { pending.delete(id); };
          pending.set(id, { call: `${prefix}.${key}`, at: Date.now(), stack: String(Error().stack ?? '').slice(0, 1000) });
          const result = value.apply(real, args);
          Promise.resolve(result).then(done, done);
          return result;
        };
        if (prefix !== 'figma' || key !== 'loadFontAsync') return call;
        return (/** @type {FontName} */ font) => {
          const name = JSON.stringify([font?.family, font?.style]);
          if (loadedFonts.has(name)) return Promise.resolve();
          const result = call(font);
          Promise.resolve(result).then(() => { loadedFonts.add(name); }, () => {});
          return result;
        };
      },
      set(_, key, value) { if (stopped) throw Error(stopped); real[key] = value; return true; },
      has: (_, key) => key in real,
      ownKeys: () => Reflect.ownKeys(real),
      getOwnPropertyDescriptor(_, key) { const d = Reflect.getOwnPropertyDescriptor(real, key); return d && { ...d, configurable: true }; }
    });
  };
  return {
    api: wrap(figma, 'figma'), cancelled,
    // Order pending calls by start time, with the oldest most likely stalled. Include only its stack to keep heartbeat URLs bounded.
    /** @param {{ changes: number, lastChangeAt: number }} activity */
    progress(activity) {
      const now = Date.now(), waiting = [...pending.values()];
      return { changes: activity.changes, ...(activity.lastChangeAt ? { lastChangeAgoMs: now - activity.lastChangeAt } : {}),
        waiting: waiting.slice(0, 3).map((p, i) => ({ call: p.call, forMs: now - p.at, ...(i ? {} : { stack: p.stack }) })), waitingCount: waiting.length };
    },
    cancel() {
      if (stopped) return;
      const oldest = pending.values().next().value;
      const error = Error(oldest ? `Aborted by cancel: the script was waiting on ${oldest.call}, which had not returned after ${Math.round((Date.now() - oldest.at) / 1000)} s`
        : 'Aborted by cancel: the script was not waiting on a figma async call; it may be waiting on a node async method (e.g. exportAsync) or on its own Promise');
      if (oldest) try { error.stack = oldest.stack; } catch (_) { /* Omit location if stack is read-only.*/ }
      stopped = 'The job was cancelled; the script can no longer call figma';
      reject(error);
    },
    get wasCancelled() { return stopped !== ''; }
  };
}

// -- Target guidance ----------------------------------------------------
// The panel first answers whether the open file/page matches the binding. Ready targets include type, page and ID; call the field nodeType so it does not overwrite the message's type.
/** @param {{ fileKey: string, nodeId: string } | undefined} binding */
async function checkTarget(binding) {
  if (!figma.fileKey) return { name: '', issue: "The plugin cannot read this file's fileKey. Use Figma Desktop and the development plugin installed by figma-agent-control connect." };
  if (!binding || binding.fileKey !== figma.fileKey) return { name: '', issue: "This is not the bound file. Open the file used by the agent and run the plugin again." };
  const node = await figma.getNodeByIdAsync(binding.nodeId);
  if (!node || node.removed) return { name: '', issue: "The bound target no longer exists. Ask the agent to bind it again." };
  const page = pageOf(node);
  return { name: node.name, nodeType: node.type, page: page && page !== node ? page.name : '', id: node.id, issue: null };
}
// Never call during execution: switching pages changes the script's figma.currentPage.
/** @param {string} id */
async function focusTarget(id) {
  const node = await figma.getNodeByIdAsync(id), page = pageOf(node);
  if (!node || !page) return;
  if (page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  if (node === page) return;
  const scene = /** @type {SceneNode} */ (node);
  page.selection = [scene];
  figma.viewport.scrollAndZoomIntoView([scene]);
}

figma.ui.onmessage = async job => {
  // At UI startup, request the current file so the bridge lets only instances in the bound file claim work.
  if (job?.type === 'hello') { figma.ui.postMessage({ type: 'file', fileKey: figma.fileKey || '' }); return; }
  if (job?.type === 'check-target') {
    let info;
    try { info = await checkTarget(job.binding); } catch { info = { name: '', issue: "The target is temporarily unavailable." }; }
    boundNodeId = info.issue ? null : job.binding.nodeId;
    figma.ui.postMessage({ type: 'target-info', ...info });
    return;
  }
  if (job?.type === 'focus-target') { if (!busy && boundNodeId) await focusTarget(boundNodeId).catch(() => {}); return; }
  if (job?.type === 'resize') { if (Number.isFinite(job.height)) figma.ui.resize(320, Math.min(600, Math.max(120, Math.ceil(job.height)))); return; }
  if (job?.type === 'hide-ui') { figma.ui.hide(); return; }
  // Check for a waiter first: when a reply lacks id, optional chains can both equal undefined, then reading fields from null would throw.
  if (job?.type === 'approval-ack') {
    if (approvalWaiter && approvalWaiter.id === job.id && approvalWaiter.channelNonce === job.channelNonce) approvalWaiter.finish(job);
    return;
  }
  if (job?.type === 'cancel') {
    if (execution && execution.id === job.id && execution.channelNonce === job.channelNonce) execution.cancel();
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
  // Failure evidence includes created, optional cleanOnFail cleaned/cleanFailed, and deletedExisting (see watchCreated). scriptFailure retains the script's original thrown value, from compilation or execution.
  let watch = /** @type {ReturnType<typeof watchCreated> | null} */ (null), leftovers = /** @type {Record<string, unknown>} */ ({}), scriptFailure = /** @type {{ error: unknown } | undefined} */ (undefined);
  // Start run progress on receipt (first report after 1 s, then every 2 s). phase identifies prepare (target, snapshots, write-ahead log), approval (user confirmation),
  // script (execution plus pending figma calls), or finish (leftovers, after snapshot, result assembly). Synchronous snapshots block progress timers; the panel keeps heartbeating the latest update.
  let phase = 'prepare', reports = 0, ticker = 0, scriptProgress = /** @type {(() => Record<string, unknown>) | null} */ (null);
  const report = (/** @type {number} */ ms) => { ticker = setTimeout(() => { send({ type: 'progress', id: job.id, seq: ++reports, phase, elapsedMs: Date.now() - receivedAt, ...scriptProgress?.() }); report(PROGRESS_MS); }, ms); };
  if (run) report(FIRST_PROGRESS_MS);
  try {
    if (!figma.fileKey) throw Error('Cannot verify the file key; use the development plugin with the private API enabled');
    if (figma.fileKey !== job.binding.fileKey) throw Error('The current file does not match the binding');
    if (figma.editorType !== 'figma' || figma.mode !== 'default') throw Error('Run the plugin in Figma Design edit mode');
    // Compile first: syntax errors return before snapshots, approval or writes, preserving executionStarted false.
    let program = null;
    if (run) try { program = compile(job); } catch (error) { scriptFailure = { error }; throw error; }
    const targetId = job.targetNodeId ?? job.binding.nodeId, candidate = await figma.getNodeByIdAsync(targetId);
    if (candidate === null && job.operation === 'inspect') {
      send({ id: job.id, ok: false, executionStarted: false, targetMissing: true, missingNodeId: targetId, fileVerified: figma.fileKey,
        error: 'Queried the original target in the bound file; the node no longer exists. Verify against the original job and the canvas', recovery: 'Keep the missing-node evidence; do not replay the original script' });
      return;
    }
    target = /** @type {SceneNode | PageNode} */ (inBinding(candidate, targetId, job.binding.nodeId));
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
      // Validate every batch target's binding scope; missing or out-of-scope nodes fail the whole task. Resolve all names to IDs first, exporting nothing if any resolution fails, then use the same export path.
      const images = [];
      for (const id of Array.isArray(job.names) ? idsByName(target, job.names) : Array.isArray(job.nodes) ? job.nodes : [target.id]) {
        const node = /** @type {SceneNode | PageNode} */ (inBinding(id === target.id ? target : await figma.getNodeByIdAsync(id), id, job.binding.nodeId));
        images.push({ nodeId: node.id, name: node.name, base64: await render(node, job.scale, budget) });
      }
      send({ id: job.id, ok: true, images, bindingVerified: { fileKey: figma.fileKey, pageId: page.id, nodeId: target.id } });
      return;
    } else if (run) {
      if (declaredDepth === null && isTruncated(before)) throw Error(`Before-snapshot truncated (deeper than ${SNAPSHOT_DEPTH} levels); the script did not run. Retarget a shallower node that still covers all writes to keep full-depth evidence; otherwise, ${SCOPE_HINT}`);
      if (job.risk?.level === 'high') {
        const asked = Date.now();
        phase = 'approval';
        try { await requestApproval(job, send); } finally { approvalMs = Date.now() - asked; phase = 'prepare'; }
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
      // For non-page targets, synchronously record direct page children at low cost: create* without appendChild leaves new nodes at page root, outside the target change set. Page targets already cover them.
      const rootChildren = (/** @type {PageNode} */ p) => p.children.map(({ id, name, type }) => ({ id, name, type })), rootBefore = target.type === 'PAGE' ? null : rootChildren(page);
      const assetsBefore = await localAssets().catch(error => { warnings.push('Cannot read variables and styles before execution; created variables and styles cannot be listed if the script fails: ' + String(error)); return null; });
      if (typeof figma.commitUndo !== 'function') throw Error('This environment does not support Undo boundaries; the script did not run');
      const commitUndo = figma.commitUndo.bind(figma);
      try { commitUndo(); undoBoundaries.before = 'committed'; }
      catch (error) { undoBoundaries.before = 'failed'; throw error; }
      watch = watchCreated(page, warnings);
      const tracker = watchExecution(), activity = watch.activity;
      execution = { id: job.id, channelNonce: job.channelNonce, cancel: tracker.cancel };
      phase = 'script'; scriptProgress = () => tracker.progress(activity());
      executionStarted = true;
      let boundaryFailure;
      try {
        const script = /** @type {Promise<unknown>} */ (/** @type {Function} */ (program)(tracker.api, target, job.data ?? null));
        script.catch(() => {});
        output = await Promise.race([script, tracker.cancelled]);
      }
      catch (error) { scriptFailure = { error }; }
      finally { execution = null; phase = 'finish'; scriptProgress = null; }
      if (tracker.wasCancelled) warnings.push('A suspended script cannot be terminated from outside: if the call it waits on returns later, the script resumes; further figma access throws, but direct writes through nodes it already holds cannot be blocked. To stop it completely, close and reopen the plugin in Figma');
      // Create history boundaries for success and partial failure alike; never trigger global Undo automatically.
      try { commitUndo(); undoBoundaries.after = 'committed'; }
      catch (error) {
        undoBoundaries.after = 'failed';
        boundaryFailure = Error(`${scriptFailure ? `Script error: ${describe(scriptFailure.error)}; ` : ''}Failed to commit the closing Undo boundary: ${String(error)}; verify the document, do not auto-undo or replay the script`);
      }
      if (scriptFailure) {
        // Default to reporting only. cleanOnFail deletes highest-level new nodes and commits another boundary, making cleanup a separate Undo step. Existing modifications remain, so execution is not atomic.
        // If the ending boundary fails, cleanup cannot be a separate step, so report without deletion. Preserve new nodes that are or contain preexisting nodes, recording cleanFailed.
        // Evidence/cleanup errors only warn; report the original script error. Read names/types before deletion because removed-node properties are inaccessible. Parent and owned-subtree size (excluding instance internals; leaves lack findAll) support deferred clean, matching src/clean.mjs.
        try {
          const nodes = await timed(watch.created(), 'Listing created nodes');
          if (nodes) {
            const created = nodes.map(node => ({ id: node.id, name: node.name, type: node.type, parentId: node.parent?.id ?? null, size: 'findAll' in node ? node.findAll(child => !child.id.startsWith('I')).length : 0 }));
            leftovers.created = created;
            if (existing && boundaryFailure) warnings.push('Closing Undo boundary failed to commit; created nodes were not deleted');
            else if (existing) {
              const cleaned = /** @type {typeof created} */ ([]), cleanFailed = /** @type {(typeof created[0] & { reason: string })[]} */ ([]), deletedExisting = await watch.deletedFrom(existing);
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
              // When cleanup removes nodes and execution also deleted originals, removed nodes may represent original content under new IDs. Report counts and warnings while continuing cleanup.
              if (cleaned.length && deletedExisting) {
                leftovers.deletedExisting = deletedExisting;
                warnings.push(`${deletedExisting} pre-existing node(s) were deleted during execution (by the script, or replaced with new IDs by detachInstance, flatten or createComponentFromNode); the cleaned nodes may include their replacements. Run inspect first; if needed, undo once in Figma to restore what the cleanup removed`);
              }
            }
          }
        } catch (error) { warnings.push('Failed to list or clean up created nodes: ' + String(error)); }
        if (assetsBefore) try { const created = newAssets(assetsBefore, await timed(localAssets(), 'Listing created variables and styles')); if (Object.keys(created).length) leftovers.createdAssets = created; }
        catch (error) { warnings.push('Failed to list created variables and styles: ' + String(error)); }
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
      // Compare page-root changes only after success. List at most 50 additions/removals each, matching src/record.mjs LIST_LIMIT without importing it, and count overflow. Omit empty results or unavailable roots, such as a deleted page.
      const pageRoot = /** @type {Record<string, unknown>} */ ({});
      if (rootBefore) try {
        const rootAfter = rootChildren(page), had = new Set(rootBefore.map(n => n.id)), has = new Set(rootAfter.map(n => n.id)), diff = { created: rootAfter.filter(n => !had.has(n.id)), deleted: rootBefore.filter(n => !has.has(n.id)) };
        if (diff.created.length || diff.deleted.length) for (const [key, list] of Object.entries(diff)) { pageRoot[key] = list.slice(0, 50); if (list.length > 50) pageRoot[key + 'Omitted'] = list.length - 50; }
      } catch (_) {}
      let serialized;
      try { serialized = serializeOutput(output, budget); }
      catch (error) { throw describe(error).includes('do not replay the script') ? error : Error('Return value cannot be converted to JSON; the script ran, check the document, do not replay the script'); }
      send({ id: job.id, ok: true, output: serialized.output, ...(serialized.binaries.length ? { binaries: serialized.binaries } : {}), ...(renders ? { renders } : {}),
        before, ...(afterError ? { afterError } : { after }), ...('created' in pageRoot ? { pageRoot } : {}), bindingVerified: { fileKey: figma.fileKey, pageId: page.id, nodeId: before.id }, undoBoundaries });
      return;
    } else throw Error('Unknown operation');
    const serialized = serializeOutput(output, budget);
    if (job.operation === 'extract' && utf8Upper(JSON.stringify(serialized.output)) > EXTRACT_BYTES) throw Error('Extract result exceeds 12 MB (UTF-8 estimate): narrow the target with --node');
    send({ id: job.id, ok: true, output: serialized.output, ...(serialized.binaries.length ? { binaries: serialized.binaries } : {}), ...(ancestors ? { ancestors } : {}),
      bindingVerified: { fileKey: figma.fileKey, pageId: page.id, nodeId: before.id } });
  } catch (e) {
    let after, stack;
    if (executionStarted) { try { after = /** @type {SceneNode | PageNode} */ (target).removed ? null : snapshot(); } catch (_) {} }
    // Return stacks only from script-thrown values, including those wrapped by an ending-boundary failure. This module's own errors have no script location to map; even reading stack may throw.
    if (scriptFailure) try { const raw = /** @type {any} */ (scriptFailure.error)?.stack; if (typeof raw === 'string') stack = raw.slice(0, 4000); } catch (_) {}
    send({ id: job.id, ok: false, error: describe(e), ...(stack ? { stack } : {}), executionStarted, ...(after !== undefined ? { before, after } : {}), ...(ancestors ? { ancestors } : {}),
      recovery: executionStarted ? 'The script started running; keep the current state, verify with inspect first, do not replay the script' : 'The script did not run; fix it and resubmit', ...(run ? { undoBoundaries } : {}),
      ...leftovers, ...(warnings.length ? { warnings } : {}) });
  } finally {
    clearTimeout(ticker);
    watch?.stop();
    busy = false;
  }
};
