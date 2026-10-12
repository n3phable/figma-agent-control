/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:path, node:child_process, node:crypto, ../src/project.mjs, ../src/bridge.mjs, ../src/record.mjs, ../src/report.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for record; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { init, json, save } from '../src/project.mjs';
import { start } from '../src/bridge.mjs';
import { changeSet, scriptTrace, localResult, summarizeRecord, exitCode, waitForResult } from '../src/record.mjs';
import { report } from '../src/report.mjs';

// -- Fixtures -------------------------------------------------------------
const ID = '12345678-1234-1234-1234-123456789012';

// Evidence directory under runs/<ID>; files maps filenames to contents and uses bridge-style atomic writes.
async function evidence(t, files) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-record-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const dir = path.join(cwd, '.figma-agent-control', 'runs', ID);
  const write = async more => { for (const [file, value] of Object.entries(more)) await save(path.join(dir, file), value); };
  await write({ 'job.json': { id: ID, operation: 'run', state: 'running' }, ...files });
  return { cwd, dir, write, read: () => localResult(cwd, ID) };
}

// Injectable clock: sleep advances virtual time and lets tests change disk state after each wait.
function fakeClock(onSleep = () => {}) {
  const clock = { t: 0, sleeps: 0, now: () => clock.t, sleep: async ms => { clock.t += ms; clock.sleeps++; await onSleep(clock.sleeps); } };
  return clock;
}

// Snapshot nodes match plugin/main.js tree(): flat properties and a children array.
const solid = (r, extra = {}) => ({ type: 'SOLID', visible: true, opacity: 1, color: { r, g: 0, b: 0 }, ...extra });
const alias = { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' };
const rect = (id, extra = {}) => ({ id, type: 'RECTANGLE', name: '\u77e9\u5f62' + id, x: 0, y: 0, width: 10, height: 10, fills: [solid(1)], ...extra });
const frame = (children, extra = {}) => ({ id: '1:2', type: 'FRAME', name: '\u753b\u677f', x: 0, y: 0, width: 100, height: 50, ...extra, children });
const zero = { created: 0, deleted: 0, moved: 0, updated: 0, bindingOnly: 0, positionOnly: 0 };

// -- Change sets ----------------------------------------------------------

test('Change sets list value changes, omit position fields from keys, and retain accompanying bindings', () => {
  const before = frame([rect('1:3', { type: 'TEXT', characters: '\u539f\u6587' }), rect('1:4')]);
  const after = frame([
    rect('1:3', { type: 'TEXT', characters: '\u65b0\u6587\u6848', x: 12, width: 24, absoluteBoundingBox: { x: 12, y: 0, width: 24, height: 10 } }),
    rect('1:4', { fills: [solid(0, { boundVariables: { color: alias } })], boundVariables: { fills: [alias] } })
  ]);
  const changes = changeSet(before, after);
  assert.deepEqual(changes.counts, { ...zero, updated: 2 });
  assert.deepEqual(changes.nodes, [
    { id: '1:3', name: '\u77e9\u5f621:3', change: 'updated', keys: ['characters', 'width'] },
    // Actual color changes cannot become bindingOnly merely because bindings also appear.
    { id: '1:4', name: '\u77e9\u5f621:4', change: 'updated', keys: ['boundVariables', 'fills'] }
  ]);
  assert.equal('omitted' in changes, false);
  assert.equal('limitation' in changes, false);
});

test('Binding-only changes, including fills/strokes/effects bindings, increment bindingOnly without listing nodes', () => {
  const shadow = { type: 'DROP_SHADOW', visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 0.2 } };
  const before = frame([rect('1:3'), rect('1:4'), rect('1:5', { strokes: [solid(0)] }), rect('1:6', { effects: [shadow] })]);
  const after = frame([
    rect('1:3', { boundVariables: { opacity: alias } }),
    rect('1:4', { fills: [solid(1, { boundVariables: { color: alias } })] }),
    rect('1:5', { strokes: [solid(0, { boundVariables: { color: alias } })] }),
    rect('1:6', { effects: [{ ...shadow, boundVariables: { radius: alias } }] })
  ]);
  const changes = changeSet(before, after);
  assert.deepEqual(changes.nodes, []);
  assert.equal(changes.counts.bindingOnly, 4);
  assert.deepEqual([changes.counts.created, changes.counts.deleted, changes.counts.moved, changes.counts.positionOnly, changes.counts.updated], [0, 0, 0, 0, 0]);
});

test('Changes only to x/y/relativeTransform/absoluteBoundingBox increment positionOnly without listing nodes', () => {
  const before = frame([rect('1:3'), rect('1:4'), rect('1:5'), rect('1:6')]);
  const after = frame([
    rect('1:3', { x: 8 }),
    rect('1:4', { y: 8 }),
    rect('1:5', { relativeTransform: [[1, 0, 0], [0, 1, 8]] }),
    rect('1:6', { absoluteBoundingBox: { x: 0, y: 8, width: 10, height: 10 } })
  ]);
  const changes = changeSet(before, after);
  assert.deepEqual(changes.nodes, []);
  assert.equal(changes.counts.positionOnly, 4);
  assert.deepEqual([changes.counts.created, changes.counts.deleted, changes.counts.moved, changes.counts.bindingOnly, changes.counts.updated], [0, 0, 0, 0, 0]);
});

