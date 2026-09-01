/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:fs, node:os, node:path, ../src/project.mjs.
 * [OUTPUT]: Selected original node:test cases and their unchanged fixture setup.
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


// -- Startup recovery -----------------------------------------------------






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








// -- Connection leases ----------------------------------------------------
// Explicitly set the undocumented foreground lease to 15 s; use the default background lease to verify the documented 90 s.







