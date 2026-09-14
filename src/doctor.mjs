/**
 * [INPUT]: Imports node:fs/promises, node:path, ./project.mjs, ./client.mjs, ./session.mjs, ./html/chrome.mjs.
 * [OUTPUT]: Exports doctor.
 * [POS]: Diagnoses workspace bindings, bridge connectivity and local execution prerequisites.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { root, json, parseTarget, readBinding, pluginHome } from './project.mjs';
import { call } from './client.mjs';
import { emptyLock, validPid } from './session.mjs';
import { findChrome, chromeVersion } from './html/chrome.mjs';

export async function doctor(cwd) {
  const checks = [];
  const add = (code, status, message, action) => checks.push({ code, status, message, ...(action ? { action } : {}) });
  const dir = root(cwd);
  const report = () => ({ ready: checks.every(c => c.status !== 'error'), checks, instruction: 'Once connected, inspect the target first to verify it; visuals and interaction need separate verification' });
  add('NODE_VERSION', Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'error', `Node.js ${process.versions.node}`, 'Requires Node.js 22+');
  // Only html commands require Chrome, so its absence does not affect ready. Check before binding so uninitialized directories also report it.
  try { const file = findChrome(); add('CHROME', 'ok', `${await chromeVersion(file)} (${file})`); }
  catch (error) { add('CHROME', 'warning', error.code === 'CHROME_NOT_FOUND' ? error.message : `Cannot read the Chrome version: ${error.message}`, 'Only html commands require Chrome: install Google Chrome or set FIGMA_AGENT_CONTROL_CHROME to its executable'); }
  let binding;
  try {
    binding = await readBinding(cwd);
    const parsed = parseTarget(binding.sourceUrl);
    if (!binding.id || parsed.fileKey !== binding.fileKey || parsed.nodeId !== binding.nodeId) throw Error();
    add('BINDING', 'ok', `Bound to file ${binding.fileKey}, node ${binding.nodeId}`);
  } catch (error) {
    add('BINDING', 'error', error.code === 'ENOENT' ? 'The current directory is not initialized' : error.code === 'LEGACY_PROJECT' ? error.message : 'The binding file is corrupt or inconsistent with its source link',
      error.code === 'ENOENT' ? 'Run figma-agent-control init <figma-url> in the project directory' : 'Run init again in a new directory and keep the existing evidence');
    return report();
  }
  let session;
  try {
    session = await json(path.join(dir, 'session.json'));
    if (!Number.isInteger(session.port) || !/^[a-f0-9]{64}$/.test(session.token) || typeof session.sessionId !== 'string') throw Error();
    add('SESSION', 'ok', `Session port ${session.port}`);
  } catch (error) {
    session = null;
    add('SESSION', 'error', error.code === 'ENOENT' ? 'No bridge session' : 'Invalid session file format', 'Run figma-agent-control connect');
  }
  try {
    const pid = (await fs.readFile(path.join(dir, 'bridge.lock'), 'utf8')).trim();
    if (!pid) add('LOCK', 'warning', emptyLock().message);
    else if (!validPid(pid)) add('LOCK', 'warning', 'Invalid PID in bridge.lock (not a positive integer in the safe range)', 'After confirming no other figma-agent-control process exists, delete .figma-agent-control/bridge.lock');
    else try { process.kill(Number(pid), 0); add('LOCK', session ? 'ok' : 'warning', `The bridge.lock process exists (PID ${pid})`, ...(session ? [] : [`Live lock process without a session: if ps -p ${pid} is not figma-agent-control (the PID was reused), delete .figma-agent-control/bridge.lock`])); }
    catch (error) {
      if (error.code === 'ESRCH') add('LOCK', 'warning', `The bridge.lock process has exited (PID ${pid})`, 'The next connect reclaims the stale lock automatically and marks unfinished jobs as pending verification');
      else add('LOCK', 'warning', `Cannot confirm the bridge.lock process (PID ${pid}, ${error.code})`, `connect treats it as alive; if ps -p ${pid} is not figma-agent-control, delete .figma-agent-control/bridge.lock`);
    }
  } catch (error) { if (error.code !== 'ENOENT') add('LOCK', 'warning', 'Cannot read the lock file', 'Check file permissions'); }
  // One global plugin installation is shared by every project.
  const manifestFile = path.join(pluginHome(), 'plugin', 'manifest.json');
  try {
    const manifest = await json(manifestFile);
    if (manifest.main !== 'main.js' || manifest.ui !== 'ui.html' || manifest.documentAccess !== 'dynamic-page') throw Error();
    if (session && !manifest.networkAccess?.devAllowedDomains?.includes(`http://localhost:${session.port}`)) throw Error();
    add('PLUGIN_FILES', 'ok', `Plugin manifest: ${manifestFile}`);
  } catch { add('PLUGIN_FILES', 'error', 'Global plugin files are missing or do not match the session port', `Run connect again; import ${manifestFile} in Figma (once globally)`); }
  if (!session) return report();
  try {
    const { status, ok, data } = await call(cwd, '/status', undefined, 3000);
    if (status === 403) { add('BRIDGE_AUTH', 'error', 'The bridge rejected the current session token', 'An old bridge process may be running for this directory; run stop, then connect'); return report(); }
    if (!ok || data.sessionId !== session.sessionId || data.binding?.id !== binding.id) { add('BRIDGE_IDENTITY', 'error', 'The online bridge does not match the local session or binding', 'Check the working directory and the bridge terminal'); return report(); }
    add('BRIDGE', 'ok', `Bridge online (PID ${data.pid})`);
    // Classify rejected plugin requests using the shared reason codes so diagnostics identify the connection issue.
    // Multiple causes may coexist: order them by remedy and offer instructions for the first only. FOREIGN_JOB must come first because
    // that instance holds a real result for another project; reopening the plugin to address another cause would lose it.
    const ISSUES = {
      FOREIGN_JOB: ['The plugin holds a job from another project and does not take jobs from this project for now', 'Go back to that project and run figma-agent-control connect so the result is delivered; if it is no longer needed, close the plugin in Figma and rerun it (the original project then treats the job as unresolved)'],
      PAIRING_MISMATCH: ['A plugin with a mismatched pairing token is running in Figma, most likely an old same-name plugin imported per project', `In Figma, Plugins -> Development, remove the old Figma Agent Control, import ${manifestFile}, then run it in the bound file`],
      NO_FILE_KEY: ['The plugin cannot read the fileKey of the current file, so it cannot verify that this is the bound file', `Make sure the running plugin is the development plugin imported from ${manifestFile} (private API enabled), open the bound file in Figma Desktop and rerun it`],
      WRONG_FILE: ['A plugin instance is running in another file and does not take jobs from this project', `Open the bound file ${binding.sourceUrl} in Figma and run the Figma Agent Control plugin there`]
    };
    const recent = data.connected ? [] : Object.keys(ISSUES).filter(code => Date.now() - Date.parse(data.pluginIssues?.[code] ?? '') < 120000);
    recent.forEach((code, i) => add(code, i ? 'warning' : 'error', `${ISSUES[code][0]} (last seen ${data.pluginIssues[code]})`, i ? undefined : ISSUES[code][1]));
    // Hidden panels still receive and return tasks through network-driven long polling; report visibility without treating it as a failure.
    if (!recent.length) add('PLUGIN_CONNECTION', data.connected ? 'ok' : 'error', !data.connected ? 'Plugin not connected' : data.connectionState === 'BACKGROUND' ? 'Plugin connected (panel hidden)' : 'Plugin connected',
      data.connected ? undefined : `Open the bound file in Figma and run the Figma Agent Control plugin; first use on this machine requires importing ${manifestFile}`);
    // Enqueueing claims active; only plugin delivery changes state to running. Do not call queued work "executing" (jobs may briefly lack the entry during enqueue persistence; treat it as queued).
    if (data.active) {
      const running = data.jobs?.find(job => job.id === data.active)?.state === 'running';
      add('ACTIVE_JOB', 'warning', running ? `Job ${data.active} is running` : `Job ${data.active} is queued; the plugin has not taken it yet`,
        `Run figma-agent-control wait ${data.active} ${running ? 'to read the result' : 'to wait for the plugin to take and run it'}; do not replay the script`);
    }
    if (data.unresolved?.length) add('UNRESOLVED_JOB', 'error', 'An unresolved write exists, so new runs are blocked', 'Confirm the previous plugin has stopped, inspect the original target, then end the wait with resolve');
  } catch (error) { add(error.code ?? 'BRIDGE_UNREACHABLE', 'error', error.message); }
  return report();
}
