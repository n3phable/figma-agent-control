/**
 * [INPUT]: Imports node:test, node:assert/strict, ./helpers/plugin.mjs, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for plugin; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plugin, BINDING } from './helpers/plugin.mjs';
import { encodePng, decodePng } from '../src/png.mjs';

// -- Fixtures -------------------------------------------------------------
const BINARY = '__figmaAgentControlBinary';
const flush = () => new Promise(resolve => setImmediate(resolve));
const pixel = base64 => [...decodePng(Buffer.from(base64, 'base64')).data.subarray(0, 4)];

// Record each node export; failOn selects which export call throws.
function trackExports(f, node, failOn) {
  const original = node.exportAsync;
  let calls = 0;
  node.exportAsync = async options => { f.events.push('export'); if (++calls === failOn) throw Error('\u5bfc\u51fa\u5931\u8d25'); return original(options); };
}
// Named-export fixture: bound page 1:1 contains frame 1:2 (text and color block), a project Section with a detail frame, and an archive Section with a deeper frame.
const PAGE_BINDING = { fileKey: 'example', nodeId: '1:1' };
function namedDoc(f) {
  const { doc } = f, section = doc.create('SECTION', doc.page), detail = doc.create('FRAME', section), archive = doc.create('SECTION', section), deep = doc.create('FRAME', archive);
  Object.assign(section, { name: '\u9879\u76ee' }); Object.assign(detail, { name: '\u8be6\u60c5' }); Object.assign(archive, { name: '\u5f52\u6863' }); Object.assign(deep, { name: '\u6df1\u5904' });
  return { section, detail, archive, deep };
}
// Track every exported node ID: name-resolution failure must not call exportAsync at all.
function trackAll(f) {
  const exported = [];
  for (const n of f.doc.all.values()) if (n.exportAsync) { const original = n.exportAsync; n.exportAsync = options => { exported.push(n.id); return original(options); }; }
  return exported;
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
test('Binding precondition failures reject without snapshots: file mismatch, non-edit mode, out-of-scope/missing target, or missing bound node', async () => {
  const cases = [
    ['fileKey mismatch', f => { f.figma.fileKey = 'other'; }, {}, /does not match the binding/],
    ['Cannot verify fileKey', f => { f.figma.fileKey = ''; }, {}, /file key/],
    ['Dev Mode', f => { f.figma.mode = 'inspect'; }, {}, /edit mode/],
    ['FigJam', f => { f.figma.editorType = 'figjam'; }, {}, /edit mode/],
    ['Target is outside binding scope', () => {}, { targetNodeId: '1:1' }, /^Error: Local target 1:1 is outside the binding scope$/],
    ['Target is missing', () => {}, { targetNodeId: '9:9' }, /^Error: Local target 9:9 does not exist; it may have been deleted or recreated\. Locate it again$/],
    ['Bound node is missing', () => {}, { binding: { ...BINDING, nodeId: '9:9' } }, /^Error: Bound node 9:9 does not exist; it may have been deleted\. Restore it in Figma, or run init again in a new project directory$/]
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
  assert.match(tooMany.error, /2000-node budget: for write jobs, target the ancestor that covers all writes \(usually the page or a Section\) and add --depth.*or the change set will be empty; when the target is a page, omit --expect and do the visual check with preview on specific frames; for read-only jobs, add --depth or narrow with --node/);
  assert.deepEqual(wide.events, []);

  const deep = plugin();
  let node = deep.doc.swatch;
  for (let i = 0; i < 33; i++) { const child = { id: `6:${i}`, type: 'FRAME', name: '\u5c42', parent: node }; node.children = [child]; node = child; }
  const truncated = await deep.send({ targetNodeId: '1:4', code: 'figma.mark("script");' });
  assert.equal(truncated.executionStarted, false);
  assert.match(truncated.error, /truncated \(deeper than 32 levels\); the script did not run\. Retarget a shallower node that still covers all writes to keep full-depth evidence; otherwise, for write jobs, target the ancestor that covers all writes.*--depth/);
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

// -- Page-root additions and removals --------------------------------------
test('Successful non-page targets report pageRoot additions/removals capped at 50 each with omitted counts; nodes moved into the target, failed scripts, and page targets omit them', async () => {
  const f = plugin(), old = f.doc.create('FRAME', f.doc.page);
  const moved = await f.send({ code: `figma.createRectangle(); (await figma.getNodeByIdAsync("${old.id}")).remove();` });
  assert.deepEqual(moved.pageRoot, { created: [{ id: '10:2', name: 'RECTANGLE-2', type: 'RECTANGLE' }], deleted: [{ id: old.id, name: 'FRAME-1', type: 'FRAME' }] });
  const many = await f.send({ code: 'for (let i = 0; i < 51; i++) figma.createRectangle();' });
  assert.deepEqual([many.pageRoot.created.length, many.pageRoot.created[0].id, many.pageRoot.createdOmitted, many.pageRoot.deleted, 'deletedOmitted' in many.pageRoot], [50, '10:3', 1, [], false]);
  const inside = await f.send({ code: 'target.appendChild(figma.createRectangle());' });
  const failed = await f.send({ code: 'figma.createRectangle(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  const page = await f.send({ binding: PAGE_BINDING, code: 'figma.createRectangle();' });
  assert.deepEqual([inside, failed, page].map(r => [r.ok, 'pageRoot' in r]), [[true, false], [false, false], [true, false]]);
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

test('preview exports multiple nodes in request order and scale; any missing/out-of-scope node fails the whole task with distinct errors', async () => {
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
  assert.match(rejected.error, /Local target 1:9 is outside the binding scope/);
  assert.equal(rejected.images, undefined);
  assert.deepEqual(f.events, []);
  // Report missing nodes separately: scripts may recreate them with new IDs.
  const missing = await f.send({ operation: 'preview', targetNodeId: '1:3', nodes: ['1:3', '9:9'] });
  assert.match(missing.error, /Local target 9:9 does not exist; it may have been deleted or recreated\. Locate it again/);
  assert.doesNotMatch(missing.error, /binding scope/);
});

test('Named preview matches exact children and nested Sections of the bound node, exports in request order, and can name Sections themselves', async () => {
  const f = plugin(), { section, detail, deep } = namedDoc(f), exported = trackAll(f);
  const r = await f.send({ operation: 'preview', binding: PAGE_BINDING, names: ['\u6df1\u5904', '\u753b\u677f', '\u8be6\u60c5', '\u9879\u76ee'] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.images.map(i => [i.nodeId, i.name]), [[deep.id, '\u6df1\u5904'], ['1:2', '\u753b\u677f'], [detail.id, '\u8be6\u60c5'], [section.id, '\u9879\u76ee']]);
  assert.deepEqual(exported, [deep.id, '1:2', detail.id, section.id]);
  assert.equal(r.bindingVerified.nodeId, '1:1');
});

test('Named preview does not descend into frames; missing names or whitespace mismatches list in-scope names and export nothing', async () => {
  const f = plugin();
  namedDoc(f);
  const exported = trackAll(f);
  for (const names of [['\u6807\u9898'], ['\u8be6\u60c5', '\u8272\u5757'], ['\u753b\u677f ']]) {
    const r = await f.send({ operation: 'preview', binding: PAGE_BINDING, names });
    assert.deepEqual([r.ok, r.executionStarted, r.images], [false, false, undefined], names.join());
    assert.match(r.error, /Name ".*" not found among the children and Sections of the bound node; names in scope: \u753b\u677f, \u9879\u76ee, \u8be6\u60c5, \u5f52\u6863, \u6df1\u5904$/, names.join());
  }
  assert.deepEqual(exported, []);
});

test('Duplicate names at root and in Sections report every candidate ID/location without falling back to the bound node or exporting', async () => {
  const f = plugin(), { detail } = namedDoc(f);
  detail.name = '\u753b\u677f';
  const exported = trackAll(f);
  const r = await f.send({ operation: 'preview', binding: PAGE_BINDING, names: ['\u6df1\u5904', '\u753b\u677f'] });
  assert.deepEqual([r.ok, r.executionStarted, r.images], [false, false, undefined]);
  assert.equal(r.error, `Error: Name "\u753b\u677f" has 2 matches: 1:2 (bound node root), ${detail.id} (Section "\u9879\u76ee"); remove the duplicate names first, or use --node instead`);
  assert.deepEqual(exported, []);
});

test('Named preview still validates resolved-node binding scope before exporting', async () => {
  const f = plugin(), { detail } = namedDoc(f), lookup = f.figma.getNodeByIdAsync;
  // Move the frame to another page after name resolution but before ID lookup; binding is page 1:1.
  f.figma.getNodeByIdAsync = async id => { if (id === detail.id) f.doc.other.appendChild(detail); return lookup(id); };
  const exported = trackAll(f);
  const r = await f.send({ operation: 'preview', binding: PAGE_BINDING, names: ['\u8be6\u60c5'] });
  assert.deepEqual([r.ok, r.executionStarted], [false, false]);
  assert.match(r.error, new RegExp(`Local target ${detail.id} is outside the binding scope`));
  assert.deepEqual(exported, []);
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
  assert.deepEqual(await ask(BINDING), { type: 'target-info', name: '\u753b\u677f', nodeType: 'FRAME', page: '\u9875\u9762', id: '1:2', issue: null });
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

test('focus-target navigates to the last verified target page, selects it, and scrolls into view; failed verification prevents movement', async () => {
  const f = plugin(), zoomed = [];
  f.figma.viewport = { scrollAndZoomIntoView: nodes => zoomed.push(Array.from(nodes, n => n.id)) };
  const focus = () => f.figma.ui.onmessage({ type: 'focus-target' });
  f.figma.currentPage = f.doc.other;
  await focus();
  assert.deepEqual(zoomed, [], 'No target has been verified');
  await f.figma.ui.onmessage({ type: 'check-target', binding: BINDING });
  await focus();
  assert.equal(f.figma.currentPage, f.doc.page);
  assert.deepEqual(Array.from(f.doc.page.selection, n => n.id), ['1:2']);
  assert.deepEqual(zoomed, [['1:2']]);
  await f.figma.ui.onmessage({ type: 'check-target', binding: { ...BINDING, fileKey: 'other' } });
  await focus();
  assert.deepEqual(zoomed, [['1:2']], 'Failed verification prevents subsequent focus');
});
