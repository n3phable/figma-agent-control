#!/usr/bin/env node
/**
 * [INPUT]: Uses the src/args command table, parse and libName (cancel first POSTs /cancel, then waits like wait); src/bridge start/DEFAULT_PORT; src/session pairingToken; src/client call/stop; src/record readers, summaries, exit codes and waiting; src/clean cleanJob; src/doctor, src/image-diff, src/frames, src/report; src/html/command html/htmlCheck; and src/project init/json/pluginHome/installPlugin. Uses src/args Options for type checking.
 * [OUTPUT]: The figma-agent-control CLI; stdout contains one JSON object (error messages containing user input are truncated at 2000 characters; stderr receives a task ID before waiting, and one per extract submitted by html).
 *           Exit 0: success, including clean with nothing to remove. Exit 1: failure, failed verdict, rejected or skipped cleanup, skipped explicit islands, extract binary write failure, verified execution with unknown result, or html frames that failed, missed the target, were unchecked or flagged (stale overrides, missing islands, output invariant violations), or stopped on a bridge issue. Exit 2: pending, including stop still finishing or html requiring continuation.
 * [POS]: The only bin source: dispatches commands without business rules. connect assembles global pairing, bridge startup and global plugin installation; installation failure shuts down the bridge before reporting the error.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { init, json, pluginHome, installPlugin } from '../src/project.mjs';
import { start, DEFAULT_PORT } from '../src/bridge.mjs';
import { pairingToken } from '../src/session.mjs';
import { COMMANDS, parse, libName } from '../src/args.mjs';
import { call, stop } from '../src/client.mjs';
import { doctor } from '../src/doctor.mjs';
import { localResult, summarizeRecord, exitCode, waitForResult } from '../src/record.mjs';
import { cleanJob } from '../src/clean.mjs';
import { imageDiff } from '../src/image-diff.mjs';
import { frames } from '../src/frames.mjs';
import { report } from '../src/report.mjs';
import { html, htmlCheck } from '../src/html/command.mjs';

const cwd = process.cwd();
/** @param {unknown} value */
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const HELP = {
  commands: Object.values(COMMANDS).map(c => c.usage),
  script: 'The run script is a trusted JavaScript function body with access to figma, target (the --node node, default the bound node) and data (the --data JSON); return the result with return. Bytes anywhere in the return value (exportAsync results, also nested in arrays or objects) are saved as files and replaced in output by file descriptors, at most 200 per job and 48 MB in total. Mark nodes with setSharedPluginData("figmaagentcontrol", key, value); setPluginData is unavailable (the manifest has no Figma-assigned plugin ID). The plugin runs with documentAccess: dynamic-page, so reading mainComponent or calling sync APIs such as figma.getNodeById throws; use the async versions such as getMainComponentAsync and getNodeByIdAsync (mapping table in the dynamic-page constraints section of docs/agent-guide.md). Nodes made by create* are attached to the current page root; appendChild them into the target. When the target is not a page, pageRoot in the result lists the nodes added to or removed from the page root',
  lib: '--lib is repeatable: each lib runs in its own outer scope and the script body can call its functions directly; same-name declarations in the body shadow the outer ones without conflict. A bare name refers to a built-in library: --lib motion provides readMotion, applyMotion, exportMotion and motionIssues (see the motion section of docs/agent-guide.md)',
  expect: '--expect changed|unchanged: export the target once before and once after the script and compare them to check whether the write changed the rendering; --tolerance sets the number of changed pixels allowed',
  cleanOnFail: 'When the script fails, the result lists the nodes it created on the target page that still exist (created); --clean-on-fail also deletes them (cleaned, cleanFailed) as a separate Undo step. Nodes that existed on the target page before the run, or created nodes containing such nodes, are not deleted. detachInstance and flatten give existing content new IDs, so it is deleted as created nodes; the result then also gives deletedExisting and a warning, and one Undo in Figma reverts the cleanup. Created components emit no creation event, are not in created and are never deleted. Modified existing nodes are not rolled back; execution is not atomic. Without --clean-on-fail, confirm the subtree with inspect, then run clean <job-id>: it re-checks each node\'s name, type, parent and subtree node count before deleting, skips mismatches (exit code 1), deletes as a separate Undo step, and is safe to re-run',
  output: 'stdout carries exactly one JSON object: submitting commands wait for the result by default and print a summary (id, output, resultFile; preview also gives images[].name and absolute paths images[].file); --full prints the full record (return value in .result.output, image paths relative to evidence); --no-wait only submits. When the script throws, the summary includes trace (the failing lib or script file, line number and source; the first entry is where it threw). '
    + 'When waiting starts, a job ID receipt is written as one line to stderr so you can still wait if the command is killed externally; do not merge 2>&1 when parsing stdout. Fetch results by job ID (result, wait, or run with your own --request-id, a new UUID per submission), never by the timestamps of runs/ directories',
  exitCodes: { 0: 'success', 1: 'failure, visual check failed, clean skipped nodes, extract skipped explicit islands or saved binaries incompletely, or verified but still unresolved; html has frames that missed the target, were unchecked or errored, stale overrides entries, missing Figma-exported islands, or generated output that violates the output invariants',
    2: 'not finished yet (wait expired or verification pending; for stop: the bridge is still shutting down, confirm later with status; for html: needs a resumed run, see instruction)' }
};