test('Added, removed, and reparented nodes become created/deleted/moved; removing the target marks all nodes deleted', () => {
  const before = frame([{ id: '1:5', type: 'GROUP', name: '\u7f16\u7ec4', children: [rect('1:6')] }, rect('1:7')]);
  const after = frame([{ id: '1:5', type: 'GROUP', name: '\u7f16\u7ec4', children: [] }, rect('1:6', { x: 40 }), rect('1:8')]);
  const changes = changeSet(before, after);
  const { created, deleted, moved, bindingOnly, positionOnly } = changes.counts;
  assert.deepEqual({ created, deleted, moved, bindingOnly, positionOnly }, { created: 1, deleted: 1, moved: 1, bindingOnly: 0, positionOnly: 0 });
  const byId = new Map(changes.nodes.map(node => [node.id, node]));
  assert.deepEqual(byId.get('1:7'), { id: '1:7', name: '\u77e9\u5f621:7', change: 'deleted' });
  // Reparenting x changes are positional and stay out of keys.
  assert.deepEqual(byId.get('1:6'), { id: '1:6', name: '\u77e9\u5f621:6', change: 'moved', keys: [] });
  assert.deepEqual(byId.get('1:8'), { id: '1:8', name: '\u77e9\u5f621:8', change: 'created' });
  assert.equal(changes.nodes.length, 3);

  // The plugin returns after=null when the target is deleted.
  const gone = changeSet(before, null);
  assert.equal(gone.counts.deleted, 4);
  assert.equal(gone.counts.created + gone.counts.moved + gone.counts.updated, 0);
});

test('Deleting the first child does not mark unchanged-parent, unchanged-relative-order siblings as moved', () => {
  const before = frame([rect('1:3'), rect('1:4'), rect('1:5')]);
  const after = frame([rect('1:4'), rect('1:5')]);
  const changes = changeSet(before, after);
  assert.equal(changes.counts.deleted, 1);
  assert.equal(changes.counts.moved, 0);
  assert.deepEqual(changes.nodes, [{ id: '1:3', name: '\u77e9\u5f621:3', change: 'deleted' }]);
});

test('Prepending one child to 60 siblings records only created, without marking later siblings moved', () => {
  const children = Array.from({ length: 60 }, (_, i) => rect(`2:${i}`));
  const changes = changeSet(frame(children), frame([rect('3:1'), ...children]));
  assert.deepEqual(changes.counts, { ...zero, created: 1 });
  assert.deepEqual(changes.nodes, [{ id: '3:1', name: '\u77e9\u5f623:1', change: 'created' }]);
});

test('Sibling reorder uses the longest order-preserving subsequence: swapping marks one move and rotating the first to last marks only that node', () => {
  const swapped = changeSet(frame([rect('1:3'), rect('1:4')]), frame([rect('1:4'), rect('1:3')]));
  assert.deepEqual(swapped.counts, { ...zero, moved: 1 });
  assert.equal(swapped.nodes.length, 1);
  assert.ok(['1:3', '1:4'].includes(swapped.nodes[0].id), swapped.nodes[0].id);
  assert.deepEqual([swapped.nodes[0].change, swapped.nodes[0].keys], ['moved', []]);

  // Reparenting remains covered by the added/removed/reparented case.
  const ids = ['1:3', '1:4', '1:5', '1:6'];
  const rotated = changeSet(frame(ids.map(id => rect(id))), frame([...ids.slice(1), ids[0]].map(id => rect(id))));
  assert.deepEqual(rotated.counts, { ...zero, moved: 1 });
  assert.deepEqual(rotated.nodes, [{ id: '1:3', name: '\u77e9\u5f621:3', change: 'moved', keys: [] }]);
});

test('Change lists cap at 50 with omitted counts; declared depth adds a limitation and allows truncated snapshots, while undeclared truncation makes comparison unavailable', () => {
  const many = frame(Array.from({ length: 60 }, (_, i) => rect(`2:${i}`)));
  const changes = changeSet(frame([]), many);
  assert.equal(changes.counts.created, 60);
  assert.equal(changes.nodes.length, 50);
  assert.equal(changes.omitted, 10);

  // depth=1 marks boundary nodes truncated; deeper changes are invisible, but changes at the boundary still count.
  const before = frame([rect('1:3', { truncated: true })]);
  const after = frame([rect('1:3', { truncated: true, width: 30 })]);
  const limited = changeSet(before, after, 1);
  assert.deepEqual(limited.nodes, [{ id: '1:3', name: '\u77e9\u5f621:3', change: 'updated', keys: ['width'] }]);
  assert.equal(typeof limited.limitation, 'string');
  assert.ok(limited.limitation.length > 0);

  // Without declared depth, truncation means incomplete snapshots: return unavailable without counts or lists.
  const unknown = changeSet(frame([rect('1:3')]), frame([rect('1:3', { truncated: true })]));
  assert.deepEqual(Object.keys(unknown), ['scope', 'unavailable']);
  assert.equal(unknown.scope, 'subtree');
  assert.match(unknown.unavailable, /truncated.*target a shallower node that still covers all writes, or declare --depth/);
});

