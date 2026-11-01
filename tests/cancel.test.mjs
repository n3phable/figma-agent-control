/**
 * [INPUT]: Imports node:test, node:assert/strict, node:timers/promises, ./helpers/plugin.mjs, ./helpers/harness.mjs, ../src/record.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for cancel; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { plugin } from './helpers/plugin.mjs';
import { harness, writeScript } from './helpers/harness.mjs';
import { scriptTrace } from '../src/record.mjs';

// A suspended script keeps plugin handling and harness drive (settle) pending; pump only panel polls and heartbeats here.
const pump = async (h, promise) => {
  let done = false;
  const result = promise.finally(() => { done = true; });
  while (!done) { await h.tick(); await delay(20); }
  return result;
};
// loadFontAsync stays pending until release(), modeling a call that hung for 27 minutes on a real device.
const hang = figma => {
  const gate = { release: null };
  figma.loadFontAsync = () => new Promise(resolve => { gate.release = resolve; });
  return gate;
};

test('Cancellation ends preparation immediately; late target, render, or asset reads cannot permit writes, and a new task can run', async () => {
  for (const stage of ['target', 'render', 'assets']) {
    const f = plugin(), entered = Promise.withResolvers(), gate = Promise.withResolvers();
    const owner = stage === 'target' ? f.figma : stage === 'render' ? f.doc.frame : f.figma.variables;
    const key = stage === 'target' ? 'getNodeByIdAsync' : stage === 'render' ? 'exportAsync' : 'getLocalVariableCollectionsAsync';
    const original = owner[key];
    owner[key] = (...args) => { entered.resolve(); return gate.promise.then(() => original(...args)); };
    const job = f.start({ code: 'target.name = "\u4e0d\u5e94\u5199\u5165";', ...(stage === 'render' ? { expect: 'changed' } : {}) });
    await entered.promise;
    await f.figma.ui.onmessage({ type: 'cancel', id: job.id, channelNonce: job.channelNonce });
    const r = await job.done;
    assert.deepEqual([r.ok, r.executionStarted, f.doc.frame.name, f.events.includes('undo')], [false, false, '\u753b\u677f', false], stage);
    assert.match(r.error, /Cancelled before execution/);
    gate.resolve(); owner[key] = original;
    await delay(5);
    assert.equal(f.doc.frame.name, '\u753b\u677f', 'Late preparation cannot resume a canceled task');
    assert.equal((await f.send({ code: 'target.name = "\u65b0\u4efb\u52a1";' })).ok, true);
    assert.equal(f.doc.frame.name, '\u65b0\u4efb\u52a1');
  }
});

test('Cancellation while awaiting approval or checkpointing ignores late approval without Undo or document writes', async () => {
  for (const approval of [true, false]) {
    const f = plugin(approval ? { approval: 'wait' } : { checkpoint: 'wait' });
    const job = f.start({ code: 'target.name = "\u4e0d\u5e94\u5199\u5165";', ...(approval ? { risk: { level: 'high', reason: 'test' } } : {}) });
    await delay(5);
    assert.equal((approval ? f.approvals : f.checkpoints).length, 1);
    await f.figma.ui.onmessage({ type: 'cancel', id: job.id, channelNonce: job.channelNonce });
    const r = await job.done;
    assert.deepEqual([r.ok, r.executionStarted], [false, false]);
    await f.figma.ui.onmessage({ type: approval ? 'approval-ack' : 'checkpoint-ack', id: job.id, channelNonce: job.channelNonce, approved: true, ok: true });
    await delay(5);
    assert.equal(f.doc.frame.name, '\u753b\u677f');
    assert.equal(f.events.includes('undo'), false);
  }
});

test('cancel requires the same task channelNonce; a hung Figma call fails immediately with caller stack and created assets, and subsequent Figma access throws', async () => {
  const f = plugin({ checkpoint: true }), gate = hang(f.figma), made = [], { variables } = f.figma;
  f.figma.variables = { ...variables, createVariable: name => { const v = { id: `VariableID:9:${made.length}`, name }; made.push(v); return v; },
    getLocalVariablesAsync: async () => [...await variables.getLocalVariablesAsync(), ...made] };
  const code = 'figma.createFrame();\nfigma.variables.createVariable("motion/ease");\nawait figma.loadFontAsync({ family: "Inter", style: "Regular" });\nfigma.createRectangle();';
  const { id, channelNonce, done } = f.start({ code });
  while (!gate.release) await delay(5);
  f.figma.ui.onmessage({ type: 'cancel', id, channelNonce: 'other' });
  await delay(20);
  assert.equal(f.results.length, 0, 'A cancel with mismatched credentials has no effect');
  f.figma.ui.onmessage({ type: 'cancel', id, channelNonce });
  const r = await done;
  assert.deepEqual([r.ok, r.executionStarted], [false, true]);
  assert.match(r.error, /^Error: Aborted by cancel: the script was waiting on figma\.loadFontAsync, which had not returned after \d+ s$/);
  const [at] = scriptTrace({ code, label: 'hang.js' }, r.stack, true);
  assert.deepEqual([at.file, at.line, at.source], ['hang.js', 3, 'await figma.loadFontAsync({ family: "Inter", style: "Regular" });']);
  assert.deepEqual([r.created.map(n => n.type), r.createdAssets], [['FRAME'], { variables: [{ id: 'VariableID:9:0', name: 'motion/ease' }] }]);
  assert.ok(r.warnings.some(w => /A suspended script cannot be terminated from outside/.test(w)), JSON.stringify(r.warnings));
  const nodes = f.doc.page.children.length;
  gate.release();
  await delay(20);
  assert.equal(f.doc.page.children.length, nodes, 'After the suspended script resumes, its next Figma call throws without creating another node');
});

test('loadFontAsync reuses successful font loads across runs in the same plugin session; failures retry normally', async () => {
  const f = plugin({ checkpoint: true }), seen = [];
  f.figma.loadFontAsync = async font => { seen.push(font.style); if (font.style === 'Missing') throw Error('font not found'); };
  const code = ['Regular', 'Regular', 'Bold', 'Missing'].map(style => `await figma.loadFontAsync({ family: "Inter", style: "${style}" }).catch(() => {});`).join('\n') + '\nreturn 1;';
  for (let i = 0; i < 2; i++) assert.equal((await f.send({ code })).ok, true);
  assert.deepEqual(seen, ['Regular', 'Bold', 'Missing', 'Missing']);
});

test('A hung run exposes progress and source location in status and wait; CLI cancel returns a failure with caller trace, rejects finished tasks, and marks undelivered tasks unexecuted', async t => {
  const h = await harness(t), gate = hang(h.figma);
  const file = await writeScript(h.cwd, 'hang.js', 'const font = { family: "Inter", style: "Regular" };\nawait figma.loadFontAsync(font);\nreturn 1;');
  const id = (await h.cli('run', file, '--no-wait')).json.id;
  // Hide the panel and stop advancing its timers after execution starts, as when Figma throttles a hidden window. Messages from main still trigger progress heartbeats, marked hidden.
  await pump(h, (async () => { while (!gate.release) await delay(20); })());
  h.document.visibilityState = 'hidden';
  const status = await (async () => {
    for (const end = Date.now() + 10000; Date.now() < end; await delay(100)) { const s = (await h.cli('status')).json; if (s.progress?.waiting?.length) return s; }
    assert.fail('No execution progress received within 10 s');
  })();
  assert.deepEqual(status.progress.waiting.map(w => [w.call, w.at?.file, w.at?.line]), [['figma.loadFontAsync', 'hang.js', 2]]);
  assert.deepEqual([status.progress.phase, status.progress.waitingCount, status.progress.hidden], ['script', 1, true]);
  const waited = await h.cli('wait', id, '--timeout', '1');
  assert.deepEqual([waited.code, waited.json.waitStatus, waited.json.progress.waiting[0].at.line], [2, 'timeout', 2]);
  assert.match(waited.json.instruction, /cancel.*Figma window was not visible.*about 1 minute longer.*uncover the Figma window/);

  // Panel timers remain stopped: hold heartbeats deliver cancellation immediately, and the resulting message triggers persistence of the failure.
  const cancelled = await h.cli('cancel', id);
  h.document.visibilityState = 'visible';
  assert.deepEqual([cancelled.code, cancelled.json.ok, cancelled.json.executionStarted], [1, false, true]);
  assert.match(cancelled.json.error, /Aborted by cancel: the script was waiting on figma\.loadFontAsync/);
  assert.deepEqual(cancelled.json.trace.map(f => [f.file, f.line]), [['hang.js', 2]]);
  assert.ok(cancelled.json.warnings.some(w => /A suspended script cannot be terminated from outside/.test(w)));
  assert.equal((await h.cli('cancel', id)).json.code, 'NOT_ACTIVE');
  gate.release();

  await h.pause();
  const queued = (await h.cli('run', file, '--no-wait')).json.id, early = await h.cli('cancel', queued);
  assert.deepEqual([early.code, early.json.executionStarted], [1, false]);
  assert.match(early.json.error, /^Cancelled before delivery: the job had not reached the plugin; the script did not run$/);
  h.resume();
});
