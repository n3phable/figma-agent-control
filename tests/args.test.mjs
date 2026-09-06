/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:path, node:child_process, node:util, ../src/args.mjs, ./helpers/harness.mjs.
 * [OUTPUT]: Selected original node:test cases and their unchanged fixture setup.
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



// ── help ────────────────────────────────────────────────────────────────

test('Empty arguments, --help, and -h anywhere select help before other validation', () => {
  const help = { command: 'help', positionals: [], options: {} };
  for (const argv of [[], ['--help'], ['-h'], ['run', 'a.js', '--help'], ['preview', '-h', '--node', 'bad'], ['bogus', '--help'], ['resolve', '-h']])
    assert.deepEqual(parse(argv), help, JSON.stringify(argv));
});

// -- Unknown commands and options -----------------------------------------



test('Commands named after Object prototype properties are still unknown commands', () => {
  for (const name of ['toString', 'constructor', '__proto__']) assert.throws(() => parse([name]), /Unknown command/, name);
});

// ── --node ──────────────────────────────────────────────────────────────







// -- Numeric ranges -------------------------------------------------------







// -- Visual verification --------------------------------------------------



// -- Waiting --------------------------------------------------------------



// -- run submission options -----------------------------------------------



// ── resolve ─────────────────────────────────────────────────────────────



// ── report ──────────────────────────────────────────────────────────────





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






