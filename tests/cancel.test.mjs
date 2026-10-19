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

test('A hung run exposes progress and source location in status and wait; CLI cancel returns a failure with caller trace, rejects finished tasks, and marks undelivered tasks unexecuted', async t => {
  const h = await harness(t), gate = hang(h.figma);
  const file = await writeScript(h.cwd, 'hang.js', 'const font = { family: "Inter", style: "Regular" };\nawait figma.loadFontAsync(font);\nreturn 1;');
  const id = (await h.cli('run', file, '--no-wait')).json.id;
  // The plugin reports its first progress update after 1 s of execution; the next heartbeat forwards it to the bridge.
  const status = await pump(h, (async () => { for (;;) { const s = (await h.cli('status')).json; if (s.progress?.waiting?.length) return s; await delay(100); } })());
  assert.deepEqual(status.progress.waiting.map(w => [w.call, w.at?.file, w.at?.line]), [['figma.loadFontAsync', 'hang.js', 2]]);
  assert.equal(status.progress.waitingCount, 1);
  const waited = await h.cli('wait', id, '--timeout', '1');
  assert.deepEqual([waited.code, waited.json.waitStatus, waited.json.progress.waiting[0].at.line], [2, 'timeout', 2]);
  assert.match(waited.json.instruction, /cancel/);

  const cancelled = await pump(h, h.cli('cancel', id));
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
