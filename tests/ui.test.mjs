/**
 * [INPUT]: plugin/ui.html script with SESSION_CONFIG replaced before node:vm execution; controlled fetch, document, parent, window, and setInterval mocks.
 * [OUTPUT]: No exports; relay behavior tests for file discovery, multiport/binding-ID routing, credentials, delivery/completion/long-poll renewal, cancellation holds, serialized ticks, approval/checkpoint forwarding, reduced failure evidence, request timeouts, foreign-project results, pairing/version errors, footer version, target/task panels, visibility/session changes, and network recovery.
 * [POS]: Plugin relay unit tests using fetch mocks to assert exact request sequences without a bridge; complements harness-driven end-to-end coverage.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fakeElement } from './helpers/harness.mjs';

// -- Fixtures -------------------------------------------------------------
// Match bridge injection by replacing only the configuration placeholder line. Queue mock fetch responses by path, defaulting to 200 + null.
const MiB = 1024 * 1024;
// ports is the candidate range: the real plugin uses eight ports from 32523; this fixture defaults to one unless a multiport case overrides it.
const config = { ports: [1234], token: 'plugin-token', version: 'v-test-0001' };
// Binding is not in plugin configuration: the bridge sends X-Figma-Binding, while one global plugin installation serves all projects.
const BINDING = { fileKey: 'example', nodeId: '1:2' };
const template = await fs.readFile(new URL('../plugin/ui.html', import.meta.url), 'utf8');
const build = (/** @type {typeof config} */ cfg) => template.match(/<script>([\s\S]*)<\/script>/)[1]
  .replace('const config = SESSION_CONFIG;', () => `const config = ${JSON.stringify(cfg)};`);
const script = build(config);
const flush = () => new Promise(resolve => setImmediate(resolve));

// fileKey is main's hello reply, normally read from figma.fileKey; null means main has not replied.
// run opens a concurrent hold=1 heartbeat cancellation channel, recorded in holds and queued under hold; calls tracks only the serial tick sequence.
// probe=1 discovery heartbeats are recorded in probes and consume probe responses in config.ports order; default binding matches the current file, so the first port wins.
function plugin({ visibility = 'visible', fileKey = 'example', ports } = {}) {
  const calls = [], holds = [], probes = [], toMain = [], queues = new Map(), elements = new Map(), listeners = {}, window = {};
  const el = id => { if (!elements.has(id)) elements.set(id, fakeElement({ hidden: id === 'approval' })); return elements.get(id); };
  const document = { visibilityState: visibility, getElementById: el, createElement: () => fakeElement(), addEventListener: (type, fn) => { listeners[type] = fn; } };
  let tick, interval;
  async function fetch(url, options = {}) {
    const { origin, pathname, searchParams } = new URL(url), key = searchParams.get('hold') === '1' ? 'hold' : searchParams.get('probe') === '1' ? 'probe' : pathname;
    (key === 'hold' ? holds : key === 'probe' ? probes : calls).push({ origin, path: pathname, query: Object.fromEntries(searchParams), headers: new Headers(options.headers), timeoutMs: options.signal?.timeoutMs,
      body: options.body === undefined ? undefined : JSON.parse(options.body) });
    const reply = await (queues.get(key)?.shift() ?? (key === 'probe' ? { headers: { 'X-Figma-Binding': JSON.stringify(BINDING) } } : {}));
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ ...(reply.session ? { 'X-Figma-Session': reply.session, 'X-Figma-Binding': JSON.stringify(reply.binding ?? BINDING) } : {}), ...reply.headers }), json: async () => reply.body ?? null };
  }
  vm.runInNewContext(ports ? build({ ...config, ports }) : script, { window, document, crypto, TextEncoder, fetch,
    parent: { postMessage: message => toMain.push(structuredClone(message.pluginMessage)) },
    AbortSignal: { timeout: ms => ({ timeoutMs: ms }) },
    setInterval: (fn, ms) => { tick = fn; interval = ms; } });
  // UI asks main for the current file on startup; afterward toMain records only task-related messages.
  if (fileKey !== null) { assert.deepEqual(toMain, [{ type: 'hello' }]); toMain.length = 0; window.onmessage({ data: { pluginMessage: { type: 'file', fileKey } } }); }
  return {
    calls, holds, probes, toMain, interval, el,
    reply: (path, ...replies) => queues.set(path, [...(queues.get(path) ?? []), ...replies]),
    trigger: () => tick(),
    tick: async () => { await tick(); await flush(); },
    fromMain: async message => { await window.onmessage({ data: { pluginMessage: message } }); await flush(); },
    click: async id => { await el(id).onclick(); await flush(); },
    setVisibility: async state => { document.visibilityState = state; await listeners.visibilitychange(); await flush(); },
    state: () => el('state').textContent,
    detail: () => el('state-detail').textContent,
    paths: (from = 0) => calls.slice(from).map(c => c.path),
    bodies: path => calls.filter(c => c.path === path).map(c => c.body),
    last: path => calls.findLast(c => c.path === path)
  };
}
// Receive a task and return this round's channel credentials.
async function claim(f, job) {
  f.reply('/poll', { body: job });
  await f.tick();
  return f.toMain.at(-1).channelNonce;
}

