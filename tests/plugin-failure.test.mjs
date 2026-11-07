/**
 * [INPUT]: tests/helpers/plugin plugin/BINDING; tests/helpers/harness harness/writeScript.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Plugin failure contracts: created nodes and real-timing event delivery; cleanOnFail cleanup, safeguards, Undo boundaries, deletedExisting counts/warnings; result.json before/after retention; CLI-to-summary cleanup behavior; script-only stacks, unstringifiable thrown values, and library source traces. Shares VM fixtures with plugin.test.mjs, which covers execution order, rejection, and return values.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { harness, writeScript } from './helpers/harness.mjs';
import { plugin, BINDING } from './helpers/plugin.mjs';

// -- Failure evidence: nodes created by this run ---------------------------
// Mock nodechange batches arrive in macrotasks after 5 ms; script setTimeout splits creates into separate batches.
const nextBatch = 'await new Promise(resolve => setTimeout(resolve, 20));';
// created entries also record parent and own subtree size for deferred cleanup checks; defaults represent empty page-root nodes.
const info = (id, type, size = 0, parentId = '1:1') => ({ id, name: `${type}-${id.slice(3)}`, type, parentId, size });

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
  assert.deepEqual(r.created, [info('10:1', 'FRAME', 1), info('10:3', 'FRAME', 1), info('10:5', 'RECTANGLE', 0, '1:2')]);
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
  assert.deepEqual(r.created, [info('10:1', 'FRAME', 1), info('10:3', 'RECTANGLE')]);
  assert.deepEqual(r.cleaned, [info('10:1', 'FRAME', 1)]);
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
  assert.deepEqual([wrapped.created, wrapped.cleaned, wrapped.undoBoundaries.clean], [[info('10:1', 'FRAME', 1)], [], undefined]);
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
  assert.deepEqual([moved.created, moved.cleaned], [[{ id: '1:4', name: '\u8272\u5757', type: 'RECTANGLE', parentId: '1:1', size: 0 }], []]);
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

test('With real-device-style batches arriving after about 100 ms, short failed scripts still report created nodes', async () => {
  const f = plugin({ delay: 100 });
  const r = await f.send({ cleanOnFail: true, code: 'figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.match(r.error, /\u4e2d\u9014\u5931\u8d25/);
  assert.deepEqual([r.created, r.cleaned, f.doc.all.get('10:1').removed], [[info('10:1', 'FRAME')], [info('10:1', 'FRAME')], true]);
});

test('Event delivery waits at least 200 ms then for 120 ms of silence, caps at 1 s wall time, and overshoots by at most one throttled interval', async () => {
  // Fake clock: each 40 ms plugin wait advances step milliseconds; arrive(waitNumber) injects a CREATE during that wait. Return the wait count.
  const waitsFor = async (step, arrive) => {
    let now = 1e6, waits = 0, listener;
    const f = plugin({ sandbox: {
      Date: class extends Date { static now() { return now; } },
      setTimeout: (fn, ms) => {
        if (ms !== 40) return ms < 1000 ? setTimeout(fn, ms) : 0;
        now += step; if (arrive(++waits)) listener?.({ nodeChanges: [{ type: 'CREATE', id: `9:${waits}`, origin: 'LOCAL' }] });
        return setTimeout(fn, 0);
      }
    } });
    const on = f.doc.page.on;
    f.doc.page.on = function (type, fn) { listener = fn; return on.call(this, type, fn); };
    const r = await f.send({ code: 'throw Error("\u4e2d\u9014\u5931\u8d25");' });
    assert.match(r.error, /\u4e2d\u9014\u5931\u8d25/);
    return waits;
  };
  // No events: wait 200 ms (five waits). An event at the fifth wait restarts 120 ms of silence, ending at 320 ms (eight waits).
  assert.equal(await waitsFor(40, () => false), 5);
  assert.equal(await waitsFor(40, n => n === 5), 8);
  // With each throttled wait lasting 300 ms and delivering events, stop by wall time at 1200 ms (four waits), only one interval past 1 s rather than 25 waits.
  assert.equal(await waitsFor(300, () => true), 4);
});

test('cleanOnFail reports deletedExisting and warnings when execution deleted old nodes and cleanup deleted new ones, excluding REMOTE deletes and moved-but-surviving nodes', async () => {
  // Model figma.flatten replacing existing color block 1:4 with new ID 10:1, which cleanup treats as a new node.
  const flatten = f => { f.figma.flatten = nodes => { nodes.forEach(n => n.remove()); return f.doc.create('VECTOR', f.doc.frame); }; };
  const f = plugin();
  flatten(f);
  let listener;
  const on = f.doc.page.on;
  f.doc.page.on = function (type, fn) { listener = fn; return on.call(this, type, fn); };
  // A collaborator actually deletes text 1:3; the node is gone but REMOTE deletion does not count.
  f.figma.remoteDelete = id => { f.doc.all.get(id).removed = true; setTimeout(() => listener({ nodeChanges: [{ type: 'DELETE', id, origin: 'REMOTE' }] }), 1); };
  const r = await f.send({ cleanOnFail: true, code: 'figma.flatten([target.children[1]]); figma.remoteDelete("1:3"); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.match(r.error, /\u4e2d\u9014\u5931\u8d25/);
  assert.deepEqual([r.created, r.cleaned, r.cleanFailed, r.deletedExisting, r.undoBoundaries.clean], [[info('10:1', 'VECTOR', 0, '1:2')], [info('10:1', 'VECTOR', 0, '1:2')], [], 1, 'committed']);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0], '1 pre-existing node(s) were deleted during execution (by the script, or replaced with new IDs by detachInstance, flatten or createComponentFromNode); the cleaned nodes may include their replacements. Run inspect first; if needed, undo once in Figma to restore what the cleanup removed');
  assert.deepEqual([f.doc.swatch.removed, f.doc.all.get('10:1').removed], [true, true]);

  // Default mode neither scans the target page nor counts existing deletions; it still lists new nodes without deleting them.
  const g = plugin();
  flatten(g);
  let scans = 0;
  const findAll = g.doc.page.findAll;
  g.doc.page.findAll = function (...args) { scans++; return findAll.apply(this, args); };
  const kept = await g.send({ code: 'figma.flatten([target.children[1]]); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([kept.created, 'cleaned' in kept, 'deletedExisting' in kept, kept.warnings, scans], [[info('10:1', 'VECTOR', 0, '1:2')], false, false, undefined, 0]);
  assert.equal(g.doc.all.get('10:1').removed, false);

  // Do not report if only old nodes were deleted and cleanup deleted none; nodes created in this run do not count as existing.
  const h = plugin();
  const onlyDeleted = await h.send({ cleanOnFail: true, code: 'target.children[1].remove(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([onlyDeleted.cleaned, 'deletedExisting' in onlyDeleted, onlyDeleted.warnings], [[], false, undefined]);
  const own = await plugin().send({ cleanOnFail: true, code: 'figma.createFrame().remove(); figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([own.cleaned, 'deletedExisting' in own, own.warnings], [[info('10:2', 'FRAME')], false, undefined]);
  // Moving an existing node to another page also emits DELETE, but the node survives and does not count as deleted.
  const m = plugin();
  const moved = await m.send({ cleanOnFail: true, code: '(await figma.getNodeByIdAsync("2:1")).appendChild(target.children[1]); figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([moved.cleaned, 'deletedExisting' in moved, moved.warnings, m.doc.other.children.map(n => n.id)], [[info('10:1', 'FRAME')], false, undefined, ['1:4']]);
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

// -- Failure reporting: script stacks --------------------------------------
test('Compilation/execution errors, including closing-boundary wrapping, return script stacks; main.js errors do not, and unstringifiable thrown values still report failure', async () => {
  const thrown = await plugin().send({ code: 'throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([thrown.executionStarted, /<anonymous>:4:\d+\)/.test(thrown.stack)], [true, true]);
  const syntax = await plugin().send({ code: 'let x = ;' });
  assert.deepEqual([syntax.executionStarted, typeof syntax.stack], [false, 'string']);
  // Errors from main.js itself: pre-execution file verification and post-success return-value serialization.
  const mismatch = await plugin().send({ binding: { ...BINDING, fileKey: 'other' }, code: 'return 1;' });
  const output = await plugin().send({ code: 'return { get bad() { throw Error("\u8bfb\u53d6\u5931\u8d25"); } };' });
  assert.deepEqual([mismatch.error, 'stack' in mismatch, output.executionStarted, 'stack' in output], ['Error: The current file does not match the binding', false, true, false]);
  assert.match(output.error, /Return value cannot be converted to JSON/);

  // Values whose String() throws: prototype-free objects and read-throwing Proxies, including stack access. Closing-boundary wrapping remains readable.
  for (const code of ['throw Object.create(null);', 'throw new Proxy({}, { get() { throw Error("\u8bfb\u53d6\u5373\u629b\u9519"); } });']) {
    const r = await plugin().send({ code });
    assert.deepEqual([r.ok, r.executionStarted, r.error, 'stack' in r], [false, true, 'The value thrown by the script cannot be converted to text (object)', false], code);
  }
  const h = plugin();
  let calls = 0;
  h.figma.commitUndo = () => { if (++calls === 2) throw Error('\u8fb9\u754c\u4e8c\u5931\u8d25'); };
  const broken = await h.send({ code: 'throw Object.create(null);' });
  assert.match(broken.error, /Script error: The value thrown by the script cannot be converted to text \(object\); Failed to commit the closing Undo boundary: Error: \u8fb9\u754c\u4e8c\u5931\u8d25/);
  const g = plugin();
  calls = 0;
  g.figma.commitUndo = () => { if (++calls === 2) throw Error('\u8fb9\u754c\u4e8c\u5931\u8d25'); };
  const wrapped = await g.send({ code: 'throw Error("\u4e2d\u9014\u5931\u8d25");' });
  assert.deepEqual([/Failed to commit the closing Undo boundary/.test(wrapped.error), /\u4e2d\u9014\u5931\u8d25/.test(wrapped.stack)], [true, true]);
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

test('Library errors retain raw stack in result.json, map the first trace frame to the library line, and expose trace in summaries', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const lib = await writeScript(h.cwd, 'lib.js', 'function align(value) {\n  if (value !== "MIN") throw Error("\u4e0d\u652f\u6301\u7684\u5bf9\u9f50\uff1a" + value);\n}\n');
  const bad = await h.run('run', await writeScript(h.cwd, 'page.js', 'target.name = "\u6539\u8fc7";\nalign("END");\n'), '--lib', lib);
  assert.equal(bad.code, 1);
  const result = JSON.parse(await fs.readFile(bad.json.resultFile, 'utf8'));
  assert.match(result.stack, /\u4e0d\u652f\u6301\u7684\u5bf9\u9f50\uff1aEND/);
  assert.deepEqual(result.trace.map(({ file, line }) => `${file}:${line}`), ['lib.js:2', 'page.js:2']);
  assert.equal(result.trace[0].source, 'if (value !== "MIN") throw Error("\u4e0d\u652f\u6301\u7684\u5bf9\u9f50\uff1a" + value);');
  assert.deepEqual([bad.json.trace, 'stack' in bad.json], [result.trace, false]);
  assert.deepEqual(h.errors, []);
});

test('--clean-on-fail flows from job.json through result/summary created and cleaned lists, deletedExisting when applicable, and guidance explaining new-node outcomes', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const script = await writeScript(h.cwd, 'leaky.js', 'target.name = "\u6539\u8fc7"; figma.createFrame(); figma.createRectangle(); throw Error("\u4e2d\u9014\u5931\u8d25");');
  const kept = await h.run('run', script);
  assert.equal(kept.code, 1);
  assert.deepEqual(kept.json.created.map(n => n.id), ['10:1', '10:2']);
  assert.match(kept.json.instruction, new RegExp(`created 2 node\\(s\\) \\(see created\\), which may contain existing layers: inspect their subtrees, then run figma-agent-control clean ${kept.json.id}, or add --clean-on-fail next time.*do not replay the script`));
  assert.deepEqual([h.doc.all.get('10:1').removed, h.doc.all.get('10:2').removed], [false, false]);

  const cleaned = await h.run('run', script, '--clean-on-fail');
  assert.equal(cleaned.code, 1);
  const job = JSON.parse(await fs.readFile(cleaned.json.evidence + '/job.json', 'utf8')), result = JSON.parse(await fs.readFile(cleaned.json.resultFile, 'utf8'));
  assert.equal(job.cleanOnFail, true);
  assert.deepEqual([result.created.map(n => n.id), result.cleaned.map(n => n.id), result.cleanFailed, result.undoBoundaries.clean], [['10:3', '10:4'], ['10:3', '10:4'], [], 'committed']);
  assert.deepEqual(cleaned.json.cleaned, result.cleaned);
  assert.match(cleaned.json.instruction, /deleted 2 node\(s\) created by this job; modified existing nodes were not rolled back; .*inspect first.*do not replay the script/);
  assert.deepEqual([h.doc.all.get('10:3').removed, h.doc.all.get('10:4').removed, h.doc.frame.name], [true, true, '\u6539\u8fc7']);
  assert.equal('deletedExisting' in result, false);

  // Deleting an existing block during execution adds deletedExisting/warnings to result.json and summaries, with guidance about replacements and Undo recovery.
  const swapped = await h.run('run', await writeScript(h.cwd, 'swap.js', 'target.children[1].remove(); figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");'), '--clean-on-fail');
  const swappedResult = JSON.parse(await fs.readFile(swapped.json.resultFile, 'utf8'));
  assert.deepEqual([swappedResult.deletedExisting, swapped.json.deletedExisting, swapped.json.cleaned.map(n => n.id)], [1, 1, ['10:5']]);
  assert.match(swapped.json.warnings[0], /1 pre-existing node\(s\) were deleted during execution/);
  assert.match(swapped.json.instruction, /not rolled back; 1 node\(s\) that existed before the run were deleted during it \(by the script, or replaced with new IDs by detachInstance, flatten or createComponentFromNode\), so the cleaned nodes may include their replacements; inspect first, and if needed undo once in Figma to restore what the cleanup deleted; .*do not replay the script/);
  assert.deepEqual(h.errors, []);
});