/** @param {string} command @param {string[]} positionals @param {import('../src/args.mjs').Options} o */
async function submit(command, [file], o) {
  // clean reads no script file: src/clean builds a normal run from the original task's evidence; nothing is submitted when there are no nodes to remove.
  /** @type {Record<string, unknown> | null} */
  const body = command === 'clean' ? await cleanJob(cwd, file) : { operation: command, targetNodeId: o.targetNodeId, nodes: o.nodes, names: o.names, snapshotDepth: o.snapshotDepth, scale: o.scale, risk: o.risk, requestId: o.requestId, expect: o.expect, tolerance: o.tolerance, islands: o.islands, cleanOnFail: o.cleanOnFail };
  if (!body) { out({ task: file, instruction: 'Nothing to clean up: created of the original job is empty, or all its nodes were already deleted or kept by protection rules (see cleaned and cleanFailed of the original job); no job was submitted' }); return 0; }
  if (command === 'run') {
    body.code = await fs.readFile(path.resolve(file), 'utf8');
    body.label = path.basename(file);
    if (o.libFiles) body.libs = await Promise.all(o.libFiles.map(async lib => ({ name: libName(lib), code: await fs.readFile(path.resolve(lib), 'utf8') })));
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
  else if (command === 'cancel') {
    const { ok, data } = await call(cwd, '/cancel', { id: positionals[0] });
    if (!ok) { out(data); process.exitCode = 1; }
    else { const record = await waitForResult(cwd, positionals[0], o.timeoutSeconds); out(o.full ? record : summarizeRecord(record)); process.exitCode = exitCode(record); }
  }
  else if (command === 'resolve') {
    const { ok, data } = await call(cwd, '/resolve', { id: positionals[0], inspectId: o.inspectId, previousPluginStopped: true });
    out(data); if (!ok) process.exitCode = 1;
  }
  else if (command === 'image-diff') { const diff = await imageDiff(cwd, positionals, o); out(diff); if (diff.expectation === 'failed') process.exitCode = 1; }
  else if (command === 'frames') out(await frames(cwd, positionals[0], o));
  else if (command === 'report') out(await report(cwd, o.since ? { since: o.since } : {}));
  else if (command === 'html' || command === 'html-check') {
    const { summary, exitCode: code } = command === 'html' ? await html(cwd, o) : await htmlCheck(cwd, positionals, o);
    out(summary); process.exitCode = code;
  }
} catch (error) { const message = String(error.message); out({ error: message.length > 2000 ? message.slice(0, 1997) + '...' : message, code: error.code || 'COMMAND_FAILED' }); process.exitCode = 1; }
