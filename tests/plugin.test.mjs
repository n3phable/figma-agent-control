/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:vm, ./helpers/harness.mjs, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
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
// sandbox can replace globals, such as timers and the clock.
function plugin({ checkpoint = true, approval = 'wait', beforeAck, sandbox } = {}) {
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
  // Replace 10 s / 300 s timeouts with no-ops so tests do not depend on wall time. Millisecond waits for nodechange delivery after failures still run normally.
  vm.runInNewContext(pluginSource, { figma, __html__: '', setTimeout: (fn, ms) => ms < 1000 ? setTimeout(fn, ms) : 0, clearTimeout() {}, ...sandbox });
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
test('Libraries nest in order with earlier ones outside; body code can call them, same-name declarations shadow, and top-level library code runs inside Undo boundaries', async () => {
  const f = plugin();
  const r = await f.send({ targetNodeId: '1:3', libs: [
    { name: 'a', code: 'const tag = "a"; function outer() { return tag; } figma.mark("lib-a");' },
    { name: 'b', code: 'const tag = "b"; function both() { return outer() + tag; } figma.mark("lib-b");' }
  ], code: 'const tag = "body"; figma.mark("body"); target.characters = both(); return { tag, both: both() };' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.output, { tag: 'body', both: 'ab' });
  assert.equal(f.doc.text.characters, 'ab');
  assert.deepEqual(f.events, ['checkpoint', 'undo', 'lib-a', 'lib-b', 'body', 'undo']);
});

test('Body/library syntax errors return before snapshots without execution, document changes, or Undo commits', async () => {
  for (const job of [
    { code: 'target.characters = "x"; const = 1;' },
    { libs: [{ name: 'bad', code: 'function (' }], code: 'target.characters = "x";' }
  ]) {
    const f = plugin();
    const r = await f.send({ targetNodeId: '1:3', ...job });
    assert.equal(r.ok, false);
    assert.equal(r.executionStarted, false);
    assert.match(r.error, /SyntaxError/);
    assert.deepEqual(r.undoBoundaries, { before: 'not-run', after: 'not-run' });
    assert.deepEqual(f.events, []);
    assert.equal(f.doc.text.characters, '\u539f\u6587');
  }
});

test('Compilation precedes target lookup: syntax errors beat missing/out-of-scope targets without querying nodes or starting execution', async () => {
  for (const targetNodeId of ['1:1', '9:9']) {
    const f = plugin();
    const lookup = f.figma.getNodeByIdAsync;
    f.figma.getNodeByIdAsync = id => { f.events.push('resolve'); return lookup(id); };
    const r = await f.send({ targetNodeId, code: 'figma.mark("script"); const = 1;' });
    assert.equal(r.ok, false, targetNodeId);
    assert.equal(r.executionStarted, false, targetNodeId);
    assert.match(r.error, /SyntaxError/, targetNodeId);
    assert.doesNotMatch(r.error, /binding scope|does not exist/, targetNodeId);
    assert.deepEqual(f.events, [], targetNodeId);
  }
});

test('Top-level library and body runtime errors count as execution and return before/after snapshots as evidence', async () => {
  const lib = plugin();
  const thrown = await lib.send({ targetNodeId: '1:3', libs: [{ name: 'boom', code: 'throw Error("lib \u9876\u5c42\u5931\u8d25");' }], code: 'target.characters = "\u4e0d\u5e94\u6267\u884c";' });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.executionStarted, true);
  assert.match(thrown.error, /lib \u9876\u5c42\u5931\u8d25/);
  assert.deepEqual(thrown.undoBoundaries, { before: 'committed', after: 'committed' });
  assert.equal(lib.doc.text.characters, '\u539f\u6587');

  const body = plugin();
  const r = await body.send({ targetNodeId: '1:3', code: 'target.characters = "\u90e8\u5206\u5199\u5165"; throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.equal(r.ok, false);
  assert.equal(r.executionStarted, true);
  assert.equal(r.before.characters, '\u539f\u6587');
  assert.equal(r.after.characters, '\u90e8\u5206\u5199\u5165');
  assert.match(r.recovery, /do not replay the script/);
});

// -- Preconditions and snapshot budgets -----------------------------------
test('Invalid binding prerequisites reject before snapshots: wrong fileKey, non-editing mode, out-of-scope target, or missing target', async () => {
  const cases = [
    ['fileKey mismatch', f => { f.figma.fileKey = 'other'; }, {}, /does not match the binding/],
    ['Cannot verify fileKey', f => { f.figma.fileKey = ''; }, {}, /file key/],
    ['Dev Mode', f => { f.figma.mode = 'inspect'; }, {}, /edit mode/],
    ['FigJam', f => { f.figma.editorType = 'figjam'; }, {}, /edit mode/],
    ['Target is outside binding scope', () => {}, { targetNodeId: '1:1' }, /binding scope/],
    ['Target is missing', () => {}, { targetNodeId: '9:9' }, /does not exist/]
  ];
  for (const [name, setup, job, reason] of cases) {
    const f = plugin();
    setup(f);
    const r = await f.send({ ...job, code: 'figma.mark("script"); target.name = "\u8d8a\u6743";' });
    assert.equal(r.ok, false, name);
    assert.equal(r.executionStarted, false, name);
    assert.match(r.error, reason, name);
    assert.equal(r.before, undefined, name);
    assert.equal(r.targetMissing, undefined, name);
    assert.deepEqual(f.events, [], name);
  }
});

test('Without explicit depth, snapshots exceeding 2000 nodes or truncating are rejected; explicit depth collects only through that level and permits execution', async () => {
  const wide = plugin();
  wide.doc.frame.children = Array.from({ length: 2100 }, (_, i) => ({ id: `5:${i}`, type: 'TEXT', name: '\u5b57', parent: wide.doc.frame }));
  const tooMany = await wide.send({ code: 'figma.mark("script");' });
  assert.equal(tooMany.executionStarted, false);
  assert.match(tooMany.error, /2000/);
  assert.deepEqual(wide.events, []);

  const deep = plugin();
  let node = deep.doc.swatch;
  for (let i = 0; i < 33; i++) { const child = { id: `6:${i}`, type: 'FRAME', name: '\u5c42', parent: node }; node.children = [child]; node = child; }
  const truncated = await deep.send({ targetNodeId: '1:4', code: 'figma.mark("script");' });
  assert.equal(truncated.executionStarted, false);
  assert.match(truncated.error, /truncated/);
  assert.deepEqual(deep.events, []);

  const shallow = plugin();
  shallow.doc.frame.children = Array.from({ length: 3 }, (_, i) => ({ id: `7:${i}`, type: 'FRAME', name: '\u7ec4', parent: shallow.doc.frame,
    children: Array.from({ length: 800 }, (_, j) => ({ id: `7:${i}:${j}`, type: 'TEXT', name: '\u5b57' })) }));
  const r = await shallow.send({ snapshotDepth: 1, code: 'target.children[0].name = "\u6539\u540d"; return target.children.length;' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.output, 3);
  assert.deepEqual(shallow.checkpoints[0].before.children.map(c => [c.truncated, c.children]), [[true, undefined], [true, undefined], [true, undefined]]);
  assert.equal(r.after.children[0].name, '\u6539\u540d');
});

// -- Approval, checkpoints, and revalidation -------------------------------
test('High-risk tasks show the panel for approval before checkpointing or execution, ignore forged replies, and do not execute when denied', async () => {
  const f = plugin();
  const job = f.start({ targetNodeId: '1:3', risk: { level: 'high', reason: '\u6539\u5199\u6807\u9898' }, libs: [{ name: 'helper', code: 'const suffix = "!";' }], code: 'target.characters = "\u9ad8\u98ce\u9669" + suffix;' });
  await flush();
  assert.deepEqual(f.events, ['show', 'approval']);
  assert.equal(f.approvals[0].reason, '\u6539\u5199\u6807\u9898');
  // The panel displays complete combined library and body source.
  assert.match(f.approvals[0].code, /const suffix = "!";[\s\S]*target\.characters = "\u9ad8\u98ce\u9669" \+ suffix;/);
  await f.figma.ui.onmessage({ type: 'approval-ack', id: job.id, channelNonce: 'forged', approved: true });
  await flush();
  assert.deepEqual(f.events, ['show', 'approval']);
  await f.figma.ui.onmessage({ type: 'approval-ack', id: job.id, channelNonce: job.channelNonce, approved: false });
  const r = await job.done;
  assert.equal(r.ok, false);
  assert.equal(r.executionStarted, false);
  assert.deepEqual(f.events, ['show', 'approval']);
  assert.equal(f.doc.text.characters, '\u539f\u6587');

  const allowed = plugin({ approval: true });
  const ok = await allowed.send({ targetNodeId: '1:3', risk: { level: 'high', reason: '\u6539\u5199\u6807\u9898' }, code: 'target.characters = "\u5df2\u786e\u8ba4";' });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(allowed.events, ['show', 'approval', 'checkpoint', 'undo', 'undo']);
  assert.equal(allowed.doc.text.characters, '\u5df2\u786e\u8ba4');
});

test('Execution waits for checkpoint acknowledgment and is rejected on save failure', async () => {
  const f = plugin({ checkpoint: 'wait' });
  const job = f.start({ targetNodeId: '1:3', code: 'target.characters = "\u5199\u5165";' });
  await flush();
  assert.deepEqual(f.events, ['checkpoint']);
  assert.equal(f.checkpoints[0].before.characters, '\u539f\u6587');
  assert.deepEqual(f.checkpoints[0].bindingVerified, { fileKey: 'example', pageId: '1:1', nodeId: '1:3' });
  assert.equal(f.doc.text.characters, '\u539f\u6587');
  await f.figma.ui.onmessage({ type: 'checkpoint-ack', id: job.id, channelNonce: job.channelNonce, ok: false });
  const r = await job.done;
  assert.equal(r.ok, false);
  assert.equal(r.executionStarted, false);
  assert.deepEqual(f.events, ['checkpoint']);
  assert.equal(f.doc.text.characters, '\u539f\u6587');
});

test('Forged checkpoint replies with wrong channelNonce or ID are ignored without accepting/rejecting; only the real reply starts execution', async () => {
  const f = plugin({ checkpoint: 'wait' });
  const job = f.start({ targetNodeId: '1:3', code: 'figma.mark("script"); target.characters = "\u5199\u5165";' });
  await flush();
  for (const forged of [
    { id: job.id, channelNonce: 'forged', ok: true },
    { id: 'job-other', channelNonce: job.channelNonce, ok: true },
    { id: job.id, channelNonce: 'forged', ok: false }
  ]) await f.figma.ui.onmessage({ type: 'checkpoint-ack', ...forged });
  await flush();
  assert.deepEqual(f.events, ['checkpoint']);
  assert.equal(f.results.length, 0);
  assert.equal(f.doc.text.characters, '\u539f\u6587');
  await f.figma.ui.onmessage({ type: 'checkpoint-ack', id: job.id, channelNonce: job.channelNonce, ok: true });
  const r = await job.done;
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(f.events, ['checkpoint', 'undo', 'script', 'undo']);
  assert.equal(f.doc.text.characters, '\u5199\u5165');
});

test('Replies missing id/channelNonce are ignored safely when no waiter exists, and subsequent tasks still execute', async () => {
  const f = plugin();
  // The old waiter?.id === job.id condition matched two undefined values, then threw while reading channelNonce from null.
  await assert.doesNotReject(f.figma.ui.onmessage({ type: 'approval-ack', approved: true }));
  await assert.doesNotReject(f.figma.ui.onmessage({ type: 'checkpoint-ack', ok: true }));
  const r = await f.send({ targetNodeId: '1:3', code: 'target.characters = "\u5199\u5165";' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(f.events, ['checkpoint', 'undo', 'undo']);
});

test('Revalidation rejects edited or moved-out-of-scope targets while preserving user changes', async () => {
  const edits = {
    \u6539\u6587\u5b57: doc => { doc.text.characters = '\u7528\u6237\u8f93\u5165'; },
    \u79fb\u51fa\u8303\u56f4: doc => { doc.frame.children = [doc.swatch]; doc.page.children.push(doc.text); doc.text.parent = doc.page; }
  };
  for (const [name, beforeAck] of Object.entries(edits)) {
    const f = plugin({ beforeAck });
    const r = await f.send({ targetNodeId: '1:3', code: 'figma.mark("script"); target.characters = "\u811a\u672c\u8986\u76d6";' });
    assert.equal(r.executionStarted, false, name);
    assert.match(r.error, /changed while waiting for the snapshot/, name);
    assert.deepEqual(f.events, ['checkpoint'], name);
    assert.notEqual(f.doc.text.characters, '\u811a\u672c\u8986\u76d6', name);
  }
});

// -- Undo boundaries ------------------------------------------------------
const write = 'figma.mark("script"); target.characters = "\u5199\u5165";';

test('Missing figma.commitUndo rejects after checkpoint without execution or document changes', async () => {
  const f = plugin();
  delete f.figma.commitUndo;
  const r = await f.send({ targetNodeId: '1:3', code: write });
  assert.equal(r.ok, false);
  assert.equal(r.executionStarted, false);
  assert.match(r.error, /does not support Undo boundaries/);
  assert.match(r.recovery, /The script did not run/);
  assert.deepEqual(r.undoBoundaries, { before: 'not-run', after: 'not-run' });
  assert.equal(r.after, undefined);
  assert.deepEqual(f.events, ['checkpoint']);
  assert.equal(f.doc.text.characters, '\u539f\u6587');
});

test('The first Undo boundary failure records before=failed without starting execution', async () => {
  const f = plugin();
  f.figma.commitUndo = () => { f.events.push('undo'); throw Error('\u8fb9\u754c\u4e00\u5931\u8d25'); };
  const r = await f.send({ targetNodeId: '1:3', code: write });
  assert.equal(r.ok, false);
  assert.equal(r.executionStarted, false);
  assert.match(r.error, /\u8fb9\u754c\u4e00\u5931\u8d25/);
  assert.match(r.recovery, /The script did not run/);
  assert.deepEqual(r.undoBoundaries, { before: 'failed', after: 'not-run' });
  assert.equal(r.after, undefined);
  assert.deepEqual(f.events, ['checkpoint', 'undo']);
  assert.equal(f.doc.text.characters, '\u539f\u6587');
});

test('The second Undo boundary failure records executionStarted:true and after=failed, forbids automatic undo/replay, and includes any script error', async () => {
  for (const [name, code, scriptError] of [
    ['Script succeeds', write + ' return 1;', null],
    ['Script fails', write + ' throw Error("\u4e2d\u9014\u5931\u8d25");', /Script error: Error: \u4e2d\u9014\u5931\u8d25/]
  ]) {
    const f = plugin();
    let calls = 0;
    f.figma.commitUndo = () => { f.events.push('undo'); if (++calls === 2) throw Error('\u8fb9\u754c\u4e8c\u5931\u8d25'); };
    const r = await f.send({ targetNodeId: '1:3', code });
    assert.equal(r.ok, false, name);
    assert.equal(r.executionStarted, true, name);
    assert.match(r.error, /\u8fb9\u754c\u4e8c\u5931\u8d25/, name);
    assert.match(r.error, /do not auto-undo or replay the script/, name);
    if (scriptError) assert.match(r.error, scriptError, name);
    else assert.doesNotMatch(r.error, /Script error/, name);
    assert.match(r.recovery, /do not replay the script/, name);
    assert.deepEqual(r.undoBoundaries, { before: 'committed', after: 'failed' }, name);
    assert.equal(r.output, undefined, name);
    assert.equal(r.before.characters, '\u539f\u6587', name);
    assert.equal(r.after.characters, '\u5199\u5165', name);
    assert.deepEqual(f.events, ['checkpoint', 'undo', 'script', 'undo'], name);
    assert.equal(f.results.length, 1, name);
  }
});

// -- Failure evidence: newly created nodes -------------------------------
// Mock nodechange batches arrive in macrotasks after 5 ms; script setTimeout splits creates into separate batches.
const nextBatch = 'await new Promise(resolve => setTimeout(resolve, 20));';
const info = (id, type) => ({ id, name: `${type}-${id.slice(3)}`, type });

test('Script failure lists surviving top-level nodes created on the target page, excluding descendants, deleted nodes, and REMOTE changes without modifying the document; success omits them', async () => {
  const f = plugin();
  f.figma.remoteCreate = () => f.doc.create('RECTANGLE', f.doc.page, { origin: 'REMOTE' });
  const r = await f.send({ code: `figma.mark("script");
    const card = figma.createFrame();
    ${nextBatch}
    card.appendChild(figma.createRectangle());
    const icon = figma.createFrame(); icon.appendChild(figma.createRectangle());
    target.appendChild(figma.createRectangle());
    figma.createRectangle().remove();
    figma.remoteCreate();
    throw Error("\u4e2d\u9014\u5931\u8d25");` });
  assert.equal(r.ok, false);
  assert.equal(r.executionStarted, true);
  assert.match(r.error, /\u4e2d\u9014\u5931\u8d25/);
  // 10:2 arrives in another batch but belongs to 10:1; 10:4 shares 10:3's batch so only 10:3 is reported; 10:6 was deleted and 10:7 is remote.
  assert.deepEqual(r.created, [info('10:1', 'FRAME'), info('10:3', 'FRAME'), info('10:5', 'RECTANGLE')]);
  assert.equal('cleaned' in r, false);
  assert.equal(r.warnings, undefined);
  assert.deepEqual(r.undoBoundaries, { before: 'committed', after: 'committed' });
  assert.deepEqual(f.events, ['checkpoint', 'undo', 'script', 'undo']);
  for (const id of ['10:1', '10:2', '10:3', '10:5', '10:7']) assert.equal(f.doc.all.get(id).removed, false, id);
  assert.equal(r.after.children.at(-1).id, '10:5');
  assert.equal(f.doc.listening(f.doc.page), 0);

  const ok = await f.send({ code: 'figma.createFrame(); return 1;' });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(['created' in ok, 'warnings' in ok, ok.undoBoundaries], [false, false, { before: 'committed', after: 'committed' }]);
  assert.equal(f.doc.listening(f.doc.page), 0);
});

test('cleanOnFail removes top-level created nodes after the closing boundary and adds a cleanup boundary; protected or undeletable nodes enter cleanFailed without reverting existing edits', async () => {
  const f = plugin();
  const create = f.doc.create;
  f.doc.create = (...args) => {
    const n = create(...args), remove = n.remove;
    n.remove = function () { f.events.push('remove ' + n.id); if (n.id === '10:3') throw Error('\u8282\u70b9\u5df2\u9501\u5b9a'); return remove.call(this); };
    return n;
  };
  const r = await f.send({ cleanOnFail: true, code: `figma.mark("script"); target.name = "\u6539\u8fc7";
    figma.createFrame().appendChild(figma.createRectangle()); figma.createRectangle(); throw Error("\u4e2d\u9014\u5931\u8d25");` });
  assert.equal(r.ok, false);
  assert.match(r.error, /\u4e2d\u9014\u5931\u8d25/);
  assert.deepEqual(r.created, [info('10:1', 'FRAME'), info('10:3', 'RECTANGLE')]);
  assert.deepEqual(r.cleaned, [info('10:1', 'FRAME')]);
  assert.equal(r.cleanFailed.length, 1);
  assert.deepEqual({ ...r.cleanFailed[0], reason: undefined }, { ...info('10:3', 'RECTANGLE'), reason: undefined });
  assert.match(r.cleanFailed[0].reason, /\u8282\u70b9\u5df2\u9501\u5b9a/);
  // Delete only top-level nodes: 10:2 disappears with 10:1 without a separate remove call.
  assert.deepEqual(f.events, ['checkpoint', 'undo', 'script', 'undo', 'remove 10:1', 'remove 10:3', 'undo']);
  assert.deepEqual(r.undoBoundaries, { before: 'committed', after: 'committed', clean: 'committed' });
  assert.deepEqual(['10:1', '10:2', '10:3'].map(id => f.doc.all.get(id).removed), [true, true, false]);
  assert.equal(f.doc.frame.name, '\u6539\u8fc7');
  assert.equal(r.after.name, '\u6539\u8fc7');

  // A new frame containing a preexisting node (the moved color block) is protected and enters cleanFailed, preserving the existing node.
  const wrap = plugin();
  const wrapped = await wrap.send({ cleanOnFail: true, code: 'figma.createFrame().appendChild(target.children[1]); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([wrapped.created, wrapped.cleaned, wrapped.undoBoundaries.clean], [[info('10:1', 'FRAME')], [], undefined]);
  assert.equal(wrapped.cleanFailed[0].reason, 'Contains node 1:4 that existed before execution; not deleted');
  assert.deepEqual([wrap.doc.all.get('10:1').removed, wrap.doc.swatch.removed, wrap.doc.swatch.parent.id], [false, false, '10:1']);

  // With no new nodes, do not delete or add a boundary. A failed cleanup boundary is recorded while retaining the original script error.
  const none = await plugin().send({ cleanOnFail: true, code: 'target.name = "\u6539\u8fc7"; throw Error("\u6ca1\u6709\u65b0\u5efa");' });
  assert.deepEqual([none.created, none.cleaned, none.cleanFailed, none.undoBoundaries], [[], [], [], { before: 'committed', after: 'committed' }]);
  const g = plugin();
  let calls = 0;
  g.figma.commitUndo = () => { if (++calls === 3) throw Error('\u8fb9\u754c\u4e09\u5931\u8d25'); };
  const late = await g.send({ cleanOnFail: true, code: 'figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.match(late.error, /\u4e2d\u9014\u5931\u8d25/);
  assert.deepEqual([late.cleaned.length, late.undoBoundaries.clean], [1, 'failed']);
  assert.match(late.warnings[0], /Undo boundary after cleanup failed to commit.*\u8fb9\u754c\u4e09\u5931\u8d25/);

  // A failed closing boundary still lists created nodes, but skips deletion because cleanup cannot be a separate Undo step.
  const h = plugin();
  calls = 0;
  h.figma.commitUndo = () => { if (++calls === 2) throw Error('\u8fb9\u754c\u4e8c\u5931\u8d25'); };
  const broken = await h.send({ cleanOnFail: true, code: 'figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.match(broken.error, /Script error: Error: \u4e2d\u9014\u5931\u8d25; Failed to commit the closing Undo boundary: Error: \u8fb9\u754c\u4e8c\u5931\u8d25/);
  assert.deepEqual([broken.created, broken.cleaned, broken.undoBoundaries], [[info('10:1', 'FRAME')], undefined, { before: 'committed', after: 'failed' }]);
  assert.deepEqual([broken.warnings, h.doc.all.get('10:1').removed], [['Closing Undo boundary failed to commit; created nodes were not deleted'], false]);
});

test('cleanOnFail protects preexisting nodes misreported as new; one revalidation failure enters cleanFailed while other nodes and cleanup boundaries proceed', async () => {
  // Model Figma possibly reporting a moved existing page-root node as CREATE (not yet verified on a real device): the pre-execution inventory protects it.
  const f = plugin();
  let listener;
  const on = f.doc.page.on;
  f.doc.page.on = function (type, fn) { listener = fn; return on.call(this, type, fn); };
  f.figma.echo = id => setTimeout(() => listener({ nodeChanges: [{ type: 'CREATE', id, origin: 'LOCAL' }] }), 1);
  const moved = await f.send({ cleanOnFail: true, code: 'target.parent.appendChild(target.children[1]); figma.echo("1:4"); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([moved.created, moved.cleaned], [[{ id: '1:4', name: '\u8272\u5757', type: 'RECTANGLE' }], []]);
  assert.deepEqual([moved.cleanFailed[0].reason, f.doc.swatch.removed], ['Already on the target page before execution; not deleted', false]);

  const g = plugin();
  const create = g.doc.create;
  g.doc.create = (...args) => { const n = create(...args); if (n.id === '10:1') n.findOne = () => { throw Error('\u8bfb\u53d6\u5b50\u6811\u5931\u8d25'); }; return n; };
  const r = await g.send({ cleanOnFail: true, code: 'figma.createFrame(); figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.match(r.error, /\u4e2d\u9014\u5931\u8d25/);
  assert.deepEqual([r.cleaned, r.cleanFailed.map(n => n.id), r.undoBoundaries.clean, r.warnings], [[info('10:2', 'FRAME')], ['10:1'], 'committed', undefined]);
  assert.match(r.cleanFailed[0].reason, /\u8bfb\u53d6\u5b50\u6811\u5931\u8d25/);
  assert.deepEqual(['10:1', '10:2'].map(id => g.doc.all.get(id).removed), [false, true]);
});

test('Event settling uses a wall-clock cap: even with continuous events and throttled timers, stop after about 500 ms', async () => {
  // Treat each 50 ms timer as a throttled 200 ms interval delivering another CREATE. An iteration cap would wait ten times; the wall-clock cap stops after three.
  let now = 1e6, waits = 0, listener;
  const f = plugin({ sandbox: {
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => {
      if (ms !== 50) return ms < 1000 ? setTimeout(fn, ms) : 0;
      now += 200; listener?.({ nodeChanges: [{ type: 'CREATE', id: `9:${++waits}`, origin: 'LOCAL' }] });
      return setTimeout(fn, 0);
    }
  } });
  const on = f.doc.page.on;
  f.doc.page.on = function (type, fn) { listener = fn; return on.call(this, type, fn); };
  const r = await f.send({ code: 'throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.match(r.error, /\u4e2d\u9014\u5931\u8d25/);
  assert.deepEqual([waits, r.created], [3, []]);
});

test('Listener/evidence failures produce warnings without replacing script errors; nodes created after switching pages are excluded from created', async () => {
  const deaf = plugin();
  deaf.doc.page.on = () => { throw Error('unsupported event'); };
  const failed = await deaf.send({ code: 'target.name = "\u5199\u5165"; figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.match(failed.error, /\u4e2d\u9014\u5931\u8d25/);
  assert.equal(failed.created, undefined);
  assert.match(failed.warnings[0], /nodechange listener unavailable.*unsupported event/);
  const ok = await deaf.send({ code: 'target.name = "\u6210\u529f"; return 1;' });
  assert.deepEqual([ok.ok, ok.output, ok.warnings, deaf.doc.frame.name], [true, 1, undefined, '\u6210\u529f']);

  const stuck = plugin();
  stuck.doc.page.off = () => { throw Error('off failed'); };
  const offFailed = await stuck.send({ code: 'figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([offFailed.created.length, offFailed.warnings], [1, undefined]);

  const lost = await plugin().send({ cleanOnFail: true, code: 'figma.createFrame(); figma.getNodeByIdAsync = async () => { throw Error("\u8bfb\u53d6\u5931\u8d25"); }; throw Error("\u811a\u672c\u5931\u8d25");' });
  assert.match(lost.error, /\u811a\u672c\u5931\u8d25/);
  assert.equal(lost.created, undefined);
  assert.match(lost.warnings[0], /Failed to list or clean up created nodes.*\u8bfb\u53d6\u5931\u8d25/);

  const f = plugin();
  const r = await f.send({ cleanOnFail: true, code: 'figma.createFrame(); await figma.setCurrentPageAsync(await figma.getNodeByIdAsync("2:1")); figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual(r.created, [info('10:1', 'FRAME')]);
  assert.deepEqual([f.doc.all.get('10:1').removed, f.doc.all.get('10:2').removed, f.doc.other.children.map(n => n.id)], [true, false, ['10:2']]);
});

// -- Single-task execution ------------------------------------------------
test('A second task arriving during execution is discarded without snapshot, execution, or result, while the first completes normally', async () => {
  const f = plugin({ checkpoint: 'wait' });
  const first = f.start({ targetNodeId: '1:3', code: 'figma.mark("first"); target.characters = "\u7b2c\u4e00\u4e2a"; return 1;' });
  await flush();
  const second = f.start({ targetNodeId: '1:4', code: 'figma.mark("second"); target.name = "\u7b2c\u4e8c\u4e2a"; return 2;' });
  await flush();
  // If the second task were not discarded, it would leave another checkpoint here and steal the reply waiter.
  assert.equal(f.checkpoints.length, 1);
  assert.equal(await second.done, undefined);
  await f.figma.ui.onmessage({ type: 'checkpoint-ack', id: first.id, channelNonce: first.channelNonce, ok: true });
  const r = await first.done;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.output, 1);
  await flush();
  assert.deepEqual(f.events, ['checkpoint', 'undo', 'first', 'undo']);
  assert.deepEqual(f.results.map(m => m.id), [first.id]);
  assert.equal(f.doc.text.characters, '\u7b2c\u4e00\u4e2a');
  assert.equal(f.doc.swatch.name, '\u8272\u5757');
});

// -- Visual verification --------------------------------------------------
const paintRed = 'figma.mark("script"); target.fills = [{ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 0, b: 0 } }]; return "\u5b8c\u6210";';

test('expect exports the before image after revalidation and before the Undo boundary, then exports after script execution, exactly once each', async () => {
  const f = plugin();
  trackExports(f, f.doc.swatch);
  const r = await f.send({ targetNodeId: '1:4', expect: 'changed', code: paintRed });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(f.events, ['checkpoint', 'export', 'undo', 'script', 'undo', 'export']);
  assert.deepEqual(pixel(r.renders.before), [0, 0, 255, 255]);
  assert.deepEqual(pixel(r.renders.after), [255, 0, 0, 255]);
});

test('After-image export failure records only renders.error and preserves script success; before-image failure prevents execution', async () => {
  const late = plugin();
  trackExports(late, late.doc.swatch, 2);
  const r = await late.send({ targetNodeId: '1:4', expect: 'changed', code: paintRed });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.output, '\u5b8c\u6210');
  assert.match(r.renders.error, /\u5bfc\u51fa\u5931\u8d25/);
  assert.equal(r.renders.after, undefined);
  assert.equal(r.after.fills[0].color.r, 1);

  const early = plugin();
  trackExports(early, early.doc.swatch, 1);
  const failed = await early.send({ targetNodeId: '1:4', expect: 'changed', code: paintRed });
  assert.equal(failed.ok, false);
  assert.equal(failed.executionStarted, false);
  assert.deepEqual(early.events, ['checkpoint', 'export']);
  assert.equal(early.doc.swatch.fills[0].color.b, 1);
});

// -- Return-value serialization -------------------------------------------
test('Byte views and complete PNG/JPEG integer arrays become binary placeholders; incomplete or out-of-range arrays remain unchanged', async () => {
  const f = plugin();
  const png = [...encodePng(1, 1, new Uint8Array([1, 2, 3, 255]))];
  const jpg = [255, 216, 255, 224, ...new Array(124).fill(0), 255, 217];
  const kept = { pngHeadOnly: png.slice(0, -1), jpgHeadOnly: jpg.slice(0, -2), outOfRange: png.with(30, 300), plain: [1, 2, 3] };
  const r = await f.send({ targetNodeId: '1:4', data: { jpg, ...kept }, code: `return {
    raw: new Uint8Array([9, 1, 2, 3]).subarray(1), wide: new Uint16Array([0x0201]), exported: Array.from(await target.exportAsync()), jpg: data.jpg,
    pngHeadOnly: data.pngHeadOnly, jpgHeadOnly: data.jpgHeadOnly, outOfRange: data.outOfRange, plain: data.plain };` });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.output, { raw: { [BINARY]: 0 }, wide: { [BINARY]: 1 }, exported: { [BINARY]: 2 }, jpg: { [BINARY]: 3 }, ...kept });
  const bytes = r.binaries.map(b => [...Buffer.from(b, 'base64')]);
  assert.equal(bytes.length, 4);
  assert.deepEqual(bytes[0], [1, 2, 3]);
  assert.deepEqual(bytes[1], [1, 2]);
  assert.deepEqual(pixel(r.binaries[2]), [0, 0, 255, 255]);
  assert.deepEqual(bytes[3], jpg);
});

test('Reserved keys, non-JSON output, or oversized binaries fail after execution and prohibit replay', async () => {
  const cases = {
    \u4fdd\u7559\u952e: ['return { real: new Uint8Array([1]), fake: { __figmaAgentControlBinary: 0 } };', /reserved key/],
    BigInt: ['return 1n;', /JSON/],
    \u8d85\u8fc7200\u4e2a: ['return Array.from({ length: 201 }, () => new Uint8Array([1]));', /200/],
    \u8d85\u8fc748MB: ['return new Uint8Array(37 * 1024 * 1024);', /48 MB/]
  };
  for (const [name, [tail, reason]] of Object.entries(cases)) {
    const f = plugin();
    const r = await f.send({ targetNodeId: '1:3', code: 'target.characters = "\u5df2\u5199\u5165"; ' + tail });
    assert.equal(r.ok, false, name);
    assert.equal(r.executionStarted, true, name);
    assert.match(r.error, reason, name);
    assert.match(r.error, /do not replay the script/, name);
    assert.equal(r.after.characters, '\u5df2\u5199\u5165', name);
    assert.equal(r.binaries, undefined, name);
  }
});

test('Large output crosses the host boundary as one string and unwraps completely; small output passes directly', async () => {
  const f = plugin();
  const big = await f.send({ targetNodeId: '1:3', code: 'return Array.from({ length: 40000 }, (_, i) => i % 256);' });
  assert.equal(big.envelope, true);
  assert.equal(big.ok, true, big.error);
  assert.equal(big.output.length, 40000);
  assert.equal(big.output[39999], 39999 % 256);
  const small = await f.send({ targetNodeId: '1:3', code: 'return 1;' });
  assert.equal(small.envelope, undefined);
  assert.equal(small.output, 1);
  // The threshold counts JS string length, not bytes: 30,000 CJK characters (about 88 KiB UTF-8) still pass directly.
  const wide = await f.send({ targetNodeId: '1:3', code: "return '\u4e2d'.repeat(30000);" });
  assert.equal(wide.envelope, undefined);
  assert.equal(wide.output, '\u4e2d'.repeat(30000));
});

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
test('result.json retains only changes on success and keeps after as evidence on post-execution failure', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const read = async summary => JSON.parse(await fs.readFile(summary.resultFile, 'utf8'));
  const ok = await h.run('run', await writeScript(h.cwd, 'ok.js', 'target.characters = "\u6210\u529f";'), '--node', '1:3');
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  const success = await read(ok.json);
  assert.equal('after' in success, false);
  assert.equal('before' in success, false);
  assert.deepEqual(success.changes.nodes[0].keys, ['characters']);

  const bad = await h.run('run', await writeScript(h.cwd, 'bad.js', 'target.characters = "\u90e8\u5206"; throw Error("\u4e2d\u9014");'), '--node', '1:3');
  assert.equal(bad.code, 1);
  const failure = await read(bad.json);
  assert.equal(failure.executionStarted, true);
  assert.equal(failure.after.characters, '\u90e8\u5206');
  assert.equal('before' in failure, false);
  assert.deepEqual(h.errors, []);
});

test('--clean-on-fail travels through job.json, result and summary created/cleaned lists, with guidance explaining the disposition of new nodes', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const script = await writeScript(h.cwd, 'leaky.js', 'target.name = "\u6539\u8fc7"; figma.createFrame(); figma.createRectangle(); throw Error("\u4e2d\u9014\u5931\u8d25");');
  const kept = await h.run('run', script);
  assert.equal(kept.code, 1);
  assert.deepEqual(kept.json.created.map(n => n.id), ['10:1', '10:2']);
  assert.match(kept.json.instruction, /created 2 node\(s\) \(see created\), which may contain existing layers: inspect their subtrees, then delete them, or add --clean-on-fail next time.*do not replay the script/);
  assert.deepEqual([h.doc.all.get('10:1').removed, h.doc.all.get('10:2').removed], [false, false]);

  const cleaned = await h.run('run', script, '--clean-on-fail');
  assert.equal(cleaned.code, 1);
  const job = JSON.parse(await fs.readFile(cleaned.json.evidence + '/job.json', 'utf8')), result = JSON.parse(await fs.readFile(cleaned.json.resultFile, 'utf8'));
  assert.equal(job.cleanOnFail, true);
  assert.deepEqual([result.created.map(n => n.id), result.cleaned.map(n => n.id), result.cleanFailed, result.undoBoundaries.clean], [['10:3', '10:4'], ['10:3', '10:4'], [], 'committed']);
  assert.deepEqual(cleaned.json.cleaned, result.cleaned);
  assert.match(cleaned.json.instruction, /deleted 2 node\(s\) created by this job; modified existing nodes were not rolled back; .*inspect first.*do not replay the script/);
  assert.deepEqual([h.doc.all.get('10:3').removed, h.doc.all.get('10:4').removed, h.doc.frame.name], [true, true, '\u6539\u8fc7']);
  assert.deepEqual(h.errors, []);
});
