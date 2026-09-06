/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:fs, node:os, node:path, node:net, node:crypto, node:child_process, node:timers/promises, node:url, ../src/bridge.mjs, ../src/project.mjs, ../src/session.mjs, ../src/png.mjs.
 * [OUTPUT]: Selected original node:test cases and their unchanged fixture setup.
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



// -- Job validation -------------------------------------------------------






// ── requestId ────────────────────────────────────────────────────────────


// -- Submission gates and delivery ----------------------------------------




// -- Checkpoints and high-risk approval ------------------------------------






// -- Completion and commit point ------------------------------------------




// -- Persisted evidence ---------------------------------------------------






// -- Shutdown -----------------------------------------------------------


// -- Unresolved tasks after restart ---------------------------------------










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


// ── /status ──────────────────────────────────────────────────────────────


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
