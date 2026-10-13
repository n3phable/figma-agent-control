/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:path, node:child_process, node:util, ../src/clean.mjs, ../src/record.mjs, ../src/project.mjs, ./helpers/plugin.mjs, ./helpers/harness.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for clean; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLEAN_SCRIPT } from '../src/clean.mjs';
import { summarizeRecord, exitCode } from '../src/record.mjs';
import { root, save, init } from '../src/project.mjs';
import { plugin } from './helpers/plugin.mjs';
import { harness, writeScript, cliFile } from './helpers/harness.mjs';

const exec = promisify(execFile);
const ID = '12345678-1234-1234-1234-123456789012';
const entry = (n, parentId = '1:1', size = 0) => ({ id: n.id, name: n.name, type: n.type, parentId, size });
const brief = ({ id, name, type }) => ({ id, name, type });

// -- Plugin: created-node ancestry, subtree size, and cleanup revalidation ---
test('created records parents and own subtree sizes excluding instance internals; leaf nodes without findAll count as 0; cleanup deletes unchanged nodes, skips changed/moved/legacy records, marks missing nodes gone, and is repeat-safe', async () => {
  const f = plugin();
  // Real leaf nodes such as RECTANGLE and TEXT lack findAll. Remove it from the mock to prove mapping does not throw and discard the entire created list.
  const create = f.doc.create;
  f.doc.create = (...args) => { const n = create(...args); if (n.type === 'RECTANGLE') { delete n.findAll; delete n.findOne; } return n; };
  const failed = await f.send({ code: `const a = figma.createFrame(); a.appendChild(figma.createRectangle()); a.children.push({ id: 'I9:1;9:2', type: 'TEXT', name: '\u5b9e\u4f8b\u5185\u90e8', parent: a });
    figma.createFrame(); figma.createFrame().appendChild(figma.createRectangle());
    target.appendChild(figma.createFrame()); figma.createRectangle(); figma.createFrame();
    throw Error("\u4e2d\u9014\u5931\u8d25");` });
  const [a, b, c, d, leaf, m] = ['10:1', '10:3', '10:4', '10:6', '10:7', '10:8'].map(id => f.doc.all.get(id));
  assert.deepEqual(failed.created, [entry(a, '1:1', 1), entry(b), entry(c, '1:1', 1), entry(d, '1:2'), entry(leaf), entry(m)]);
  assert.equal('findAll' in leaf, false);

  // After failure: rename B, add to C, delete D, move M into the frame, leave A and the leaf unchanged; also include legacy record E, cross-page G, and undeletable L.
  b.name = '\u6539\u540d'; f.doc.create('FRAME', c); d.remove(); f.doc.frame.appendChild(m);
  const [e, g, l] = [0, 1, 2].map(() => f.doc.create('FRAME', f.doc.page));
  f.doc.other.appendChild(g);
  l.remove = () => { throw Error('\u8282\u70b9\u5df2\u9501\u5b9a'); };
  const nodes = [...failed.created, brief(e), entry(g), entry(l)];
  const clean = () => f.send({ code: CLEAN_SCRIPT, label: `clean ${ID}`, snapshotDepth: 1, data: { task: ID, pageId: '1:1', nodes } });
  const skipped = [
    { ...brief(failed.created[1]), reason: 'changed to FRAME "\u6539\u540d"' }, { ...brief(failed.created[2]), reason: 'subtree node count 1 -> 2, changed after the failure' },
    { ...brief(failed.created[5]), reason: 'moved to 1:2' }, { ...brief(e), reason: 'the failure record has no parent or subtree size (old plugin version); inspect, then delete manually' },
    { ...brief(g), reason: 'no longer on the page where the failure happened' }, { ...brief(l), reason: 'Error: \u8282\u70b9\u5df2\u9501\u5b9a' }];
  const first = await clean();
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.output, { task: ID, cleaned: [brief(a), brief(leaf)], gone: [brief(d)], skipped });
  assert.deepEqual([first.undoBoundaries, a.removed, f.doc.all.get('10:2').removed, leaf.removed], [{ before: 'committed', after: 'committed' }, true, true, true]);
  const again = await clean();
  assert.deepEqual(again.output, { task: ID, cleaned: [], gone: [brief(a), brief(d), brief(leaf)], skipped });
});

