/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:net, node:path, node:vm, node:crypto, node:child_process, node:util, node:timers/promises, ./helpers/harness.mjs, ../src/bridge.mjs, ../src/project.mjs, ../src/session.mjs, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for cli; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { harness, writeScript, fakeFigma, cliFile } from './helpers/harness.mjs';
import { start } from '../src/bridge.mjs';
import { root, json, save, hash, init, installPlugin } from '../src/project.mjs';
import { pairingToken } from '../src/session.mjs';
import { encodePng, decodePng } from '../src/png.mjs';

const FIGMA_URL = 'https://www.figma.com/design/example/Test?node-id=1-2';
const exec = promisify(execFile);
const exists = file => fs.access(file).then(() => true, () => false);
const runsDir = cwd => path.join(root(cwd), 'runs');
// runs/ may not exist before the first submission; treat it as empty.
const runIds = cwd => fs.readdir(runsDir(cwd)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
const APPEND = 'target.characters += "+"; return target.characters;';

// -- Fixtures -------------------------------------------------------------
// Execute CLI directly for directories outside harness: uninitialized, legacy, or sessionless.
async function cli(cwd, ...args) {
  try { const { stdout } = await exec(process.execPath, [cliFile, ...args], { cwd, env: { ...process.env, FIGMA_AGENT_CONTROL_HOME: path.join(cwd, 'plugin-home') } }); return { code: 0, json: JSON.parse(stdout) }; }
  catch (error) { return { code: error.code, json: JSON.parse(error.stdout || 'null') }; }
}

// A just-released random port models session.json pointing to an unresponsive bridge.
async function closedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Reopening the plugin creates a VM with new-session files installed in the test-owned global directory, sharing the document with the old instance. Stop pumping the old instance to model closure.
async function reopenPlugin(bridge, h) {
  await installPlugin(h.home, bridge.plugin);
  const { 'main.js': main, 'ui.html': html } = bridge.plugin, doc = h.doc;
  const pending = new Set(), errors = [], window = {};
  const track = promise => { const work = Promise.resolve(promise).catch(error => errors.push(error)).finally(() => pending.delete(work)); pending.add(work); };
  const figma = fakeFigma(doc, { onUi: message => track(window.onmessage({ data: { pluginMessage: structuredClone(message) } })) });
  let tick;
  vm.runInNewContext(main, { figma, __html__: html, setTimeout, clearTimeout });
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], { window, crypto: globalThis.crypto, fetch, AbortSignal, TextEncoder,
    parent: { postMessage: message => track(figma.ui.onmessage(structuredClone(message.pluginMessage))) },
    document: { visibilityState: 'visible', addEventListener() {}, getElementById: () => ({}) }, setInterval: callback => { tick = callback; } });
  const drive = async promise => {
    let done = false; const result = promise.finally(() => { done = true; });
    while (!done) { await tick(); while (pending.size) await Promise.all([...pending]); await delay(10); }
    return result;
  };
  await drive(Promise.resolve());
  return { drive, errors };
}

