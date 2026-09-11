/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:fs, node:os, node:path, ../src/project.mjs, ../src/session.mjs, ../src/connection.mjs, ../src/bridge.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for project session; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTarget, init, readBinding, save, json, isNodeId, isJobId, installPlugin, pluginHome } from '../src/project.mjs';
import { pairingToken, unfinishedOperations, acquireLock } from '../src/session.mjs';
import { createConnection } from '../src/connection.mjs';
import { start } from '../src/bridge.mjs';

// -- Fixtures -------------------------------------------------------------
async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-ps-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const exists = file => fs.access(file).then(() => true, () => false);
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const URL_OK = 'https://www.figma.com/design/abc/Test?node-id=1-2';

// Task evidence under runs/<uuid(n)> defaults to a running run bound to B; overrides construct damaged or completed records.
async function writeRun(dir, n, { job = {}, result, resolution } = {}) {
  const run = path.join(dir, 'runs', uuid(n));
  const record = { id: uuid(n), operation: 'run', state: 'running', bindingId: 'B', createdAt: '2026-10-06T00:00:00.000Z', claimedAt: '2026-10-06T00:00:01.000Z', ...job };
  await save(path.join(run, 'job.json'), record, true);
  if (result) await save(path.join(run, 'result.json'), { id: uuid(n), ...result }, true);
  if (resolution) await save(path.join(run, 'resolution.json'), { id: uuid(n), bindingId: 'B', inspectId: uuid(900 + n), status: 'reviewed-without-replay', previousPluginStopped: true, ...resolution });
  return { run, job: record };
}
const readRun = (dir, n, file) => json(path.join(dir, 'runs', uuid(n), file));

// Stub process.kill with per-PID liveness/errors and call recording; t.mock restores it. onProbe runs synchronously during probing to model a competitor.
function probe(t, states, onProbe = () => {}) {
  const calls = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    calls.push({ pid, signal });
    onProbe(pid);
    if (states[pid] === 'alive') return true;
    throw Object.assign(Error(String(states[pid])), { code: states[pid] });
  });
  return calls;
}

// -- Bindings -------------------------------------------------------------
test('parseTarget accepts only Figma design/file HTTPS links with node-id and restores node-id hyphens to colons', () => {
  const binding = parseTarget('https://www.figma.com/design/AbC_1-x/Test?node-id=12-34&t=k');
  assert.equal(binding.format, 2);
  assert.equal(binding.fileKey, 'AbC_1-x');
  assert.equal(binding.nodeId, '12:34');
  assert.equal(binding.sourceUrl, 'https://www.figma.com/design/AbC_1-x/Test?node-id=12-34&t=k');
  assert.ok(isJobId(binding.id));
  assert.notEqual(parseTarget(binding.sourceUrl).id, binding.id, 'Each binding has a distinct identity');
  assert.equal(parseTarget('https://figma.com/file/abc?node-id=0%3A1').nodeId, '0:1');
  for (const raw of [
    'http://figma.com/design/abc?node-id=1-2',
    'https://figma.com.evil/design/abc?node-id=1-2',
    'https://api.figma.com/design/abc?node-id=1-2',
    'https://user@figma.com/design/abc?node-id=1-2',
    'https://figma.com:8443/design/abc?node-id=1-2',
    'https://figma.com/proto/abc?node-id=1-2',
    'https://figma.com/design/abc/Test',
    'https://figma.com/design/abc?node-id=1-2-3',
    'https://figma.com/design/abc?node-id=I1-2;3-4',
    'figma.com/design/abc?node-id=1-2'
  ]) assert.throws(() => parseTarget(raw), raw);
});

test('init writes format-2 binding and maintains .gitignore without overwriting existing bindings or creating directories for invalid links', async t => {
  const base = await tmp(t);
  const cases = [[undefined, '.figma-agent-control/\n'], ['node_modules/', 'node_modules/\n.figma-agent-control/\n'], ['dist/\r\n.figma-agent-control/\r\n', 'dist/\r\n.figma-agent-control/\r\n']];
  for (const [i, [before, after]] of cases.entries()) {
    const cwd = path.join(base, String(i));
    await fs.mkdir(cwd);
    if (before !== undefined) await fs.writeFile(path.join(cwd, '.gitignore'), before);
    const { binding } = await init(cwd, URL_OK);
    assert.deepEqual(await readBinding(cwd), binding);
    assert.equal(binding.format, 2);
    assert.equal(await fs.readFile(path.join(cwd, '.gitignore'), 'utf8'), after, JSON.stringify(before));
  }

  const cwd = path.join(base, '0');
  await assert.rejects(init(cwd, 'https://figma.com/design/other/Test?node-id=3-4'), { code: 'EEXIST' });
  assert.equal((await readBinding(cwd)).fileKey, 'abc');
  assert.equal(await fs.readFile(path.join(cwd, '.gitignore'), 'utf8'), '.figma-agent-control/\n');

  const bad = path.join(base, 'bad');
  await fs.mkdir(bad);
  await assert.rejects(init(bad, 'https://figma.com/design/abc/Test'));
  assert.equal(await exists(path.join(bad, '.figma-agent-control')), false);
});