// -- Script error locations -----------------------------------------------
// Real Figma Desktop QuickJS samples: two probe scripts each use one --lib. Stacks and source, including trailing newlines, are preserved exactly from submission/readback.
const PROBE = { label: 'probe-stack.js', libs: [{ name: 'probe-lib.js', code: [
  "// \u63a2\u9488 lib\uff1a\u7b2c 3 \u884c\u629b\u9519",
  "function libThrow() {",
  "  throw new Error('probe-lib.js:3');",
  "}",
  ""].join('\n') }], code: [
  "const here = new Error('probe-stack.js:1').stack;",
  "const grab = f => { try { f(); return null; } catch (e) { return { text: String(e), stack: typeof e?.stack === 'string' ? e.stack : `(${typeof e?.stack})` }; } };",
  "const out = { here };",
  "out.lib = grab(() => libThrow());",
  "out.host = grab(() => figma.getNodeById(target.id));",
  "out.fn = grab(() => new Function('a', 'b', '\\n\\nthrow Error(\"fn:3\")')(1, 2));",
  "out.sourceURL = grab(() => new Function('throw Error(\"s\")\\n//# sourceURL=fac-probe.js')());",
  "out.syntax = grab(() => new Function('\\n\\nlet x = ;'));",
  "function inner() { throw Error('probe-stack.js:9'); }",
  "function outer() { [0].forEach(() => inner()); }",
  "out.chain = grab(outer);",
  "await new Promise(resolve => setTimeout(resolve, 0));",
  "out.afterAwait = grab(() => { throw Error('probe-stack.js:13'); });",
  "try { await figma.loadFontAsync({ family: 'FAC-Probe-NoSuchFont', style: 'Regular' }); } catch (e) { out.asyncHost = { text: String(e), stack: typeof e?.stack === 'string' ? e.stack : `(${typeof e?.stack})` }; }",
  "const f = figma.createFrame();",
  "try { f.layoutMode = 'HORIZONTAL'; out.setter = grab(() => { f.counterAxisAlignItems = 'END'; }); } finally { f.remove(); }",
  "out.engine = { captureStackTrace: typeof Error.captureStackTrace, prepareStackTrace: typeof Error.prepareStackTrace, intl: typeof Intl };",
  "return out;",
  ""].join('\n') };
const PROBE2 = { label: 'probe2.js', libs: [{ name: 'probe2-lib.js', code: [
  "function parseIt(s) {",
  "  return JSON.parse(s);",
  "}",
  "function setIt(inst, props) {",
  "  inst.setProperties(props);",
  "}",
  ""].join('\n') }], code: [
  "const grab = f => { try { f(); return null; } catch (e) { return { text: String(e), stack: typeof e?.stack === 'string' ? e.stack : `(${typeof e?.stack})` }; } };",
  "const out = {};",
  "out.json = grab(() => parseIt('{\\n\"a\":'));",
  "const a = figma.createComponent(); a.name = 'K=a';",
  "const b = figma.createComponent(); b.name = 'K=b';",
  "const set = figma.combineAsVariants([a, b], figma.currentPage);",
  "const inst = a.createInstance();",
  "try { out.props = grab(() => setIt(inst, { K: 'zzz' })); } finally { inst.remove(); set.remove(); }",
  "return out;",
  ""].join('\n') };
const STACKS = {
  lib: "    at libThrow (<input>:6:18)\n    at <anonymous> (<input>:13:30)\n    at grab (<input>:11:28)\n    at <anonymous> (<input>:13:15)\n    at <anonymous> (<input>:29:3)\n    at anonymous (<input>:3:1)\n    at <anonymous> (PLUGIN_11_SOURCE:661:61)\n",
  setter: "    at <anonymous> (<input>:25:63)\n    at grab (<input>:11:28)\n    at <anonymous> (<input>:25:53)\n",
  syntax: "    at <input>:5:9\n    at Function (native)\n    at <anonymous> (<input>:17:37)\n    at grab (<input>:11:28)\n    at <anonymous> (<input>:17:18)\n    at <anonymous> (<input>:29:3)\n    at anonymous (<input>:3:1)\n    at <anonymous> (PLUGIN_11_SOURCE:661:61)\n",
  fn: "    at anonymous (<input>:5:12)\n    at <anonymous> (<input>:15:70)\n    at grab (<input>:11:28)\n    at <anonymous> (<input>:15:14)\n    at <anonymous> (<input>:29:3)\n    at anonymous (<input>:3:1)\n    at <anonymous> (PLUGIN_11_SOURCE:661:61)\n",
  afterAwait: "    at <anonymous> (<input>:22:42)\n    at grab (<input>:11:28)\n    at <anonymous> (<input>:22:22)\n",
  json: "    at <input>:2:5\n    at parse (native)\n    at parseIt (<input>:5:3)\n    at <anonymous> (<input>:14:30)\n    at grab (<input>:12:28)\n    at <anonymous> (<input>:14:16)\n    at <anonymous> (<input>:22:3)\n    at anonymous (<input>:3:1)\n    at <anonymous> (PLUGIN_11_SOURCE:661:61)\n",
  props: "    at setIt (<input>:8:21)\n    at <anonymous> (<input>:19:35)\n    at grab (<input>:12:28)\n    at <anonymous> (<input>:19:23)\n    at <anonymous> (<input>:22:3)\n    at anonymous (<input>:3:1)\n    at <anonymous> (PLUGIN_11_SOURCE:661:61)\n"
};
const where = trace => trace.map(({ file, line }) => `${file}:${line}`);

test('scriptTrace maps real Figma stacks to library/body lines, skips anonymous runtime frames, and stops at the outer wrapper', () => {
  const lib = scriptTrace(PROBE, STACKS.lib, true);
  assert.deepEqual(where(lib), ['probe-lib.js:3', 'probe-stack.js:4', 'probe-stack.js:2', 'probe-stack.js:4']);
  assert.deepEqual(lib[0], { file: 'probe-lib.js', line: 3, column: 18, source: "throw new Error('probe-lib.js:3');" });
  // Synchronous host API validation errors preserve script frames; after await, only frames inside the async boundary remain.
  assert.deepEqual(where(scriptTrace(PROBE, STACKS.setter, true)), ['probe-stack.js:16', 'probe-stack.js:2', 'probe-stack.js:16']);
  assert.deepEqual(where(scriptTrace(PROBE, STACKS.afterAwait, true)), ['probe-stack.js:13', 'probe-stack.js:2', 'probe-stack.js:13']);
  // Nested script-created Function syntax and anonymous body frames do not belong to the submitted source segments.
  assert.equal(where(scriptTrace(PROBE, STACKS.syntax, true))[0], 'probe-stack.js:8');
  assert.equal(where(scriptTrace(PROBE, STACKS.fn, true))[0], 'probe-stack.js:6');
  // JSON.parse anonymous locations refer to JSON text; host setProperties errors still preserve the caller chain.
  assert.deepEqual(where(scriptTrace(PROBE2, STACKS.json, true)), ['probe2-lib.js:2', 'probe2.js:3', 'probe2.js:1', 'probe2.js:3']);
  assert.deepEqual(where(scriptTrace(PROBE2, STACKS.props, true)), ['probe2-lib.js:5', 'probe2.js:8', 'probe2.js:1', 'probe2.js:8']);
});

