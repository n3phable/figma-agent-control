/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:fs, node:os, node:path, node:net, node:crypto, node:child_process, node:timers/promises, node:url, ../src/bridge.mjs, ../src/project.mjs, ../src/session.mjs, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for bridge; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { start } from '../src/bridge.mjs';
import { init, root, json } from '../src/project.mjs';
import { pairingToken } from '../src/session.mjs';
import { encodePng, decodePng } from '../src/png.mjs';

// -- Fixtures -------------------------------------------------------------
const MiB = 1024 * 1024;
const FIGMA_URL = 'https://www.figma.com/design/example/Test?node-id=1-2';
const OPTIONS = { timeout: 10000 };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const WHITE = [255, 255, 255], RED = [255, 0, 0], BLUE = [0, 0, 255];
const png = (w, h, rgb) => encodePng(w, h, new Uint8Array(Array.from({ length: w * h }, () => [...rgb, 255]).flat()));
const b64 = bytes => Buffer.from(bytes).toString('base64');
const verified = nodeId => ({ fileKey: 'example', pageId: '1:1', nodeId });
const RUN = { operation: 'run', code: 'return 1;' };
const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function send(port, route, { token, version, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers['X-Session-Token'] = token;
  if (version !== undefined) headers['X-Plugin-Version'] = version;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

// Real bridge with both roles. The injected clock keeps connection freshness dependent only on b.clock, not execution speed.
async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-bridge-'));
  await init(cwd, FIGMA_URL);
  const dir = root(cwd);
  // Follow connect: read plugin credentials from the global directory, replaced here by the test-owned temporary directory.
  const b = { cwd, dir, home: path.join(cwd, 'plugin-home'), clock: 0, run: id => path.join(dir, 'runs', id) };
  b.boot = async () => {
    b.pairing = await pairingToken(b.home);
    b.bridge = await start(cwd, 0, { now: () => b.clock, pollHoldMs: 0, pluginToken: b.pairing });
    b.token = (await json(path.join(dir, 'session.json'))).token;
  };
  b.restart = async () => { await b.bridge.close(); await b.boot(); };
  await b.boot();
  t.after(async () => { await b.bridge.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  b.send = (route, options) => send(b.bridge.port, route, options);
  b.cli = (route, body) => send(b.bridge.port, route, { token: b.token, body });
  b.plugin = (route, body) => send(b.bridge.port, route, { token: b.pairing, version: b.bridge.version, body });
  b.poll = () => b.plugin('/poll?client=plugin&file=example');
  b.status = async () => (await b.cli('/status')).body;
  b.submit = async body => { const r = await b.cli('/job', body); assert.equal(r.status, 202, JSON.stringify(r.body)); return r.body.id; };
  b.deliver = async body => { const id = await b.submit(body); const job = (await b.poll()).body; assert.equal(job?.id, id); return job; };
  b.finish = async (body, completion) => {
    const job = await b.deliver(body);
    const r = await b.plugin('/complete', { id: job.id, ...completion });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: job.id, job, result: await json(path.join(b.run(job.id), 'result.json')) };
  };
  return b;
}

// After /shutdown replies, wait for the lock release (the last close step). Do not call bridge.close(), so shutdown itself must close the bridge.
async function stopped(b) {
  const lock = path.join(b.dir, 'bridge.lock');
  for (let i = 0; i < 5000 && await exists(lock); i++) await nextTurn();
  assert.equal(await exists(lock), false, 'The bridge did not close itself after shutdown');
  assert.equal(await exists(path.join(b.dir, 'session.json')), false);
  await assert.rejects(fetch(`http://127.0.0.1:${b.bridge.port}/status`));
}

// -- Role credentials and plugin versions ---------------------------------
test('CLI and plugin credentials are not interchangeable; missing or incorrect credentials return 403 without side effects', OPTIONS, async t => {
  const b = await fixture(t);
  const wrong = 'f'.repeat(64), version = b.bridge.version;
  const cliRoutes = [['/status'], ['/result?id=' + uuid(1)], ['/job', { operation: 'inspect' }], ['/resolve', { id: uuid(1), inspectId: uuid(2), previousPluginStopped: true }], ['/shutdown', { force: true }]];
  const pluginRoutes = [['/poll?client=plugin&file=example'], ['/heartbeat?client=plugin&file=example'], ['/checkpoint', { id: uuid(1) }], ['/approve', { id: uuid(1) }], ['/complete', { id: uuid(1), ok: true }]];
  for (const [route, body] of cliRoutes) for (const token of [undefined, wrong, b.pairing])
    assert.equal((await b.send(route, { token, version, body })).status, 403, `${route} accepted ${token === b.pairing ? 'plugin credentials' : 'missing or incorrect credentials'}`);
  for (const [route, body] of pluginRoutes) for (const token of [undefined, wrong, b.token])
    assert.equal((await b.send(route, { token, version, body })).status, 403, `${route} accepted ${token === b.token ? 'CLI credentials' : 'missing or incorrect credentials'}`);

  // Rejected requests neither connected, submitted a task, nor stopped the bridge; a successful /status proves it is still running.
  const status = await b.status();
  assert.equal(status.connected, false);
  assert.deepEqual(status.jobs, []);

  // Plugin credentials in the ui.html configuration returned by start match global pairing.json, version, and port. Pairing files are owner-only; the bridge does not install plugin files.
  const ui = b.bridge.plugin['ui.html'];
  assert.equal(await exists(path.join(b.dir, 'plugin')), false, 'connect installs plugins globally, not inside the project');
  const config = JSON.parse(ui.match(/const config = (\{.*\});/)[1]);
  assert.deepEqual([config.token, config.version, config.port], [b.pairing, version, b.bridge.port]);
  assert.equal((await fs.stat(path.join(b.home, 'pairing.json'))).mode & 0o777, 0o600);
  assert.equal(await exists(path.join(b.dir, 'pairing.json')), false, 'The project directory does not store pairing credentials');
});

test('Missing or mismatched X-Plugin-Version returns 409 PLUGIN_OUTDATED and prevents old plugins from receiving tasks', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const id = await b.submit(RUN);
  for (const version of [undefined, '0'.repeat(16)])
    for (const [route, body] of [['/poll?client=plugin&file=example'], ['/heartbeat?client=plugin&file=example'], ['/checkpoint', { id }], ['/approve', { id }], ['/complete', { id, ok: true }]]) {
      const r = await b.send(route, { token: b.pairing, version, body });
      assert.deepEqual([r.status, r.body.code], [409, 'PLUGIN_OUTDATED'], `${route} version ${version}`);
    }
  assert.equal((await b.cli('/result?id=' + id)).body.state, 'queued');
  assert.equal((await b.poll()).body.id, id);
});

// -- Job validation -------------------------------------------------------
test('Every protocol.md job-field constraint rejects out-of-bounds values with 400 and accepts boundary values', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  // Occupy the active slot first: valid requests reach 409 ACTIVE_JOB, while invalid ones fail earlier with 400.
  await b.submit({ operation: 'inspect' });
  const preview = { operation: 'preview', targetNodeId: '1:3' };
  const nodes = n => ['1:3', ...Array.from({ length: n - 1 }, (_, i) => `2:${i + 1}`)];
  const lib = (name, code) => ({ name, code });
  const rejected = {
    'unknown operation': { operation: 'rollback' },
    'run without a script': { operation: 'run' },
    'run with whitespace-only script': { operation: 'run', code: ' \n' },
    'script on a non-run task': { operation: 'inspect', code: 'return 1;' },
    'target ID contains a path': { operation: 'inspect', targetNodeId: '../1:2' },
    'instance ID lacks descendant chain': { operation: 'inspect', targetNodeId: 'I1:2' },
    '21 libraries': { ...RUN, libs: Array.from({ length: 21 }, (_, i) => lib(`l${i}`, '')) },
    'libraries total over 2 MiB': { ...RUN, libs: [lib('a', 'a'.repeat(MiB)), lib('b', 'a'.repeat(MiB + 1))] },
    'libraries on inspect': { operation: 'inspect', libs: [lib('a', '')] },
    'library missing name': { ...RUN, libs: [{ code: '' }] },
    'snapshotDepth 0': { ...RUN, snapshotDepth: 0 },
    'snapshotDepth 32': { ...RUN, snapshotDepth: 32 },
    'noninteger snapshotDepth': { ...RUN, snapshotDepth: 1.5 },
    'snapshotDepth on preview': { ...preview, nodes: ['1:3', '1:4'], snapshotDepth: 1 },
    'only 1 node': { ...preview, nodes: ['1:3'] },
    '51 nodes': { ...preview, nodes: nodes(51) },
    'duplicate nodes': { ...preview, nodes: ['1:3', '1:3'] },
    'first node is not the target': { ...preview, nodes: ['1:4', '1:3'] },
    'nodes on inspect': { operation: 'inspect', targetNodeId: '1:3', nodes: ['1:3', '1:4'] },
    'scale on inspect': { operation: 'inspect', scale: 1 },
    'scale on run without expect': { ...RUN, scale: 1 },
    'scale below 0.1': { ...preview, scale: 0.09 },
    'scale above 4': { ...preview, scale: 4.01 },
    'string scale': { ...preview, scale: '1' },
    'data on inspect': { operation: 'inspect', data: {} },
    'data over 1 MiB': { ...RUN, data: 'a'.repeat(MiB) },
    'invalid expect value': { ...RUN, expect: 'same' },
    'expect on inspect': { operation: 'inspect', expect: 'changed' },
    'tolerance without expect': { ...RUN, tolerance: 0 },
    'negative tolerance': { ...RUN, expect: 'changed', tolerance: -1 },
    'noninteger tolerance': { ...RUN, expect: 'changed', tolerance: 1.5 },
    'high risk without reason': { ...RUN, risk: { level: 'high' } },
    'high risk on inspect': { operation: 'inspect', risk: { level: 'high', reason: '\u8bf4\u660e' } },
    'unknown risk level': { ...RUN, risk: { level: 'urgent', reason: '\u8bf4\u660e' } },
    'non-UUID requestId': { operation: 'inspect', requestId: 'abc' }
  };
  const accepted = {
    'minimal run': RUN,
    '20 libraries totaling exactly 2 MiB': { ...RUN, libs: [lib('big', 'a'.repeat(2 * MiB - 19)), ...Array.from({ length: 19 }, (_, i) => lib(`l${i}`, 'a'))] },
    'snapshotDepth 1（run）': { ...RUN, snapshotDepth: 1 },
    'snapshotDepth 31（inspect）': { operation: 'inspect', snapshotDepth: 31 },
    '2 nodes': { ...preview, nodes: ['1:3', '1:4'] },
    '50 nodes': { ...preview, nodes: nodes(50) },
    'scale 0.1（preview）': { ...preview, scale: 0.1 },
    'scale 4 on run with expect': { ...RUN, expect: 'changed', scale: 4 },
    'data exactly 1 MiB': { ...RUN, data: 'a'.repeat(MiB - 2) },
    'expect unchanged with tolerance 0': { ...RUN, expect: 'unchanged', tolerance: 0 },
    'high risk with reason': { ...RUN, risk: { level: 'high', reason: '\u8c03\u6574\u5171\u4eab\u7ec4\u4ef6' } },
    'instance descendant target': { operation: 'inspect', targetNodeId: 'I1:2;3:4' },
    'variables': { operation: 'variables' },
    'UUID requestId': { operation: 'inspect', requestId: uuid(9) }
  };
  for (const [name, body] of Object.entries(rejected)) {
    const r = await b.cli('/job', body);
    assert.equal(r.status, 400, `${name} should be rejected: ${JSON.stringify(r.body)}`);
  }
  for (const [name, body] of Object.entries(accepted)) {
    const r = await b.cli('/job', body);
    assert.equal(r.body.code, 'ACTIVE_JOB', `${name} should pass validation: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await b.status()).jobs.length, 1);
});

test('MiB limits count bytes: oversized data and libraries with multibyte characters are rejected', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  await b.submit({ operation: 'inspect' });
  // U+4E2D occupies 3 UTF-8 bytes and 2 UTF-16 bytes. Both payloads exceed their byte limits in either encoding while remaining within the code-unit limits.
  const data = await b.cli('/job', { ...RUN, data: '\u4e2d'.repeat(600_000) });
  const libs = await b.cli('/job', { ...RUN, libs: [{ name: 'cjk.js', code: '\u4e2d'.repeat(1_100_000) }] });
  assert.deepEqual({ data: data.status, libs: libs.status }, { data: 400, libs: 400 }, 'Reject approximately 1.8 MB of data and 3.3 MB of libraries');
});

test('Preview without targetNodeId validates its first node against the bound node', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  assert.equal((await b.cli('/job', { operation: 'preview', nodes: ['1:3', '1:2'] })).status, 400, 'The first node is not the bound node');
  const r = await b.cli('/job', { operation: 'preview', nodes: ['1:2', '1:3'] });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual((await json(path.join(b.run(r.body.id), 'job.json'))).nodes, ['1:2', '1:3']);
});

// ── requestId ────────────────────────────────────────────────────────────
test('requestId resubmission returns the original task, rejects any changed content across restarts, and rejects incomplete journals', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const id = uuid(1);
  const original = { operation: 'run', requestId: id, code: 'return data;', libs: [{ name: 'lib.js', code: 'const k = 1;' }], data: { text: '\u539f\u6587' },
    expect: 'changed', tolerance: 2, scale: 2, snapshotDepth: 3, targetNodeId: '1:3', risk: { level: 'high', reason: '\u6539\u5171\u4eab\u7ec4\u4ef6' }, label: 'body.js' };
  assert.equal((await b.cli('/job', original)).status, 202);
  const again = await b.cli('/job', original);
  assert.deepEqual([again.status, again.body.id, again.body.state, again.body.reused], [200, id, 'queued', true]);

  const variants = { code: { code: 'return 2;' }, libs: { libs: [{ name: 'lib.js', code: 'const k = 2;' }] }, data: { data: { text: '\u65b0\u6587' } },
    expect: { expect: 'unchanged' }, tolerance: { tolerance: 3 }, scale: { scale: 1 }, snapshotDepth: { snapshotDepth: 4 },
    targetNodeId: { targetNodeId: '1:4' }, risk: { risk: { level: 'normal' } } };
  for (const [field, change] of Object.entries(variants)) {
    // A new requestId reaches only ACTIVE_JOB, proving each variant is otherwise valid and 400 specifically means the same ID has different content.
    assert.equal((await b.cli('/job', { ...original, ...change, requestId: uuid(2) })).body.code, 'ACTIVE_JOB', field);
    assert.equal((await b.cli('/job', { ...original, ...change })).status, 400, `${field} differs but was treated as resubmission`);
  }
  assert.equal(await fs.readFile(path.join(b.run(id), 'script.js'), 'utf8'), original.code);
  assert.equal((await json(path.join(b.run(id), 'job.json'))).risk.level, 'high');

  await b.poll();
  await b.plugin('/complete', { id, ok: false, executionStarted: false, error: '\u672a\u786e\u8ba4' });
  assert.deepEqual(await b.cli('/job', original).then(r => [r.status, r.body.state, r.body.reused]), [200, 'failed', true]);
  // operation participates in comparison: resubmission with only a changed operation is also rejected.
  assert.equal((await b.cli('/job', { operation: 'inspect', requestId: uuid(4) })).status, 202);
  assert.equal((await b.cli('/job', { operation: 'variables', requestId: uuid(4) })).status, 400);

  // After restart the task is absent from memory but still recognized from its journal; /result serves only the current session.
  await b.restart();
  assert.deepEqual(await b.cli('/job', original).then(r => [r.status, r.body.id, r.body.state]), [200, id, 'failed']);
  assert.equal((await b.cli('/job', { ...original, code: 'return 2;' })).status, 400);
  assert.equal((await b.cli('/result?id=' + id)).status, 404);

  // An evidence directory without job.json cannot prove whether delivery occurred. Reject the same ID; the plugin is disconnected so this cannot be RECONNECTING.
  await fs.mkdir(b.run(uuid(3)));
  assert.equal((await b.cli('/job', { operation: 'inspect', requestId: uuid(3) })).status, 400);
  assert.equal(await exists(path.join(b.run(uuid(3)), 'job.json')), false);
});

// -- Submission gates and delivery ----------------------------------------
test('Submission returns RECONNECTING before connection and ACTIVE_JOB for an in-flight task; delivery occurs once and includes binding', OPTIONS, async t => {
  const b = await fixture(t);
  assert.equal((await b.cli('/job', { operation: 'inspect' })).body.code, 'RECONNECTING');
  await b.poll();
  b.clock = 15000; // The foreground lease expires after 15 s.
  const stale = await b.cli('/job', { operation: 'inspect' });
  assert.deepEqual([stale.status, stale.body.code], [409, 'RECONNECTING']);
  assert.deepEqual((await b.status()).jobs, []);

  await b.poll();
  const id = await b.submit({ ...RUN, targetNodeId: '1:3' });
  const busy = await b.cli('/job', { operation: 'inspect' });
  assert.deepEqual([busy.status, busy.body.code, busy.body.active], [409, 'ACTIVE_JOB', id]);

  const polls = await Promise.all(Array.from({ length: 10 }, () => b.poll()));
  const delivered = polls.map(p => p.body).filter(Boolean);
  assert.equal(delivered.length, 1, 'Concurrent polls deliver only once');
  const [job] = delivered;
  assert.deepEqual([job.id, job.state, job.code, job.targetNodeId], [id, 'running', 'return 1;', '1:3']);
  assert.deepEqual(job.binding, await json(path.join(b.dir, 'binding.json')), 'The plugin needs binding to verify the file and scope');
  assert.equal((await json(path.join(b.run(id), 'job.json'))).state, 'running');
  assert.equal((await b.poll()).body, null);
  assert.equal((await b.cli('/result?id=' + id)).body.state, 'running');

  await b.plugin('/complete', { id, ok: true, output: 1 });
  assert.equal((await b.cli('/job', { operation: 'inspect' })).status, 202);
});

test('Concurrent /job submissions yield one 202 and one 409 ACTIVE_JOB, creating only one runs/ directory', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const replies = await Promise.all([b.cli('/job', { operation: 'inspect' }), b.cli('/job', RUN)]);
  const accepted = replies.filter(r => r.status === 202), refused = replies.filter(r => r.status === 409);
  assert.deepEqual([accepted.length, refused.length], [1, 1], JSON.stringify(replies.map(r => r.body)));
  assert.deepEqual([refused[0].body.code, refused[0].body.active], ['ACTIVE_JOB', accepted[0].body.id]);
  assert.deepEqual(await fs.readdir(path.join(b.dir, 'runs')), [accepted[0].body.id]);
});

// -- Checkpoints and high-risk approval ------------------------------------
test('Checkpoint accepts only a delivered run with the correct target and locks the hash after persistence', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const inspect = await b.deliver({ operation: 'inspect' });
  assert.equal((await b.plugin('/checkpoint', { id: inspect.id, before: { id: '1:2' }, bindingVerified: verified('1:2') })).status, 400, 'Read-only tasks do not need checkpoints');
  await b.plugin('/complete', { id: inspect.id, ok: true, output: { id: '1:2' } });

  const id = await b.submit(RUN);
  const checkpoint = { id, before: { id: '1:2', name: '\u753b\u677f' }, bindingVerified: verified('1:2') };
  assert.equal((await b.plugin('/checkpoint', checkpoint)).status, 400, 'The task has not been delivered');
  await b.poll();
  for (const [name, bad] of [['Snapshot is not the target', { before: { id: '1:3' } }], ['File mismatch', { bindingVerified: { ...verified('1:2'), fileKey: 'other' } }],
    ['Missing page', { bindingVerified: { fileKey: 'example', nodeId: '1:2' } }]])
    assert.equal((await b.plugin('/checkpoint', { ...checkpoint, ...bad })).status, 400, name);
  const beforeFile = path.join(b.run(id), 'before.json');
  assert.equal(await exists(beforeFile), false);

  const saved = await Promise.all([b.plugin('/checkpoint', checkpoint), b.plugin('/checkpoint', checkpoint)]);
  assert.deepEqual(saved.map(r => [r.status, r.body.saved]), [[200, true], [200, true]]);
  assert.equal(saved[0].body.hash, saved[1].body.hash);
  assert.deepEqual(await json(beforeFile), checkpoint);
  assert.equal((await b.plugin('/checkpoint', { ...checkpoint, before: { id: '1:2', name: '\u6539\u8fc7' } })).status, 400, 'A locked checkpoint cannot be overwritten');
  assert.deepEqual(await json(beforeFile), checkpoint);
  const repeat = await b.plugin('/checkpoint', checkpoint);
  assert.deepEqual([repeat.status, repeat.body.hash], [200, saved[0].body.hash]);
});

test('High-risk tasks cannot checkpoint before approval; the decision binds to the script hash and is immutable', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const risky = { ...RUN, risk: { level: 'high', reason: '\u6539\u5171\u4eab\u7ec4\u4ef6' } };
  const denied = await b.deliver(risky);
  const checkpoint = id => ({ id, before: { id: '1:2' }, bindingVerified: verified('1:2') });
  assert.equal((await b.plugin('/checkpoint', checkpoint(denied.id))).status, 400, 'Not approved');
  const decide = (job, approved, extra = {}) => b.plugin('/approve', { id: job.id, scriptHash: job.scriptHash, approved, ...extra });
  assert.equal((await decide(denied, true, { scriptHash: 'f'.repeat(64) })).status, 400, 'Script hash mismatch');
  assert.equal((await decide(denied, 'yes')).status, 400, 'The decision must be a boolean');
  assert.equal((await decide(denied, false)).status, 200);
  assert.deepEqual(await json(path.join(b.run(denied.id), 'approval.json')).then(a => [a.approved, a.scriptHash]), [false, denied.scriptHash]);
  assert.equal((await decide(denied, true)).status, 400, 'Denial cannot become approval');
  assert.equal((await decide(denied, false)).status, 200, 'The same decision may be reported again');
  assert.equal((await b.plugin('/checkpoint', checkpoint(denied.id))).status, 400, 'Denied scripts cannot checkpoint');
  await b.plugin('/complete', { id: denied.id, ok: false, executionStarted: false, error: '\u7528\u6237\u62d2\u7edd' });

  const allowed = await b.deliver(risky);
  assert.equal((await decide(allowed, true)).status, 200);
  assert.equal((await b.plugin('/checkpoint', checkpoint(allowed.id))).status, 200);
  assert.equal((await decide(allowed, false)).status, 400, 'Approval cannot become denial');
});

test('/approve accepts only high-risk runs; ordinary runs and inspect return 400 without writing approval.json', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  for (const body of [RUN, { operation: 'inspect' }]) {
    const job = await b.deliver(body);
    const r = await b.plugin('/approve', { id: job.id, scriptHash: job.scriptHash, approved: true });
    assert.equal(r.status, 400, `${body.operation} does not need approval: ${JSON.stringify(r.body)}`);
    assert.equal(await exists(path.join(b.run(job.id), 'approval.json')), false, body.operation);
    await b.plugin('/complete', { id: job.id, ok: false, executionStarted: false, error: '\u7ed3\u675f' });
  }
});

// -- Completion and commit point ------------------------------------------
test('The first result wins and repeats are idempotent; result.json commits the result but the gate stays closed until journaling completes', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  // A task unknown to this project belongs elsewhere because the plugin is global. Return 409 so the plugin retains the result; neither reject its content nor persist it here.
  const foreign = await b.plugin('/complete', { id: uuid(404), ok: true });
  assert.deepEqual([foreign.status, foreign.body.code, await exists(b.run(uuid(404)))], [409, 'FOREIGN_JOB', false]);
  assert.equal((await b.plugin('/complete', { id: 'not-a-job', ok: true })).status, 400, 'Invalid task ID');
  const id = await b.submit({ operation: 'inspect' });
  assert.equal((await b.plugin('/complete', { id, ok: true })).status, 400, 'Not yet delivered');
  await b.poll();
  assert.equal((await b.plugin('/complete', { id, output: 1 })).status, 400, 'Missing ok');

  const replies = await Promise.all(Array.from({ length: 10 }, (_, output) => b.plugin('/complete', { id, ok: true, output })));
  assert.ok(replies.every(r => r.status === 200));
  const resultFile = path.join(b.run(id), 'result.json');
  const persisted = await json(resultFile);
  assert.ok(Number.isInteger(persisted.output) && persisted.output >= 0 && persisted.output < 10);
  assert.equal((await b.plugin('/complete', { id, ok: false, output: '\u8986\u76d6\u5c1d\u8bd5' })).status, 200);
  assert.deepEqual(await json(resultFile), persisted);
  assert.deepEqual((await b.cli('/result?id=' + id)).body, persisted);
  const journal = await json(path.join(b.run(id), 'job.json'));
  assert.equal('result' in journal, false, 'job.json does not embed results');
  assert.deepEqual([journal.state, journal.finishedAt], ['done', persisted.finishedAt]);

  // Replace job.json with a directory to fail the second step: the result is committed but the gate stays closed; retry reuses the committed result.
  const runId = (await b.deliver(RUN)).id;
  const journalFile = path.join(b.run(runId), 'job.json'), backup = path.join(b.run(runId), 'job.backup');
  await fs.rename(journalFile, backup);
  await fs.mkdir(journalFile);
  assert.equal((await b.plugin('/complete', { id: runId, ok: false, executionStarted: true, error: '\u9996\u4e2a\u7ed3\u679c' })).status, 400);
  assert.equal((await json(path.join(b.run(runId), 'result.json'))).error, '\u9996\u4e2a\u7ed3\u679c');
  assert.equal((await b.status()).active, runId);
  assert.equal((await b.cli('/job', { operation: 'inspect' })).body.code, 'ACTIVE_JOB');
  assert.deepEqual((await fs.readdir(b.run(runId))).filter(name => name.endsWith('.tmp')), []);
  await fs.rmdir(journalFile);
  await fs.rename(backup, journalFile);
  assert.equal((await b.plugin('/complete', { id: runId, ok: true, output: '\u540e\u6765\u7684\u7ed3\u679c' })).status, 200);
  assert.equal((await json(path.join(b.run(runId), 'result.json'))).error, '\u9996\u4e2a\u7ed3\u679c');
  assert.equal((await json(journalFile)).state, 'failed');
  assert.equal((await b.status()).active, null);
});

test('/complete allows 72 MiB for images and binaries; other routes allow 16 MiB', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const tooBig = await b.cli('/job', { operation: 'inspect', pad: 'a'.repeat(16 * MiB) });
  assert.equal(tooBig.status, 413);
  assert.deepEqual((await b.status()).jobs, []);
  const job = await b.deliver({ operation: 'inspect' });
  assert.equal((await b.plugin('/complete', { id: job.id, ok: true, output: 'a'.repeat(17 * MiB) })).status, 200);
  assert.equal((await json(path.join(b.run(job.id), 'result.json'))).output.length, 17 * MiB);
});

// -- Persisted evidence ---------------------------------------------------
test('Preview images use ordinal and node names; binary placeholders become files, before stays in checkpoints, and after is retained only for post-execution failures', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const red = png(2, 2, RED), blue = png(3, 1, BLUE);
  const preview = await b.deliver({ operation: 'preview', targetNodeId: '1:3', nodes: ['1:3', '1:4'] });
  const swapped = await b.plugin('/complete', { id: preview.id, ok: true, images: [{ nodeId: '1:4', name: '\u8272\u5757', base64: b64(blue) }, { nodeId: '1:3', name: '\u6807\u9898', base64: b64(red) }] });
  assert.equal(swapped.status, 400, 'Images for nodes other than those requested must not be persisted');
  assert.equal(await exists(path.join(b.run(preview.id), 'result.json')), false);
  await b.plugin('/complete', { id: preview.id, ok: true, images: [{ nodeId: '1:3', name: '\u6807\u9898', base64: b64(red) }, { nodeId: '1:4', name: '\u8272\u5757', base64: b64(blue) }], bindingVerified: verified('1:3') });
  const images = (await json(path.join(b.run(preview.id), 'result.json'))).images;
  for (const [i, [nodeId, bytes, width, height, color]] of [['1:3', red, 2, 2, '#FF0000'], ['1:4', blue, 3, 1, '#0000FF']].entries()) {
    const image = images[i];
    assert.equal(image.file, `images/${i + 1}-${nodeId.replace(':', '-')}.png`);
    assert.deepEqual(await fs.readFile(path.join(b.run(preview.id), image.file)), bytes);
    assert.deepEqual([image.nodeId, image.bytes, image.sha256, image.width, image.height, image.pixels.dominant.color], [nodeId, bytes.length, sha256(bytes), width, height, color]);
    assert.equal(image.base64, undefined);
  }

  const pdf = Buffer.from('%PDF-1.4\n');
  const binary = await b.finish(RUN, { ok: true, executionStarted: true, binaries: [b64(red), b64(pdf)],
    output: { chart: { __figmaAgentControlBinary: 0 }, list: [{ __figmaAgentControlBinary: 1 }], bad: { __figmaAgentControlBinary: 5 } } });
  const { chart, list: [doc], bad } = binary.result.output;
  assert.deepEqual([chart.file, chart.type, chart.bytes, chart.sha256, chart.width, chart.height], ['files/output-1.png', 'png', red.length, sha256(red), 2, 2]);
  assert.deepEqual(await fs.readFile(path.join(b.run(binary.id), chart.file)), red);
  assert.deepEqual([doc.file, doc.type, doc.sha256], ['files/output-2.pdf', 'pdf', sha256(pdf)]);
  assert.deepEqual(bad, { binaryUnavailable: true });
  assert.ok(binary.result.binaryErrors.length > 0, 'Invalid placeholders are recorded in binaryErrors');
  assert.equal(binary.result.ok, true, 'Binary problems do not change the script result');
  assert.equal(binary.result.binaries, undefined);

  const before = { id: '1:2', name: '\u753b\u677f', children: [{ id: '1:3', name: '\u6807\u9898', characters: '\u539f\u6587' }] };
  const after = { id: '1:2', name: '\u753b\u677f', children: [{ id: '1:3', name: '\u6807\u9898', characters: '\u65b0\u6587' }] };
  const done = (await b.finish(RUN, { ok: true, executionStarted: true, output: null, before, after })).result;
  assert.deepEqual([done.before, done.after], [undefined, undefined]);
  assert.equal(done.changes.counts.updated, 1);
  assert.deepEqual(done.changes.nodes, [{ id: '1:3', name: '\u6807\u9898', change: 'updated', keys: ['characters'] }]);
  const partial = (await b.finish(RUN, { ok: false, executionStarted: true, error: '\u811a\u672c\u4e2d\u9014\u629b\u9519', before, after })).result;
  assert.deepEqual([partial.before, partial.after], [undefined, after]);
  const early = (await b.finish(RUN, { ok: false, executionStarted: false, error: 'Syntax error', before, after })).result;
  assert.equal(early.after, undefined);
});

test('Visual verification persists before/after/diff images, computes pass from tolerance, and reports missing renders without changing ok', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const white = png(2, 2, WHITE), red = png(2, 2, RED), wide = png(3, 2, WHITE);
  const cases = [
    ['Changed pixels satisfy expect changed', { expect: 'changed' }, white, red, { pass: true, changedPixels: 4, tolerance: 0, sameSize: true }],
    ['Changed pixels within tolerance count as unchanged', { expect: 'changed', tolerance: 4 }, white, red, { pass: false, changedPixels: 4, tolerance: 4, sameSize: true }],
    ['Identical images satisfy expect unchanged', { expect: 'unchanged' }, white, white, { pass: true, changedPixels: 0, tolerance: 0, sameSize: true }],
    ['Different sizes count as changed', { expect: 'unchanged' }, white, wide, { pass: false, changedPixels: 0, tolerance: 0, sameSize: false }]
  ];
  for (const [name, expect, beforeImage, afterImage, want] of cases) {
    const { id, result } = await b.finish({ ...RUN, ...expect }, { ok: true, executionStarted: true, output: null, renders: { before: b64(beforeImage), after: b64(afterImage) } });
    const { verify } = result;
    assert.equal(result.ok, true, name);
    assert.equal(result.renders, undefined, name);
    assert.deepEqual({ pass: verify.pass, changedPixels: verify.changedPixels, tolerance: verify.tolerance, sameSize: verify.sameSize }, want, name);
    assert.equal(verify.expect, expect.expect, name);
    assert.deepEqual(verify.images, { before: 'images/render-before.png', after: 'images/render-after.png', diff: 'images/render-diff.png' }, name);
    assert.deepEqual(await fs.readFile(path.join(b.run(id), verify.images.before)), beforeImage, name);
    assert.deepEqual(await fs.readFile(path.join(b.run(id), verify.images.after)), afterImage, name);
    if (verify.changedPixels) assert.deepEqual([...decodePng(await fs.readFile(path.join(b.run(id), verify.images.diff))).data.subarray(0, 4)], [255, 0, 0, 255], 'Changed pixels are red');
  }

  const missing = await b.finish({ ...RUN, expect: 'changed' }, { ok: true, executionStarted: true, output: 7 });
  assert.deepEqual([missing.result.ok, missing.result.output], [true, 7]);
  // Unavailable verification contains only expect, tolerance, pass:false, and error; no pixel statistics or images.
  assert.deepEqual(missing.result.verify, { expect: 'changed', tolerance: 0, pass: false, error: missing.result.verify.error });
  assert.match(missing.result.verify.error, /^Visual check unavailable: /);
  assert.equal(await exists(path.join(b.run(missing.id), 'images', 'render-before.png')), false);
  const exportFailed = await b.finish({ ...RUN, expect: 'changed' }, { ok: true, executionStarted: true, output: null, renders: { before: b64(white), error: '\u540e\u56fe\u5bfc\u51fa\u5931\u8d25\uff1a\u76ee\u6807\u5df2\u5220\u9664' } });
  assert.match(exportFailed.result.verify.error, /\u540e\u56fe\u5bfc\u51fa\u5931\u8d25\uff1a\u76ee\u6807\u5df2\u5220\u9664/);
  assert.equal(exportFailed.result.verify.pass, false);
  const failedRun = await b.finish({ ...RUN, expect: 'changed' }, { ok: false, executionStarted: true, error: '\u811a\u672c\u629b\u9519', renders: { before: b64(white), after: b64(red) } });
  assert.equal(failedRun.result.verify, undefined, 'Failed scripts skip visual verification');
});

test('Evidence permissions: .figma-agent-control and runs/<id> use 0700; session.json and before.json use 0600', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const job = await b.deliver(RUN);
  assert.equal((await b.plugin('/checkpoint', { id: job.id, before: { id: '1:2' }, bindingVerified: verified('1:2') })).status, 200);
  const mode = async file => (await fs.stat(file)).mode & 0o777;
  assert.deepEqual({ dir: await mode(b.dir), run: await mode(b.run(job.id)), session: await mode(path.join(b.dir, 'session.json')), before: await mode(path.join(b.run(job.id), 'before.json')) },
    { dir: 0o700, run: 0o700, session: 0o600, before: 0o600 });
});

// -- Shutdown -----------------------------------------------------------
test('Shutdown returns 202 and closes when idle, returns 409 with an active job, and force blocks submissions/delivery while marking undelivered jobs unexecuted without recovery hints', OPTIONS, async t => {
  const b = await fixture(t);
  assert.equal((await b.cli('/shutdown', {})).status, 400, 'force must be a boolean');
  const idle = await b.cli('/shutdown', { force: false });
  assert.deepEqual([idle.status, idle.body.stopping], [202, true]);
  await stopped(b);

  await b.boot();
  await b.poll();
  const active = await b.submit(RUN);
  const refused = await b.cli('/shutdown', { force: false });
  assert.deepEqual([refused.status, refused.body.code, refused.body.active], [409, 'ACTIVE_JOB', active]);

  // Shutdown normally closes immediately after its reply, making the stopping state invisible over HTTP. Block an earlier pipelined request on a FIFO read:
  // shutdown has set stopping=true, but its reply waits behind the earlier response, delaying close and making the stopping window deterministic.
  const held = uuid(7), fifo = path.join(b.run(held), 'job.json');
  await fs.mkdir(b.run(held), { recursive: true });
  execFileSync('mkfifo', [fifo]);
  const frame = (route, body) => { const text = JSON.stringify(body); return `POST ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Session-Token: ${b.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`; };
  const socket = net.connect(b.bridge.port, '127.0.0.1');
  let replies = '';
  socket.on('data', chunk => { replies += chunk; });
  socket.on('error', () => {});
  const socketClosed = new Promise(resolve => socket.on('close', resolve));
  socket.write(frame('/job', { operation: 'inspect', requestId: held }) + frame('/shutdown', { force: true }));
  try {
    let gate;
    for (let i = 0; i < 1000; i++) { gate = await b.cli('/job', { operation: 'inspect' }); if (gate.body.code !== 'ACTIVE_JOB') break; }
    assert.deepEqual([gate.status, gate.body.code], [409, 'BRIDGE_STOPPING']);
    assert.equal((await b.poll()).body, null, 'Queued tasks are not delivered during shutdown');
  } finally {
    // Open nonblocking: succeed immediately if a reader is waiting; retry otherwise, so the test cannot block forever.
    for (let i = 0; i < 1000; i++) {
      try { const handle = await fs.open(fifo, constants.O_WRONLY | constants.O_NONBLOCK); await handle.write('{}'); await handle.close(); break; }
      catch (error) { if (error.code !== 'ENXIO') throw error; await nextTurn(); }
    }
  }
  await socketClosed;
  assert.match(replies, /HTTP\/1\.1 202/);
  await stopped(b);
  // The active task is still queued and was never delivered. Persist an unexecuted failure so it does not become unresolved after restart.
  const undelivered = await json(path.join(b.run(active), 'result.json'));
  assert.deepEqual([undelivered.ok, undelivered.executionStarted], [false, false]);
  assert.equal((await json(path.join(b.run(active), 'job.json'))).state, 'failed');
  assert.equal(await exists(path.join(b.run(active), 'recovery.json')), false);
  // Remove the FIFO before restart: startup scans runs/ and would block forever reading it without a writer.
  await fs.rm(b.run(held), { recursive: true, force: true });
  await b.boot();
  assert.deepEqual((await b.status()).unresolved, []);
});

// -- Unresolved tasks after restart ---------------------------------------
test('Recovery blocks run on unresolved tasks but allows reads; resolve requires a current-session inspect of the original target and never replays the task', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const r1 = (await b.deliver({ ...RUN, targetNodeId: '1:3' })).id;
  // Another task delivered before the crash, with neither a result nor a verification record, is also unresolved.
  const r2 = uuid(2), binding = await json(path.join(b.dir, 'binding.json'));
  await fs.mkdir(b.run(r2));
  await fs.writeFile(path.join(b.run(r2), 'job.json'), JSON.stringify({ id: r2, operation: 'run', code: 'return 2;', targetNodeId: '1:4', risk: { level: 'normal' }, state: 'running', bindingId: binding.id }));
  // A queued, never-delivered task is provably unexecuted: backfill a failure without making it unresolved.
  const r3 = uuid(3);
  await fs.mkdir(b.run(r3));
  await fs.writeFile(path.join(b.run(r3), 'job.json'), JSON.stringify({ id: r3, operation: 'run', code: 'return 3;', risk: { level: 'normal' }, state: 'queued', bindingId: binding.id }));
  const { token: oldToken, pairing } = b;
  await b.restart();

  assert.equal((await json(path.join(b.run(r1), 'recovery.json'))).status, 'unknown-after-disconnect');
  assert.deepEqual([(await json(path.join(b.run(r3), 'result.json'))).executionStarted, (await json(path.join(b.run(r3), 'job.json'))).state], [false, 'failed']);
  assert.equal(b.pairing, pairing, 'Pairing credentials survive restart');
  assert.equal((await b.send('/status', { token: oldToken })).status, 403, 'Previous CLI credentials are invalid');
  assert.deepEqual((await b.status()).unresolved.sort(), [r1, r2].sort());
  assert.equal((await b.poll()).body, null, 'Unresolved tasks are not delivered again');
  const blocked = await b.cli('/job', RUN);
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'REVIEW_REQUIRED']);
  assert.ok(blocked.body.unresolved.includes(r1));
  const stale = (await b.deliver({ operation: 'inspect', targetNodeId: '1:3' })).id;
  await b.restart();

  // Accept a late inspect result from the previous plugin session, but do not allow it as verification.
  assert.deepEqual((await b.status()).unresolved.sort(), [r1, r2].sort(), 'Read-only tasks do not become unresolved');
  await b.poll();
  assert.equal((await b.plugin('/complete', { id: stale, ok: true, output: { id: '1:3' }, bindingVerified: verified('1:3') })).status, 200);
  const resolve = (inspectId, extra = {}) => b.cli('/resolve', { id: r1, inspectId, previousPluginStopped: true, ...extra });
  assert.equal((await resolve(stale)).status, 400, 'inspect belongs to the previous session');
  const parent = await b.finish({ operation: 'inspect' }, { ok: true, output: { id: '1:2' }, bindingVerified: verified('1:2') });
  assert.equal((await resolve(parent.id)).status, 400, 'inspect queries an ancestor instead of the original target');
  const variables = await b.finish({ operation: 'variables', targetNodeId: '1:3' }, { ok: true, output: { id: '1:3' }, bindingVerified: verified('1:3') });
  assert.equal((await resolve(variables.id)).status, 400, 'Task is not inspect');
  const review = await b.submit({ operation: 'inspect', targetNodeId: '1:3' });
  assert.equal((await resolve(review)).status, 400, 'inspect is incomplete');
  await b.poll();
  await b.plugin('/complete', { id: review, ok: true, output: { id: '1:3' }, bindingVerified: verified('1:3') });
  assert.equal((await resolve(review, { previousPluginStopped: false })).status, 400, 'Previous plugin shutdown has not been confirmed');

  const resolved = await resolve(review);
  assert.equal(resolved.status, 200);
  assert.deepEqual([resolved.body.status, resolved.body.inspectId, resolved.body.targetMissing], ['reviewed-without-replay', review, false]);
  assert.deepEqual(await json(path.join(b.run(r1), 'resolution.json')), resolved.body);
  assert.equal(await exists(path.join(b.run(r1), 'result.json')), false, 'The original task is not replayed');
  assert.equal((await json(path.join(b.run(r1), 'job.json'))).state, 'running', 'The original task result remains unknown');
  assert.deepEqual((await b.status()).unresolved, [r2]);
  assert.equal((await b.cli('/job', RUN)).body.code, 'REVIEW_REQUIRED');

  // A missing target is valid verification only with proof that the query ran in the bound file.
  const missing = fileVerified => ({ ok: false, executionStarted: false, targetMissing: true, missingNodeId: '1:4', fileVerified, error: 'Target does not exist' });
  const elsewhere = await b.finish({ operation: 'inspect', targetNodeId: '1:4' }, missing('other'));
  assert.equal((await b.cli('/resolve', { id: r2, inspectId: elsewhere.id, previousPluginStopped: true })).status, 400, 'Missing-target evidence comes from a different file');
  const gone = await b.finish({ operation: 'inspect', targetNodeId: '1:4' }, missing('example'));
  const resolvedMissing = await b.cli('/resolve', { id: r2, inspectId: gone.id, previousPluginStopped: true });
  assert.deepEqual([resolvedMissing.status, resolvedMissing.body.targetMissing], [200, true]);

  assert.deepEqual((await b.status()).unresolved, []);
  await b.finish(RUN, { ok: true, executionStarted: true, output: 3 });
  await b.restart();
  assert.deepEqual((await b.status()).unresolved, [], 'Verification records remain valid across restarts');
});

test('Recovered runs cannot approve or checkpoint; late failures from the old plugin are accepted and clear unresolved state', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const risky = await b.deliver({ ...RUN, risk: { level: 'high', reason: '\u6539\u5171\u4eab\u7ec4\u4ef6' } });
  // An ordinary-risk running task has only the recovered gate left on /checkpoint, independently proving that checkpointing is blocked.
  const plain = uuid(2), binding = await json(path.join(b.dir, 'binding.json'));
  await fs.mkdir(b.run(plain));
  await fs.writeFile(path.join(b.run(plain), 'job.json'), JSON.stringify({ id: plain, operation: 'run', code: 'return 2;', risk: { level: 'normal' }, state: 'running', bindingId: binding.id }));
  await b.restart();
  assert.deepEqual((await b.status()).unresolved.sort(), [risky.id, plain].sort());

  const approve = await b.plugin('/approve', { id: risky.id, scriptHash: risky.scriptHash, approved: true });
  assert.equal(approve.status, 400, JSON.stringify(approve.body));
  assert.equal(await exists(path.join(b.run(risky.id), 'approval.json')), false);
  for (const id of [risky.id, plain]) {
    const r = await b.plugin('/checkpoint', { id, before: { id: '1:2' }, bindingVerified: verified('1:2') });
    assert.equal(r.status, 400, `${id}: ${JSON.stringify(r.body)}`);
    assert.equal(await exists(path.join(b.run(id), 'before.json')), false, id);
  }

  const late = await b.plugin('/complete', { id: risky.id, ok: false, executionStarted: false, error: '\u6865\u63a5\u91cd\u542f\uff0c\u672a\u83b7\u786e\u8ba4' });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  const result = await json(path.join(b.run(risky.id), 'result.json'));
  assert.deepEqual([result.ok, result.executionStarted, result.error], [false, false, '\u6865\u63a5\u91cd\u542f\uff0c\u672a\u83b7\u786e\u8ba4']);
  assert.equal((await json(path.join(b.run(risky.id), 'job.json'))).state, 'failed');
  assert.deepEqual((await b.status()).unresolved, [plain]);
});

test('Recovery accepts resent results with 200 without overwriting existing evidence for tasks absent from session memory', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const { id, result } = await b.finish({ operation: 'inspect' }, { ok: true, output: { id: '1:2' } });
  await b.restart();
  const r = await b.plugin('/complete', { id, ok: false, error: '\u91cd\u53d1\u7684\u53e6\u4e00\u4efd\u7ed3\u679c' });
  assert.deepEqual([r.status, r.body], [200, { received: true }]);
  assert.deepEqual(await json(path.join(b.run(id), 'result.json')), result);
  assert.equal((await json(path.join(b.run(id), 'job.json'))).state, 'done');
});

test('Interrupted read-only tasks do not become unresolved or block run; late results are accepted but cannot resolve a task', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const stale = (await b.deliver({ operation: 'inspect', targetNodeId: '1:3' })).id;
  await b.restart();
  assert.deepEqual((await b.status()).unresolved, []);
  await b.poll();
  const pending = (await b.deliver({ ...RUN, targetNodeId: '1:3' })).id;
  // Restart again: pending becomes unresolved; stale is still a previous-session read task, exposing the resolve provenance restriction.
  await b.restart();
  assert.deepEqual((await b.status()).unresolved, [pending]);
  await b.poll();
  const late = await b.plugin('/complete', { id: stale, ok: true, output: { id: '1:3' }, bindingVerified: verified('1:3') });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal((await json(path.join(b.run(stale), 'result.json'))).output.id, '1:3');
  assert.equal((await json(path.join(b.run(stale), 'job.json'))).state, 'done');
  assert.equal((await b.cli('/resolve', { id: pending, inspectId: stale, previousPluginStopped: true })).status, 400);
  assert.deepEqual((await b.status()).unresolved, [pending]);
  assert.equal(await exists(path.join(b.run(pending), 'resolution.json')), false);
});

test('Recovery starts normally and creates no unresolved task when runs/<id>/ has only a directory or script.js without job.json', OPTIONS, async t => {
  const b = await fixture(t);
  await fs.mkdir(b.run(uuid(1)), { recursive: true });
  await fs.mkdir(b.run(uuid(2)));
  await fs.writeFile(path.join(b.run(uuid(2)), 'script.js'), 'return 1;');
  await b.restart();
  const status = await b.status();
  assert.deepEqual([status.unresolved, status.jobs], [[], []]);
});

// -- Global plugin and credential diagnostics ------------------------------
test('Mismatched plugin credentials return PAIRING_MISMATCH and update status; missing version headers or wrong CLI credentials do not; only authenticated plugin responses include binding and project', OPTIONS, async t => {
  const b = await fixture(t);
  const wrong = 'e'.repeat(64);
  // Simple browser requests and port scans cannot send custom headers: return the same 403 without changing diagnostics.
  assert.equal((await b.send('/heartbeat?client=probe', { token: wrong })).status, 403);
  assert.equal((await b.send('/status', { token: wrong })).status, 403);
  assert.deepEqual((await b.status()).pluginIssues, {});
  const rejected = await b.send('/poll?client=old&file=example', { token: wrong, version: b.bridge.version });
  assert.deepEqual([rejected.status, rejected.body.code, rejected.headers.get('X-Figma-Binding')], [403, 'PAIRING_MISMATCH', null]);
  assert.equal(JSON.stringify(rejected.body).includes(b.pairing), false, 'Credentials are not echoed');
  const { pluginIssues } = await b.status();
  assert.deepEqual(Object.keys(pluginIssues), ['PAIRING_MISMATCH']);
  assert.ok(Math.abs(Date.now() - Date.parse(pluginIssues.PAIRING_MISMATCH)) < 5000);
  const accepted = await b.poll();
  // In Figma the plugin can read only CORS-exposed headers; omitting these would incorrectly report a file mismatch on every check.
  assert.deepEqual(accepted.headers.get('Access-Control-Expose-Headers').split(','), ['X-Figma-Session', 'X-Figma-Binding', 'X-Long-Poll']);
  assert.deepEqual(JSON.parse(accepted.headers.get('X-Figma-Binding')), { fileKey: 'example', nodeId: '1:2', project: path.basename(b.cwd) });
  assert.equal((await b.cli('/status')).headers.get('X-Figma-Binding'), null);
});

test('Global plugins embed pluginToken without project pairing files; identical port/version produces identical files across projects; invalid credentials fail startup and release locks', OPTIONS, async t => {
  const project = async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-bridge-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await init(cwd, FIGMA_URL);
    return cwd;
  };
  const token = 'c'.repeat(64), a = await project(), c = await project();
  const first = await start(a, 0, { pluginToken: token, pollHoldMs: 0 });
  const { port, plugin } = first;
  await first.close();
  const second = await start(c, port, { pluginToken: token, pollHoldMs: 0 });
  // Close explicitly: t.after runs in registration order, so directory cleanup would otherwise precede bridge shutdown.
  try { assert.deepEqual(second.plugin, plugin, 'Switching projects leaves plugin files unchanged, avoiding a Figma reload on install'); }
  finally { await second.close(); }
  assert.deepEqual(JSON.parse(plugin['ui.html'].match(/const config = (\{.*\});/)[1]), { port, token, version: first.version });
  assert.equal(await exists(path.join(root(a), 'pairing.json')), false);
  await assert.rejects(start(a, 0, { pluginToken: 'not-a-token', pollHoldMs: 0 }), /Invalid plugin pairing token/);
  const again = await start(a, 0, { pluginToken: token, pollHoldMs: 0 });
  await again.close();
});

test('Among global plugin instances, only the bound file owns the lease and receives tasks; other files receive binding headers without renewal or delivery', OPTIONS, async t => {
  const b = await fixture(t);
  const id = await b.submit({ operation: 'inspect' }).catch(() => null);
  assert.equal(id, null, 'No instance has connected');
  // An instance in another file arrives first: return no task with binding headers for the panel, without a lease, and record WRONG_FILE.
  const elsewhere = await b.plugin('/poll?client=x&file=other');
  assert.deepEqual([elsewhere.status, elsewhere.body, JSON.parse(elsewhere.headers.get('X-Figma-Binding')).fileKey], [200, null, 'example']);
  assert.equal((await b.plugin('/heartbeat?client=x&file=other')).status, 200);
  const status = await b.status();
  assert.deepEqual([status.connected, Object.keys(status.pluginIssues)], [false, ['WRONG_FILE']]);
  // An instance lacking fileKey also cannot lease. Record its own reason without conflating it with another open file or replacing the existing reason.
  for (const route of ['/poll?client=z&file=', '/poll?client=z']) assert.equal((await b.plugin(route)).body, null, route);
  assert.deepEqual(Object.keys((await b.status()).pluginIssues).sort(), ['NO_FILE_KEY', 'WRONG_FILE']);
  // The bound-file instance arrives next and takes over immediately, without waiting for another lease; only it receives the task.
  assert.equal((await b.plugin('/poll?client=y&file=example')).body, null);
  const queued = await b.submit({ operation: 'inspect' });
  assert.equal((await b.plugin('/poll?client=x&file=other')).body, null, 'An instance in another file cannot receive tasks');
  assert.equal((await b.plugin('/poll?client=y&file=example')).body.id, queued);
});

test('A heartbeat for another project returns 409 FOREIGN_JOB without lease renewal; known tasks, including recovered ones, heartbeat normally', OPTIONS, async t => {
  const b = await fixture(t);
  const foreign = await b.plugin(`/heartbeat?client=x&file=example&job=${uuid(9)}`);
  assert.deepEqual([foreign.status, foreign.body.code], [409, 'FOREIGN_JOB']);
  assert.deepEqual([(await b.status()).connected, Object.keys((await b.status()).pluginIssues)], [false, ['FOREIGN_JOB']]);
  await b.poll();
  const job = await b.deliver({ operation: 'run', code: 'return 1;' });
  assert.equal((await b.plugin(`/heartbeat?client=plugin&file=example&job=${job.id}`)).status, 200);
  await b.restart();
  assert.equal((await b.plugin(`/heartbeat?client=plugin&file=example&job=${job.id}`)).status, 200, 'Recovered tasks still belong to this project');
  assert.equal((await b.plugin('/complete', { id: job.id, ok: true, output: 1 })).status, 200);
});

test('Non-ASCII project names with CJK, accents, and emoji work; binding headers stay ASCII and round-trip exactly', OPTIONS, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-bridge-'));
  let bridge;
  // Close the bridge before deleting the directory: t.after runs in registration order.
  t.after(async () => { await bridge?.close(); await fs.rm(parent, { recursive: true, force: true }); });
  const cwd = path.join(parent, '\u8bbe\u8ba1\u7a3f caf\u00e9 \ud83c\udfa8');
  await fs.mkdir(cwd);
  await init(cwd, FIGMA_URL);
  const token = 'a'.repeat(64);
  bridge = await start(cwd, 0, { pollHoldMs: 0, pluginToken: token });
  const r = await send(bridge.port, '/poll?client=plugin&file=example', { token, version: bridge.version });
  const header = r.headers.get('X-Figma-Binding');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(header, /^[\x20-\x7e]+$/);
  assert.equal(JSON.parse(header).project, '\u8bbe\u8ba1\u7a3f caf\u00e9 \ud83c\udfa8');
});

// -- Long polling ---------------------------------------------------------
test('An empty /poll waits, wakes on enqueue, times out with X-Long-Poll, and releases immediately on bridge close', OPTIONS, async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-bridge-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await init(cwd, FIGMA_URL);
  const pairing = 'a'.repeat(64);
  const bridge = await start(cwd, 0, { pollHoldMs: 300, pluginToken: pairing });
  let closed = false;
  t.after(async () => { if (!closed) await bridge.close(); });
  const { token } = await json(path.join(root(cwd), 'session.json'));
  const url = route => `http://127.0.0.1:${bridge.port}${route}`;
  const poll = () => fetch(url('/poll?client=plugin&visibility=hidden&file=example'), { headers: { 'X-Session-Token': pairing, 'X-Plugin-Version': bridge.version } });

  let started = performance.now();
  const empty = await poll();
  assert.ok(performance.now() - started >= 250, 'An empty poll waits');
  assert.deepEqual([empty.status, await empty.json(), empty.headers.get('X-Long-Poll')], [200, null, '1']);

  const held = poll();
  await new Promise(resolve => setTimeout(resolve, 50));
  started = performance.now();
  const submitted = await fetch(url('/job'), { method: 'POST', headers: { 'X-Session-Token': token }, body: JSON.stringify({ operation: 'inspect' }) });
  assert.equal(submitted.status, 202, 'A pending poll keeps the connection fresh');
  const claimed = await held;
  assert.ok(performance.now() - started < 250, 'Enqueue wakes the poll before its timeout');
  assert.deepEqual([(await claimed.json()).id, claimed.headers.get('X-Long-Poll')], [(await submitted.json()).id, null]);

  await fetch(url('/complete'), { method: 'POST', headers: { 'X-Session-Token': pairing, 'X-Plugin-Version': bridge.version }, body: JSON.stringify({ id: (await (await fetch(url('/status'), { headers: { 'X-Session-Token': token } })).json()).active, ok: true, output: {} }) });
  const pending = poll();
  await new Promise(resolve => setTimeout(resolve, 50));
  started = performance.now();
  closed = true;
  await bridge.close();
  const released = await pending.then(r => r.status, () => 'closed');
  assert.ok(performance.now() - started < 250, 'Closing immediately releases a pending poll');
  assert.ok(released === 200 || released === 'closed', String(released));
});

// ── /status ──────────────────────────────────────────────────────────────
test('/status reports session, connection, active/unresolved tasks, binding, plugin version, and the latest 20 tasks', OPTIONS, async t => {
  const b = await fixture(t);
  const first = await b.cli('/status');
  const session = await json(path.join(b.dir, 'session.json'));
  assert.deepEqual([first.body.sessionId, first.headers.get('x-figma-session'), first.body.pid], [session.sessionId, session.sessionId, process.pid]);
  assert.equal(first.body.pluginVersion, b.bridge.version);
  assert.deepEqual(first.body.binding, await json(path.join(b.dir, 'binding.json')));
  assert.deepEqual([first.body.connected, first.body.connectionState, first.body.pollAgeMs, first.body.active, first.body.unresolved], [false, 'STALE', null, null, []]);

  await b.poll();
  b.clock = 1234;
  const live = await b.status();
  assert.deepEqual([live.connected, live.connectionState, live.pollAgeMs], [true, 'ACTIVE', 1234]);

  const ids = [];
  for (let i = 0; i < 21; i++) ids.push((await b.finish({ operation: 'inspect', ...(i === 20 ? { label: 'probe.js' } : {}) }, { ok: true, output: { id: '1:2' } })).id);
  const queued = await b.submit({ operation: 'inspect' });
  const status = await b.status();
  assert.equal(status.active, queued);
  assert.deepEqual(status.jobs.map(job => job.id), [...ids.slice(2), queued]);
  assert.deepEqual(status.jobs.at(-2), { id: ids[20], operation: 'inspect', state: 'done', label: 'probe.js' });
  assert.deepEqual(status.jobs.at(-1), { id: queued, operation: 'inspect', state: 'queued' });
});

// -- Occupied ports -------------------------------------------------------
test('Occupied ports report EADDRINUSE and a remedy, release the lock, and leave the original listener unaffected', OPTIONS, async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-bridge-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await init(cwd, FIGMA_URL);
  const listener = net.createServer(socket => socket.end());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const { port } = listener.address();
  await assert.rejects(start(cwd, port, { pluginToken: 'a'.repeat(64) }), error => error.code === 'EADDRINUSE' && error.message.includes(String(port)) && error.message.includes('figma-agent-control stop'));
  assert.equal(listener.listening, true);
  assert.equal(await exists(path.join(root(cwd), 'bridge.lock')), false);
  assert.equal(await exists(path.join(root(cwd), 'session.json')), false);
  const bridge = await start(cwd, 0, { pluginToken: 'a'.repeat(64) });
  await bridge.close();
});

// -- Missing plugin templates ---------------------------------------------
test('Missing templates make start report ENOENT without leaving bridge.lock or session.json; restoring them allows startup', OPTIONS, async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-bridge-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await init(cwd, FIGMA_URL);
  // start reads ../plugin/ relative to itself: load bridge from a package copy missing only ui.html.
  const pkg = path.join(cwd, 'pkg'), source = file => fileURLToPath(new URL('../' + file, import.meta.url));
  await fs.cp(source('src/'), path.join(pkg, 'src'), { recursive: true });
  await fs.mkdir(path.join(pkg, 'plugin'));
  await fs.copyFile(source('plugin/main.js'), path.join(pkg, 'plugin', 'main.js'));
  const { start: startCopy } = await import(pathToFileURL(path.join(pkg, 'src', 'bridge.mjs')).href);
  await assert.rejects(startCopy(cwd, 0, { pluginToken: 'a'.repeat(64) }), { code: 'ENOENT' });
  assert.equal(await exists(path.join(root(cwd), 'bridge.lock')), false);
  assert.equal(await exists(path.join(root(cwd), 'session.json')), false);
  await fs.copyFile(source('plugin/ui.html'), path.join(pkg, 'plugin', 'ui.html'));
  const bridge = await startCopy(cwd, 0, { pluginToken: 'a'.repeat(64) });
  await bridge.close();
});
