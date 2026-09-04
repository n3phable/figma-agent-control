#!/usr/bin/env node
/**
 * [INPUT]: Imports node:fs/promises, node:path, ../src/project.mjs, ../src/session.mjs, ../src/args.mjs, ../src/record.mjs, ../src/report.mjs.
 * [OUTPUT]: CLI dispatch for the commands currently listed by help.
 * [POS]: CLI shell: validate arguments, dispatch a command, and emit its JSON result and exit status.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { init, json, pluginHome, installPlugin } from '../src/project.mjs';

import { pairingToken } from '../src/session.mjs';
import { COMMANDS, parse } from '../src/args.mjs';


import { localResult, summarizeRecord, exitCode, waitForResult } from '../src/record.mjs';

import { report } from '../src/report.mjs';

const cwd = process.cwd();
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const HELP = {
  commands: Object.values(COMMANDS).map(c => c.usage),
  exitCodes: { 0: 'success', 1: 'failure, failed visual verification, or a reviewed result that remains unknown', 2: 'not complete (wait expired or review pending; for stop, the bridge is still finishing shutdown, so check status later)' }
};



try {
  const { command, positionals, options: o } = parse(process.argv.slice(2));
  if (command === 'help') out(HELP);
  else if (command === 'init') out(await init(cwd, positionals[0]));
  else if (command === 'result') { const record = await localResult(cwd, positionals[0]); out(o.full ? record : summarizeRecord(record)); process.exitCode = exitCode(record); }
  else if (command === 'wait') { const record = await waitForResult(cwd, positionals[0], o.timeoutSeconds); out(o.full ? record : summarizeRecord(record)); process.exitCode = exitCode(record); }
} catch (error) { out({ error: error.message, code: error.code || 'COMMAND_FAILED' }); process.exitCode = 1; }
