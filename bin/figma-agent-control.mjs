#!/usr/bin/env node
/**
 * [INPUT]: Imports node:fs/promises, node:path, ../src/project.mjs, ../src/bridge.mjs, ../src/session.mjs, ../src/args.mjs, ../src/client.mjs, ../src/record.mjs, ../src/report.mjs.
 * [OUTPUT]: CLI dispatch for the commands currently listed by help.
 * [POS]: CLI shell: validate arguments, dispatch a command, and emit its JSON result and exit status.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { init, json, pluginHome, installPlugin } from '../src/project.mjs';
import { start, DEFAULT_PORT } from '../src/bridge.mjs';
import { pairingToken } from '../src/session.mjs';
import { COMMANDS, parse } from '../src/args.mjs';
import { call } from '../src/client.mjs';

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
  else if (command === 'connect') {
    // Install one global plugin: all projects share pairing credentials and the plugin directory; unchanged content is not rewritten.
    const home = pluginHome();
    const bridge = await start(cwd, DEFAULT_PORT, { pluginToken: await pairingToken(home) });
    let installed;
    try { installed = await installPlugin(home, bridge.plugin); } catch (error) { await bridge.close(); throw error; }
    out({ listening: `127.0.0.1:${bridge.port}`, manifest: installed.manifest, pluginVersion: bridge.version, pluginUpdated: installed.changed, ...(bridge.recovered ? { recovered: bridge.recovered } : {}),
      instruction: 'First use on this machine: in Figma, Plugins -> Development -> Import plugin from manifest, import the manifest above (once globally, shared by all projects), then run the Figma Agent Control plugin; switching projects or restarting the bridge later needs no reopen. Stop: figma-agent-control stop or Ctrl-C' });
    const close = () => { void bridge.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }
  else if (command === 'status') { const { ok, data } = await call(cwd, '/status'); out(data); if (!ok) process.exitCode = 1; }
  else if (command === 'result') { const record = await localResult(cwd, positionals[0]); out(o.full ? record : summarizeRecord(record)); process.exitCode = exitCode(record); }
  else if (command === 'wait') { const record = await waitForResult(cwd, positionals[0], o.timeoutSeconds); out(o.full ? record : summarizeRecord(record)); process.exitCode = exitCode(record); }
} catch (error) { out({ error: error.message, code: error.code || 'COMMAND_FAILED' }); process.exitCode = 1; }