test('scriptTrace trusts unnamed frames only before execution, returns empty for missing/unknown stacks, accepts only V8 eval-at-compile frames, caps at 10, and defaults the body label to script', () => {
  // Match real stack shapes: an unnamed syntax-error frame precedes Function (native) and plugin frames.
  const compileError = '    at <input>:5:9\n    at Function (native)\n    at <anonymous> (PLUGIN_11_SOURCE:509:10)\n', bad = { label: 'bad.js', code: 'const a = 1;\nlet x = ;\n' };
  assert.deepEqual(scriptTrace(bad, compileError, false), [{ file: 'bad.js', line: 2, column: 9, source: 'let x = ;' }]);
  assert.deepEqual(scriptTrace(bad, compileError, true), []);
  for (const stack of [undefined, null, 42, '', 'Error: x', 'Error: x\n    at f (other.js:1:1)\n    at g (native)', '    at <anonymous> (PLUGIN_11_SOURCE:661:61)']) assert.deepEqual(scriptTrace(bad, stack, true), [], String(stack));
  // In V8 node:vm, nested new Function frames add another eval at level and main.js frames use evalmachine; trust neither.
  const v8 = 'Error: x\n    at eval (eval at <anonymous> (eval at compile (evalmachine.<anonymous>:506:10)), <anonymous>:5:7)\n'
    + '    at a (eval at compile (evalmachine.<anonymous>:506:10), <anonymous>:5:9)\n    at globalThis.go (evalmachine.<anonymous>:5:56)\n';
  assert.deepEqual(scriptTrace({ code: 'f();\nthrow Error("x");\n' }, v8, true), [{ file: 'script', line: 2, column: 9, source: 'throw Error("x");' }]);
  assert.equal(scriptTrace({ code: 'f();\n' }, '    at f (<input>:4:1)\n'.repeat(12), true).length, 10);
});

test('Failure summaries expose trace or fall back to the first 500 stack characters', async t => {
  const trace = [{ file: 'lib.js', line: 2, column: 3, source: 'boom();' }], base = { id: ID, ok: false, error: 'Error: x', executionStarted: true };
  const { write, read } = await evidence(t, { 'result.json': { ...base, stack: '    at boom (<input>:5:3)\n', trace } });
  const traced = summarizeRecord(await read());
  assert.deepEqual([traced.trace, 'stack' in traced], [trace, false]);
  await write({ 'result.json': { ...base, stack: 'x'.repeat(600) } });
  const raw = summarizeRecord(await read());
  assert.deepEqual(['trace' in raw, raw.stack.length, raw.stack.slice(-4)], [false, 500, 'x...']);
});

// -- Readback -------------------------------------------------------------

test('localResult treats result.json as the sole completion commit regardless of job.state backfill and exposes before.json as checkpointFile', async t => {
  const { cwd, dir, write, read } = await evidence(t);
  let record = await read();
  assert.deepEqual([record.result, record.journalComplete, record.checkpointFile], [null, false, null]);

  for (const state of ['running', 'done', 'failed']) {
    await write({ 'result.json': { id: ID, ok: true }, 'job.json': { id: ID, operation: 'run', state } });
    record = await read();
    assert.deepEqual([record.journalComplete, record.instruction], [true, 'Result read from saved evidence'], state);
  }

  await write({ 'before.json': { id: ID, before: rect('1:2') } });
  record = await read();
  assert.equal(record.checkpointFile, path.join(dir, 'before.json'));

  await assert.rejects(localResult(cwd, '../session.json'), /Invalid job ID/);
  await write({ 'result.json': { id: ID, ok: 'true' } });
  await assert.rejects(read(), /Invalid result file/);
});

// -- Summaries ------------------------------------------------------------

test('Summaries expose changes/verify/images/ancestors/binaryErrors/timing and absolute evidence image paths per protocol', async t => {
  const changes = { scope: 'subtree', counts: { ...zero, updated: 1 }, nodes: [{ id: '1:4', name: '\u8272\u5757', change: 'updated', keys: ['fills'] }] };
  const verify = { expect: 'changed', tolerance: 0, pass: true, changedPixels: 4, images: { before: 'images/render-before.png', after: 'images/render-after.png', diff: 'images/render-diff.png' } };
  const ancestors = [{ id: '1:2', name: '\u753b\u677f', visible: true, opacity: 1 }];
  const binaryErrors = [{ path: 'output.bytes', error: '\u8d85\u8fc7\u4e0a\u9650' }];
  const image = { nodeId: '1:3', name: '\u6807\u9898', file: 'images/1-1_3.png', bytes: 64, sha256: 'a'.repeat(64), width: 2, height: 2, pixels: { opaque: 4 } };
  const { dir, read } = await evidence(t, {
    'job.json': { id: ID, operation: 'run', label: 'paint.js', state: 'done', createdAt: '2026-10-06T00:00:00.000Z', claimedAt: '2026-10-06T00:00:01.500Z' },
    'result.json': { id: ID, ok: true, output: { n: 1 }, changes, verify, ancestors, binaryErrors, images: [image], pluginMs: 120, approvalMs: 3000, finishedAt: '2026-10-06T00:00:05.000Z' }
  });
  const summary = summarizeRecord(await read());
  assert.deepEqual([summary.id, summary.operation, summary.label, summary.state, summary.journalComplete, summary.ok], [ID, 'run', 'paint.js', 'done', true, true]);
  assert.deepEqual(summary.output, { n: 1 });
  assert.deepEqual([summary.changes, summary.verify, summary.ancestors, summary.binaryErrors], [changes, verify, ancestors, binaryErrors]);
  assert.equal(summary.images.length, 1);
  assert.equal(summary.images[0].file, path.join(dir, 'images/1-1_3.png'));
  assert.deepEqual([summary.images[0].nodeId, summary.images[0].width, summary.images[0].height, summary.images[0].pixels], ['1:3', 2, 2, { opaque: 4 }]);
  assert.deepEqual(summary.timing, { queueMs: 1500, pluginMs: 120, approvalMs: 3000, totalMs: 5000 });
  assert.equal(summary.evidence, dir);
  assert.equal(summary.resultFile, path.join(dir, 'result.json'));
});