// -- Complete round trip --------------------------------------------------
test('High-risk run completes delivery, approval, checkpoint, and result return, then immediately polls for the next task without waiting for a tick', async () => {
  const f = plugin();
  assert.equal(f.interval, 750);
  const job = { id: 'job-1', operation: 'run', code: 'return 1', risk: { level: 'high', reason: '\u5220\u9664\u56fe\u5c42' }, scriptHash: 'h1' };
  const channelNonce = await claim(f, job);
  assert.match(channelNonce, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.toMain, [{ ...job, channelNonce }]);

  // While a task is active, send heartbeats without receiving a second task.
  await f.tick(); await f.tick();
  assert.deepEqual(f.paths(), ['/poll', '/heartbeat', '/heartbeat']);
  assert.equal(f.state(), 'Working');

  // Show high-risk approval without submitting before a click; release main only after the bridge saves the decision.
  await f.fromMain({ type: 'approval-request', id: 'job-1', channelNonce, reason: '\u5220\u9664\u56fe\u5c42', scriptHash: 'h1', code: 'return 1', binding: BINDING });
  assert.equal(f.el('approval').hidden, false);
  assert.equal(f.state(), 'Review changes');
  assert.equal(f.last('/approve'), undefined);
  f.reply('/approve', { body: { approved: true } });
  await f.click('approve');
  assert.deepEqual(f.last('/approve').body, { id: 'job-1', scriptHash: 'h1', approved: true });
  assert.deepEqual(f.toMain.at(-1), { type: 'approval-ack', id: 'job-1', channelNonce, approved: true });
  assert.equal(f.el('approval').hidden, true);

  // Send the checkpoint snapshot to the bridge and acknowledge only after saving.
  const before = { id: '1:2', name: '\u753b\u677f' }, bindingVerified = { fileKey: 'example', pageId: '1:1', nodeId: '1:2' };
  f.reply('/checkpoint', { body: { saved: true, hash: 'abc' } });
  await f.fromMain({ type: 'checkpoint', id: 'job-1', channelNonce, before, bindingVerified });
  assert.deepEqual(f.last('/checkpoint').body.before, before);
  assert.deepEqual(f.last('/checkpoint').body.bindingVerified, bindingVerified);
  assert.deepEqual(f.toMain.at(-1), { type: 'checkpoint-ack', id: 'job-1', channelNonce, ok: true });

  // A result triggers /complete immediately without tick, followed by /poll for the next task.
  const next = { id: 'job-2', operation: 'inspect' };
  f.reply('/poll', { body: next });
  const mark = f.calls.length;
  const result = { id: 'job-1', ok: true, output: 1, before, after: { id: '1:2', name: '\u65b0\u753b\u677f' }, bindingVerified, undoBoundaries: { before: 'committed', after: 'committed' } };
  await f.fromMain({ ...result, channelNonce });
  assert.deepEqual(f.paths(mark), ['/complete', '/poll'], 'Do not heartbeat before returning a pending result');
  assert.deepEqual(f.last('/complete').body, result);
  const delivered = f.toMain.at(-1);
  assert.notEqual(delivered.channelNonce, channelNonce);
  assert.deepEqual(delivered, { ...next, channelNonce: delivered.channelNonce });

  // Every plugin request includes pairing credentials and version; poll/heartbeat use the same client and visibility.
  assert.deepEqual([...new Set(f.paths())].sort(), ['/approve', '/checkpoint', '/complete', '/heartbeat', '/poll']);
  for (const call of f.calls) {
    assert.equal(call.origin, 'http://localhost:1234');
    assert.equal(call.headers.get('X-Session-Token'), config.token, call.path);
    assert.equal(call.headers.get('X-Plugin-Version'), config.version, call.path);
  }
  // poll/heartbeat include the current file; active heartbeats include the held task so the bridge can verify instance ownership.
  const leased = f.calls.filter(c => c.path === '/poll' || c.path === '/heartbeat');
  assert.ok(leased[0].query.client);
  for (const call of leased) assert.deepEqual([call.query.client, call.query.visibility, call.query.file], [leased[0].query.client, 'visible', 'example']);
  assert.deepEqual(leased.map(c => [c.path, c.query.job]), [['/poll', undefined], ['/heartbeat', 'job-1'], ['/heartbeat', 'job-1'], ['/poll', undefined]]);
});

