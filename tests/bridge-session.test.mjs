/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:fs, node:os, node:path, node:net, node:crypto, node:child_process, node:timers/promises, node:url, ../src/bridge.mjs, ../src/project.mjs, ../src/png.mjs, ./helpers/bridge.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for bridge session; tests use local synthetic inputs and isolated state.
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
import { encodePng, decodePng } from '../src/png.mjs';
import { FIGMA_URL, OPTIONS, RUN, uuid, verified, exists, fixture } from './helpers/bridge.mjs';

// -- Fixtures -------------------------------------------------------------
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const WHITE = [255, 255, 255], RED = [255, 0, 0], BLUE = [0, 0, 255];
const png = (w, h, rgb) => encodePng(w, h, new Uint8Array(Array.from({ length: w * h }, () => [...rgb, 255]).flat()));
const b64 = bytes => Buffer.from(bytes).toString('base64');

// After /shutdown replies, wait for the lock release (the last close step). Do not call bridge.close(), so shutdown itself must close the bridge.
async function stopped(b) {
  const lock = path.join(b.dir, 'bridge.lock');
  for (let i = 0; i < 5000 && await exists(lock); i++) await nextTurn();
  assert.equal(await exists(lock), false, 'The bridge did not close itself after shutdown');
  assert.equal(await exists(path.join(b.dir, 'session.json')), false);
  await assert.rejects(fetch(`http://127.0.0.1:${b.bridge.port}/status`));
}

// -- Persisted evidence ---------------------------------------------------
test('Named previews validate image count, names, and node IDs; images use resolved IDs and job.json stores only names', OPTIONS, async t => {
  const b = await fixture(t);
  await b.poll();
  const red = png(2, 2, RED), image = (name, nodeId) => ({ nodeId, name, base64: b64(red) });
  const job = await b.deliver({ operation: 'preview', names: ['\u9996\u9875 · 1440', '\u8272\u5757'] });
  for (const images of [
    [image('\u9996\u9875 · 1440', '30:7')],
    [image('\u8272\u5757', '1:4'), image('\u9996\u9875 · 1440', '30:7')],
    [image('\u9996\u9875 · 1440', '../30:7'), image('\u8272\u5757', '1:4')],
    [image('\u9996\u9875 · 1440', '30:7'), image('\u8272\u5757 ', '1:4')],
  ]) assert.equal((await b.plugin('/complete', { id: job.id, ok: true, images, bindingVerified: verified('1:2') })).status, 400, JSON.stringify(images.map(i => [i.name, i.nodeId])));
  assert.equal(await exists(path.join(b.run(job.id), 'result.json')), false);
  const ok = await b.plugin('/complete', { id: job.id, ok: true, images: [image('\u9996\u9875 · 1440', '30:7'), image('\u8272\u5757', '1:4')], bindingVerified: verified('1:2') });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const result = await json(path.join(b.run(job.id), 'result.json')), saved = await json(path.join(b.run(job.id), 'job.json'));
  assert.deepEqual(result.images.map(i => [i.nodeId, i.name, i.file]), [['30:7', '\u9996\u9875 · 1440', 'images/1-30-7.png'], ['1:4', '\u8272\u5757', 'images/2-1-4.png']]);
  assert.deepEqual([saved.names, saved.targetNodeId, saved.nodes], [['\u9996\u9875 · 1440', '\u8272\u5757'], undefined, undefined]);
});

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
  const early = (await b.finish(RUN, { ok: false, executionStarted: false, error: '\u8bed\u6cd5\u9519\u8bef', before, after })).result;
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

// -- Shutdown -------------------------------------------------------------
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
  const missing = fileVerified => ({ ok: false, executionStarted: false, targetMissing: true, missingNodeId: '1:4', fileVerified, error: '\u76ee\u6807\u4e0d\u5b58\u5728' });
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