test('Summaries give distinct next steps for success, unexecuted failure, executed failure, and verification failure', async t => {
  const { write, read } = await evidence(t);
  const done = { id: ID, operation: 'run', state: 'done' }, failed = { ...done, state: 'failed' };

  await write({ 'job.json': done, 'result.json': { id: ID, ok: true, output: null } });
  const success = summarizeRecord(await read());
  assert.doesNotMatch(success.instruction, /do not replay/);

  await write({ 'job.json': failed, 'result.json': { id: ID, ok: false, error: '\u8bed\u6cd5\u9519\u8bef', executionStarted: false, targetMissing: true, missingNodeId: '1:9', fileVerified: 'example' } });
  const notStarted = summarizeRecord(await read());
  assert.deepEqual([notStarted.ok, notStarted.error, notStarted.executionStarted], [false, '\u8bed\u6cd5\u9519\u8bef', false]);
  assert.deepEqual([notStarted.targetMissing, notStarted.missingNodeId, notStarted.fileVerified], [true, '1:9', 'example']);
  assert.match(notStarted.instruction, /resubmit/);
  assert.doesNotMatch(notStarted.instruction, /do not replay/);

  await write({ 'job.json': failed, 'result.json': { id: ID, ok: false, error: '\u8fd0\u884c\u65f6\u9519\u8bef', executionStarted: true, recovery: '\u5148 inspect' }, 'before.json': { id: ID } });
  const started = summarizeRecord(await read());
  assert.equal(started.executionStarted, true);
  assert.equal(started.recoveryHint, '\u5148 inspect');
  assert.equal(started.checkpointFile, path.join(path.dirname(started.resultFile), 'before.json'));
  assert.match(started.instruction, /do not replay/);

  await write({ 'job.json': done, 'result.json': { id: ID, ok: true, verify: { expect: 'unchanged', tolerance: 0, pass: false, changedPixels: 3 } } });
  const verdict = summarizeRecord(await read());
  assert.equal(verdict.ok, true);
  assert.match(verdict.instruction, /do not replay/);
  assert.notEqual(verdict.instruction, started.instruction);
});

test('Failure summaries explain created-node outcomes, cap lists at 50, expose deleted-existing counts and listener warnings, and retain inspect-first/no-replay guidance', async t => {
  const { write, read } = await evidence(t);
  const failed = { id: ID, operation: 'run', state: 'failed' }, base = { id: ID, ok: false, error: '\u4e2d\u9014\u5931\u8d25', executionStarted: true };
  const nodes = n => Array.from({ length: n }, (_, i) => ({ id: `10:${i + 1}`, name: `FRAME-${i + 1}`, type: 'FRAME' }));

  await write({ 'job.json': failed, 'result.json': { ...base, created: nodes(60) } });
  const left = summarizeRecord(await read());
  assert.deepEqual([left.created.length, left.createdOmitted, left.created[0]], [50, 10, nodes(1)[0]]);
  assert.match(left.instruction, new RegExp(`at failure it had created 60 node\\(s\\) \\(see created\\), which may contain existing layers: inspect their subtrees, then run figma-agent-control clean ${ID}, or add --clean-on-fail next time; keep the evidence; verify the current state with inspect first; do not replay the script`));
  // When --clean-on-fail was supplied but only created is available because the closing boundary failed, do not suggest adding it next time.
  await write({ 'job.json': { ...failed, cleanOnFail: true } });
  assert.match(summarizeRecord(await read()).instruction, new RegExp(`inspect their subtrees, then run figma-agent-control clean ${ID}; keep the evidence`));
  await write({ 'job.json': failed });

  await write({ 'result.json': { ...base, created: nodes(3), cleaned: nodes(2), cleanFailed: [{ ...nodes(3)[2], reason: '\u8282\u70b9\u5df2\u9501\u5b9a' }] } });
  const cleaned = summarizeRecord(await read());
  assert.deepEqual([cleaned.cleaned.length, cleaned.cleanFailed[0].reason, 'cleanedOmitted' in cleaned], [2, '\u8282\u70b9\u5df2\u9501\u5b9a', false]);
  assert.match(cleaned.instruction, /deleted 2 node\(s\) created by this job, 1 not deleted \(reasons in cleanFailed\); modified existing nodes were not rolled back; keep the evidence; verify the current state with inspect first; do not replay the script/);
  assert.equal('deletedExisting' in cleaned, false);
  // If execution deleted old nodes and cleanup deleted new ones, expose the count and explain that cleanup may remove replacements and one Undo restores cleanup.
  await write({ 'result.json': { ...base, created: nodes(1), cleaned: nodes(1), cleanFailed: [], deletedExisting: 2 } });
  const swapped = summarizeRecord(await read());
  assert.equal(swapped.deletedExisting, 2);
  assert.equal(swapped.instruction, 'The script started running; deleted 1 node(s) created by this job; modified existing nodes were not rolled back; 2 node(s) that existed before the run were deleted during it (by the script, or replaced with new IDs by detachInstance, flatten or createComponentFromNode), '
    + 'so the cleaned nodes may include their replacements; inspect first, and if needed undo once in Figma to restore what the cleanup deleted; keep the evidence; verify the current state with inspect first; do not replay the script');
  // If nothing was removed because nodes were kept or deletion failed, do not say zero nodes were deleted.
  await write({ 'result.json': { ...base, created: nodes(2), cleaned: [], cleanFailed: nodes(2).map(n => ({ ...n, reason: '\u542b\u6267\u884c\u524d\u5df2\u5b58\u5728\u7684\u8282\u70b9 1:4\uff0c\u672a\u5220\u9664' })) } });
  assert.equal(summarizeRecord(await read()).instruction, 'The script started running; the document may have been modified; created nodes were not deleted: 2 node(s) kept or failed to delete (reasons in cleanFailed); keep the evidence; verify the current state with inspect first; do not replay the script');

  await write({ 'result.json': { ...base, created: [], cleaned: [], cleanFailed: [] } });
  const none = summarizeRecord(await read());
  assert.equal(none.instruction, 'The script started running; the document may have been modified; keep the evidence; verify the current state with inspect first; do not replay the script');

  await write({ 'result.json': { ...base, warnings: ['nodechange \u76d1\u542c\u4e0d\u53ef\u7528'] } });
  const deaf = summarizeRecord(await read());
  assert.deepEqual([deaf.warnings, 'created' in deaf, deaf.instruction], [['nodechange \u76d1\u542c\u4e0d\u53ef\u7528'], false, none.instruction]);
  assert.equal(exitCode(await read()), 1);
});

