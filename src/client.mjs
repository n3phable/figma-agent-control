/**
 * [INPUT]: Imports node:fs/promises, node:path, node:timers/promises, ./project.mjs, ./session.mjs.
 * [OUTPUT]: Exports readSession, call.
 * [POS]: CLI-side transport and bridge shutdown; result interpretation stays in the evidence layer.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, json } from './project.mjs';
import { emptyLock } from './session.mjs';

const exists = file => fs.access(file).then(() => true, () => false);

const fail = (message, code) => Object.assign(Error(message), { code });

export async function readSession(cwd) {
  try { return await json(path.join(root(cwd), 'session.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw fail('No running bridge session in the current directory; run figma-agent-control connect first (init first if not initialized), or diagnose with doctor', 'NO_SESSION');
    throw error;
  }
}

// fetch failure details live in error.cause.code; sandbox rejection and a stopped bridge require different remedies.
function networkError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (['EPERM', 'EACCES'].includes(code)) return fail('Cannot reach the local bridge: the current environment blocks localhost networking; rerun this command with elevated permissions', 'SANDBOX_BLOCKED');
  if (code === 'ECONNREFUSED') return fail('Bridge not running: the session file exists but the port does not respond; run figma-agent-control doctor to diagnose, and connect again if needed', 'BRIDGE_DOWN');
  if (error?.name === 'TimeoutError') return fail('Bridge response timed out; run figma-agent-control status to check its state', 'BRIDGE_TIMEOUT');
  return fail(`Failed to reach the bridge: ${error?.message}${code ? ` (${code})` : ''}`, code ?? 'BRIDGE_UNREACHABLE');
}

export async function call(cwd, route, body, timeoutMs = 10000) {
  const session = await readSession(cwd);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${session.port}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.token }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) { throw networkError(error); }
  return { status: response.status, ok: response.ok, data: await response.json() };
}
