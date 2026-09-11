/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:path, node:child_process, node:util, ../src/args.mjs, ./helpers/harness.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for args; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, COMMANDS } from '../src/args.mjs';
import { cliFile } from './helpers/harness.mjs';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e', ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const URL_ = 'https://www.figma.com/design/k/n?node-id=1-2';
// Valid positional arguments from the documented usage; resolve also needs two required flags. Independent of COMMANDS to verify the command table itself.
const POSITIONALS = {
  help: [], init: [URL_], connect: [], stop: [], status: [], doctor: [],
  run: ['a.js'], inspect: [], preview: [], variables: [], result: [ID], wait: [ID],
  resolve: [ID], 'image-diff': ['a.png', 'b.png'], report: [],
};
const FLAGS = { resolve: ['--inspect', ID2, '--previous-plugin-stopped'] };
const usageOf = cmd => ({ message }) => message.startsWith('Usage: ' + cmd);
const opts = (...argv) => parse(argv).options;

// -- Positional arguments ------------------------------------------------

test('Each command enforces positional argument bounds and reports its own usage', () => {
  for (const [cmd, pos] of Object.entries(POSITIONALS)) {
    const flags = FLAGS[cmd] ?? [];
    const ok = parse([cmd, ...pos, ...flags]);
    assert.deepEqual([ok.command, ok.positionals], [cmd, pos], cmd);
    assert.throws(() => parse([cmd, ...pos, 'extra', ...flags]), usageOf(cmd), cmd + ' extra argument');
    if (pos.length) assert.throws(() => parse([cmd, ...pos.slice(1), ...flags]), usageOf(cmd), cmd + ' missing argument');
  }
});

// ── help ────────────────────────────────────────────────────────────────

test('Empty arguments, --help, and -h anywhere select help before other validation', () => {
  const help = { command: 'help', positionals: [], options: {} };
  for (const argv of [[], ['--help'], ['-h'], ['run', 'a.js', '--help'], ['preview', '-h', '--node', 'bad'], ['bogus', '--help'], ['resolve', '-h']])
    assert.deepEqual(parse(argv), help, JSON.stringify(argv));
});

// -- Unknown commands and options -----------------------------------------

test('Unknown commands point to help; unknown, disallowed, or valueless options include command usage', () => {
  assert.throws(() => parse(['bogus']), /Unknown command: bogus.*figma-agent-control help/);
  for (const [cmd, ...rest] of [
    ['run', 'a.js', '--bogus'], ['status', '--node', '1:2'], ['inspect', '--high-risk', '\u98ce\u9669'], ['inspect', '--expect', 'changed'],
    ['preview', '--depth', '1'], ['run', 'a.js', '--threshold', '3'], ['image-diff', 'a.png', 'b.png', '--tolerance', '3'],
    ['wait', ID, '--no-wait'], ['run', 'a.js', '--high-risk'], ['run', 'a.js', '--high-risk', '--node', '1:2'], ['inspect', '--node'],
  ]) assert.throws(() => parse([cmd, ...rest]), ({ message }) => message.startsWith('Invalid arguments') && message.endsWith('; usage: ' + COMMANDS[cmd].usage), rest.join(' '));
});

test('Commands named after Object prototype properties are still unknown commands', () => {
  for (const name of ['toString', 'constructor', '__proto__']) assert.throws(() => parse([name]), /Unknown command/, name);
});

// ── --node ──────────────────────────────────────────────────────────────

test('--node converts hyphens to colons, preserves instance chains, rejects invalid IDs, and defaults to no target', () => {
  for (const [raw, id] of [['1-2', '1:2'], ['153:9848', '153:9848'], ['I1-2;3-4', 'I1:2;3:4'], ['I153:9884;150:7584', 'I153:9884;150:7584']])
    assert.equal(opts('inspect', '--node', raw).targetNodeId, id, raw);
  for (const bad of ['x', '', 'I1:2', '1:2;3:4', 'I1:2;', '../1:2', '1-2-3', ' 1:2'])
    assert.throws(() => parse(['run', 'a.js', '--node', bad]), /--node needs a valid node ID/, JSON.stringify(bad));
  assert.deepEqual(opts('variables'), {});
});