test('Before learning the current file, send no network request and ask main each tick; learning it immediately enables delivery', async () => {
  const f = plugin({ fileKey: null });
  await f.tick(); await f.tick();
  assert.deepEqual([f.calls, f.toMain], [[], [{ type: 'hello' }, { type: 'hello' }, { type: 'hello' }]]);
  await f.fromMain({ type: 'file', fileKey: 'example' });
  await f.fromMain({ type: 'file', fileKey: 'other' });
  await f.tick();
  assert.deepEqual(f.calls.map(c => [c.path, c.query.file]), [['/poll', 'example']], 'Accept only the first file report');
  // If main reports an empty fileKey, continue polling with an empty file so the bridge reports NO_FILE_KEY instead of leaving the plugin silent.
  const g = plugin({ fileKey: '' });
  await g.tick();
  assert.deepEqual(g.calls.map(c => [c.path, c.query.file]), [['/poll', '']]);
});

test('After bridge restart and another instance lease, late results bypass rejected heartbeats and still persist', async () => {
  const f = plugin();
  const channelNonce = await claim(f, { id: 'job-1', operation: 'run', code: 'return 1' });
  f.reply('/heartbeat', { status: 409, body: { code: 'CONNECTION_IN_USE' } });
  await f.tick();
  assert.equal(f.last('/heartbeat') !== undefined, true);
  const mark = f.calls.length;
  await f.fromMain({ id: 'job-1', ok: true, output: 1, channelNonce });
  assert.deepEqual(f.paths(mark).slice(0, 1), ['/complete']);
  assert.deepEqual(f.last('/complete').body, { id: 'job-1', ok: true, output: 1 });
});

test('X-Long-Poll empty responses immediately renew polling without a tick; ordinary empty responses stop renewal', async () => {
  const f = plugin();
  f.reply('/poll', { headers: { 'X-Long-Poll': '1' } }, { headers: { 'X-Long-Poll': '1' } }, {});
  await f.tick();
  assert.deepEqual(f.paths(), ['/poll', '/poll', '/poll'], 'Each of two held responses renews once; the ordinary empty response stops');
  const job = { id: 'job-1', operation: 'inspect' };
  f.reply('/poll', { headers: { 'X-Long-Poll': '1' } }, { body: job });
  await f.tick();
  assert.deepEqual(f.paths(3), ['/poll', '/poll']);
  assert.deepEqual(f.toMain.at(-1), { ...job, channelNonce: f.toMain.at(-1).channelNonce }, 'A task received by renewed polling still reaches main');
});

test('run opens a cancellation hold heartbeat channel, renews X-Long-Poll immediately, forwards cancel then stops; read-only tasks do not', async () => {
  const f = plugin();
  f.reply('hold', { headers: { 'X-Long-Poll': '1' } }, { headers: { 'X-Long-Poll': '1' } }, { body: { connected: true, active: 'job-1', cancel: true } });
  f.reply('/poll', { body: { id: 'job-1', operation: 'run' } });
  await f.tick();
  for (let i = 0; i < 5; i++) await flush();
  const { channelNonce } = f.toMain[0];
  assert.deepEqual(f.holds.map(c => [c.path, c.query.job, c.timeoutMs]), Array(3).fill(['/heartbeat', 'job-1', 15000]));
  assert.deepEqual(f.toMain.slice(1), [{ type: 'cancel', id: 'job-1', channelNonce }]);
  assert.deepEqual(f.paths(), ['/poll'], 'The serial tick request sequence is unaffected');
  const g = plugin();
  await claim(g, { id: 'job-2', operation: 'inspect' });
  await flush();
  assert.equal(g.holds.length, 0);
});

test('Accept results only for the current task and channel credentials; previous credentials expire with the task', async () => {
  const f = plugin();
  const first = await claim(f, { id: 'job-1', operation: 'run' });
  await f.fromMain({ id: 'job-1', ok: true, channelNonce: 'forged' });
  await f.fromMain({ type: 'checkpoint', id: 'job-1', channelNonce: 'forged', before: { id: '1:2' } });
  await f.fromMain({ id: 'other', ok: true, channelNonce: first });
  assert.deepEqual(f.paths(), ['/poll']);

  f.reply('/poll', { body: { id: 'job-2', operation: 'run' } });
  await f.fromMain({ id: 'job-1', ok: true, channelNonce: first });
  await f.fromMain({ id: 'job-2', ok: true, channelNonce: first });
  assert.equal(f.bodies('/complete').length, 1);
});

