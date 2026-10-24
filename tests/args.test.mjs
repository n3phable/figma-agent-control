/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:path, node:child_process, node:util, node:url, ../src/args.mjs, ./helpers/harness.mjs.
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
import { fileURLToPath } from 'node:url';
import { parse, COMMANDS, libName } from '../src/args.mjs';
import { cliFile } from './helpers/harness.mjs';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e', ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const URL_ = 'https://www.figma.com/design/k/n?node-id=1-2';
// Valid positional arguments from the documented usage; resolve also needs two required flags. Independent of COMMANDS to verify the command table itself.
const POSITIONALS = {
  help: [], init: [URL_], connect: [], stop: [], status: [], doctor: [],
  run: ['a.js'], inspect: [], preview: [], variables: [], extract: [], clean: [ID], result: [ID], wait: [ID], cancel: [ID],
  resolve: [ID], frames: ['a.webm'], 'image-diff': ['a.png', 'b.png'], report: [], html: [], 'html-check': ['a.html'],
};
const FLAGS = { resolve: ['--inspect', ID2, '--previous-plugin-stopped'], html: ['--node', '1:2', '--out', 'd'] };
const usageOf = cmd => ({ message }) => message.startsWith('Usage: ' + cmd);
const opts = (...argv) => parse(argv).options;

// -- Positional arguments ------------------------------------------------

test('Each command enforces positional argument bounds and reports its own usage', () => {
  for (const [cmd, pos] of Object.entries(POSITIONALS)) {
    const flags = FLAGS[cmd] ?? [];
    const ok = parse([cmd, ...pos, ...flags]);
    assert.deepEqual([ok.command, ok.positionals], [cmd, pos], cmd);
    if (cmd === 'html-check') continue;   // Accepts 1-50 pages; dedicated cases cover both bounds.
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
    ['inspect', '--clean-on-fail'], ['extract', '--clean-on-fail'], ['run', 'a.js', '--clean-on-fail=yes'],
    ['clean', ID, '--node', '1:2'], ['clean', ID, '--clean-on-fail'], ['clean', ID, '--data', 'd.json'],
  ]) assert.throws(() => parse([cmd, ...rest]), ({ message }) => message.startsWith('Invalid arguments') && message.endsWith('; usage: ' + COMMANDS[cmd].usage), rest.join(' '));
});