test('preview allows repeated --node: use the first target, deduplicate normalized IDs, and cap at 50', () => {
  assert.deepEqual(opts('preview', '--node', '1-3', '--node', '1:4'), { targetNodeId: '1:3', nodes: ['1:3', '1:4'] });
  assert.deepEqual(opts('preview', '--node', '1:3'), { targetNodeId: '1:3' });
  assert.throws(() => parse(['preview', '--node', '1:2', '--node', '1-2']), /without duplicates/);
  const many = n => Array.from({ length: n }, (_, i) => ['--node', `1:${i + 1}`]).flat();
  assert.equal(opts('preview', ...many(50)).nodes.length, 50);
  assert.throws(() => parse(['preview', ...many(51)]), /at most 50/);
});

test('Commands other than preview reject repeated --node instead of silently writing to the last target', () => {
  assert.throws(() => parse(['run', 'a.js', '--node', '1:2', '--node', '1:3']));
});

// -- Numeric ranges -------------------------------------------------------

test('--depth accepts only integers from 1 to 31', () => {
  assert.equal(opts('inspect', '--depth', '1').snapshotDepth, 1);
  assert.equal(opts('run', 'a.js', '--depth', '31').snapshotDepth, 31);
  for (const bad of ['0', '32', '1.5', '-1', 'abc', ''])
    assert.throws(() => parse(['inspect', `--depth=${bad}`]), /--depth must be an integer 1-31/, bad);
});

test('image-diff --threshold accepts only integers from 0 to 255, including with --expect', () => {
  assert.deepEqual(opts('image-diff', 'a.png', 'b.png', '--threshold', '0', '--expect', 'unchanged'), { threshold: 0, expect: 'unchanged' });
  assert.equal(opts('image-diff', 'a.png', 'b.png', '--threshold', '255').threshold, 255);
  for (const bad of ['256', '-1', '1.5', 'x'])
    assert.throws(() => parse(['image-diff', 'a.png', 'b.png', `--threshold=${bad}`]), /--threshold must be an integer 0-255/, bad);
  assert.throws(() => parse(['image-diff', 'a.png', 'b.png', '--expect', 'same']), /--expect accepts only/);
});

test('--scale ranges from 0.1 to 4; run requires --expect, while preview accepts it directly', () => {
  assert.equal(opts('preview', '--scale', '0.1').scale, 0.1);
  assert.equal(opts('preview', '--scale', '4').scale, 4);
  assert.equal(opts('preview', '--scale', '.5').scale, 0.5);
  for (const bad of ['0', '0.05', '4.01', '1e0', 'abc'])
    assert.throws(() => parse(['preview', '--scale', bad]), /--scale must be 0.1-4/, bad);
  assert.throws(() => parse(['run', 'a.js', '--scale', '2']), /--expect/);
  assert.deepEqual(opts('run', 'a.js', '--expect', 'changed', '--scale', '0.5'), { expect: 'changed', scale: 0.5 });
});

// -- Visual verification --------------------------------------------------

test('--expect accepts only changed|unchanged; --tolerance requires --expect and a nonnegative integer', () => {
  assert.equal(opts('run', 'a.js', '--expect', 'unchanged').expect, 'unchanged');
  for (const bad of ['Changed', 'yes']) assert.throws(() => parse(['run', 'a.js', '--expect', bad]), /accepts only changed or unchanged/, bad);
  assert.throws(() => parse(['run', 'a.js', '--tolerance', '3']), /--tolerance requires --expect/);
  assert.deepEqual(opts('run', 'a.js', '--expect', 'changed', '--tolerance', '0'), { expect: 'changed', tolerance: 0 });
  for (const bad of ['-1', '1.5', 'x'])
    assert.throws(() => parse(['run', 'a.js', '--expect', 'changed', `--tolerance=${bad}`]), /non-negative integer/, bad);
});

// -- Waiting --------------------------------------------------------------

test('--no-wait cannot combine with --timeout or --full; --timeout uses positive integer seconds', () => {
  assert.deepEqual(opts('inspect', '--no-wait'), { noWait: true });
  assert.deepEqual(opts('run', 'a.js', '--timeout', '30', '--full'), { timeoutSeconds: 30, full: true });
  for (const argv of [['inspect', '--no-wait', '--timeout', '5'], ['inspect', '--timeout', '5', '--no-wait'], ['run', 'a.js', '--no-wait', '--full']])
    assert.throws(() => parse(argv), /--no-wait cannot be combined with/, argv.join(' '));
  for (const bad of ['0', 'abc']) assert.throws(() => parse(['wait', ID, '--timeout', bad]), /--timeout/, bad);
});

// -- run submission options -----------------------------------------------