test('Summaries omit output above 16 KiB and provide a command to read the original value', async t => {
  // JSON.stringify({ items }) occupies 12 + items.length bytes for ASCII.
  const exact = { items: 'a'.repeat(16 * 1024 - 12) };
  const { dir, write, read } = await evidence(t, { 'job.json': { id: ID, operation: 'run', state: 'done' }, 'result.json': { id: ID, ok: true, output: exact } });
  assert.deepEqual(summarizeRecord(await read()).output, exact);

  const over = { items: exact.items + 'a' };
  await write({ 'result.json': { id: ID, ok: true, output: over } });
  const summary = summarizeRecord(await read());
  assert.equal(summary.output.omitted, true);
  assert.equal(summary.output.bytes, 16 * 1024 + 1);
  assert.deepEqual(summary.output.keys, ['items']);
  const resultFile = path.join(dir, 'result.json');
  assert.ok(summary.output.read.includes(`'${resultFile}'`) && summary.output.read.includes('.output'), summary.output.read);
  assert.deepEqual((await json(resultFile)).output, over);
});

test('Unavailable visual verification asks for inspection instead of claiming no change, while retaining exit 1', () => {
  const record = { evidence: '/tmp/e', job: { id: ID, operation: 'run' }, recordedState: 'done', journalComplete: true, instruction: 'Result read from saved evidence',
    result: { id: ID, ok: true, verify: { expect: 'changed', tolerance: 0, pass: false, error: 'Visual check unavailable: Target was deleted by the script' } } };
  const summary = summarizeRecord(record);
  assert.match(summary.instruction, /Visual check unavailable: Target was deleted by the script.*preview or inspect.*do not replay/);
  assert.doesNotMatch(summary.instruction, /diff image|fix it with a new script/);
  assert.equal(exitCode(record), 1);
});

test('Summaries preserve pageRoot and append appendChild guidance for new root nodes, including omitted counts and failed/unavailable verification, without changing exit codes; removals alone need no hint', () => {
  const record = (pageRoot, verify) => ({ evidence: '/tmp/e', job: { id: ID, operation: 'run' }, recordedState: 'done', journalComplete: true, instruction: 'Result read from saved evidence',
    result: { id: ID, ok: true, output: null, pageRoot, verify } });
  const stray = record({ created: [{ id: '10:1', name: '\u692d\u5706', type: 'ELLIPSE' }], deleted: [], createdOmitted: 3 });
  const summary = summarizeRecord(stray);
  assert.deepEqual(summary.pageRoot, stray.result.pageRoot);
  const hint = '; 4 new node(s) appeared on the page root (see pageRoot), usually from a missing appendChild after create*; this is a before/after comparison that also includes nodes created by collaborators meanwhile and nodes swapped out by flatten or detachInstance (old IDs are in deleted): inspect to confirm they came from this script before deleting or re-parenting them';
  assert.equal(summary.instruction, 'Result read from saved evidence' + hint);
  // Missing appendChild leaves the frame unchanged and fails --expect changed; that verification branch must not swallow the guidance.
  for (const verify of [{ expect: 'changed', pass: false }, { error: 'Visual check unavailable' }]) {
    const failed = record(stray.result.pageRoot, verify);
    assert.deepEqual([summarizeRecord(failed).instruction.endsWith(hint), exitCode(failed)], [true, 1], JSON.stringify(verify));
  }
  const removed = record({ created: [], deleted: [{ id: '1:9', name: '\u65e7\u753b\u6846', type: 'FRAME' }] });
  assert.deepEqual([summarizeRecord(removed).pageRoot, summarizeRecord(removed).instruction, exitCode(stray), exitCode(removed)], [removed.result.pageRoot, 'Result read from saved evidence', 0, 0]);
});