test('Non-format-2 bindings are LEGACY_PROJECT and are rejected before the bridge acquires a lock', async t => {
  const cwd = await tmp(t), dir = path.join(cwd, '.figma-agent-control');
  await assert.rejects(readBinding(cwd), { code: 'ENOENT' });
  for (const format of [undefined, 1, '2']) {
    await save(path.join(dir, 'binding.json'), { id: 'old', fileKey: 'abc', nodeId: '1:2', format });
    await assert.rejects(readBinding(cwd), { code: 'LEGACY_PROJECT' }, String(format));
  }
  await assert.rejects(start(cwd, 0), { code: 'LEGACY_PROJECT' });
  for (const file of ['bridge.lock', 'pairing.json', 'session.json', 'plugin']) assert.equal(await exists(path.join(dir, file)), false, file);
});

// -- Atomic writes --------------------------------------------------------
test('save writes compact single-line or default two-space JSON; serialization/rename failures preserve old contents and leave no temporary file', async t => {
  const dir = path.join(await tmp(t), 'nested'), file = path.join(dir, 'a.json');
  await save(file, { a: [1, 2] }, true);
  assert.equal(await fs.readFile(file, 'utf8'), '{"a":[1,2]}\n');
  await save(file, { a: [1, 2] });
  assert.equal(await fs.readFile(file, 'utf8'), '{\n  "a": [\n    1,\n    2\n  ]\n}\n');

  const loop = {}; loop.self = loop;
  await assert.rejects(save(file, loop), TypeError);
  const taken = path.join(dir, 'taken');
  await fs.mkdir(taken); await fs.writeFile(path.join(taken, 'x'), '');
  await assert.rejects(save(taken, { b: 1 }));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: [1, 2] });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['a.json', 'taken']);
});

test('save removes temporary partial files even on mid-write disk-full failures', async t => {
  const dir = await tmp(t), file = path.join(dir, 'result.json');
  const write = fs.writeFile;
  const failing = t.mock.method(fs, 'writeFile', async (target, data, options) => {
    await write(target, String(data).slice(0, 8), options);
    throw Object.assign(Error('no space left on device'), { code: 'ENOSPC' });
  });
  await assert.rejects(save(file, { output: 'x'.repeat(1000) }), { code: 'ENOSPC' });
  failing.mock.restore();
  assert.deepEqual(await fs.readdir(dir), []);
});

test('Concurrent save/read interleaving exposes only complete versions to readers', async t => {
  const dir = await tmp(t), file = path.join(dir, 'job.json');
  await save(file, { n: 0, pad: '' });
  const writes = Array.from({ length: 30 }, (_, i) => save(file, { n: i + 1, pad: 'x'.repeat((i + 1) * 500) }, i % 2 === 0));
  const reads = Array.from({ length: 60 }, () => json(file).then(value => assert.equal(value.pad.length, value.n * 500)));
  await Promise.all([...writes, ...reads]);
  assert.deepEqual(await fs.readdir(dir), ['job.json']);
});

// -- Identifiers ----------------------------------------------------------
test('isNodeId and isJobId require complete formats and enforce length, instance-chain, case, and path boundaries', () => {
  const chain = 'I1:2' + ';3:4'.repeat(254);
  for (const id of ['0:1', '153:9848', 'I153:9884;150:7584', 'I1:2;3:4;5:6', chain + ';9:9']) assert.equal(isNodeId(id), true, id);
  for (const id of [null, {}, 12, '', '1-2', 'I1:2', '1:2;3:4', 'I1:2;', 'I1:2;I3:4', '../1:2', '1:2/', ' 1:2', '1:2\n', chain + ';9:99']) {
    assert.equal(isNodeId(id), false, JSON.stringify(id));
  }
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(isJobId(id), true);
  for (const bad of [id.toUpperCase(), id.replace(/-/g, ''), id + '0', id + '\n', '../' + id.slice(3), id.replace('0f', 'g0'), null, 1]) {
    assert.equal(isJobId(bad), false, JSON.stringify(bad));
  }
});

