/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:vm, ./helpers/harness.mjs, ../src/png.mjs.
 * [OUTPUT]: Selected original node:test cases and their unchanged fixture setup.
 * [POS]: Regression coverage for plugin; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createDoc, fakeFigma, pluginSource, harness, writeScript } from './helpers/harness.mjs';
import { encodePng, decodePng } from '../src/png.mjs';

// -- Fixtures -------------------------------------------------------------
const BINDING = { fileKey: 'example', nodeId: '1:2' };
const BINARY = '__figmaAgentControlBinary';
const flush = () => new Promise(resolve => setImmediate(resolve));
const pixel = base64 => [...decodePng(Buffer.from(base64, 'base64')).data.subarray(0, 4)];

// Run real main.js in a VM. Capture postMessage with structuredClone to match the host boundary; unwrap large-result string envelopes before dispatch.
// Respond to checkpoints and high-risk approvals by scenario: true/false acknowledges automatically; wait leaves acknowledgment to the test.
// events records host-call order: show, approval, checkpoint, undo, export, and script markers through figma.mark.
function plugin({ checkpoint = true, approval = 'wait', beforeAck } = {}) {
  const doc = createDoc(), events = [], checkpoints = [], approvals = [], results = [], infos = [];
  const reply = message => queueMicrotask(() => figma.ui.onmessage(message));
  const figma = fakeFigma(doc, { onUi: raw => {
    let message = structuredClone(raw);
    if (message.type === 'serialized-result') message = { ...JSON.parse(message.serialized), envelope: true };
    if (message.type === 'checkpoint') {
      checkpoints.push(message); events.push('checkpoint');
      if (checkpoint === 'wait') return;
      beforeAck?.(doc);
      reply({ type: 'checkpoint-ack', id: message.id, channelNonce: message.channelNonce, ok: checkpoint });
    } else if (message.type === 'approval-request') {
      approvals.push(message); events.push('approval');
      if (approval !== 'wait') reply({ type: 'approval-ack', id: message.id, channelNonce: message.channelNonce, approved: approval });
    } else if (message.type === 'target-info') infos.push(message);
    else results.push(message);
  } });
  figma.commitUndo = () => { events.push('undo'); };
  figma.ui.show = () => { events.push('show'); };
  figma.mark = label => { events.push(label); };
  // Inject no-op timers for 10 s / 300 s waits; those timeouts never fire and tests do not depend on wall-clock time.
  vm.runInNewContext(pluginSource, { figma, __html__: '', setTimeout: () => 0, clearTimeout() {} });
  let seq = 0;
  const start = job => {
    const id = `job-${++seq}`, channelNonce = `nonce-${seq}`;
    const done = figma.ui.onmessage({ id, channelNonce, operation: 'run', binding: BINDING, ...job }).then(() => results.find(r => r.id === id));
    return { id, channelNonce, done };
  };
  return { doc, figma, events, checkpoints, approvals, results, infos, start, send: job => start(job).done };
}
// Record each node export; failOn selects which export call throws.
function trackExports(f, node, failOn) {
  const original = node.exportAsync;
  let calls = 0;
  node.exportAsync = async options => { f.events.push('export'); if (++calls === failOn) throw Error('\u5bfc\u51fa\u5931\u8d25'); return original(options); };
}

// -- Compilation and libraries --------------------------------------------








// -- Preconditions and snapshot budgets -----------------------------------




// -- Approval, checkpoints, and revalidation -------------------------------








// -- Undo boundaries ------------------------------------------------------
const write = 'figma.mark("script"); target.characters = "\u5199\u5165";';







// -- Single-task execution ------------------------------------------------


// -- Visual verification --------------------------------------------------
const paintRed = 'figma.mark("script"); target.fills = [{ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 0, b: 0 } }]; return "\u5b8c\u6210";';





// -- Return-value serialization -------------------------------------------