test('Commands for omitted summary output remain executable with apostrophes in evidence paths', () => {
  const evidence = "/tmp/Bob's designs/.figma-agent-control/runs/" + ID;
  const summary = summarizeRecord({ evidence, job: { id: ID, operation: 'run' }, recordedState: 'done', journalComplete: true, instruction: '',
    result: { id: ID, ok: true, output: 'x'.repeat(17000) } });
  // Parse the same command with sh and capture jq's two arguments.
  const argv = execFileSync('/bin/sh', ['-c', summary.output.read.replace(/^jq /, 'printf "%s\\n" ')], { encoding: 'utf8' }).split('\n');
  assert.deepEqual(argv.slice(0, 2), ['.output', path.join(evidence, 'result.json')]);
});

test('Summary 16 KiB limits count bytes and omit oversized multibyte text', async t => {
  // 6000 CJK characters produce about 18 KB of UTF-8 JSON but only 6002 UTF-16 code units.
  const output = '\u6c49'.repeat(6000);
  const { read } = await evidence(t, { 'job.json': { id: ID, operation: 'run', state: 'done' }, 'result.json': { id: ID, ok: true, output } });
  const summary = summarizeRecord(await read());
  assert.equal(typeof summary.output, 'object', '18 KB output should be omitted');
  assert.equal(summary.output.bytes, Buffer.byteLength(JSON.stringify(output)));
});

test('Exit codes: 0 success; 1 failure, failed verification with ok true, or reviewed unknown results; 2 unfinished', () => {
  const ok = { id: ID, ok: true };
  const cases = [
    [{ result: ok }, 0],
    [{ result: ok, waitStatus: 'completed' }, 0],
    [{ result: { ...ok, verify: { expect: 'changed', pass: true } } }, 0],
    [{ result: { ...ok, verify: { expect: 'unchanged', pass: false } } }, 1],
    [{ result: { ...ok, verify: { expect: 'changed', pass: false, error: '\u753b\u9762\u5224\u5b9a\u4e0d\u53ef\u7528' } } }, 1],
    [{ result: { id: ID, ok: false, executionStarted: false } }, 1],
    [{ result: null }, 2],
    [{ result: null, waitStatus: 'needs-review', recovery: { status: 'unknown-after-disconnect' } }, 2],
    [{ result: null, waitStatus: 'timeout' }, 2],
    [{ result: null, waitStatus: 'resolved', resolution: { status: 'reviewed-without-replay' } }, 1],
    [{ result: ok, resolution: { status: 'reviewed-without-replay' } }, 0]
  ];
  for (const [record, code] of cases) assert.equal(exitCode(record), code, JSON.stringify(record));
});

test('Extract-only missing explicit islands or binary persistence errors exit 1 without affecting same-named run output fields; summaries expose shape and cap skipped islands at 50', () => {
  const base = { evidence: '/tmp/e', recordedState: 'done', journalComplete: true, instruction: 'Result read from saved evidence' };
  const extract = result => ({ ...base, job: { id: ID, operation: 'extract' }, result: { id: ID, ok: true, ...result } });
  const run = { ...base, job: { id: ID, operation: 'run' }, result: { id: ID, ok: true, output: { islandsSkipped: ['1:3'] }, binaryErrors: ['Binary value 1 is invalid'] } };
  assert.deepEqual([exitCode(run), summarizeRecord(run).instruction, summarizeRecord(run).extract], [0, 'Result read from saved evidence', undefined]);
  const clean = extract({ output: { stats: { nodes: 1 }, islandsSkipped: [], warnings: [] } });
  assert.deepEqual([exitCode(clean), summarizeRecord(clean).output.omitted, summarizeRecord(clean).output.keys], [0, true, ['stats', 'islandsSkipped', 'warnings']]);
  const many = summarizeRecord(extract({ output: { stats: {}, islandsSkipped: Array.from({ length: 60 }, (_, i) => `1:${i}`), warnings: [] } }));
  assert.deepEqual([many.extract.islandsSkipped.length, many.extract.islandsSkippedOmitted], [50, 10]);
  assert.match(many.instruction, /60 explicit island\(s\) have no result.*resubmit/);
  const lost = extract({ output: { islandsSkipped: [] }, binaryErrors: ['Invalid binary placeholder: 0'] });
  assert.deepEqual([exitCode(lost), summarizeRecord(lost).instruction], [1, 'Binary files were not fully saved (see binaryErrors); the document was not modified; resubmit extract']);
});

// -- Reports --------------------------------------------------------------

test('report reads completion time and totalMs from result.json when job.json lacks finishedAt', async t => {
  // Use times relative to wall time: report prefilters by directory mtime, so fixed historical dates would be excluded.
  const createdAt = new Date(Date.now() - 10000).toISOString(), finishedAt = new Date(Date.parse(createdAt) + 1500).toISOString();
  const { cwd } = await evidence(t, {
    'job.json': { id: ID, operation: 'run', state: 'running', createdAt, claimedAt: createdAt },
    'result.json': { id: ID, ok: true, pluginMs: 100, finishedAt }
  });
  const summary = await report(cwd, { since: createdAt });
  assert.equal(summary.jobs.count, 1);
  assert.deepEqual([summary.timing.total.count, summary.timing.total.sumMs], [1, 1500]);
  assert.equal(summary.window.to, finishedAt);
});

