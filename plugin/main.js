/**
 * [INPUT]: Figma Plugin API, bridge configuration and the sandbox/iframe message channel.
 * [OUTPUT]: Plugin task handling and serialized results.
 * [POS]: Figma sandbox executor for bound reads and trusted writes, with approval, checkpoints and Undo boundaries.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
figma.showUI(__html__, { width: 320, height: 200, themeColors: true });
let busy = false;
let checkpointWaiter = null;
let approvalWaiter = null;
// Web components often have nested wrappers; cover typical component trees without increasing the total node budget.
const SNAPSHOT_DEPTH = 32, NODE_BUDGET = 2000;
// Combined image/binary return limit, measured as base64.
const BINARY_LIMIT = 48 * 1024 * 1024;
const BINARY_KEY = '__figmaAgentControlBinary';

// -- Approval round trips -----------------------------------------------
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
function tree(node, maxDepth, depth = 0, budget = { count: 0 }) {
  if (++budget.count > NODE_BUDGET) throw Error(`Target exceeds the ${NODE_BUDGET}-node budget; narrow the target with --node, or add --depth for read-only jobs`);
  const value = { id: node.id, name: node.name, type: node.type };
  for (const key of KEYS) if (key in node && node[key] !== undefined) value[key] = copy(node[key]);
  if ('children' in node) {
    if (depth >= maxDepth && node.children.length) value.truncated = true;
    else value.children = node.children.map(child => tree(child, maxDepth, depth + 1, budget));
  }
  return value;
}
const isTruncated = node => node.truncated === true || (node.children || []).some(isTruncated);
// Visibility chain above the target through its page: masks, visibility, opacity and fills explain whether writes can appear on screen (inspect only).
function ancestry(node) {
  const chain = [];
  for (let current = node.parent; current && !['PAGE', 'DOCUMENT'].includes(current.type) && chain.length < 20; current = current.parent) {
    const entry = { id: current.id, name: current.name, type: current.type };
    for (const key of ['visible', 'opacity', 'isMask', 'maskType', 'clipsContent', 'fills', 'fillStyleId']) if (key in current && current[key] !== undefined) entry[key] = copy(current[key]);
    chain.unshift(entry);
  }
  return chain;
}
function within(node, rootId) {
  for (let current = node; current; current = current.parent) if (current.id === rootId) return true;
  return false;
}

// -- Return values ------------------------------------------------------
// Return byte arrays separately for file persistence, leaving JSON placeholders. Plain integer arrays count as images only when they encode complete PNG/JPEG data,
// supporting Array.from(await node.exportAsync()).
const PNG_HEAD = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82], PNG_TAIL = [73, 69, 78, 68, 174, 66, 96, 130];
function wholeImage(a) {
  if (a.length >= 57 && PNG_HEAD.every((v, i) => a[i] === v) && PNG_TAIL.every((v, i) => a[a.length - 8 + i] === v)) return true;
  return a.length >= 128 && a[0] === 255 && a[1] === 216 && a[2] === 255 && (a[3] >= 0xE0 && a[3] <= 0xEF || [0xDB, 0xC0, 0xC4, 0xFE].includes(a[3])) && a[a.length - 2] === 255 && a[a.length - 1] === 217;
}
function serializeOutput(output, budget) {
  const binaries = [];
  // Read the original value: byte views with toJSON, such as Buffer, are converted before the replacer runs.
  const text = JSON.stringify(output, function (key, value) {
    if (typeof value === 'symbol') return 'MIXED';
    const original = this[key];
    if (original && typeof original === 'object' && !ArrayBuffer.isView(original) && Object.prototype.hasOwnProperty.call(original, BINARY_KEY)) throw Error(`Return value contains the reserved key ${BINARY_KEY}; the script ran, check the document, do not replay the script`);
    const encodedImage = Array.isArray(original) && wholeImage(original) && original.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
    if (!ArrayBuffer.isView(original) && !encodedImage) return value;
    const bytes = encodedImage ? Uint8Array.from(original) : original instanceof Uint8Array ? original : new Uint8Array(original.buffer, original.byteOffset, original.byteLength);
    const encoded = figma.base64Encode(bytes);
    if (binaries.length >= 200 || (budget.size += encoded.length) > BINARY_LIMIT) throw Error('Binary return values exceed 200 items or 48 MB; the script ran, check the document, do not replay the script');
    binaries.push(encoded);
    return { [BINARY_KEY]: binaries.length - 1 };
  });
  return { output: text === undefined ? null : JSON.parse(text), binaries };
}
async function render(node, scale, budget) {
  const encoded = figma.base64Encode(await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale ?? 1 } }));
  if ((budget.size += encoded.length) > BINARY_LIMIT) throw Error('Exported images exceed 48 MB in total; lower --scale or export in batches');
  return encoded;
}

// -- Local variables ----------------------------------------------------
// Read-only collections, alias-resolved default-mode values, and binding counts within the target subtree.
async function localVariables(target) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync(), variables = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(variables.map(v => [v.id, v])), byCollection = new Map(collections.map(c => [c.id, c])), counts = new Map();
  let scanned = 0, truncated = false;
  const count = value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string') { counts.set(value.id, (counts.get(value.id) || 0) + 1); return; }
    for (const item of Object.values(value)) count(item);
  };
  const visit = node => {
    if (truncated || ++scanned > 50000) { truncated = true; return; }
    count(node.boundVariables);
    for (const child of node.children || []) visit(child);
  };
  visit(target);
  const defaultValue = v => v.valuesByMode[byCollection.get(v.variableCollectionId)?.defaultModeId ?? Object.keys(v.valuesByMode)[0]];
  const resolve = (variable, depth = 0) => {
    const raw = defaultValue(variable);
    return raw?.type === 'VARIABLE_ALIAS' && depth < 10 && byId.has(raw.id) ? resolve(byId.get(raw.id), depth + 1) : raw;
  };
  const hex = value => value && typeof value.r === 'number' ? '#' + [value.r, value.g, value.b, value.a ?? 1].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase() : undefined;
  return {
    collections: collections.map(c => ({ id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId })),
    variables: variables.map(v => {
      const raw = defaultValue(v), value = resolve(v);
      return { id: v.id, name: v.name, collectionId: v.variableCollectionId, collection: byCollection.get(v.variableCollectionId)?.name ?? null, type: v.resolvedType,
        value: value ?? null, ...(v.resolvedType === 'COLOR' && hex(value) ? { hex: hex(value) } : {}), ...(raw?.type === 'VARIABLE_ALIAS' ? { aliasOf: raw.id } : {}),
        scopes: v.scopes, bindings: counts.get(v.id) || 0 };
    }),
    bindingScope: { nodeId: target.id, scannedNodes: Math.min(scanned, 50000), truncated },
    limitation: 'Lists local variables only, with default-mode values (following aliases up to 10 levels); bindings counts only boundVariables on nodes in the target subtree'
  };
}

// -- Script compilation -------------------------------------------------
// Nest each library and the body in its own function scope: earlier libraries are outermost, with the body inside and able to call their functions directly;
// duplicate names shadow outer declarations instead of causing redeclaration errors. Library top-level code evaluates with the body inside Undo boundaries.
function compile(job) {
  const body = (job.libs || []).reduceRight((inner, lib) => `${lib.code}\nreturn (async () => {\n${inner}\n})();`, job.code);
  return new Function('figma', 'target', 'data', `return (async () => {\n${body}\n})();`);
}

// -- Target guidance ----------------------------------------------------
// The panel answers whether the currently open file and page match the bound target.
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
  if (job?.type === 'approval-ack') {
    if (approvalWaiter?.id === job.id && approvalWaiter.channelNonce === job.channelNonce) approvalWaiter.finish(job);
    return;
  }
  if (job?.type === 'checkpoint-ack') {
    if (checkpointWaiter?.id === job.id && checkpointWaiter.channelNonce === job.channelNonce) checkpointWaiter.finish(job);
    return;
  }
  if (!job || !job.id || busy) return;
  busy = true;
  const receivedAt = Date.now();
  let approvalMs = 0;
  const send = message => {
    // Final results include plugin duration, covering snapshots and exports but excluding user approval time.
    const final = message.id === job.id && typeof message.ok === 'boolean';
    const payload = { ...message, ...(final ? { pluginMs: Date.now() - receivedAt - approvalMs, ...(approvalMs ? { approvalMs } : {}) } : {}), channelNonce: job.channelNonce };
    const serialized = JSON.stringify(payload);
    // Cross-host conversion of many numbers is expensive. Serialize task messages (result, checkpoint, approval-request) as one string above 65536 JS characters, not bytes.
    figma.ui.postMessage(serialized.length > 65536 ? { type: 'serialized-result', id: job.id, channelNonce: job.channelNonce, serialized } : payload);
  };
  let before, target = null, page = null, executionStarted = false, ancestors = null;
  const run = job.operation === 'run';
  const declaredDepth = ['run', 'inspect'].includes(job.operation) && Number.isInteger(job.snapshotDepth) && job.snapshotDepth >= 1 && job.snapshotDepth < SNAPSHOT_DEPTH ? job.snapshotDepth : null;
  // preview and variables snapshot only the root; inspect defaults to one level for pages; other operations default to a full snapshot.
  const snapshot = () => tree(target, ['preview', 'variables'].includes(job.operation) ? 0 : declaredDepth ?? (job.operation === 'inspect' && target.type === 'PAGE' ? 1 : SNAPSHOT_DEPTH));
  const undoBoundaries = { before: 'not-run', after: 'not-run' };
  const budget = { size: 0 };
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
    target = candidate;
    page = target;
    while (page && page.type !== 'PAGE') page = page.parent;
    if (!page) throw Error('Target is not inside a page');
    await page.loadAsync();
    await figma.setCurrentPageAsync(page);
    before = snapshot();
    let output;
    if (job.operation === 'inspect') { output = before; ancestors = ancestry(target); }
    else if (job.operation === 'variables') output = await localVariables(target);
    else if (job.operation === 'preview') {
      // Validate binding scope for every batch export; any out-of-scope node fails the entire job.
      const images = [];
      for (const id of Array.isArray(job.nodes) ? job.nodes : [target.id]) {
        const node = id === target.id ? target : await figma.getNodeByIdAsync(id);
        if (!node || !within(node, job.binding.nodeId)) throw Error('Preview node does not exist or is outside the binding scope: ' + id);
        images.push({ nodeId: node.id, name: node.name, base64: await render(node, job.scale, budget) });
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
      let currentPage = target;
      while (currentPage && currentPage.type !== 'PAGE') currentPage = currentPage.parent;
      if (figma.fileKey !== job.binding.fileKey || target.removed || !within(target, job.binding.nodeId) || currentPage?.id !== page.id || JSON.stringify(snapshot()) !== JSON.stringify(before)) throw Error('Target changed while waiting for the snapshot; the script did not run. Run inspect again');
      // Export the before image outside the Undo boundary. Export is read-only, and failure means the script has not executed.
      const renders = job.expect ? { before: await render(target, job.scale, budget) } : null;
      if (typeof figma.commitUndo !== 'function') throw Error('This environment does not support Undo boundaries; the script did not run');
      const commitUndo = figma.commitUndo.bind(figma);
      try { commitUndo(); undoBoundaries.before = 'committed'; }
      catch (error) { undoBoundaries.before = 'failed'; throw error; }
      executionStarted = true;
      let scriptFailure;
      try { output = await program(figma, target, job.data ?? null); }
      catch (error) { scriptFailure = { error }; }
      // Create history boundaries for success and partial failure alike; never trigger global Undo automatically.
      try { commitUndo(); undoBoundaries.after = 'committed'; }
      catch (error) {
        undoBoundaries.after = 'failed';
        throw Error(`${scriptFailure ? `Script error: ${String(scriptFailure.error)}; ` : ''}Failed to commit the closing Undo boundary: ${String(error)}; verify the document, do not auto-undo or replay the script`);
      }
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
    send({ id: job.id, ok: true, output: serializeOutput(output, budget).output, ...(ancestors ? { ancestors } : {}), bindingVerified: { fileKey: figma.fileKey, pageId: page.id, nodeId: before.id } });
  } catch (e) {
    let after;
    if (executionStarted) { try { after = target.removed ? null : snapshot(); } catch (_) {} }
    send({ id: job.id, ok: false, error: String(e), executionStarted, ...(after !== undefined ? { before, after } : {}), ...(ancestors ? { ancestors } : {}),
      recovery: executionStarted ? 'The script started running; keep the current state, verify with inspect first, do not replay the script' : 'The script did not run; fix it and resubmit', ...(run ? { undoBoundaries } : {}) });
  } finally {
    busy = false;
  }
};
