/**
 * [INPUT]: ./helpers/harness.mjs harness/writeScript; node:test, node:assert, node:fs/promises, and node:path.
 * [OUTPUT]: No exports; node:test smoke cases.
 * [POS]: Shortest end-to-end path for libraries/data, nonexecuted syntax errors, visual verification, batch previews, and job.json without embedded results. Run first after changes.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { harness, writeScript } from './helpers/harness.mjs';

test('Smoke: run with library and data, reject syntax errors without execution, verify visuals, and preview a batch', { timeout: 30000 }, async t => {
  const h = await harness(t);
  const status = await h.cli('status');
  assert.equal(status.json.connected, true);

  const lib = await writeScript(h.cwd, 'lib.js', 'const label = "lib"; function shout(s) { return s + "!"; }');
  const body = await writeScript(h.cwd, 'body.js', 'const label = "body"; target.characters = shout(data.text); return { label, text: target.characters };');
  await fs.writeFile(path.join(h.cwd, 'data.json'), JSON.stringify({ text: '\u65b0\u6587\u6848' }));
  const run = await h.run('run', body, '--node', '1:3', '--lib', lib, '--data', 'data.json');
  assert.equal(run.code, 0, JSON.stringify(run.json));
  assert.deepEqual(run.json.output, { label: 'body', text: '\u65b0\u6587\u6848!' });
  assert.equal(run.json.changes.counts.updated, 1);
  assert.deepEqual(run.json.changes.nodes[0].keys, ['characters']);

  const broken = await writeScript(h.cwd, 'broken.js', 'target.characters = "x"; const = 1;');
  const syntax = await h.run('run', broken, '--node', '1:3');
  assert.equal(syntax.code, 1);
  assert.equal(syntax.json.executionStarted, false);
  assert.equal(h.doc.text.characters, '\u65b0\u6587\u6848!');

  const paint = await writeScript(h.cwd, 'paint.js', 'target.fills = [{ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 0, b: 0 } }];');
  const changed = await h.run('run', paint, '--node', '1:4', '--expect', 'changed');
  assert.equal(changed.code, 0, JSON.stringify(changed.json));
  assert.equal(changed.json.verify.pass, true);
  const same = await h.run('run', paint, '--node', '1:4', '--expect', 'changed');
  assert.equal(same.code, 1);
  assert.equal(same.json.verify.pass, false);
  assert.equal(same.json.ok, true);

  const preview = await h.run('preview', '--node', '1:3', '--node', '1:4');
  assert.equal(preview.code, 0, JSON.stringify(preview.json));
  assert.equal(preview.json.images.length, 2);

  const job = await fs.readFile(path.join(h.cwd, '.figma-agent-control/runs', run.json.id, 'job.json'), 'utf8');
  assert.equal(JSON.parse(job).result, undefined);
  assert.deepEqual(h.errors, []);
});