// -- Polling and visibility -----------------------------------------------
test('tick serializes concurrent triggers into one rerun, merging visibility changes with the latest state', async () => {
  const f = plugin();
  // The first tick discovers the bridge asynchronously; only later requests start synchronously.
  await f.tick();
  assert.deepEqual(f.paths(), ['/poll']);
  const hold = () => { let release; f.reply('/poll', new Promise(resolve => { release = resolve; })); return () => release({}); };
  let release = hold();
  const first = f.trigger();
  f.trigger(); f.trigger();
  assert.deepEqual(f.paths(1), ['/poll']);
  release();
  await first; await flush();
  assert.deepEqual(f.paths(1), ['/poll', '/poll']);

  release = hold();
  const second = f.trigger();
  await f.setVisibility('hidden');
  assert.equal(f.calls.length, 4);
  release();
  await second; await flush();
  assert.deepEqual(f.calls.map(c => [c.path, c.query.visibility]).slice(3), [['/poll', 'visible'], ['/poll', 'hidden']]);
});

test('Visibility changes immediately heartbeat without waiting for a tick, including startup while hidden', async () => {
  const f = plugin({ visibility: 'hidden' });
  await flush();
  assert.deepEqual(f.calls.map(c => [c.path, c.query.visibility]), [['/heartbeat', 'hidden']]);
  await f.setVisibility('visible');
  assert.deepEqual(f.calls.map(c => [c.path, c.query.visibility]), [['/heartbeat', 'hidden'], ['/heartbeat', 'visible']]);
});

test('Bridge session changes send header binding to main for reverification and show project and target status', async () => {
  const f = plugin();
  const other = { fileKey: 'other', nodeId: '9:9', project: 'project-b' };
  f.reply('/poll', { session: 'S1', binding: { ...BINDING, project: 'project-a' } }, { session: 'S1' }, { session: 'S2', binding: other });
  await f.tick();
  assert.deepEqual(f.toMain, [{ type: 'check-target', binding: { ...BINDING, project: 'project-a' } }]);
  assert.deepEqual([f.el('project').textContent, f.el('project').hidden], ['project-a', false]);
  await f.tick();
  assert.equal(f.toMain.length, 1, 'The same session does not repeat verification');
  await f.tick();
  assert.deepEqual(f.toMain.at(-1), { type: 'check-target', binding: other }, 'A different project uses its new binding');
  assert.equal(f.el('project').textContent, 'project-b');

  await f.fromMain({ type: 'target-info', name: '', issue: 'This is not the bound file' });
  assert.deepEqual([f.state(), f.detail(), f.el('state-detail').hidden], ['Target needs attention', 'This is not the bound file', false]);
  assert.equal(f.el('target-name').disabled, true, 'An unready target cannot be focused');
  await f.fromMain({ type: 'target-info', name: '\u753b\u677f', nodeType: 'COMPONENT_SET', page: '\u9875\u9762', id: '1:2', issue: null });
  assert.deepEqual([f.el('target-name').textContent, f.el('target-meta').textContent, f.el('target-name').disabled], ['\u753b\u677f', 'Component set · \u9875\u9762 · 1:2', false]);
  assert.deepEqual([f.state(), f.el('state-detail').hidden], ['Connected', true], 'Normal operation hides the detail text');
  await f.click('target-name');
  assert.deepEqual(f.toMain.at(-1), { type: 'focus-target' });
});

