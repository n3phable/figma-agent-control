/**
 * [INPUT]: src/bridge start for a real bridge with random ports and an injectable clock; src/project init/root/json; src/session pairingToken.
 * [OUTPUT]: Exports fixture(t) with boot/restart and CLI/plugin/poll/status/submit/deliver/finish requests, send(port, route, options), FIGMA_URL, OPTIONS, RUN, uuid, verified, and exists.
 * [POS]: Shared bridge contract fixture for bridge.test.mjs and bridge-session.test.mjs. Fetch acts as CLI with session.json credentials or plugin with global pairing.json credentials, the reported version, and current file; no plugin code runs.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start } from '../../src/bridge.mjs';
import { init, root, json } from '../../src/project.mjs';
import { pairingToken } from '../../src/session.mjs';

export const FIGMA_URL = 'https://www.figma.com/design/example/Test?node-id=1-2';
export const OPTIONS = { timeout: 10000 };
export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const verified = nodeId => ({ fileKey: 'example', pageId: '1:1', nodeId });
export const RUN = { operation: 'run', code: 'return 1;' };
export const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export async function send(port, route, { token, version, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers['X-Session-Token'] = token;
  if (version !== undefined) headers['X-Plugin-Version'] = version;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

// Real bridge with both roles. The injected clock keeps connection freshness dependent only on b.clock, not execution speed.
export async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-bridge-'));
  await init(cwd, FIGMA_URL);
  const dir = root(cwd);
  // Follow connect: read plugin credentials from the global directory, replaced here by the test-owned temporary directory.
  const b = { cwd, dir, home: path.join(cwd, 'plugin-home'), clock: 0, run: id => path.join(dir, 'runs', id) };
  b.boot = async () => {
    b.pairing = await pairingToken(b.home);
    b.bridge = await start(cwd, 0, { now: () => b.clock, pollHoldMs: 0, pluginToken: b.pairing });
    b.token = (await json(path.join(dir, 'session.json'))).token;
  };
  b.restart = async () => { await b.bridge.close(); await b.boot(); };
  await b.boot();
  t.after(async () => { await b.bridge.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  b.send = (route, options) => send(b.bridge.port, route, options);
  b.cli = (route, body) => send(b.bridge.port, route, { token: b.token, body });
  b.plugin = (route, body) => send(b.bridge.port, route, { token: b.pairing, version: b.bridge.version, body });
  b.poll = () => b.plugin('/poll?client=plugin&file=example');
  b.status = async () => (await b.cli('/status')).body;
  b.submit = async body => { const r = await b.cli('/job', body); assert.equal(r.status, 202, JSON.stringify(r.body)); return r.body.id; };
  b.deliver = async body => { const id = await b.submit(body); const job = (await b.poll()).body; assert.equal(job?.id, id); return job; };
  b.finish = async (body, completion) => {
    const job = await b.deliver(body);
    const r = await b.plugin('/complete', { id: job.id, ...completion });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: job.id, job, result: await json(path.join(b.run(job.id), 'result.json')) };
  };
  return b;
}