test('clean accepts only wait options; task IDs are validated when reading evidence', () => {
  assert.equal(COMMANDS.clean.submit, true);
  assert.deepEqual(parse(['clean', ID, '--timeout', '60', '--full']), { command: 'clean', positionals: [ID], options: { timeoutSeconds: 60, full: true } });
  assert.deepEqual(opts('clean', ID, '--no-wait'), { noWait: true });
  assert.throws(() => parse(['clean', ID, '--no-wait', '--full']), /--no-wait cannot be combined with --full or --timeout/);
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

test('preview preserves repeated --name values, disallows --node, and rejects empty, duplicate, over-200-character, or over-50-name inputs; other commands reject it', () => {
  assert.deepEqual(opts('preview', '--name', '\u9996\u9875 · 1440', '--name', ' \u8272\u5757 ', '--scale', '0.5'), { names: ['\u9996\u9875 · 1440', ' \u8272\u5757 '], scale: 0.5 });
  const many = n => Array.from({ length: n }, (_, i) => ['--name', `\u753b\u6846 ${i}`]).flat();
  assert.equal(opts('preview', ...many(50)).names.length, 50);
  assert.equal(opts('preview', '--name', '\u5b57'.repeat(200)).names[0].length, 200);
  for (const [argv, message] of [
    [['--name', 'a', '--node', '1:2'], /^--name cannot be combined with --node$/], [['--node', '1:2', '--node', '1:3', '--name', 'a'], /^--name cannot be combined with --node$/],
    [['--name', ''], /^--name must not be empty$/], [['--name', 'a', '--name', ''], /^--name must not be empty$/],
    [['--name', '\u753b\u6846', '--name', '\u753b\u6846'], /^--name has a duplicate name: \u753b\u6846$/], [many(51), /^--name takes at most 50 names$/], [['--name', '\u5b57'.repeat(201)], /^--name values must be at most 200 characters each$/],
  ]) assert.throws(() => parse(['preview', ...argv]), error => message.test(error.message), argv.slice(0, 4).join(' '));
  for (const cmd of [['run', 'a.js'], ['inspect'], ['extract']]) assert.throws(() => parse([...cmd, '--name', 'a']), /^Error: Invalid arguments/, cmd[0]);
});

test('extract accepts --scale and repeated --island: normalize IDs, reject duplicates or more than 500, name invalid options, and reject script options', () => {
  assert.deepEqual(opts('extract', '--node', '1-2', '--scale', '2', '--island', '3-4', '--island', 'I5:6;7:8'), { targetNodeId: '1:2', scale: 2, islands: ['3:4', 'I5:6;7:8'] });
  assert.deepEqual(opts('extract', '--timeout', '60', '--full'), { timeoutSeconds: 60, full: true });
  assert.throws(() => parse(['extract', '--island', 'x']), /^Error: --island needs a valid node ID/);
  assert.throws(() => parse(['extract', '--node', 'x']), /^Error: --node needs a valid node ID/);
  assert.throws(() => parse(['extract', '--island', '1:2', '--island', '1-2']), /--island has a duplicate node: 1:2/);
  const many = n => Array.from({ length: n }, (_, i) => ['--island', `1:${i + 1}`]).flat();
  assert.equal(opts('extract', ...many(500)).islands.length, 500);
  assert.throws(() => parse(['extract', ...many(501)]), /^Error: --island takes at most 500 nodes$/);
  for (const flag of [['--lib', 'a.js'], ['--depth', '1'], ['--expect', 'changed'], ['--node', '1:2', '--node', '1:3']]) assert.throws(() => parse(['extract', ...flag]), /extract \[--node/, flag[0]);
});

test('html accepts repeated --node and --from totaling 1-50 frames, maps --from to fromIds, and normalizes output, overrides, check, timeout, and budget options', () => {
  assert.deepEqual(opts('html', '--from', ID, '--node', '1-2', '--from', ID2, '--node', '1:3', '--out', 'd', '--overrides', 'o.json', '--no-check', '--timeout', '5', '--budget', '600'),
    { targetNodeId: '1:2', nodes: ['1:2', '1:3'], timeoutSeconds: 5, outDir: 'd', fromIds: [ID, ID2], overridesFile: 'o.json', noCheck: true, budgetSeconds: 600 });
  assert.deepEqual(opts('html', '--node', '1:2', '--out', ' d ', '--budget', '10'), { targetNodeId: '1:2', outDir: ' d ', budgetSeconds: 10 });
  const many = (flag, n, at = i => `1:${i + 1}`) => Array.from({ length: n }, (_, i) => [flag, at(i)]).flat();
  const uuid = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  assert.equal(opts('html', ...many('--node', 25), ...many('--from', 25, uuid), '--out', 'd').fromIds.length, 25);
  for (const [argv, message] of [
    [['--node', '1:2'], /^html requires --out/], [['--node', '1:2', '--out', '  '], /^html requires --out/], [['--out', 'd'], /^html needs 1-50 frames.*got 0$/],
    [[...many('--node', 26), ...many('--from', 25, uuid), '--out', 'd'], /got 51$/], [[...many('--node', 51), '--out', 'd'], /^--node takes at most 50 nodes, without duplicates$/],
    [['--from', ID.toUpperCase(), '--out', 'd'], /^--from must be an extract job ID \(lowercase UUID\)/], [['--from', 'x', '--out', 'd'], /lowercase UUID/], [['--from', ID, '--from', ID, '--out', 'd'], /^--from has a duplicate job: /],
    ...['9', '601', '1.5'].map(v => [['--node', '1:2', '--out', 'd', '--budget', v], /^--budget must be an integer 10-600 seconds$/]),
    [['--node', '1:2', '--out', 'd', '--out', 'e'], /--out may be given only once/], [['--node', '1:2', '--out', 'd', '--budget', '10', '--budget', '20'], /--budget may be given only once/],
  ]) assert.throws(() => parse(['html', ...argv]), error => message.test(error.message), argv.join(' '));
});

test('html-check accepts 1-50 pages, normalizes up to 50 distinct --node values, and accepts --zoom once as a task ID', () => {
  const pages = n => Array.from({ length: n }, (_, i) => `p${i}.html`), nodes = n => Array.from({ length: n }, (_, i) => ['--node', `1-${i + 1}`]).flat();
  assert.deepEqual(parse(['html-check', ...pages(50)]).positionals.length, 50);
  for (const n of [0, 51]) assert.throws(() => parse(['html-check', ...pages(n)]), usageOf('html-check'), String(n));
  assert.throws(() => parse(['html-check', 'a.html', '--no-check']), /^Error: Invalid arguments/);
  assert.deepEqual(opts('html-check', 'a.html', '--node', '1-2', '--node', 'I1-3;4-5', '--zoom', ID), { targetNodeId: '1:2', nodes: ['1:2', 'I1:3;4:5'], zoomId: ID });
  assert.deepEqual(opts('html-check', 'a.html', '--node', '1:2'), { targetNodeId: '1:2' });
  assert.equal(opts('html-check', 'a.html', ...nodes(50)).nodes.length, 50);
  for (const [argv, message] of [[nodes(51), /^--node takes at most 50 nodes, without duplicates$/], [['--node', '1:2', '--node', '1-2'], /^--node takes at most 50 nodes, without duplicates$/],
    [['--node', 'x'], /^--node needs a valid node ID/], [['--zoom', 'abc'], /^--zoom must be an extract job ID \(lowercase UUID\): abc$/], [['--zoom', ID, '--zoom', ID2], /--zoom may be given only once/]])
    assert.throws(() => parse(['html-check', 'a.html', ...argv]), error => message.test(error.message), argv.join(' '));
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

test('run validates UUID --request-id and nonempty --high-risk reasons, preserves repeated --lib order, and accepts --clean-on-fail once', () => {
  assert.equal(opts('run', 'a.js', '--request-id', ID).requestId, ID);
  for (const bad of ['abc', ID.slice(1), ID + '0']) assert.throws(() => parse(['run', 'a.js', '--request-id', bad]), /--request-id/, bad);
  assert.deepEqual(opts('run', 'a.js', '--high-risk', '\u5220\u9664\u65e7\u56fe\u5c42').risk, { level: 'high', reason: '\u5220\u9664\u65e7\u56fe\u5c42' });
  for (const bad of ['', '   ']) assert.throws(() => parse(['run', 'a.js', '--high-risk', bad]), /requires a risk description/, JSON.stringify(bad));
  assert.deepEqual(opts('run', 'a.js', '--lib', 'outer.js', '--lib', 'inner.js').libFiles, ['outer.js', 'inner.js']);
  assert.deepEqual([opts('run', 'a.js', '--clean-on-fail').cleanOnFail, opts('run', 'a.js').cleanOnFail], [true, undefined]);
  assert.throws(() => parse(['run', 'a.js', '--clean-on-fail', '--clean-on-fail']), /--clean-on-fail may be given only once/);
});

test('run --lib resolves bare names to bundled lib/<name>.js, preserves mixed local-file order, and suggests a path for unknown bundled names', () => {
  const [local, motion] = opts('run', 'a.js', '--lib', 'outer.js', '--lib', 'motion').libFiles;
  assert.deepEqual([local, motion], ['outer.js', fileURLToPath(new URL('../lib/motion.js', import.meta.url))]);
  assert.throws(() => parse(['run', 'a.js', '--lib', 'nope']), /No built-in library named nope; give local files as a path, e\.g\. \.\/nope\.js/);
  assert.deepEqual(opts('run', 'a.js', '--lib', './motion', '--lib', 'Motion.js').libFiles, ['./motion', 'Motion.js'], 'Paths or extensions select local files');
  assert.deepEqual([libName(motion), libName(local), libName('scripts/motion.js')], ['lib:motion', 'outer.js', 'motion.js'], 'Traces name bundled libraries lib:<name> to distinguish same-named scripts');
});

test('frames parses, deduplicates, and sorts up to 24 --at times; --count (2-24) is exclusive, --compare is preserved, and --dump is a flag', () => {
  assert.deepEqual(opts('frames', 'a.webm', '--at', '0.5, 0,.25,0.5').atSeconds, [0, 0.25, 0.5]);
  for (const bad of ['', '1,', 'a', '1s', '0.1.2']) assert.throws(() => parse(['frames', 'a.webm', '--at', bad]), /--at needs comma-separated seconds/, JSON.stringify(bad));
  assert.throws(() => parse(['frames', 'a.webm', '--at', Array.from({ length: 25 }, (_, i) => i).join(',')]), /--at takes at most 24 times/);
  assert.equal(opts('frames', 'a.webm', '--count', '12').frameCount, 12);
  for (const bad of ['1', '25', '2.5']) assert.throws(() => parse(['frames', 'a.webm', '--count', bad]), /--count must be an integer 2-24/, bad);
  assert.throws(() => parse(['frames', 'a.webm', '--at', '0', '--count', '3']), /--at cannot be combined with --count/);
  assert.equal(opts('frames', 'a.webm', '--compare', ID).compareSource, ID);
  assert.deepEqual([opts('frames', 'a.webm', '--dump').dump, opts('frames', 'a.webm').dump], [true, undefined]);
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