test('The task panel shows operation, label, and progress, disables focus while running, then keeps up to five persisted recent tasks with failure reasons', async () => {
  const f = plugin();
  await f.fromMain({ type: 'target-info', name: '\u753b\u677f', nodeType: 'FRAME', page: '\u9875\u9762', id: '1:2', issue: null });
  assert.deepEqual([f.el('job').hidden, f.el('empty').hidden], [true, false]);
  const channelNonce = await claim(f, { id: 'job-0001-abcdef', operation: 'run', label: 'body.js', targetNodeId: '3:4', code: 'return 1' });
  assert.deepEqual([f.el('job').hidden, f.el('empty').hidden, f.el('target-name').disabled], [false, true, true]);
  assert.deepEqual([f.el('job-op').textContent, f.el('job-label').textContent, f.el('job-phase').textContent], ['run', 'body.js', 'Running · Node 3:4 · #job-0001']);
  assert.match(f.el('job-time').textContent, /^\d+ ms$/);
  f.reply('/complete', { body: { saved: true } });
  await f.fromMain({ id: 'job-0001-abcdef', ok: false, executionStarted: true, error: 'TypeError: x is undefined', channelNonce });
  const text = row => row.children.map(cell => cell.textContent);
  const rows = () => f.el('recent').children;
  assert.deepEqual([f.el('job').hidden, f.el('target-name').disabled], [true, false]);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].className, 'job failed');
  assert.deepEqual(text(rows()[0]).slice(0, 3), ['✕', 'run', 'body.js']);
  assert.equal(text(rows()[0])[4], 'TypeError: x is undefined');
  assert.match(rows()[0].title, /^Task job-0001-abcdef\nTypeError/);

  for (let i = 2; i <= 6; i++) {
    const nonce = await claim(f, { id: `job-${i}`, operation: 'inspect' });
    assert.equal(f.el('job-label').textContent, 'Read node tree', 'Unlabeled built-in operations use English descriptions');
    f.reply('/complete', { body: { saved: true } });
    await f.fromMain({ id: `job-${i}`, ok: true, output: i, channelNonce: nonce });
  }
  assert.deepEqual(rows().map(row => [row.className, text(row)[1], row.children.length]), Array(5).fill(['job done', 'inspect', 4]));
  assert.match(rows()[0].title, /^Task job-6$/);
});

// -- Approval and checkpoints ---------------------------------------------
test('Unsaved checkpoints deny execution; unsaved approvals remain visible without acknowledging main', async () => {
  const f = plugin();
  const channelNonce = await claim(f, { id: 'job-1', operation: 'run' });
  const checkpoint = { type: 'checkpoint', id: 'job-1', channelNonce, before: { id: '1:2' } };
  f.reply('/checkpoint', { status: 400, body: { error: 'The pre-change snapshot is locked; refusing overwrite' } }, new TypeError('Failed to fetch'));
  await f.fromMain(checkpoint);
  await f.fromMain(checkpoint);
  assert.deepEqual(f.toMain.slice(1), [
    { type: 'checkpoint-ack', id: 'job-1', channelNonce, ok: false },
    { type: 'checkpoint-ack', id: 'job-1', channelNonce, ok: false }
  ]);

  await f.fromMain({ type: 'approval-request', id: 'job-1', channelNonce, reason: 'High risk', scriptHash: 'h1', code: 'x', binding: BINDING });
  f.reply('/approve', { status: 400, body: { error: 'Invalid approval target, script, or state' } });
  await f.click('approve');
  assert.equal(f.toMain.length, 3);
  assert.equal(f.el('approval').hidden, false);
  assert.equal(f.state(), 'Review changes');

  f.reply('/approve', { body: { approved: false } });
  await f.click('reject');
  assert.deepEqual(f.last('/approve').body, { id: 'job-1', scriptHash: 'h1', approved: false });
  assert.deepEqual(f.toMain.at(-1), { type: 'approval-ack', id: 'job-1', channelNonce, approved: false });
  assert.equal(f.el('approval').hidden, true);
});

// -- Reduced result fallback ----------------------------------------------
test('A 413 response switches the next attempt to reduced failure evidence preserving execution/verification fields instead of resending the original', async () => {
  const f = plugin();
  const channelNonce = await claim(f, { id: 'job-1', operation: 'run' });
  const bindingVerified = { fileKey: 'example', pageId: '1:1', nodeId: '1:2' }, undoBoundaries = { before: 'committed', after: 'committed' };
  const result = { id: 'job-1', ok: true, output: '\u6b63\u6587', before: { id: '1:2' }, after: { id: '1:2', name: '\u65b0' }, bindingVerified, undoBoundaries };
  f.reply('/complete', { status: 413, body: { error: 'Request too large' } });
  await f.fromMain({ ...result, channelNonce });
  assert.equal(f.state(), 'Check the connection');
  assert.ok(!f.paths().slice(1).includes('/poll'));

  await f.tick();
  const sends = f.bodies('/complete');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], result);
  const { error, recovery, ...rest } = sends[1];
  assert.deepEqual(rest, { id: 'job-1', ok: false, executionStarted: true, bindingVerified, undoBoundaries });
  assert.match(error, /size limit/);
  assert.match(recovery, /do not replay the script/);
  assert.equal(f.paths().at(-1), '/poll');
  assert.equal(f.toMain.length, 1);
});