// -- Pairing credentials --------------------------------------------------
test('pairingToken creates stable 64-digit hex with 0600 permissions, resolves concurrent first creation once, and reports corrupt-file path/remedy without silent repair', async t => {
  const dir = await tmp(t), file = path.join(dir, 'pairing.json');
  // Two simultaneous first connects: the loser reads the winner's token without replacing credentials already embedded in the plugin.
  const tokens = await Promise.all(Array.from({ length: 20 }, () => pairingToken(dir)));
  const token = tokens[0];
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.deepEqual(new Set(tokens), new Set([token]));
  assert.deepEqual((await fs.readdir(dir)).sort(), ['pairing.json'], 'No temporary files remain');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.chmod(file, 0o644);
  assert.equal(await pairingToken(dir), token);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  for (const broken of ['{"token":"short"}', '{"tok', 'null']) {
    await fs.writeFile(file, broken);
    await assert.rejects(pairingToken(dir), error => error.code === 'PAIRING_INVALID' && error.message.includes(file) && error.message.includes('figma-agent-control connect'), broken);
    assert.equal(await fs.readFile(file, 'utf8'), broken);
  }
  // A dangling symlink cannot be read and blocks exclusive creation. Fail immediately instead of looping through read/create/read.
  await fs.rm(file);
  await fs.symlink(path.join(dir, 'missing.json'), file);
  await assert.rejects(pairingToken(dir), { code: 'PAIRING_INVALID' });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['pairing.json'], 'No temporary files remain and the symlink is not replaced');
});

// -- Startup recovery -----------------------------------------------------
test('unfinishedOperations repairs completed/queued journals, keeps delivered unverified runs unresolved, allows verified records across bindings, and ignores foreign-binding read tasks', async t => {
  const dir = await tmp(t);
  assert.deepEqual(await unfinishedOperations(dir, 'B'), []);
  const done = await writeRun(dir, 1, { result: { ok: true, output: 42, finishedAt: '2026-10-06T00:00:02.000Z' } });
  await writeRun(dir, 2, { job: { state: 'queued' }, result: { ok: false, error: '\u5931\u8d25', finishedAt: '2026-10-06T00:00:03.000Z' } });
  await writeRun(dir, 3);
  await writeRun(dir, 4, { job: { state: 'queued' } });
  await writeRun(dir, 5, { resolution: {} });
  const finished = await writeRun(dir, 6, { job: { state: 'done' } });
  const otherReviewed = await writeRun(dir, 8, { job: { bindingId: 'OTHER' }, resolution: { bindingId: 'OTHER' } });
  const otherRead = await writeRun(dir, 9, { job: { bindingId: 'OTHER', operation: 'inspect' } });
  await fs.mkdir(path.join(dir, 'runs', 'notes'));
  await fs.writeFile(path.join(dir, 'runs', uuid(7)), '\u4e0d\u662f\u76ee\u5f55');

  const pending = await unfinishedOperations(dir, 'B');
  assert.deepEqual(pending.map(job => job.id), [uuid(3)]);
  assert.ok(pending.every(job => job.recovered === true));
  // queued proves no delivery: backfill an unexecuted failure without creating an unresolved task.
  const undelivered = await readRun(dir, 4, 'result.json');
  assert.deepEqual([undelivered.ok, undelivered.executionStarted, typeof undelivered.finishedAt], [false, false, 'string']);
  assert.match(undelivered.error, /before the job was delivered.*did not run/);
  assert.deepEqual([(await readRun(dir, 4, 'job.json')).state, (await readRun(dir, 4, 'job.json')).finishedAt], ['failed', undelivered.finishedAt]);

  const repaired = await readRun(dir, 1, 'job.json');
  assert.equal(repaired.state, 'done');
  assert.equal(repaired.result, undefined);
  assert.equal(repaired.claimedAt, done.job.claimedAt);
  assert.equal((await readRun(dir, 2, 'job.json')).state, 'failed');
  assert.deepEqual(await readRun(dir, 1, 'result.json'), { id: uuid(1), ok: true, output: 42, finishedAt: '2026-10-06T00:00:02.000Z' });
  assert.equal((await readRun(dir, 5, 'job.json')).state, 'running');
  assert.deepEqual(await readRun(dir, 6, 'job.json'), finished.job);
  assert.deepEqual([await readRun(dir, 8, 'job.json'), await readRun(dir, 9, 'job.json')], [otherReviewed.job, otherRead.job]);
});