// -- Readback: clean summaries and exit codes -------------------------------
test('Summaries recognize clean by label and data.task: skipped nodes exit 1 and explain separate Undo, no rollback, and safe retry; a same-named script does not count', () => {
  const record = (job, output) => ({ evidence: '/tmp/runs/x', job: { id: 'x', operation: 'run', ...job }, recordedState: 'done', journalComplete: true, instruction: '\u7ed3\u679c\u6765\u81ea\u5df2\u4fdd\u5b58\u8bc1\u636e', result: { id: 'x', ok: true, output } });
  const job = { label: `clean ${ID}`, data: { task: ID } }, item = { id: '10:1', name: 'A', type: 'FRAME' };
  const done = record(job, { task: ID, cleaned: [item], gone: [], skipped: [] }), partial = record(job, { task: ID, cleaned: [], gone: [item], skipped: [{ ...item, reason: 'moved to 1:2' }] });
  assert.deepEqual([exitCode(done), exitCode(partial)], [0, 1]);
  assert.match(summarizeRecord(done).instruction, new RegExp(`^Cleaned up nodes left by job ${ID}: 1 deleted, 0 already gone, 0 skipped; the deletion is a single Undo step; .*undo once in Figma to restore anything deleted by mistake; existing nodes modified by the original job are not rolled back; clean can run again`));
  assert.match(summarizeRecord(partial).instruction, /1 skipped \(reasons in output\.skipped; inspect, then handle them manually\); existing nodes modified by the original job are not rolled back/);
  for (const other of [{ label: 'clean.js', data: { task: ID } }, { label: `clean ${ID}` }, { ...job, operation: 'inspect' }])
    assert.deepEqual([exitCode(record(other, partial.result.output)), summarizeRecord(record(other, partial.result.output)).instruction], [0, '\u7ed3\u679c\u6765\u81ea\u5df2\u4fdd\u5b58\u8bc1\u636e'], JSON.stringify(other));
});