test('Reduced failed-run evidence preserves created/cleaned node lists, deleted-existing count, and script stack', async () => {
  const f = plugin();
  const channelNonce = await claim(f, { id: 'job-1', operation: 'run' });
  const leftovers = { created: [{ id: '9:1', name: '\u534a\u6210\u54c1', type: 'FRAME' }], cleaned: [{ id: '9:1', name: '\u534a\u6210\u54c1', type: 'FRAME' }], cleanFailed: [], deletedExisting: 1, warnings: ['Sample warning'], stack: '    at f (<input>:4:1)\n' };
  const result = { id: 'job-1', ok: false, error: 'boom', executionStarted: true, after: { id: '1:2' }, undoBoundaries: { before: 'committed', after: 'committed', clean: 'committed' }, ...leftovers };
  f.reply('/complete', { status: 413, body: { error: 'Request too large' } });
  await f.fromMain({ ...result, channelNonce });
  await f.tick();
  const compact = f.bodies('/complete')[1];
  assert.equal(compact.after, undefined);
  assert.deepEqual({ created: compact.created, cleaned: compact.cleaned, cleanFailed: compact.cleanFailed, deletedExisting: compact.deletedExisting, warnings: compact.warnings, stack: compact.stack }, leftovers);
  assert.equal(compact.undoBoundaries.clean, 'committed');
});

test('Three 400 rejections of the same result trigger reduced evidence while preserving main\'s execution status', async () => {
  const f = plugin();
  const channelNonce = await claim(f, { id: 'job-1', operation: 'run' });
  const result = { id: 'job-1', ok: false, error: 'Syntax error', executionStarted: false, recovery: 'The script did not execute; correct it and resubmit' };
  f.reply('/complete', { status: 400 }, { status: 400 }, { status: 400 });
  await f.fromMain({ ...result, channelNonce });
  await f.tick(); await f.tick();
  assert.deepEqual(f.bodies('/complete'), [result, result, result]);
  assert.equal(f.state(), 'Check the connection');

  await f.tick();
  const compact = f.bodies('/complete')[3];
  assert.equal(compact.ok, false);
  assert.equal(compact.executionStarted, false);
  assert.match(compact.error, /rejected this result content/);
  assert.equal(f.paths().at(-1), '/poll');
  assert.equal(f.toMain.length, 1);
});

test('400 rejection counts accumulate for the same result without resetting on intervening 409 or other errors', async () => {
  const f = plugin();
  const channelNonce = await claim(f, { id: 'job-1', operation: 'run' });
  const result = { id: 'job-1', ok: true, output: 1, executionStarted: true };
  f.reply('/complete', { status: 400 }, { status: 409, body: { code: 'FOREIGN_JOB' } }, { status: 400 }, { status: 400 });
  await f.fromMain({ ...result, channelNonce });
  await f.tick(); await f.tick(); await f.tick();
  assert.deepEqual(f.bodies('/complete'), [result, result, result, result]);

  await f.tick();
  const compact = f.bodies('/complete')[4];
  assert.deepEqual([compact.ok, compact.executionStarted], [false, true]);
  assert.match(compact.error, /rejected this result content/);
});

test('Renders do not count toward the 16 MB structured limit; only oversized structure triggers reduction, retaining snapshots that fit', async () => {
  const f = plugin();
  let channelNonce = await claim(f, { id: 'job-1', operation: 'run', expect: 'changed' });
  const renders = { before: 'A'.repeat(16 * MiB), after: 'B'.repeat(16 * MiB) };
  await f.fromMain({ type: 'serialized-result', id: 'job-1', channelNonce, serialized: JSON.stringify({ id: 'job-1', ok: true, output: null, renders, channelNonce }) });
  const sent = f.last('/complete').body;
  assert.equal(sent.ok, true);
  assert.equal(sent.renders.before, renders.before);
  assert.equal(sent.renders.after, renders.after);

  const g = plugin();
  channelNonce = await claim(g, { id: 'job-2', operation: 'run' });
  const before = { id: '1:2', name: '\u65e7' }, after = { id: '1:2', name: '\u65b0' };
  await g.fromMain({ type: 'serialized-result', id: 'job-2', channelNonce, serialized: JSON.stringify({ id: 'job-2', ok: true, output: 'x'.repeat(16 * MiB), before, after, channelNonce }) });
  const compact = g.last('/complete').body;
  assert.equal(compact.ok, false);
  assert.equal(compact.output, undefined);
  assert.equal(compact.executionStarted, true);
  assert.deepEqual([compact.before, compact.after], [before, after]);
});