// -- Read-only tasks ------------------------------------------------------
test('inspect returns the target-to-page display chain in top-down order excluding the page, without checkpointing', async () => {
  const f = plugin(), { doc } = f;
  const group = { id: '1:5', type: 'GROUP', name: '\u7ec4', removed: false, visible: false, opacity: 0.5, isMask: false, parent: doc.frame, children: [doc.swatch] };
  doc.frame.children = [doc.text, group]; doc.frame.clipsContent = true; doc.swatch.parent = group; doc.all.set(group.id, group);
  const r = await f.send({ operation: 'inspect', targetNodeId: '1:4' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.output.id, '1:4');
  assert.deepEqual(r.ancestors, [
    { id: '1:2', name: '\u753b\u677f', type: 'FRAME', visible: true, clipsContent: true, fills: doc.frame.fills },
    { id: '1:5', name: '\u7ec4', type: 'GROUP', visible: false, opacity: 0.5, isMask: false }
  ]);
  assert.deepEqual(f.events, []);
});

test('Missing inspect targets return targetMissing and fileVerified, but file mismatch supplies no such proof', async () => {
  const f = plugin();
  const r = await f.send({ operation: 'inspect', targetNodeId: '9:9' });
  assert.equal(r.ok, false);
  assert.equal(r.executionStarted, false);
  assert.equal(r.targetMissing, true);
  assert.equal(r.missingNodeId, '9:9');
  assert.equal(r.fileVerified, 'example');
  f.figma.fileKey = 'other';
  const wrongFile = await f.send({ operation: 'inspect', targetNodeId: '9:9' });
  assert.equal(wrongFile.ok, false);
  assert.equal(wrongFile.targetMissing, undefined);
  assert.equal(wrongFile.fileVerified, undefined);
});

test('preview exports nodes in request order and scale; any out-of-scope node fails the entire job', async () => {
  const f = plugin();
  const r = await f.send({ operation: 'preview', targetNodeId: '1:3', nodes: ['1:3', '1:4'], scale: 2 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.images.map(i => [i.nodeId, i.name]), [['1:3', '\u6807\u9898'], ['1:4', '\u8272\u5757']]);
  assert.deepEqual(pixel(r.images[0].base64), [128, 128, 128, 255]);
  assert.deepEqual(pixel(r.images[1].base64), [0, 0, 255, 255]);
  assert.equal(decodePng(Buffer.from(r.images[1].base64, 'base64')).width, 4);
  assert.deepEqual(f.events, []);

  const outside = { id: '1:9', type: 'FRAME', name: '\u5916\u90e8', removed: false, parent: f.doc.page,
    exportAsync: async () => { f.events.push('export-outside'); return encodePng(1, 1, new Uint8Array(4)); } };
  f.doc.page.children.push(outside); f.doc.all.set(outside.id, outside);
  const rejected = await f.send({ operation: 'preview', targetNodeId: '1:3', nodes: ['1:3', '1:9'] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /1:9/);
  assert.equal(rejected.images, undefined);
  assert.deepEqual(f.events, []);
});

test('variables reads local default-mode values through aliases and counts bindings only within the target subtree', async () => {
  const f = plugin(), { doc } = f;
  const collection = { id: 'C1', name: '\u8bed\u4e49', modes: [{ modeId: 'm1', name: '\u6df1\u8272' }, { modeId: 'm2', name: '\u6d45\u8272' }], defaultModeId: 'm2' };
  const base = { id: 'V1', name: 'base/white', variableCollectionId: 'C1', resolvedType: 'COLOR', scopes: ['ALL_FILLS'],
    valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 }, m2: { r: 1, g: 1, b: 1, a: 0.05 } } };
  const alias = { ...base, id: 'V2', name: 'surface/veil', valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 }, m2: { type: 'VARIABLE_ALIAS', id: 'V1' } } };
  f.figma.variables = { getLocalVariableCollectionsAsync: async () => [collection], getLocalVariablesAsync: async () => [base, alias] };
  doc.swatch.boundVariables = { fills: [{ type: 'VARIABLE_ALIAS', id: 'V2' }] };
  doc.frame.boundVariables = { width: { type: 'VARIABLE_ALIAS', id: 'V1' } };
  const r = await f.send({ operation: 'variables', targetNodeId: '1:4' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.output.variables.map(v => [v.id, v.collection, v.hex, v.aliasOf ?? null, v.bindings]),
    [['V1', '\u8bed\u4e49', '#FFFFFF0D', null, 0], ['V2', '\u8bed\u4e49', '#FFFFFF0D', 'V1', 1]]);
  assert.deepEqual(r.output.bindingScope, { nodeId: '1:4', scannedNodes: 1, truncated: false });
  assert.deepEqual(f.events, []);
});

test('check-target identifies the bound file and explains missing targets or read failures', async () => {
  const f = plugin();
  const ask = async binding => { await f.figma.ui.onmessage({ type: 'check-target', binding }); return f.infos.at(-1); };
  assert.deepEqual(await ask(BINDING), { type: 'target-info', name: '\u753b\u677f', issue: null });
  assert.match((await ask({ ...BINDING, fileKey: 'other' })).issue, /not the bound file/);
  f.doc.frame.removed = true;
  assert.match((await ask(BINDING)).issue, /no longer exists/);
  f.figma.getNodeByIdAsync = async () => { throw Error('\u8bfb\u53d6\u5931\u8d25'); };
  assert.match((await ask(BINDING)).issue, /temporarily unavailable/);
  // If fileKey is unavailable, explain that directly instead of reporting a file mismatch.
  f.figma.fileKey = undefined;
  assert.match((await ask(BINDING)).issue, /cannot read this file's fileKey/);
  assert.equal(f.results.length, 0);
});

// -- End to end: result.json before/after retention -------------------------