// -- CLI: rejection conditions --------------------------------------------
test('clean rejects missing/local-invalid tasks, non-run or successful/unexecuted/incomplete runs, missing created/checkpoint evidence, and oversized snapshots/data with exit 1 and no submission; an empty list exits 0 without submission', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-clean-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await init(cwd, 'https://www.figma.com/design/example/Test?node-id=1-1');
  const failure = { ok: false, executionStarted: true, error: '\u4e2d\u9014\u5931\u8d25', created: [{ id: '10:1', name: 'A', type: 'FRAME', parentId: '1:1', size: 0 }] };
  const many = (/** @type {number} */ n, parentId = '1:1', name = 'A') => Array.from({ length: n }, (_, i) => ({ id: `10:${i}`, name, type: 'FRAME', parentId, size: 0 }));
  const cases = [
    [{ operation: 'inspect' }, { ok: true }, /it is inspect; only run leaves nodes behind/], [{}, { ok: true }, /the original job succeeded/], [{}, { ok: false, executionStarted: false }, /the script did not run; nothing was left behind/],
    [{}, null, /has no result yet.*through the resolve flow/], [{}, { ok: false, executionStarted: true }, /has no created.*inspect, then handle manually/], [{}, failure, /the checkpoint before\.json is missing/],
    [{}, { ...failure, cleaned: [], cleanFailed: [{ ...failure.created[0], reason: '\u6267\u884c\u524d\u5df2\u5728\u76ee\u6807\u9875\uff0c\u672a\u5220\u9664' }] }, null],
    // Cases below include checkpoints: 2000 direct children exceed the depth-1 snapshot budget; nodes elsewhere do not count, but long names exceed the 1 MiB data limit.
    [{}, { ...failure, created: many(2000) }, /2000 or more nodes in the deletion list sit directly under the bound node.*inspect, then delete manually/, true], [{}, { ...failure, created: many(300, '1:2', 'A'.repeat(4000)) }, /1 MiB data limit/, true],
    [null, null, /no local evidence for this job/]];
  const ids = cases.map((_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  for (const [i, [job, result, , before]] of cases.entries()) {
    const dir = path.join(root(cwd), 'runs', ids[i]);
    if (job) await save(path.join(dir, 'job.json'), { id: ids[i], operation: 'run', state: 'failed', ...job });
    if (result) await save(path.join(dir, 'result.json'), { id: ids[i], ...result });
    if (before) await save(path.join(dir, 'before.json'), { id: ids[i], bindingVerified: { pageId: '1:1' } });
  }
  const before = (await fs.readdir(path.join(root(cwd), 'runs'))).sort();
  for (const [i, [, , message]] of cases.entries()) {
    let code = 0, stdout;
    try { ({ stdout } = await exec(process.execPath, [cliFile, 'clean', ids[i]], { cwd, env: { ...process.env, FIGMA_AGENT_CONTROL_HOME: path.join(cwd, 'plugin-home') } })); }
    catch (error) { ({ code, stdout } = error); }
    const out = JSON.parse(stdout);
    if (message) assert.deepEqual([code, message.test(out.error), out.error.startsWith(`Cannot clean up job ${ids[i]}: `)], [1, true, true], out.error);
    else assert.deepEqual([code, out.task, /Nothing to clean up/.test(out.instruction)], [0, ids[i], true]);
  }
  assert.deepEqual((await fs.readdir(path.join(root(cwd), 'runs'))).sort(), before);
});

// -- CLI: end to end ------------------------------------------------------
test('clean submits a fixed depth-1 run against the bound target; root deletions enter changes, nested ones appear only in output.cleaned, retries report gone, and skipped nodes exit 1 consistently in submit/result/wait', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const leaky = await h.run('run', await writeScript(h.cwd, 'leaky.js', 'target.name = "\u6539\u8fc7"; figma.createFrame(); target.appendChild(figma.createFrame()); throw Error("\u4e2d\u9014\u5931\u8d25");'));
  const source = leaky.json.id;
  assert.deepEqual([leaky.code, leaky.json.created.map(n => [n.id, n.parentId, n.size])], [1, [['10:1', '1:1', 0], ['10:2', '1:2', 0]]]);

  const cleaned = await h.run('clean', source);
  assert.equal(cleaned.code, 0, JSON.stringify(cleaned.json));
  const job = JSON.parse(await fs.readFile(path.join(cleaned.json.evidence, 'job.json'), 'utf8'));
  assert.deepEqual([job.operation, job.code, job.label, job.snapshotDepth, job.data], ['run', CLEAN_SCRIPT, `clean ${source}`, 1, { task: source, pageId: '1:1', nodes: leaky.json.created }]);
  assert.deepEqual(['targetNodeId' in job, 'cleanOnFail' in job], [false, false]);
  assert.deepEqual([cleaned.json.output.cleaned.map(n => n.id), cleaned.json.changes.counts.deleted, h.doc.all.get('10:1').removed, h.doc.frame.name], [['10:1', '10:2'], 1, true, '\u6539\u8fc7']);
  assert.match(cleaned.json.instruction, /2 deleted, 0 already gone, 0 skipped; the deletion is a single Undo step/);
  const again = await h.run('clean', source);
  assert.deepEqual([again.code, again.json.output.cleaned, again.json.output.gone.map(n => n.id)], [0, [], ['10:1', '10:2']]);

  // A node renamed after failure is skipped with exit 1; --no-wait followed by wait or result returns the same exit code and instruction.
  const renamed = await h.run('run', await writeScript(h.cwd, 'rename.js', 'figma.createFrame(); throw Error("\u4e2d\u9014\u5931\u8d25");'));
  h.doc.all.get(renamed.json.created[0].id).name = '\u6539\u540d';
  const skipped = await h.run('clean', renamed.json.id);
  assert.deepEqual([skipped.code, skipped.json.output.skipped.map(n => n.reason)], [1, ['changed to FRAME "\u6539\u540d"']]);
  const queued = await h.cli('clean', renamed.json.id, '--no-wait');
  const [waited, read] = [await h.drive(h.cli('wait', queued.json.id)), await h.cli('result', skipped.json.id)];
  assert.deepEqual([queued.code, waited.code, read.code, read.json.instruction], [0, 1, 1, skipped.json.instruction]);
  assert.match(waited.json.instruction, /1 skipped \(reasons in output\.skipped/);
  assert.deepEqual(h.errors, []);
});