test('Request timeouts are 15 s for poll, 3 s for heartbeat, and 3 s plus 1 s per 10 MB of complete-body characters, allowing near-limit extracts to return', async () => {
  const f = plugin();
  let channelNonce = await claim(f, { id: 'job-1', operation: 'extract' });
  await f.tick();
  await f.fromMain({ id: 'job-1', ok: true, output: { schema: 1 }, channelNonce });
  assert.deepEqual(['/poll', '/heartbeat', '/complete'].map(path => f.calls.find(c => c.path === path).timeoutMs), [15000, 3000, 3000]);
  channelNonce = await claim(f, { id: 'job-2', operation: 'extract' });
  await f.fromMain({ id: 'job-2', ok: true, output: { reference: { __figmaAgentControlBinary: 0 } }, binaries: ['A'.repeat(48e6)], channelNonce });
  assert.deepEqual([f.last('/complete').body.id, f.last('/complete').timeoutMs], ['job-2', 7800]);
});

test('409 FOREIGN_JOB retains and retries original results without rejection counting or reduction, identifies the owner project, and resumes polling after that project persists the result', async () => {
  const f = plugin();
  f.reply('/poll', { session: 'S1', binding: { ...BINDING, project: 'project-a' }, body: { id: 'job-1', operation: 'run' } });
  await f.tick();
  const channelNonce = f.toMain.at(-1).channelNonce;
  // The bridge switches to project B: active heartbeats are rejected and the panel waits for the original project.
  f.reply('/heartbeat', { status: 409, body: { code: 'FOREIGN_JOB' } });
  await f.tick();
  assert.equal(f.state(), 'Waiting for original project');
  assert.match(f.detail(), /project-a/);
  const result = { id: 'job-1', ok: true, output: '\u771f\u5b9e\u7ed3\u679c' };
  const foreign = { status: 409, body: { code: 'FOREIGN_JOB' } };
  f.reply('/complete', foreign, foreign, foreign, foreign, {});
  await f.fromMain({ ...result, channelNonce });
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.state(), 'Waiting for original project');
  assert.ok(!f.paths().includes('/poll', 1), 'Do not poll while holding another project\'s result');
  await f.tick();
  assert.deepEqual(f.bodies('/complete'), Array(5).fill(result), 'All five retries preserve the original result');
  assert.equal(f.paths().at(-1), '/poll');
});

// -- Connection errors ----------------------------------------------------
test('403 PAIRING_MISMATCH identifies mismatched plugin credentials and an older same-name plugin without delivering tasks to main', async () => {
  const f = plugin();
  f.reply('/poll', { status: 403, body: { code: 'PAIRING_MISMATCH', error: 'Plugin pairing credentials do not match' } });
  await f.tick();
  assert.equal(f.state(), 'Plugin credentials do not match');
  assert.match(f.detail(), /older.*same name.*manifest/);
  assert.deepEqual(f.toMain, []);
});

test('409 PLUGIN_OUTDATED asks to reopen the plugin without delivering tasks to main', async () => {
  const f = plugin();
  const outdated = { status: 409, body: { code: 'PLUGIN_OUTDATED', error: 'Plugin code updated: close and reopen the plugin in Figma' }, session: 'S-new' };
  f.reply('/poll', outdated, outdated);
  await f.tick(); await f.tick();
  assert.deepEqual(f.toMain, []);
  assert.equal(f.state(), 'Reopen the plugin');
  assert.match(f.detail(), /run it again/);
});

test('The footer shows the injected status.pluginVersion before file discovery and retains it during PLUGIN_OUTDATED', async () => {
  assert.match(template, /<small id="plugin-version"[^>]*><\/small>/);
  const f = plugin({ fileKey: null });
  assert.equal(f.el('plugin-version').textContent, config.version);
  await f.fromMain({ type: 'file', fileKey: 'example' });
  f.reply('/poll', { status: 409, body: { code: 'PLUGIN_OUTDATED' } });
  await f.tick();
  assert.deepEqual([f.state(), f.el('plugin-version').textContent], ['Reopen the plugin', config.version]);
});