// Each case owns temporary directories and random ports without shared state, allowing concurrency. Timeouts report bugs that prevent panel/plugin steps from returning.
describe('figma-agent-control CLI', { concurrency: true, timeout: 20000 }, () => {

  // -- Submission and waiting -----------------------------------------------
  test('run waits for a summary by default, --full returns the full record, and output above 16 KiB is omitted with a readback command', async t => {
    const h = await harness(t);
    const run = await h.run('run', await writeScript(h.cwd, 'retitle.js', 'target.characters = "\u65b0\u6807\u9898"; return { now: target.characters };'), '--node', '1:3');
    assert.equal(run.code, 0, JSON.stringify(run.json));
    const s = run.json;
    assert.deepEqual([s.operation, s.label, s.waitStatus, s.journalComplete, s.ok, s.target], ['run', 'retitle.js', 'completed', true, true, '1:3']);
    // result.json is the sole commit point; job.json state is updated later. Either running or done is valid during summary reads; see the record wait tests.
    assert.ok(['running', 'done'].includes(s.state), s.state);
    assert.deepEqual(s.output, { now: '\u65b0\u6807\u9898' });
    assert.deepEqual(s.changes.nodes, [{ id: '1:3', name: '\u6807\u9898', change: 'updated', keys: ['characters'] }]);
    assert.deepEqual(Object.keys(s.timing), ['queueMs', 'pluginMs', 'totalMs']);
    assert.ok(Object.values(s.timing).every(ms => Number.isInteger(ms) && ms >= 0), JSON.stringify(s.timing));
    // Summaries do not embed job records; resultFile holds full results, using the CLI subprocess's real working path.
    assert.deepEqual([s.job, s.result], [undefined, undefined]);
    assert.equal(s.resultFile, path.join(runsDir(await fs.realpath(h.cwd)), s.id, 'result.json'));
    assert.deepEqual((await json(s.resultFile)).output, s.output);

    const full = await h.run('run', await writeScript(h.cwd, 'one.js', 'return 1;'), '--full');
    assert.equal(full.code, 0);
    assert.deepEqual([full.json.waitStatus, full.json.job.label, full.json.result.output, typeof full.json.result.finishedAt], ['completed', 'one.js', 1, 'string']);

    const big = await h.run('run', await writeScript(h.cwd, 'big.js', 'return "x".repeat(20000);'));
    assert.equal(big.code, 0);
    assert.deepEqual([big.json.output.omitted, big.json.output.bytes], [true, 20002]);
    assert.ok(big.json.output.read.includes(big.json.resultFile), big.json.output.read);
    assert.equal((await json(big.json.resultFile)).output.length, 20000);
    const stored = await h.cli('result', big.json.id, '--full');
    assert.equal(stored.json.result.output, 'x'.repeat(20000));
  });

  test('After snapshots above 2000 nodes keep script success/output but mark changes unavailable', async t => {
    const h = await harness(t);
    const grow = await writeScript(h.cwd, 'grow.js', 'for (let i = 0; i < 2100; i++) target.children.push({ id: "9:" + i, type: "RECTANGLE", name: "n", visible: true, removed: false, parent: target }); return target.children.length;');
    const run = await h.run('run', grow, '--node', '1:2');
    assert.equal(run.code, 0, JSON.stringify(run.json));
    assert.deepEqual([run.json.ok, run.json.output], [true, 2102]);
    assert.match(run.json.changes.unavailable, /After-snapshot unavailable/);
    assert.equal((await json(run.json.resultFile)).afterError, undefined);
  });

  test('The 16 KiB output limit counts bytes and also omits long CJK text', async t => {
    const h = await harness(t);
    // 6000 CJK characters produce 6002 JSON characters and 18002 UTF-8 bytes.
    const run = await h.run('run', await writeScript(h.cwd, 'cjk.js', 'return "\u6c49".repeat(6000);'));
    assert.equal(run.code, 0);
    assert.equal(run.json.output?.omitted, true, `Output was not omitted (${Buffer.byteLength(JSON.stringify(run.json.output))} bytes)`);
  });

  test('--no-wait only submits; stop rejects active work, wait retrieves results, later stop releases the lock, and result reads evidence offline', async t => {
    const h = await harness(t);
    const dir = root(h.cwd), sessionFile = path.join(dir, 'session.json'), lockFile = path.join(dir, 'bridge.lock');
    const session = await json(sessionFile);
    const ready = await h.cli('doctor');
    assert.equal(ready.code, 0);
    assert.equal(ready.json.ready, true);
    // CHROME depends on the local environment; it is a warning that does not affect ready and has dedicated coverage.
    assert.deepEqual(ready.json.checks.filter(c => c.code !== 'CHROME').map(c => [c.code, c.status]),
      [['NODE_VERSION', 'ok'], ['BINDING', 'ok'], ['SESSION', 'ok'], ['LOCK', 'ok'], ['PLUGIN_FILES', 'ok'], ['BRIDGE', 'ok'], ['PLUGIN_CONNECTION', 'ok']]);
    assert.equal(JSON.stringify(ready.json).includes(session.token), false);

    await h.pause();
    const queued = await h.cli('run', await writeScript(h.cwd, 'append.js', APPEND), '--node', '1:3', '--no-wait');
    assert.equal(queued.code, 0);
    const id = queued.json.id;
    assert.deepEqual([queued.json.state, queued.json.evidence], ['queued', path.join(runsDir(h.cwd), id)]);

    const busy = await h.cli('doctor');
    const active = busy.json.checks.find(c => c.code === 'ACTIVE_JOB');
    assert.equal(active?.status, 'warning');
    assert.ok(active.message.includes(id));
    assert.match(active.action, /wait/);
    assert.match(active.message, /is queued/, 'An undelivered task must not be reported as executing');
    assert.ok(active.action.includes(id));

    const refused = await h.cli('stop');
    assert.equal(refused.code, 1);
    assert.deepEqual([refused.json.bridge, refused.json.code, refused.json.active], ['running', 'ACTIVE_JOB', id]);
    assert.equal(await exists(lockFile), true);

    const waited = await h.run('wait', id);
    assert.equal(waited.code, 0);
    assert.deepEqual([waited.json.waitStatus, waited.json.output], ['completed', '\u539f\u6587+']);

    const stopped = await h.cli('stop');
    assert.equal(stopped.code, 0, JSON.stringify(stopped.json));
    assert.deepEqual([stopped.json.bridge, stopped.json.sessionId], ['stopped', session.sessionId]);
    assert.deepEqual([await exists(lockFile), await exists(sessionFile)], [false, false]);

    const offline = await h.cli('result', id);
    assert.equal(offline.code, 0);
    assert.deepEqual([offline.json.ok, offline.json.output, offline.json.journalComplete], [true, '\u539f\u6587+', true]);
    assert.equal(h.doc.text.characters, '\u539f\u6587+');
  });

  test('--timeout expires with exit 2 without resubmitting, then wait retrieves the same task result', async t => {
    const h = await harness(t);
    // Pause the plugin so the task remains queued and waiting expires after one second.
    await h.pause();
    const expired = await h.cli('run', await writeScript(h.cwd, 'append.js', APPEND), '--node', '1:3', '--timeout', '1');
    assert.equal(expired.code, 2);
    assert.deepEqual([expired.json.waitStatus, expired.json.state, expired.json.ok], ['timeout', 'queued', null]);
    assert.match(expired.json.instruction, /do not replay the script/);
    const waited = await h.run('wait', expired.json.id);
    assert.equal(waited.code, 0);
    assert.deepEqual([waited.json.waitStatus, waited.json.output], ['completed', '\u539f\u6587+']);
    assert.deepEqual(await fs.readdir(runsDir(h.cwd)), [expired.json.id]);
  });

  // -- Pre-submission failures ----------------------------------------------
  // --timeout 1 makes accidental submissions fail promptly with exit 2 instead of hanging until the test timeout.
  test('Missing --lib or --data files fail before submission with exit 1 and no runs/ task', async t => {
    const h = await harness(t);
    const file = await writeScript(h.cwd, 'append.js', APPEND), lib = await writeScript(h.cwd, 'lib.js', 'function noop() {}');
    const missingLib = await h.cli('run', file, '--node', '1:3', '--lib', 'missing-lib.js', '--timeout', '1');
    const missingData = await h.cli('run', file, '--node', '1:3', '--lib', lib, '--data', 'missing-data.json', '--timeout', '1');
    for (const [failed, name] of [[missingLib, 'missing-lib.js'], [missingData, 'missing-data.json']]) {
      assert.equal(failed.code, 1, JSON.stringify(failed.json));
      assert.ok(failed.json.error.includes(name), failed.json.error);
    }
    assert.deepEqual(await runIds(h.cwd), []);
    assert.equal(h.doc.text.characters, '\u539f\u6587');
  });

  test('Repeated run --node is rejected with exit 1 and an only-once message without creating a task', async t => {
    const h = await harness(t);
    const refused = await h.cli('run', await writeScript(h.cwd, 'append.js', APPEND), '--node', '1:3', '--node', '1:4', '--timeout', '1');
    assert.equal(refused.code, 1, JSON.stringify(refused.json));
    assert.match(refused.json.error, /--node may be given only once/);
    assert.deepEqual(await runIds(h.cwd), []);
    assert.equal(h.doc.text.characters, '\u539f\u6587');
  });

  // ── requestId ────────────────────────────────────────────────────────────
  test('--request-id reuse returns the original task without reexecution and rejects changed content under the same ID', async t => {
    const h = await harness(t);
    const id = randomUUID(), file = await writeScript(h.cwd, 'append.js', APPEND);
    const first = await h.run('run', file, '--node', '1:3', '--request-id', id);
    assert.equal(first.code, 0);
    assert.deepEqual([first.json.id, first.json.output], [id, '\u539f\u6587+']);
    // Keep pumping the plugin during resubmission to expose any erroneous requeue as repeated execution.
    const again = await h.run('run', file, '--node', '1:3', '--request-id', id);
    assert.equal(again.code, 0);
    // Only waiting produces summary fields: reused submission waits for the original task and returns its result.
    assert.deepEqual([again.json.id, again.json.reused, again.json.waitStatus, again.json.ok, again.json.output], [id, true, 'completed', true, '\u539f\u6587+']);
    assert.equal(h.doc.text.characters, '\u539f\u6587+');
    const altered = await h.cli('run', file, '--node', '1:4', '--request-id', id);
    assert.equal(altered.code, 1);
    assert.match(altered.json.error, /cannot change its content/);
    assert.deepEqual(await fs.readdir(runsDir(h.cwd)), [id]);
  });

  test('Reusing a failed task requestId preserves its failure exit code', async t => {
    const h = await harness(t);
    const id = randomUUID(), file = await writeScript(h.cwd, 'fail.js', 'throw Error("\u6545\u610f\u5931\u8d25");');
    const first = await h.run('run', file, '--request-id', id);
    assert.deepEqual([first.code, first.json.ok], [1, false]);
    const again = await h.run('run', file, '--request-id', id);
    assert.equal(again.json.id, id);
    // Exit 0 means success; reusing a failed task must not report success.
    assert.equal(again.code, 1, JSON.stringify(again.json));
  });

  test('Reusing an unfinished requestId waits on the original until timeout, returns reused/timeout with exit 2, and does not requeue', async t => {
    const h = await harness(t);
    const id = randomUUID(), file = await writeScript(h.cwd, 'append.js', APPEND);
    await h.pause();
    const first = await h.cli('run', file, '--node', '1:3', '--request-id', id, '--no-wait');
    assert.deepEqual([first.code, first.json.id, first.json.state], [0, id, 'queued']);
    // While paused, the original remains queued and resubmission can only wait for it.
    const again = await h.cli('run', file, '--node', '1:3', '--request-id', id, '--timeout', '1');
    assert.equal(again.code, 2, JSON.stringify(again.json));
    assert.deepEqual([again.json.id, again.json.reused, again.json.waitStatus, again.json.state, again.json.ok], [id, true, 'timeout', 'queued', null]);
    assert.match(again.json.instruction, /do not replay the script/);
    // Resume pumping afterward: the script executes only once.
    const waited = await h.run('wait', id);
    assert.deepEqual([waited.code, waited.json.output], [0, '\u539f\u6587+']);
    assert.equal(h.doc.text.characters, '\u539f\u6587+');
    assert.deepEqual(await runIds(h.cwd), [id]);
  });

  // -- Binary return values -------------------------------------------------
  test('exportAsync bytes and complete PNG integer arrays persist as files, leaving only descriptors in output', async t => {
    const h = await harness(t);
    const run = await h.run('run', await writeScript(h.cwd, 'export.js', 'const png = await target.exportAsync({ format: "PNG" }); return { png, copied: Array.from(png) };'), '--node', '1:4');
    assert.equal(run.code, 0, JSON.stringify(run.json));
    const expected = Buffer.from(await h.doc.swatch.exportAsync({ format: 'PNG' }));
    for (const [key, file] of [['png', 'files/output-1.png'], ['copied', 'files/output-2.png']]) {
      const described = run.json.output[key];
      assert.deepEqual([described.file, described.type, described.width, described.height, described.bytes], [file, 'png', 2, 2, expected.length]);
      const saved = await fs.readFile(path.join(run.json.evidence, file));
      assert.deepEqual(saved, expected);
      assert.equal(described.sha256, hash(saved));
      assert.equal(described.pixels.dominant.color, '#0000FF');
    }
  });

  // -- Named previews -------------------------------------------------------
  test('preview --name exports by name, stores only names in job.json, names images by resolved ID, and exits 1 without images for missing names', async t => {
    const h = await harness(t);
    const ok = await h.run('preview', '--name', '\u8272\u5757', '--name', '\u6807\u9898', '--scale', '2');
    assert.equal(ok.code, 0, JSON.stringify(ok.json));
    assert.deepEqual(ok.json.images.map(i => [i.nodeId, i.name, path.basename(i.file), i.width]), [['1:4', '\u8272\u5757', '1-1-4.png', 4], ['1:3', '\u6807\u9898', '2-1-3.png', 4]]);
    assert.ok(await exists(ok.json.images[0].file), ok.json.images[0].file);
    const job = await json(path.join(ok.json.evidence, 'job.json'));
    assert.deepEqual([job.names, job.targetNodeId, job.nodes], [['\u8272\u5757', '\u6807\u9898'], undefined, undefined]);

    const missing = await h.run('preview', '--name', '\u8272\u5757', '--name', '\u4e0d\u5b58\u5728');
    assert.equal(missing.code, 1, JSON.stringify(missing.json));
    assert.deepEqual([missing.json.ok, missing.json.executionStarted, missing.json.images], [false, false, undefined]);
    assert.match(missing.json.error, /Name "\u4e0d\u5b58\u5728" not found among the children and Sections of the bound node; names in scope: \u6807\u9898, \u8272\u5757/);
    assert.equal((await json(missing.json.resultFile)).images, undefined);
    assert.deepEqual(h.errors, []);
  });

  // -- High-risk approval ---------------------------------------------------
  test('--high-risk waits for panel approval before execution/checkpoint, executes when allowed, and does not execute when canceled', async t => {
    const h = await harness(t);
    // main.js calls figma.ui.show() then sends approval synchronously; show means the panel is ready.
    const panelShown = () => new Promise(resolve => { h.figma.ui.show = resolve; });
    const id = randomUUID();
    let shown = panelShown();
    const approving = h.run('run', await writeScript(h.cwd, 'risky.js', 'target.characters = "\u5df2\u786e\u8ba4"; return target.characters;'), '--node', '1:3', '--high-risk', '\u6539\u5199\u6807\u9898', '--request-id', id);
    await shown;
    // Cancel approval after assertion failure so the child exits immediately instead of waiting the 300 s main.js timeout.
    try {
      // A task waiting for approval has been delivered, so doctor reports it as running.
      const busy = (await h.cli('doctor')).json.checks.find(c => c.code === 'ACTIVE_JOB');
      assert.deepEqual([busy.message, busy.action.includes(id)], [`Job ${id} is running`, true]);
      assert.equal(h.element('approval-reason').textContent, '\u6539\u5199\u6807\u9898');
      assert.equal(h.doc.text.characters, '\u539f\u6587');
      assert.equal(await exists(path.join(runsDir(h.cwd), id, 'before.json')), false);
    } catch (error) { await h.element('reject').onclick(); await approving; throw error; }
    await h.element('approve').onclick();
    const approved = await approving;
    assert.equal(approved.code, 0, JSON.stringify(approved.json));
    assert.equal(approved.json.output, '\u5df2\u786e\u8ba4');
    assert.equal((await json(path.join(runsDir(h.cwd), id, 'approval.json'))).approved, true);

    shown = panelShown();
    const rejecting = h.run('run', await writeScript(h.cwd, 'denied.js', 'target.characters = "\u4e0d\u8be5\u51fa\u73b0";'), '--node', '1:3', '--high-risk', '\u518d\u6b21\u6539\u5199');
    await shown;
    await h.element('reject').onclick();
    const rejected = await rejecting;
    assert.equal(rejected.code, 1);
    assert.deepEqual([rejected.json.ok, rejected.json.executionStarted], [false, false]);
    assert.equal(h.doc.text.characters, '\u5df2\u786e\u8ba4');
    assert.equal((await json(path.join(rejected.json.evidence, 'approval.json'))).approved, false);
  });

  // -- Visual verification --------------------------------------------------
  test('--expect unchanged with visual changes exits 1 while ok stays true; --tolerance permits the specified differing pixels', async t => {
    const h = await harness(t);
    const paint = (name, color) => writeScript(h.cwd, name, `target.fills = [{ type: "SOLID", visible: true, opacity: 1, color: ${JSON.stringify(color)} }];`);
    const red = await h.run('run', await paint('red.js', { r: 1, g: 0, b: 0 }), '--node', '1:4', '--expect', 'unchanged');
    assert.equal(red.code, 1);
    assert.deepEqual([red.json.ok, red.json.verify.pass, red.json.verify.changedPixels], [true, false, 4]);
    assert.match(red.json.instruction, /do not replay the script/);
    // A changed 2x2 export differs at all four pixels, so tolerance 4 passes.
    const green = await h.run('run', await paint('green.js', { r: 0, g: 1, b: 0 }), '--node', '1:4', '--expect', 'unchanged', '--tolerance', '4');
    assert.equal(green.code, 0, JSON.stringify(green.json.verify));
    assert.deepEqual([green.json.verify.pass, green.json.verify.changedPixels, green.json.verify.tolerance], [true, 4, 4]);
  });

  // -- Writes with unknown results ------------------------------------------
  test('Forced stop during execution requires review after restart and blocks run; inspect the original target then resolve without replay or undo', async t => {
    const h = await harness(t);
    const started = Promise.withResolvers();
    // Suspend after a write so the plugin is still executing when the bridge stops.
    h.figma.hold = () => { started.resolve(); return new Promise(() => {}); };
    const queued = await h.cli('run', await writeScript(h.cwd, 'hang.js', 'target.characters += "+"; await figma.hold(); return "\u4e0d\u4f1a\u5230\u8fbe";'), '--node', '1:3', '--no-wait');
    const id = queued.json.id;
    await h.tick();
    await started.promise;

    const stopped = await h.cli('stop', '--force');
    assert.equal(stopped.code, 0, JSON.stringify(stopped.json));
    assert.deepEqual([stopped.json.bridge, stopped.json.activeJob], ['stopped', id]);

    const bridge = await start(h.cwd, 0, { pollHoldMs: 50, pluginToken: await pairingToken(h.home) });
    t.after(() => bridge.close().catch(() => {}));
    const plugin = await reopenPlugin(bridge, h);
    assert.deepEqual((await h.cli('status')).json.unresolved, [id]);
    const pending = await h.cli('wait', id);
    assert.equal(pending.code, 2);
    assert.deepEqual([pending.json.waitStatus, pending.json.recovery], ['needs-review', 'unknown-after-disconnect']);
    const diagnosis = await h.cli('doctor');
    assert.deepEqual([diagnosis.code, diagnosis.json.ready], [1, false]);
    assert.match(diagnosis.json.checks.find(c => c.code === 'UNRESOLVED_JOB')?.action ?? '', /resolve/);

    const reader = await writeScript(h.cwd, 'read.js', 'return target.characters;');
    const blocked = await h.cli('run', reader, '--node', '1:3');
    assert.deepEqual([blocked.code, blocked.json.code], [1, 'REVIEW_REQUIRED']);

    // Inspecting the parent frame cannot replace directly querying the original target.
    const parentReview = await plugin.drive(h.cli('inspect', '--node', '1:2'));
    assert.equal(parentReview.code, 0);
    const indirect = await h.cli('resolve', id, '--inspect', parentReview.json.id, '--previous-plugin-stopped');
    assert.equal(indirect.code, 1);
    assert.match(indirect.json.error, /original job's target/);
    const review = await plugin.drive(h.cli('inspect', '--node', '1:3'));
    assert.equal((await h.cli('resolve', id, '--inspect', review.json.id)).code, 1);
    const resolved = await h.cli('resolve', id, '--inspect', review.json.id, '--previous-plugin-stopped');
    assert.equal(resolved.code, 0, JSON.stringify(resolved.json));
    assert.deepEqual([resolved.json.status, resolved.json.inspectId, resolved.json.targetMissing], ['reviewed-without-replay', review.json.id, false]);

    const after = await plugin.drive(h.cli('run', reader, '--node', '1:3'));
    assert.equal(after.code, 0, JSON.stringify(after.json));
    assert.equal(after.json.output, '\u539f\u6587+');
    assert.deepEqual(plugin.errors, []);
    await bridge.close();
  });

  test('After resolve, wait/result on the original task exit 1; wait returns resolved with guidance from the review record', async t => {
    const h = await harness(t);
    const started = Promise.withResolvers();
    h.figma.hold = () => { started.resolve(); return new Promise(() => {}); };
    const queued = await h.cli('run', await writeScript(h.cwd, 'hang.js', 'target.characters += "+"; await figma.hold();'), '--node', '1:3', '--no-wait');
    const id = queued.json.id;
    await h.tick();
    await started.promise;
    // Closing during execution follows stop --force: write recovery guidance and require review after restart.
    await h.close();
    const bridge = await start(h.cwd, 0, { pollHoldMs: 50, pluginToken: await pairingToken(h.home) });
    t.after(() => bridge.close().catch(() => {}));
    const plugin = await reopenPlugin(bridge, h);
    const pending = await h.cli('wait', id);
    assert.deepEqual([pending.code, pending.json.waitStatus], [2, 'needs-review']);

    const review = await plugin.drive(h.cli('inspect', '--node', '1:3'));
    const resolved = await h.cli('resolve', id, '--inspect', review.json.id, '--previous-plugin-stopped');
    assert.equal(resolved.code, 0, JSON.stringify(resolved.json));
    assert.equal(typeof resolved.json.instruction, 'string');

    // Review records take precedence over recovery hints: waiting cannot help and exits 1; offline result returns the same review guidance.
    const waited = await h.cli('wait', id);
    assert.equal(waited.code, 1, JSON.stringify(waited.json));
    assert.deepEqual([waited.json.waitStatus, waited.json.resolution, waited.json.ok, waited.json.instruction],
      ['resolved', 'reviewed-without-replay', null, resolved.json.instruction]);
    const stored = await h.cli('result', id);
    assert.equal(stored.code, 1, JSON.stringify(stored.json));
    assert.deepEqual([stored.json.waitStatus, stored.json.resolution, stored.json.ok, stored.json.instruction],
      [undefined, 'reviewed-without-replay', null, resolved.json.instruction]);
    assert.deepEqual(plugin.errors, []);
    await bridge.close();
  });

  // -- Inactive bridges -----------------------------------------------------
  test('doctor identifies every plugin lease rejection in remedy order, offers action only on the first, and prioritizes tasks owned by another project', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-cli-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    assert.equal((await cli(cwd, 'init', FIGMA_URL)).code, 0);
    const home = path.join(cwd, 'plugin-home'), token = await pairingToken(home);
    const bridge = await start(cwd, 0, { pollHoldMs: 0, pluginToken: token });
    t.after(() => bridge.close().catch(() => {}));
    const manifest = (await installPlugin(home, bridge.plugin)).manifest;
    const plugin = (route, pairing = token, version = bridge.version) => fetch(`http://127.0.0.1:${bridge.port}${route}`, { headers: { 'X-Session-Token': pairing, ...(version ? { 'X-Plugin-Version': version } : {}) } });
    // Keep only plugin-reason and connection checks, returning [code, status, hasAction] in order.
    const diagnose = async () => {
      const result = await cli(cwd, 'doctor');
      assert.deepEqual([result.code, result.json.ready], [1, false]);
      const checks = result.json.checks.filter(c => ['FOREIGN_JOB', 'PAIRING_MISMATCH', 'NO_FILE_KEY', 'WRONG_FILE', 'PLUGIN_CONNECTION'].includes(c.code));
      return { checks, shape: checks.map(c => [c.code, c.status, c.action !== undefined]) };
    };

    assert.equal((await plugin('/poll?client=old&file=example', 'e'.repeat(64))).status, 403);
    // Requests without a plugin-version header, such as simple browser requests or port scans, do not affect diagnostics.
    assert.equal((await plugin('/poll?client=probe', 'f'.repeat(64), null)).status, 403);
    let d = await diagnose();
    assert.deepEqual(d.shape, [['PAIRING_MISMATCH', 'error', true]], 'Do not collapse the reason into a generic disconnected-plugin message');
    assert.match(d.checks[0].message, /mismatched pairing token.*same-name plugin/);
    assert.ok(d.checks[0].action.includes(manifest), d.checks[0].action);
    const files = (await cli(cwd, 'doctor')).json.checks.find(c => c.code === 'PLUGIN_FILES');
    assert.deepEqual([files.status, files.message.includes(manifest)], ['ok', true]);

    // Idle wrong-file and missing-fileKey instances add explanations without replacing existing reasons.
    assert.equal((await plugin('/poll?client=x&file=other')).status, 200);
    assert.equal((await plugin('/poll?client=z&file=')).status, 200);
    d = await diagnose();
    assert.deepEqual(d.shape, [['PAIRING_MISMATCH', 'error', true], ['NO_FILE_KEY', 'warning', false], ['WRONG_FILE', 'warning', false]]);
    assert.match(d.checks.at(-1).message, /another file/);

    // A bound-file instance holding another project's task takes priority; remedy is returning to that project, not reopening the plugin.
    assert.equal((await plugin(`/heartbeat?client=y&file=example&job=${randomUUID()}`)).status, 409);
    await plugin('/poll?client=x&file=other');
    d = await diagnose();
    assert.deepEqual(d.shape.map(([code, status, action]) => [code, status, action]), [['FOREIGN_JOB', 'error', true], ['PAIRING_MISMATCH', 'warning', false], ['NO_FILE_KEY', 'warning', false], ['WRONG_FILE', 'warning', false]]);
    assert.match(d.checks[0].action, /Go back to that project and run figma-agent-control connect/);
  });

  test('doctor reports WRONG_FILE with a bound-file link when only other-file instances are connected', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-cli-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    assert.equal((await cli(cwd, 'init', FIGMA_URL)).code, 0);
    const token = await pairingToken(path.join(cwd, 'plugin-home'));
    const bridge = await start(cwd, 0, { pollHoldMs: 0, pluginToken: token });
    t.after(() => bridge.close().catch(() => {}));
    await fetch(`http://127.0.0.1:${bridge.port}/poll?client=x&file=other`, { headers: { 'X-Session-Token': token, 'X-Plugin-Version': bridge.version } });
    const check = (await cli(cwd, 'doctor')).json.checks.find(c => c.code === 'WRONG_FILE');
    assert.equal(check?.status, 'error');
    assert.ok(check.action.includes(FIGMA_URL), check.action);
  });

  test('Switching from project A to B during execution prevents B delivery, preserves late results without content-error reduction, and persists the original result when A returns', async t => {
    const h = await harness(t);
    const started = Promise.withResolvers(), finish = Promise.withResolvers();
    h.figma.hold = () => { started.resolve(); return finish.promise; };
    const queued = await h.cli('run', await writeScript(h.cwd, 'slow.js', 'target.characters += "+"; await figma.hold(); return target.characters;'), '--node', '1:3', '--no-wait');
    const id = queued.json.id, port = h.bridge.port, pluginToken = await pairingToken(h.home);
    await h.tick(); await started.promise;
    await h.close();

    // B binds the same file, so file checks cannot distinguish it; identify ownership by the held task being unknown to B.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-\u9879\u76eeB-'));
    t.after(() => fs.rm(other, { recursive: true, force: true }));
    await init(other, FIGMA_URL);
    const b = await start(other, port, { pollHoldMs: 50, pluginToken });
    try {
      // The script remains in hold: pump one heartbeat but do not settle, which would wait for execution.
      await h.tick();
      assert.equal(h.element('state').textContent, 'Waiting for original project');
      assert.match(h.element('state-detail').textContent, new RegExp(path.basename(h.cwd)));
      const status = async () => (await cli(other, 'status')).json;
      assert.deepEqual([(await status()).connected, Object.keys((await status()).pluginIssues)], [false, ['FOREIGN_JOB']], 'An instance holding another project job does not renew the lease for B');
      assert.equal((await cli(other, 'inspect', '--no-wait')).json.code, 'RECONNECTING');

      // Drive retries until B receives five completions, exceeding the three-rejection fallback threshold; every attempt must retain the original result.
      finish.resolve(); await h.settle();
      const completes = () => h.requests.filter(r => r.path === '/complete').map(r => r.body);
      while (completes().length < 5) { await h.tick(); await delay(5); }
      await h.pause(); h.resume(); await delay(20);
      assert.deepEqual(completes().map(body => [body.id, body.ok, body.output]), Array(5).fill([id, true, '\u539f\u6587+']), 'Repeated rejection by B preserves the original result without degrading it to failure');
      assert.equal(h.element('state').textContent, 'Waiting for original project');
      assert.deepEqual(await runIds(other), [], 'B does not persist another project\'s result');
    } finally { await b.close(); }

    const a = await start(h.cwd, port, { pollHoldMs: 50, pluginToken });
    t.after(() => a.close().catch(() => {}));
    await h.tick(); await h.settle();
    const result = await json(path.join(runsDir(h.cwd), id, 'result.json'));
    assert.deepEqual([result.ok, result.output, result.error], [true, '\u539f\u6587+', undefined], 'Returning to A persists the actual result unchanged');
    assert.deepEqual(h.errors, []);
    await a.close();
  });

  test('Without a bridge, doctor identifies each blocking stage, stop distinguishes no session/empty/stale locks, and network errors map to NO_SESSION or BRIDGE_DOWN', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-cli-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const dir = root(cwd), lockFile = path.join(dir, 'bridge.lock');
    const check = (result, code) => result.json.checks.find(c => c.code === code);

    const bare = await cli(cwd, 'doctor');
    assert.deepEqual([bare.code, bare.json.ready], [1, false]);
    assert.deepEqual(bare.json.checks.map(c => c.code), ['NODE_VERSION', 'CHROME', 'BINDING']);
    assert.match(check(bare, 'BINDING').action, /init/);

    // Legacy bindings lack format:2.
    await save(path.join(dir, 'binding.json'), { id: randomUUID(), fileKey: 'example', nodeId: '1:2', sourceUrl: FIGMA_URL });
    const legacy = await cli(cwd, 'doctor');
    assert.equal(legacy.json.ready, false);
    assert.match(check(legacy, 'BINDING').message, /legacy format/);
    await fs.rm(dir, { recursive: true });

    assert.equal((await cli(cwd, 'init', FIGMA_URL)).code, 0);
    const idle = await cli(cwd, 'doctor');
    assert.deepEqual([idle.json.ready, check(idle, 'BINDING').status, check(idle, 'SESSION').status], [false, 'ok', 'error']);
    assert.match(check(idle, 'SESSION').action, /connect/);
    assert.equal(check(idle, 'BRIDGE'), undefined);

    const noSession = await cli(cwd, 'status');
    assert.deepEqual([noSession.code, noSession.json.code], [1, 'NO_SESSION']);
    const notRunning = await cli(cwd, 'stop');
    assert.deepEqual([notRunning.code, notRunning.json.bridge], [0, 'not-running']);

    // An empty lock means another connect is writing its PID. stop/doctor agree with connect without claiming no bridge or cleaning the lock.
    await fs.writeFile(lockFile, '');
    const starting = await cli(cwd, 'stop');
    assert.deepEqual([starting.code, starting.json.code], [1, 'BRIDGE_RUNNING']);
    assert.match(starting.json.error, /another connect/);
    const emptyLock = check(await cli(cwd, 'doctor'), 'LOCK');
    assert.deepEqual([emptyLock.status, emptyLock.message], ['warning', starting.json.error]);
    assert.equal(await fs.readFile(lockFile, 'utf8'), '');
    // PIDs beyond safe integers are invalid for both doctor and acquireLock and are not probed.
    await fs.writeFile(lockFile, '99999999999999999999');
    assert.match(check(await cli(cwd, 'doctor'), 'LOCK').message, /Invalid PID/);

    await fs.writeFile(lockFile, '424242');
    const orphan = await cli(cwd, 'stop');
    assert.deepEqual([orphan.code, orphan.json.code], [1, 'LOCK_WITHOUT_SESSION']);
    assert.equal(await fs.readFile(lockFile, 'utf8'), '424242');
    await fs.rm(lockFile);

    await save(path.join(dir, 'session.json'), { port: await closedPort(), token: 'a'.repeat(64), sessionId: randomUUID(), pid: process.pid });
    const down = await cli(cwd, 'status');
    assert.deepEqual([down.code, down.json.code], [1, 'BRIDGE_DOWN']);
    assert.equal(check(await cli(cwd, 'doctor'), 'BRIDGE_DOWN')?.status, 'error');
  });

  test('doctor lists CHROME warning before BINDING, rejects invalid environment overrides without fallback, suggests correction, and reports executable versions', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-cli-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const fake = path.join(cwd, 'fake-chrome');
    await fs.writeFile(fake, '#!/bin/sh\necho "Google Chrome 1.2.3"\n', { mode: 0o755 });
    // In an uninitialized directory doctor exits 1 but still returns complete diagnostics.
    const chrome = async value => {
      const env = { ...process.env, FIGMA_AGENT_CONTROL_HOME: path.join(cwd, 'plugin-home'), FIGMA_AGENT_CONTROL_CHROME: value };
      const { stdout } = await exec(process.execPath, [cliFile, 'doctor'], { cwd, env }).catch(error => error);
      const checks = JSON.parse(stdout).checks;
      assert.deepEqual(checks.map(c => c.code), ['NODE_VERSION', 'CHROME', 'BINDING']);
      return checks[1];
    };
    const missing = await chrome('/nonexistent');
    assert.deepEqual([missing.status, missing.message.includes('/nonexistent')], ['warning', true]);
    assert.match(missing.action, /FIGMA_AGENT_CONTROL_CHROME/);
    assert.match(missing.action, /html/);
    const found = await chrome(fake);
    assert.equal(found.status, 'ok');
    assert.ok(found.message.includes('Google Chrome 1.2.3') && found.message.includes(fake), found.message);
  });

  // -- Offline tools --------------------------------------------------------
  test('image-diff accepts files or single-image preview tasks, rejects multi-image tasks, exits 1 when expect changed sees no change, and writes project diffs/', async t => {
    const h = await harness(t);
    const png = (name, pixels) => fs.writeFile(path.join(h.cwd, name), encodePng(2, 2, Uint8Array.from(pixels.flat())));
    const white = [255, 255, 255, 255], black = [0, 0, 0, 255], blue = [0, 0, 255, 255];
    await Promise.all([png('a.png', [white, white, white, white]), png('b.png', [white, white, white, black]), png('blue.png', [blue, blue, blue, blue])]);

    const diff = await h.cli('image-diff', 'a.png', 'b.png');
    assert.equal(diff.code, 0, JSON.stringify(diff.json));
    assert.deepEqual([diff.json.changed, diff.json.changedPixels, diff.json.changedBounds], [true, 1, { x: 1, y: 1, width: 1, height: 1 }]);
    assert.equal(path.dirname(diff.json.diffImage), path.join(root(await fs.realpath(h.cwd)), 'diffs'));
    // The changed lower-right pixel is red in the diff.
    assert.deepEqual([...decodePng(await fs.readFile(diff.json.diffImage)).data.subarray(12, 16)], [255, 0, 0, 255]);

    const same = await h.cli('image-diff', 'a.png', 'a.png', '--expect', 'changed');
    assert.deepEqual([same.code, same.json.changed, same.json.expectation], [1, false, 'failed']);
    assert.match(same.json.hint, /rendering did not change/);

    const single = await h.run('preview', '--node', '1:4');
    const fromJob = await h.cli('image-diff', single.json.id, 'blue.png', '--expect', 'unchanged');
    assert.equal(fromJob.code, 0, JSON.stringify(fromJob.json));
    assert.deepEqual([fromJob.json.changed, fromJob.json.beforeFile], [false, single.json.images[0].file]);

    const batch = await h.run('preview', '--node', '1:3', '--node', '1:4');
    const refused = await h.cli('image-diff', batch.json.id, 'blue.png');
    assert.equal(refused.code, 1);
    assert.match(refused.json.error, /single-image preview/);
  });

  test('report --since counts tasks, durations, and repeated execution of the same script on the same target within the window', async t => {
    const h = await harness(t);
    const since = new Date().toISOString();
    const bump = await writeScript(h.cwd, 'bump.js', 'target.characters += "+";');
    await h.run('run', bump, '--node', '1:3');
    await h.run('run', bump, '--node', '1:3');
    await h.run('inspect', '--node', '1:2');
    // Start the window at the second persisted task's createdAt without depending on wall-clock or directory-mtime precision.
    const created = (await Promise.all((await fs.readdir(runsDir(h.cwd))).map(id => json(path.join(runsDir(h.cwd), id, 'job.json'))))).map(job => job.createdAt).sort();
    const mid = created[1];

    const all = await h.cli('report', '--since', since);
    assert.equal(all.code, 0);
    assert.deepEqual([all.json.jobs.count, all.json.jobs.byOperation, all.json.jobs.failed], [3, { run: 2, inspect: 1 }, 0]);
    assert.deepEqual(all.json.repeats.map(r => [r.label, r.target, r.count]), [['bump.js', '1:3', 2]]);
    assert.deepEqual([all.json.timing.total.count, all.json.timing.queue.count, all.json.timing.plugin.count], [3, 3, 3]);
    const journals = await Promise.all((await fs.readdir(runsDir(h.cwd))).map(id => json(path.join(runsDir(h.cwd), id, 'job.json'))));
    assert.equal(all.json.timing.total.sumMs, journals.reduce((sum, job) => sum + Date.parse(job.finishedAt) - Date.parse(job.createdAt), 0));

    const later = await h.cli('report', '--since', mid);
    assert.equal(later.json.jobs.count, 2);
    assert.deepEqual(later.json.repeats, []);
  });
});
