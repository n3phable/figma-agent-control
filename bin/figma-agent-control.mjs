#!/usr/bin/env node
/**
 * [INPUT]: Imports node:fs/promises, node:path, ../src/project.mjs, ../src/bridge.mjs, ../src/session.mjs, ../src/args.mjs, ../src/client.mjs, ../src/doctor.mjs, ../src/record.mjs, ../src/image-diff.mjs, ../src/report.mjs, ../src/html/command.mjs.
 * [OUTPUT]: Plugin task handling and serialized results.
 * [POS]: CLI shell: validate arguments, dispatch a command, and emit its JSON result and exit status.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { init, json, pluginHome, installPlugin } from '../src/project.mjs';
import { start, DEFAULT_PORT } from '../src/bridge.mjs';
import { pairingToken } from '../src/session.mjs';
import { COMMANDS, parse } from '../src/args.mjs';
import { call, stop } from '../src/client.mjs';
import { doctor } from '../src/doctor.mjs';
import { localResult, summarizeRecord, exitCode, waitForResult } from '../src/record.mjs';
import { imageDiff } from '../src/image-diff.mjs';
import { report } from '../src/report.mjs';
import { html, htmlCheck } from '../src/html/command.mjs';

const cwd = process.cwd();
/** @param {unknown} value */
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const HELP = {
  commands: Object.values(COMMANDS).map(c => c.usage),
  script: 'run executes a trusted JavaScript function body with figma, target (the --node node, or the bound node by default), and data (JSON from --data). Use return for output; exportAsync bytes returned directly are saved as files. Mark nodes with setSharedPluginData("figmaagentcontrol", key, value); setPluginData is unavailable because the manifest has no Figma-assigned plugin ID. Under documentAccess: dynamic-page, synchronous APIs such as mainComponent and figma.getNodeById throw; use getMainComponentAsync/getNodeByIdAsync. See dynamic-page constraints in docs/agent-guide.md',
  lib: '--lib is repeatable: each library executes in a separate enclosing scope, and the body can call its functions directly; same-name declarations shadow outer scopes without conflicts',
  expect: '--expect changed|unchanged: export the target once before and once after the script and compare them to check whether the write changed the rendering; --tolerance sets the number of changed pixels allowed',
  cleanOnFail: 'On script failure, created lists surviving nodes created on the target page. --clean-on-fail deletes them as a separate Undo step and reports cleaned/cleanFailed, preserving preexisting target-page nodes and containers holding them. detachInstance/flatten replace IDs, so their existing content can be mistaken for new and deleted; deletedExisting and warnings identify this, and one Undo restores cleanup. New components emit no creation event, do not enter created, and are not deleted. Existing edits are not rolled back; execution is not atomic',
  output: 'stdout contains one JSON object. Submission commands wait by default and print a summary with id, output and resultFile; preview also includes images[].name and absolute images[].file. --full prints the complete record with the return value in .result.output and image paths relative to evidence. --no-wait only submits.'
    + 'When waiting starts, a job ID receipt is written as one line to stderr so you can still wait if the command is killed externally; do not merge 2>&1 when parsing stdout. Fetch results by job ID (result, wait, or run with your own --request-id, a new UUID per submission), never by the timestamps of runs/ directories',
  exitCodes: { 0: 'success', 1: 'failure, failed visual verification, skipped explicit islands or incomplete extract binaries, or a reviewed result that remains unknown; html also fails for frames below target, unchecked or errored frames, stale overrides, missing Figma-exported islands, or generated-output invariant violations',
    2: 'not finished yet (wait expired or verification pending; for stop: the bridge is still shutting down, confirm later with status; for html: needs a resumed run, see instruction)' }
};

/** @param {string} command @param {string[]} positionals @param {import('../src/args.mjs').Options} o */
async function submit(command, [file], o) {
  /** @type {Record<string, unknown>} */
  const body = { operation: command, targetNodeId: o.targetNodeId, nodes: o.nodes, names: o.names, snapshotDepth: o.snapshotDepth, scale: o.scale, risk: o.risk, requestId: o.requestId, expect: o.expect, tolerance: o.tolerance, islands: o.islands, cleanOnFail: o.cleanOnFail };
  if (command === 'run') {
    body.code = await fs.readFile(path.resolve(file), 'utf8');
    body.label = path.basename(file);
    if (o.libFiles) body.libs = await Promise.all(o.libFiles.map(async lib => ({ name: path.basename(lib), code: await fs.readFile(path.resolve(lib), 'utf8') })));
    if (o.dataFile) body.data = await json(path.resolve(o.dataFile));
  }
  const { ok, data } = await call(cwd, '/job', body);
  if (!ok || o.noWait) { out(data); return ok ? 0 : 1; }
  // Write the task ID to stderr first so an agent can wait on the same task after an external timeout, without resubmitting it.
  process.stderr.write(JSON.stringify({ submitted: data.id, ...(data.reused ? { reused: true } : {}), next: `figma-agent-control wait ${data.id}` }) + '\n');
  // Wait in the submitting command. Deduplicated submissions wait on the original task and report its exit code; a timeout never resubmits, and the ID remains valid for wait.
  const record = await waitForResult(cwd, data.id, o.timeoutSeconds);
  out({ ...(o.full ? record : summarizeRecord(record)), ...(data.reused ? { reused: true } : {}) });
  return exitCode(record);
}

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
  else if (command === 'stop') { const { exitCode: code, ...result } = await stop(cwd, o.force === true); out(result); process.exitCode = code; }
  else if (command === 'status') { const { ok, data } = await call(cwd, '/status'); out(data); if (!ok) process.exitCode = 1; }
  else if (command === 'doctor') { const result = await doctor(cwd); out(result); if (!result.ready) process.exitCode = 1; }
  else if (COMMANDS[command].submit) process.exitCode = await submit(command, positionals, o);
  else if (command === 'result') { const record = await localResult(cwd, positionals[0]); out(o.full ? record : summarizeRecord(record)); process.exitCode = exitCode(record); }
  else if (command === 'wait') { const record = await waitForResult(cwd, positionals[0], o.timeoutSeconds); out(o.full ? record : summarizeRecord(record)); process.exitCode = exitCode(record); }
  else if (command === 'resolve') {
    const { ok, data } = await call(cwd, '/resolve', { id: positionals[0], inspectId: o.inspectId, previousPluginStopped: true });
    out(data); if (!ok) process.exitCode = 1;
  }
  else if (command === 'image-diff') { const diff = await imageDiff(cwd, positionals, o); out(diff); if (diff.expectation === 'failed') process.exitCode = 1; }
  else if (command === 'report') out(await report(cwd, o.since ? { since: o.since } : {}));
  else if (command === 'html' || command === 'html-check') {
    const { summary, exitCode: code } = command === 'html' ? await html(cwd, o) : await htmlCheck(cwd, positionals, o);
    out(summary); process.exitCode = code;
  }
} catch (error) { const message = String(error.message); out({ error: message.length > 2000 ? message.slice(0, 1997) + '...' : message, code: error.code || 'COMMAND_FAILED' }); process.exitCode = 1; }