test('report counts execution and verification failures separately; failed/unavailable verification increments verifyFailed, while passed/undeclared verification does not', async t => {
  const { cwd } = await evidence(t);
  const createdAt = new Date(Date.now() - 10000).toISOString(), finishedAt = new Date(Date.parse(createdAt) + 500).toISOString();
  const results = [
    { ok: true },
    { ok: true, verify: { expect: 'changed', pass: true } },
    { ok: true, verify: { expect: 'changed', pass: false, changedPixels: 0 } },
    { ok: true, verify: { expect: 'unchanged', pass: false, error: 'Visual check unavailable: Target was deleted by the script' } },
    { ok: false, executionStarted: false, verify: { expect: 'changed', pass: false } }
  ];
  for (const result of results) {
    const id = crypto.randomUUID(), dir = path.join(cwd, '.figma-agent-control', 'runs', id);
    await save(path.join(dir, 'job.json'), { id, operation: 'run', state: result.ok ? 'done' : 'failed', createdAt, finishedAt });
    await save(path.join(dir, 'result.json'), { id, ...result, finishedAt });
  }
  const { jobs } = await report(cwd, { since: createdAt });
  assert.deepEqual([jobs.failed, jobs.verifyFailed], [1, 2]);
});

// -- Waiting --------------------------------------------------------------

test('Wait expiration returns timeout and exit 2 without modifying evidence; timeout accepts integer seconds from 1 to 300', async t => {
  const { cwd, dir } = await evidence(t);
  const baseline = await fs.readFile(path.join(dir, 'job.json'), 'utf8');
  const clock = fakeClock();
  const record = await waitForResult(cwd, ID, 1, clock);
  assert.equal(record.waitStatus, 'timeout');
  assert.equal(clock.t, 1000);
  assert.equal(exitCode(record), 2);
  const summary = summarizeRecord(record);
  assert.deepEqual([summary.waitStatus, summary.ok], ['timeout', null]);
  assert.match(summary.instruction, /do not replay/);
  assert.equal(await fs.readFile(path.join(dir, 'job.json'), 'utf8'), baseline);
  assert.deepEqual(await fs.readdir(dir), ['job.json']);

  // Default wait is 30 seconds.
  const fallback = fakeClock();
  assert.equal((await waitForResult(cwd, ID, undefined, fallback)).waitStatus, 'timeout');
  assert.equal(fallback.t, 30000);

  for (const bad of [0, 301, 1.5]) await assert.rejects(waitForResult(cwd, ID, bad, fakeClock()), /from 1 to 300/);
});

test('Waiting returns as soon as result.json exists without waiting for job.json backfill', async t => {
  const { cwd, write } = await evidence(t);
  const clock = fakeClock(async n => { if (n === 1) await write({ 'result.json': { id: ID, ok: true, output: 42 } }); });
  const record = await waitForResult(cwd, ID, 5, clock);
  assert.deepEqual([record.waitStatus, record.recordedState], ['completed', 'running']);
  assert.equal(clock.sleeps, 1);
  assert.equal(record.result.output, 42);
  assert.equal(exitCode(record), 0);
});

test('Recovery hints immediately return review-needed with exit 2; reviewed resolutions return resolved with exit 1 because waiting cannot help; read-only tasks suggest resubmission', async t => {
  const { cwd, write } = await evidence(t, { 'recovery.json': { status: 'unknown-after-disconnect', instruction: 'After reconnecting, inspect first; do not replay the script' } });
  const clock = fakeClock();
  const recovered = await waitForResult(cwd, ID, 5, clock);
  assert.deepEqual([recovered.waitStatus, clock.sleeps, exitCode(recovered)], ['needs-review', 0, 2]);
  assert.deepEqual([summarizeRecord(recovered).recovery, summarizeRecord(recovered).instruction], ['unknown-after-disconnect', 'After reconnecting, inspect first; do not replay the script']);

  await write({ 'job.json': { id: ID, operation: 'inspect', state: 'running' } });
  assert.match(summarizeRecord(await waitForResult(cwd, ID, 5, fakeClock())).instruction, /Read-only job interrupted.*resubmit/);

  await write({ 'job.json': { id: ID, operation: 'run', state: 'running' }, 'resolution.json': { id: ID, status: 'reviewed-without-replay', instruction: '\u5df2\u6838\u5bf9' } });
  const resolved = await waitForResult(cwd, ID, 5, fakeClock());
  assert.deepEqual([resolved.waitStatus, exitCode(resolved)], ['resolved', 1]);
  assert.deepEqual([summarizeRecord(resolved).resolution, summarizeRecord(resolved).instruction], ['reviewed-without-replay', '\u5df2\u6838\u5bf9']);
});

test('Hidden-panel active tasks still default to a 30-second wait: long polling prevents background delivery/completion delays, so the limit stays unchanged', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-record-bg-'));
  let bridge;
  t.after(async () => { await bridge?.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  await init(cwd, 'https://www.figma.com/design/example/Test?node-id=1-2');
  const pluginToken = 'a'.repeat(64);
  bridge = await start(cwd, 0, { pollHoldMs: 0, pluginToken });
  const session = await json(path.join(cwd, '.figma-agent-control', 'session.json'));
  const hidden = await fetch(`http://127.0.0.1:${bridge.port}/heartbeat?client=test&file=example&visibility=hidden`, { headers: { 'X-Session-Token': pluginToken, 'X-Plugin-Version': bridge.version } });
  assert.equal(hidden.status, 200);
  const submitted = await fetch(`http://127.0.0.1:${bridge.port}/job`, { method: 'POST', headers: { 'X-Session-Token': session.token }, body: JSON.stringify({ operation: 'inspect' }) });
  const { id } = await submitted.json();
  const status = await (await fetch(`http://127.0.0.1:${bridge.port}/status`, { headers: { 'X-Session-Token': session.token } })).json();
  assert.deepEqual([status.connectionState, status.active], ['BACKGROUND', id]);
  const clock = fakeClock();
  assert.equal((await waitForResult(cwd, id, undefined, clock)).waitStatus, 'timeout');
  assert.equal(clock.t, 30000);
});