test('Multiport discovery probes once per port, selects the current-file binding, falls back to the first responder, and retries each tick when none respond', async () => {
  const f = plugin({ ports: [1234, 1235, 1236] });
  const header = binding => ({ headers: { 'X-Figma-Binding': JSON.stringify(binding) } });
  f.reply('probe', new TypeError('Failed to fetch'), header({ fileKey: 'other', nodeId: '1:1' }), header(BINDING));
  await f.tick();
  assert.deepEqual(f.probes.map(c => c.origin), ['http://localhost:1234', 'http://localhost:1235', 'http://localhost:1236']);
  for (const probe of f.probes) assert.deepEqual([probe.path, probe.query.file, probe.query.job, probe.timeoutMs], ['/heartbeat', 'example', undefined, 1500], 'Probes do not include the held task');
  assert.deepEqual(f.calls.map(c => [c.origin, c.path]), [['http://localhost:1236', '/poll']], 'Connect to the bridge bound to the current file');
  await f.tick();
  assert.equal(f.probes.length, 3, 'Stop probing after finding a bridge');

  // A stopped bridge releases its port on connection failure; search again next tick. With no responder, suggest connect without ordinary requests.
  f.reply('/poll', new TypeError('Failed to fetch'));
  await f.tick();
  f.reply('probe', new TypeError('a'), new TypeError('b'), new TypeError('c'));
  await f.tick();
  assert.equal(f.state(), 'Waiting for bridge');
  assert.match(f.detail(), /figma-agent-control connect/);
  assert.equal(f.calls.length, 3, 'No ordinary requests without a bridge');
  // If only another project's bridge is online, use it so check-target displays the mismatch; rediscover every few seconds while mismatched.
  f.reply('probe', header({ fileKey: 'other', nodeId: '1:1' }), new TypeError('b'), new TypeError('c'));
  f.reply('/poll', { session: 'S9', binding: { fileKey: 'other', nodeId: '1:1', project: 'project-b' } });
  await f.tick();
  assert.deepEqual(f.calls.at(-1).origin, 'http://localhost:1234');
  assert.deepEqual(f.toMain.at(-1), { type: 'check-target', binding: { fileKey: 'other', nodeId: '1:1', project: 'project-b' } });
});

test('If same-file project B takes A\'s port, retain A\'s result and route by bindingId when A returns on another port, without reexecution', async () => {
  const f = plugin({ ports: [1234, 1235] }), a = { ...BINDING, id: 'binding-a', project: 'A' }, b = { ...BINDING, id: 'binding-b', project: 'B' };
  const header = binding => ({ headers: { 'X-Figma-Binding': JSON.stringify(binding) } });
  const job = { id: 'job-a', bindingId: a.id, operation: 'inspect' };
  f.reply('probe', header(a), new TypeError('offline'));
  f.reply('/poll', { session: 'A-1', binding: a, body: job });
  await f.tick();
  const channelNonce = f.toMain.at(-1).channelNonce, result = { id: job.id, ok: true, output: { value: '\u539f\u7ed3\u679c' } };
  f.reply('/complete', { ...header(b), status: 409, body: { code: 'FOREIGN_JOB' } });
  await f.fromMain({ ...result, channelNonce });
  assert.equal(f.state(), 'Waiting for original project');
  f.reply('probe', header(b), new TypeError('Project A is not running yet'));
  await f.tick();
  assert.equal(f.bodies('/complete').length, 1, 'Finding only B must not resend A\'s result to B');
  f.reply('probe', header(b), header(a));
  f.reply('/complete', { session: 'A-2', binding: a, body: { received: true } });
  await f.tick();
  assert.deepEqual(f.calls.filter(c => c.path === '/complete').map(c => c.origin), ['http://localhost:1234', 'http://localhost:1235']);
  assert.deepEqual(f.bodies('/complete'), [result, result]);
  assert.equal(f.toMain.filter(m => m.id === job.id).length, 1);
  assert.equal(f.state(), 'Connected');
});

test('Network failures distinguish automatic recovery from manual checks, retaining and retrying active results without reexecution', async () => {
  const f = plugin();
  f.reply('/poll', new TypeError('Failed to fetch'));
  await f.tick();
  assert.equal(f.state(), 'Reconnecting');
  assert.match(f.detail(), /will reconnect/);
  f.reply('/poll', new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  await f.tick();
  assert.equal(f.state(), 'Reconnecting');
  assert.match(f.detail(), /timed out/);
  f.reply('/poll', { status: 409, body: { code: 'CONNECTION_IN_USE' } });
  await f.tick();
  assert.equal(f.state(), 'Check the connection');

  const channelNonce = await claim(f, { id: 'job-1', operation: 'run' });
  assert.equal(f.state(), 'Working');
  f.reply('/complete', new TypeError('Failed to fetch'));
  await f.fromMain({ id: 'job-1', ok: true, output: 1, channelNonce });
  assert.equal(f.state(), 'Reconnecting');
  await f.tick();
  const sends = f.bodies('/complete');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1], sends[0]);
  assert.equal(f.toMain.length, 1);
  assert.equal(f.state(), 'Connected');
});
