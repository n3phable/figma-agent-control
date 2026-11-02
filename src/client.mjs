/**
 * [INPUT]: Imports node:fs/promises, node:path, node:timers/promises, ./project.mjs, ./session.mjs.
 * [OUTPUT]: Exports readSession, call, stop.
 * [POS]: CLI-side transport and bridge shutdown; result interpretation stays in the evidence layer.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, json } from './project.mjs';
import { emptyLock } from './session.mjs';

/** @param {string} file */
const exists = file => fs.access(file).then(() => true, () => false);

/** @param {string} message @param {string} code */
const fail = (message, code) => Object.assign(Error(message), { code });

/** @param {string} cwd */
export async function readSession(cwd) {
  try { return await json(path.join(root(cwd), 'session.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw fail('No running bridge session in the current directory; run figma-agent-control connect first (init first if not initialized), or diagnose with doctor', 'NO_SESSION');
    throw error;
  }
}

// fetch failure details live in error.cause.code; sandbox rejection and a stopped bridge require different remedies.
/** @param {Error & { cause?: { code?: string }, code?: string }} error */
function networkError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (['EPERM', 'EACCES'].includes(/** @type {string} */ (code))) return fail('Cannot reach the local bridge: the current environment blocks localhost networking; rerun this command with elevated permissions', 'SANDBOX_BLOCKED');
  if (code === 'ECONNREFUSED') return fail('Bridge not running: the session file exists but the port does not respond; run figma-agent-control doctor to diagnose, and connect again if needed', 'BRIDGE_DOWN');
  if (error?.name === 'TimeoutError') return fail('Bridge response timed out; run figma-agent-control status to check its state', 'BRIDGE_TIMEOUT');
  return fail(`Failed to reach the bridge: ${error?.message}${code ? ` (${code})` : ''}`, code ?? 'BRIDGE_UNREACHABLE');
}

// data is a bridge JSON response; its shape and the caller's interpretation depend on the route.
/** @param {string} cwd @param {string} route @param {unknown} [body] @returns {Promise<{ status: number, ok: boolean, data: any }>} */
export async function call(cwd, route, body, timeoutMs = 10000) {
  const session = await readSession(cwd);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${session.port}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.token }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) { throw networkError(error); }
  return { status: response.status, ok: response.ok, data: await response.json() };
}

// -- Stopping -----------------------------------------------------------
// Stopping affects only the local bridge process: it sends no Figma operation and does not touch Figma cloud synchronization.
// Without a session, inspect the lock: an empty lock does not mean "not running".
/** @param {string} cwd */
export async function stop(cwd, force = false) {
  const lockFile = path.join(root(cwd), 'bridge.lock');
  let session;
  try { session = await readSession(cwd); }
  catch (error) {
    if (error.code !== 'NO_SESSION') throw error;
    let pid = null;
    try { pid = (await fs.readFile(lockFile, 'utf8')).trim(); } catch (lockError) { if (lockError.code !== 'ENOENT') throw lockError; }
    if (pid !== null) throw pid ? fail(`No session file, but bridge.lock exists (PID ${pid}); run figma-agent-control doctor and check before acting`, 'LOCK_WITHOUT_SESSION') : emptyLock();
    return { bridge: 'not-running', exitCode: 0 };
  }
  const { status, data } = await call(cwd, '/shutdown', { force });
  if (status === 409) return { bridge: 'running', ...data, exitCode: 1 };
  if (status !== 202) throw fail(data?.error ?? `Stop request rejected (HTTP ${status})`, 'STOP_REJECTED');
  let released = false;
  for (let i = 0; i < 100 && !released; i++) {
    try { await fs.access(lockFile); await delay(50); } catch (error) { if (error.code !== 'ENOENT') throw error; released = true; }
  }
  const result = released && data.active && await exists(path.join(root(cwd), 'runs', data.active, 'result.json'))
    ? await json(path.join(root(cwd), 'runs', data.active, 'result.json')) : null;
  return { bridge: released ? 'stopped' : 'stopping', pid: data.pid, sessionId: session.sessionId, activeJob: data.active, unresolved: data.unresolved,
    document: 'not modified: stop sends no operation to Figma', cloudSync: 'not affected: sync is handled by Figma itself and this tool cannot verify it',
    plugin: 'a plugin panel that is still open shows that it is reconnecting; it reattaches automatically after connect, no reopen needed',
    ...(data.active ? { recovery: !released ? `Job ${data.active} is still finishing; check it later with figma-agent-control wait ${data.active}`
      : result?.executionStarted === false ? `Job ${data.active} is explicitly recorded as not executed and may be resubmitted`
      : result ? `Job ${data.active} has saved its execution result; read it with figma-agent-control result ${data.active}; do not replay the script`
      : `Recovery instruction written for running job ${data.active}: ${(await json(path.join(root(cwd), 'runs', data.active, 'recovery.json')).catch(() => null))?.instruction ?? 'after reconnecting, inspect first; do not replay the script'}` } : {}),
    ...(released ? {} : { note: 'The bridge is still shutting down; run figma-agent-control status later to confirm' }), exitCode: released ? 0 : 2 };
}
