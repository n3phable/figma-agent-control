/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:path, ../src/bridge.mjs, ../src/project.mjs, ./helpers/bridge.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for bridge; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start } from '../src/bridge.mjs';
import { init, root, json } from '../src/project.mjs';
import { FIGMA_URL, OPTIONS, RUN, uuid, verified, exists, send, fixture } from './helpers/bridge.mjs';

// -- Fixtures -------------------------------------------------------------
const MiB = 1024 * 1024;

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
  const names = n => Array.from({ length: n }, (_, i) => `\u753b\u6846 ${i}`), named = list => ({ operation: 'preview', names: list });
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
    'names on run': { ...RUN, names: ['\u753b\u6846'] },
    'names on inspect': { operation: 'inspect', names: ['\u753b\u6846'] },
    'names with targetNodeId': { ...preview, names: ['\u753b\u6846'] },
    'names with nodes': { operation: 'preview', nodes: ['1:2', '1:3'], names: ['\u753b\u6846'] },
    'empty names array': named([]),
    '51 names': named(names(51)),
    'duplicate names': named(['\u753b\u6846', '\u753b\u6846']),
    'names contain empty string': named(['\u753b\u6846', '']),
    'name exceeds 200 characters': named(['\u5b57'.repeat(201)]),
    'names contain nonstring': named(['\u753b\u6846', 1]),
    'names is not an array': named('\u753b\u6846'),
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
    'non-UUID requestId': { operation: 'inspect', requestId: 'abc' },
    'cleanOnFail on inspect': { operation: 'inspect', cleanOnFail: true },
    'nonboolean cleanOnFail': { ...RUN, cleanOnFail: 'true' }
  };
  const accepted = {
    'minimal run': RUN,
    '20 libraries totaling exactly 2 MiB': { ...RUN, libs: [lib('big', 'a'.repeat(2 * MiB - 19)), ...Array.from({ length: 19 }, (_, i) => lib(`l${i}`, 'a'))] },
    'snapshotDepth 1（run）': { ...RUN, snapshotDepth: 1 },
    'snapshotDepth 31（inspect）': { operation: 'inspect', snapshotDepth: 31 },
    '2 nodes': { ...preview, nodes: ['1:3', '1:4'] },
    '50 nodes': { ...preview, nodes: nodes(50) },
    '1 name': named(['\u9996\u9875 · 1440']),
    '50 names': named(names(50)),
    '200-character name': named(['\u5b57'.repeat(200)]),
    'scale 0.1（preview）': { ...preview, scale: 0.1 },
    'scale 4 on run with expect': { ...RUN, expect: 'changed', scale: 4 },
    'data exactly 1 MiB': { ...RUN, data: 'a'.repeat(MiB - 2) },
    'expect unchanged with tolerance 0': { ...RUN, expect: 'unchanged', tolerance: 0 },
    'high risk with reason': { ...RUN, risk: { level: 'high', reason: '\u8c03\u6574\u5171\u4eab\u7ec4\u4ef6' } },
    'instance descendant target': { operation: 'inspect', targetNodeId: 'I1:2;3:4' },
    'variables': { operation: 'variables' },
    'UUID requestId': { operation: 'inspect', requestId: uuid(9) },
    'cleanOnFail（run）': { ...RUN, cleanOnFail: true },
    'cleanOnFail false': { ...RUN, cleanOnFail: false }
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
    targetNodeId: { targetNodeId: '1:4' }, risk: { risk: { level: 'normal' } }, cleanOnFail: { cleanOnFail: true } };
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

test('Preview names participate in requestId comparison: changed names/order, nodes substitution, or names omission are rejected', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const named = { operation: 'preview', requestId: uuid(1), names: ['\u6807\u9898', '\u8272\u5757'] };
  assert.equal((await b.cli('/job', named)).status, 202);
  assert.deepEqual(await b.cli('/job', named).then(r => [r.status, r.body.id, r.body.reused]), [200, uuid(1), true]);
  for (const change of [{ names: ['\u6807\u9898'] }, { names: ['\u8272\u5757', '\u6807\u9898'] }, { names: undefined, nodes: ['1:2', '1:3'] }, { names: undefined }])
    assert.equal((await b.cli('/job', { ...named, ...change })).status, 400, JSON.stringify(change));
  assert.deepEqual((await json(path.join(b.run(uuid(1)), 'job.json'))).names, ['\u6807\u9898', '\u8272\u5757']);
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
  const cwd = path.join(parent, '\u8349\u56fe café 🎨');
  await fs.mkdir(cwd);
  await init(cwd, FIGMA_URL);
  const token = 'a'.repeat(64);
  bridge = await start(cwd, 0, { pollHoldMs: 0, pluginToken: token });
  const r = await send(bridge.port, '/poll?client=plugin&file=example', { token, version: bridge.version });
  const header = r.headers.get('X-Figma-Binding');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(header, /^[\x20-\x7e]+$/);
  assert.equal(JSON.parse(header).project, '\u8349\u56fe café 🎨');
});