test('run validates UUID --request-id and nonempty --high-risk reasons, and preserves repeated --lib order', () => {
  assert.equal(opts('run', 'a.js', '--request-id', ID).requestId, ID);
  for (const bad of ['abc', ID.slice(1), ID + '0']) assert.throws(() => parse(['run', 'a.js', '--request-id', bad]), /--request-id/, bad);
  assert.deepEqual(opts('run', 'a.js', '--high-risk', '\u5220\u9664\u65e7\u56fe\u5c42').risk, { level: 'high', reason: '\u5220\u9664\u65e7\u56fe\u5c42' });
  for (const bad of ['', '   ']) assert.throws(() => parse(['run', 'a.js', '--high-risk', bad]), /requires a risk description/, JSON.stringify(bad));
  assert.deepEqual(opts('run', 'a.js', '--lib', 'outer.js', '--lib', 'inner.js').libFiles, ['outer.js', 'inner.js']);
});

// ── resolve ─────────────────────────────────────────────────────────────

test('resolve requires both --inspect and --previous-plugin-stopped, with UUIDs for both task IDs', () => {
  assert.deepEqual(opts('resolve', ID, '--inspect', ID2, '--previous-plugin-stopped'), { inspectId: ID2, previousPluginStopped: true });
  for (const argv of [[ID, '--previous-plugin-stopped'], [ID, '--inspect', ID2], [ID, '--inspect', 'abc', '--previous-plugin-stopped'], ['abc', '--inspect', ID2, '--previous-plugin-stopped']])
    assert.throws(() => parse(['resolve', ...argv]), ({ message }) => message.startsWith('Usage: resolve') && message.includes('first confirm the previous plugin has stopped'), argv.join(' '));
});

// ── report ──────────────────────────────────────────────────────────────

test('report normalizes --since to UTC ISO time and rejects invalid times', () => {
  assert.equal(opts('report', '--since', '2026-10-01T08:00:00+08:00').since, '2026-10-01T00:00:00.000Z');
  for (const bad of ['yesterday', '2026-13-01', '2026-02-30', '2026-04-31T00:00Z']) assert.throws(() => parse(['report', '--since', bad]), /--since needs an ISO time/, bad);
  assert.deepEqual(opts('report'), {});
});

test('report --since rejects non-ISO input without guessing the local timezone', () => {
  for (const bad of ['1', 'Oct 1 2026']) assert.throws(() => parse(['report', '--since', bad]), /--since needs an ISO time/, bad);
});

// -- CLI subprocesses -----------------------------------------------------

const exec = promisify(execFile);
async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-args-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function cli(cwd, ...args) {
  try { const { stdout } = await exec(process.execPath, [cliFile, ...args], { cwd, env: { ...process.env, FIGMA_AGENT_CONTROL_HOME: path.join(cwd, 'plugin-home') } }); return { code: 0, json: JSON.parse(stdout) }; }
  catch (error) { return { code: error.code, json: JSON.parse(error.stdout) }; }
}

test('CLI help returns one JSON listing all commands and exit codes; -h anywhere returns the same output', async t => {
  const cwd = await tmp(t);
  const [help, inline] = await Promise.all([cli(cwd, 'help'), cli(cwd, 'run', 'x.js', '--node', 'bad', '-h')]);
  assert.equal(help.code, 0);
  assert.deepEqual(help.json.commands.map(u => u.split(/[\s:]/)[0]).sort(), Object.keys(POSITIONALS).sort());
  assert.deepEqual(Object.keys(help.json.exitCodes), ['0', '1', '2']);
  assert.deepEqual(inline, help);
});

test('CLI argument errors return one {error, code} JSON and exit 1 before any filesystem access', async t => {
  const cwd = await tmp(t);
  const cases = [[['bogus'], /Unknown command/], [['run', 'missing.js', '--tolerance', '3'], /--tolerance requires --expect/], [['init', URL_, 'extra'], /^Usage: init/]];
  const results = await Promise.all(cases.map(([argv]) => cli(cwd, ...argv)));
  results.forEach(({ code, json }, i) => {
    assert.equal(code, 1, cases[i][0].join(' '));
    assert.ok(Object.keys(json).every(k => k === 'error' || k === 'code'), JSON.stringify(json));
    assert.match(json.error, cases[i][1]);
  });
  assert.deepEqual(await fs.readdir(cwd), []);
});

test('CLI status in an uninitialized directory reports NO_SESSION and suggests init or connect', async t => {
  const { code, json } = await cli(await tmp(t), 'status');
  assert.equal(code, 1);
  assert.equal(json.code, 'NO_SESSION');
  assert.match(json.error, /init/);
  assert.match(json.error, /connect/);
});
