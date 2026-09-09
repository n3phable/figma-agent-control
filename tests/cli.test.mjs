/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:net, node:path, node:vm, node:crypto, node:child_process, node:util, node:timers/promises, ./helpers/harness.mjs, ../src/bridge.mjs, ../src/project.mjs, ../src/session.mjs, ../src/png.mjs.
 * [OUTPUT]: Selected original node:test cases and their unchanged fixture setup.
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
    assert.deepEqual([s.operation, s.label, s.waitStatus, s.state, s.journalComplete, s.ok, s.target], ['run', 'retitle.js', 'completed', 'done', true, true, '1:3']);
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

  

  

  // -- Offline tools --------------------------------------------------------
  

  
});