test('Backfilled job.json matches normal completion by taking finishedAt from result.json', async t => {
  const dir = await tmp(t);
  await writeRun(dir, 1, { result: { ok: true, finishedAt: '2026-10-06T00:00:02.000Z' } });
  await unfinishedOperations(dir, 'B');
  assert.equal((await readRun(dir, 1, 'job.json')).finishedAt, '2026-10-06T00:00:02.000Z');
});

test('unfinishedOperations fails startup for corrupt or foreign-binding records without ignoring or rewriting them', async t => {
  const base = await tmp(t);
  const cases = [
    [/Job record is corrupt/, { job: { id: uuid(99) } }],
    [/Job result is corrupt/, { result: { id: uuid(98), ok: true } }],
    [/Job result is corrupt/, { result: { ok: 'yes' } }],
    [/verification record is corrupt/, { resolution: { previousPluginStopped: false } }],
    [/another target/, { job: { bindingId: 'OTHER' } }]
  ];
  for (const [i, [message, options]] of cases.entries()) {
    const dir = path.join(base, String(i));
    const { job } = await writeRun(dir, 1, options);
    await assert.rejects(unfinishedOperations(dir, 'B'), message);
    assert.deepEqual(await readRun(dir, 1, 'job.json'), job);
  }
});

// -- Global plugin directory ----------------------------------------------
test('installPlugin rewrites only changed content to avoid unnecessary Figma reloads, using atomic 0600 writes without temporary leftovers', async t => {
  const home = await tmp(t), dir = path.join(home, 'plugin');
  const files = { 'manifest.json': '{"name":"Figma Agent Control"}\n', 'main.js': 'main', 'ui.html': 'ui' };
  assert.deepEqual(await installPlugin(home, files), { manifest: path.join(dir, 'manifest.json'), changed: true });
  const mtime = name => fs.stat(path.join(dir, name)).then(stat => stat.mtimeMs);
  const before = await mtime('main.js');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await installPlugin(home, files)).changed, false);
  assert.equal((await installPlugin(home, { ...files, 'ui.html': 'ui2' })).changed, true);
  assert.equal(await fs.readFile(path.join(dir, 'ui.html'), 'utf8'), 'ui2');
  assert.equal(await mtime('main.js'), before, 'Unchanged files are not rewritten');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['main.js', 'manifest.json', 'ui.html']);
  assert.equal((await fs.stat(path.join(dir, 'ui.html'))).mode & 0o777, 0o600);
});

test('pluginHome prefers FIGMA_AGENT_CONTROL_HOME and defaults to ~/.config/figma-agent-control, distinct from project .figma-agent-control', t => {
  const saved = process.env.FIGMA_AGENT_CONTROL_HOME;
  t.after(() => { if (saved === undefined) delete process.env.FIGMA_AGENT_CONTROL_HOME; else process.env.FIGMA_AGENT_CONTROL_HOME = saved; });
  process.env.FIGMA_AGENT_CONTROL_HOME = '/tmp/figma-agent-control-home';
  assert.equal(pluginHome(), '/tmp/figma-agent-control-home');
  delete process.env.FIGMA_AGENT_CONTROL_HOME;
  assert.equal(pluginHome(), path.join(os.homedir(), '.config', 'figma-agent-control'));
});

// -- Single-instance locks ------------------------------------------------
test('Only one concurrent acquireLock succeeds; live/EPERM PIDs return BRIDGE_RUNNING, while invalid PIDs are neither probed nor cleaned', async t => {
  const dir = await tmp(t), file = path.join(dir, 'bridge.lock');
  await writeRun(dir, 1);
  const calls = probe(t, { [process.pid]: 'alive', 4242: 'EPERM', 4343: 'alive' });

  const results = await Promise.allSettled([acquireLock(dir), acquireLock(dir)]);
  const winners = results.filter(r => r.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(winners[0].value.recovered, null);
  assert.equal(await fs.readFile(file, 'utf8'), String(process.pid));
  await winners[0].value.lock.close();

  const running = { code: 'BRIDGE_RUNNING' }, invalid = /Invalid PID/;
  for (const [raw, expected] of [['4242', running], ['4343', running], ['', running], ['0', invalid], ['-1', invalid], ['1.5', invalid], ['abc', invalid], ['99999999999999999999', invalid]]) {
    await fs.writeFile(file, raw);
    await assert.rejects(acquireLock(dir), expected, raw);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
  assert.equal(await exists(path.join(dir, 'recoveries')), false);
  assert.equal(await exists(path.join(dir, 'runs', uuid(1), 'recovery.json')), false);
  assert.deepEqual(calls.filter(c => c.pid !== process.pid), [{ pid: 4242, signal: 0 }, { pid: 4343, signal: 0 }]);
  assert.ok(calls.every(c => c.signal === 0));
});

test('Stale ESRCH locks archive to recoveries/<id>; delivered unfinished tasks require document review and stay unresolved, while undelivered tasks are marked unexecuted', async t => {
  const dir = await tmp(t), file = path.join(dir, 'bridge.lock');
  const open = await writeRun(dir, 1);
  await writeRun(dir, 2, { job: { state: 'queued' } });
  await writeRun(dir, 3, { result: { ok: true, finishedAt: '2026-10-06T00:00:02.000Z' } });
  await writeRun(dir, 4, { resolution: {} });
  await fs.writeFile(file, '4242\n');
  const calls = probe(t, { 4242: 'ESRCH' });

  const { lock, recovered } = await acquireLock(dir);
  t.after(() => lock.close());
  assert.ok(isJobId(recovered.recoveryId));
  assert.deepEqual(recovered.unfinished, [uuid(1)]);
  assert.equal(await fs.readFile(path.join(dir, 'recoveries', recovered.recoveryId, 'bridge.lock'), 'utf8'), '4242\n');
  assert.equal(await fs.readFile(file, 'utf8'), String(process.pid));

  const recovery = await readRun(dir, 1, 'recovery.json');
  assert.deepEqual([recovery.status, recovery.recordedState, recovery.recoveryId], ['needs-document-review', 'running', recovered.recoveryId]);
  assert.deepEqual([(await readRun(dir, 2, 'job.json')).state, (await readRun(dir, 2, 'result.json')).executionStarted], ['failed', false]);
  for (const n of [2, 3, 4]) assert.equal(await exists(path.join(dir, 'runs', uuid(n), 'recovery.json')), false, String(n));
  assert.equal((await readRun(dir, 3, 'job.json')).state, 'done');
  assert.deepEqual(await readRun(dir, 1, 'job.json'), open.job, 'Original evidence is untouched and the result remains unknown');
  assert.deepEqual((await unfinishedOperations(dir, 'B')).map(job => job.id), [uuid(1)]);
  assert.deepEqual(calls, [{ pid: 4242, signal: 0 }]);
});

test('Stale-lock recovery must not archive a new lock already acquired by a competing bridge', async t => {
  const dir = await tmp(t), file = path.join(dir, 'bridge.lock');
  await fs.writeFile(file, '4242');
  // After reading the old PID but before archiving, a competitor finishes recovery by removing the old lock and writing its live PID 5151.
  let raced = false;
  probe(t, { 4242: 'ESRCH', 5151: 'alive' }, pid => {
    if (pid !== 4242 || raced) return;
    raced = true;
    fsSync.renameSync(file, path.join(dir, 'competitor-archive.lock'));
    fsSync.writeFileSync(file, '5151', { flag: 'wx' });
  });
  const outcome = await acquireLock(dir).then(async ({ lock }) => { await lock.close(); return 'acquired'; }, error => error.code);
  assert.notEqual(outcome, 'acquired', 'Two bridges both believe they hold bridge.lock');
  assert.equal(outcome, 'BRIDGE_RUNNING');
  assert.equal(await fs.readFile(file, 'utf8'), '5151');
});

test('An existing takeover marker returns BRIDGE_RUNNING without archiving even for exited lock PIDs; successful recovery removes the marker', async t => {
  const dir = await tmp(t), file = path.join(dir, 'bridge.lock'), takeover = file + '.takeover';
  await writeRun(dir, 1);
  await fs.writeFile(file, '4242');
  await fs.writeFile(takeover, '');
  probe(t, { 4242: 'ESRCH' });

  await assert.rejects(acquireLock(dir), { code: 'BRIDGE_RUNNING' });
  assert.equal(await fs.readFile(file, 'utf8'), '4242');
  assert.equal(await exists(takeover), true, 'The marker belongs to another recovering process and must not be removed by the loser');
  assert.equal(await exists(path.join(dir, 'recoveries')), false);
  assert.equal(await exists(path.join(dir, 'runs', uuid(1), 'recovery.json')), false);

  await fs.unlink(takeover);
  const { lock, recovered } = await acquireLock(dir);
  t.after(() => lock.close());
  assert.deepEqual(recovered.unfinished, [uuid(1)]);
  assert.equal(await fs.readFile(file, 'utf8'), String(process.pid));
  assert.equal(await exists(takeover), false, 'Recovery must remove its marker or all later connects will be rejected');
});

// -- Connection leases ----------------------------------------------------
// Explicitly set the undocumented foreground lease to 15 s; use the default background lease to verify the documented 90 s.
test('A new instance takes over only after lease expiry; the displaced instance is permanently retired', () => {
  let clock = 0;
  const c = createConnection({ now: () => clock, timeoutMs: 15000 });
  assert.deepEqual([c.connected, c.state, c.ageMs, c.owns('a')], [false, 'STALE', null, false]);
  assert.equal(c.touch('a', false).ok, true);
  assert.equal(c.state, 'ACTIVE');
  clock = 14999;
  assert.equal(c.touch('b', false).code, 'CONNECTION_IN_USE');
  assert.equal(c.owns('a'), true);
  clock = 15000;
  assert.deepEqual([c.connected, c.state, c.owns('a')], [false, 'STALE', false]);
  assert.equal(c.touch('b', false).ok, true);
  assert.equal(c.owns('b'), true);
  clock = 60000;
  assert.equal(c.touch('a', false).code, 'RETIRED_CLIENT');
  assert.equal(c.touch('b', false).ok, true, 'The original owner can renew after expiry');
  clock = 75000;
  assert.equal(c.touch('c', false).ok, true);
  assert.equal(c.touch('b', false).code, 'RETIRED_CLIENT');
});

test('An active task prevents lease transfer, rejection does not refresh it, and the original instance can renew at any time', () => {
  let clock = 0;
  const c = createConnection({ now: () => clock, timeoutMs: 15000 });
  c.touch('a', false);
  clock = 60000;
  assert.equal(c.touch('b', true).code, 'OPERATION_UNCERTAIN');
  assert.deepEqual([c.ageMs, c.connected, c.owns('b')], [60000, false, false]);
  assert.equal(c.touch('a', true).ok, true);
  assert.deepEqual([c.ageMs, c.owns('a')], [0, true]);
  clock = 75000;
  assert.equal(c.touch('b', false).ok, true, 'After the task ends, the rejected instance remains eligible to take over an expired lease');
});

test('Hidden panels use a 90 s background lease and return to the foreground lease when visible', () => {
  let clock = 0;
  const c = createConnection({ now: () => clock, timeoutMs: 15000 });
  c.touch('a', false, 'hidden');
  clock = 89999;
  assert.deepEqual([c.connected, c.state, c.ageMs], [true, 'BACKGROUND', 89999]);
  assert.equal(c.touch('b', false).code, 'CONNECTION_IN_USE');
  clock = 90000;
  assert.equal(c.state, 'STALE');
  assert.equal(c.touch('a', false, 'visible').ok, true);
  assert.equal(c.state, 'ACTIVE');
  clock = 105000;
  assert.equal(c.state, 'STALE');
  assert.equal(c.touch('b', false).ok, true);
  assert.equal(c.touch('a', false, 'hidden').code, 'RETIRED_CLIENT');
});

test('Invalid client or visibility values are rejected without changing lease or ownership', () => {
  let clock = 0;
  const c = createConnection({ now: () => clock, timeoutMs: 15000 });
  for (const client of [null, undefined, 42, '', 'x'.repeat(161)]) assert.equal(c.touch(client, false).code, 'INVALID_CLIENT', String(client).slice(0, 8));
  assert.equal(c.ageMs, null);
  const owner = 'x'.repeat(160);
  assert.equal(c.touch(owner, false).ok, true);
  clock = 20000;
  for (const visibility of ['prerender', '', 'HIDDEN']) assert.equal(c.touch('b', false, visibility).code, 'INVALID_VISIBILITY', visibility);
  assert.equal(c.ageMs, 20000);
  assert.equal(c.touch(owner, false, 'bogus').code, 'INVALID_VISIBILITY');
  assert.equal(c.ageMs, 20000);
  assert.equal(c.touch(owner, false).ok, true, 'Invalid requests do not retire the original instance');
});
