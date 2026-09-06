/**
 * [INPUT]: Imports node:http, node:fs/promises, node:path, node:crypto, node:url, ./project.mjs, ./connection.mjs, ./session.mjs, ./png.mjs, ./record.mjs.
 * [OUTPUT]: Exports DEFAULT_PORT, start.
 * [POS]: Owns authenticated CLI/plugin transport, single-job delivery and durable outcomes.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { json, root, save, hash, isJobId, isNodeId, readBinding } from './project.mjs';
import { createConnection } from './connection.mjs';
import { unfinishedOperations, acquireLock, NOT_DELIVERED } from './session.mjs';
import { pngSize, imageStats, diffPng } from './png.mjs';
import { changeSet } from './record.mjs';

export const DEFAULT_PORT = 32523;
const assets = fileURLToPath(new URL('../plugin/', import.meta.url));
const OPERATIONS = new Set(['run', 'inspect', 'preview', 'variables']);
const PLUGIN_ROUTES = new Set(['/poll', '/heartbeat', '/checkpoint', '/approve', '/complete']);
const BINARY_KEY = '__figmaAgentControlBinary';
// Pixel decoding blocks the event loop: skip summaries above 16 million pixels per image or 32 million per task.
const PIXEL_LIMIT = 16e6, JOB_PIXEL_LIMIT = 32e6;

const normalizeRisk = risk => risk?.level === 'high' ? { level: 'high', reason: risk.reason } : { level: 'normal' };
// A requestId must always describe identical work: resubmission retrieves the original job and cannot run different content under the old ID.
const specKey = job => JSON.stringify([job.bindingId, job.operation, job.code ?? '', job.libs ?? [], job.targetNodeId ?? null, job.snapshotDepth ?? null,
  job.nodes ?? null, job.scale ?? null, job.data ?? null, normalizeRisk(job.risk), job.expect ?? null, job.tolerance ?? null]);

// -- Task validation ----------------------------------------------------
// Pure normalization of CLI requests into task records; reject every out-of-range field.
function buildJob(data, binding) {
  if (!OPERATIONS.has(data.operation)) throw Error('Unknown operation');
  const run = data.operation === 'run';
  if (data.targetNodeId !== undefined && !isNodeId(data.targetNodeId)) throw Error('Invalid local target ID');
  if (run && (typeof data.code !== 'string' || !data.code.trim())) throw Error('Missing trusted script');
  if (!run && data.code) throw Error('Only run accepts a script');
  if (data.libs !== undefined && (!run || !Array.isArray(data.libs) || data.libs.length > 20 || data.libs.some(lib => typeof lib?.name !== 'string' || !lib.name || lib.name.length > 200 || typeof lib.code !== 'string')
    || data.libs.reduce((n, lib) => n + Buffer.byteLength(lib.code), 0) > 2 * 1024 * 1024)) throw Error('libs is only for run: at most 20, total <= 2 MiB (UTF-8)');
  if (data.snapshotDepth !== undefined && (!['run', 'inspect'].includes(data.operation) || !Number.isInteger(data.snapshotDepth) || data.snapshotDepth < 1 || data.snapshotDepth > 31)) throw Error('snapshotDepth is only for run or inspect and must be an integer 1-31');
  if (data.nodes !== undefined && (data.operation !== 'preview' || !Array.isArray(data.nodes) || data.nodes.length < 2 || data.nodes.length > 50 || data.nodes.some(id => !isNodeId(id)) || new Set(data.nodes).size !== data.nodes.length || data.nodes[0] !== (data.targetNodeId ?? binding.nodeId))) throw Error('nodes is only for preview: 2-50 unique node IDs, the first equal to the target node');
  if (data.expect !== undefined && (!run || !['changed', 'unchanged'].includes(data.expect))) throw Error('expect is only for run: changed or unchanged');
  if (data.tolerance !== undefined && (data.expect === undefined || !Number.isInteger(data.tolerance) || data.tolerance < 0 || data.tolerance > 1e8)) throw Error('tolerance requires expect and must be a non-negative integer pixel count');
  if (data.scale !== undefined && ((data.operation !== 'preview' && data.expect === undefined) || typeof data.scale !== 'number' || !Number.isFinite(data.scale) || data.scale < 0.1 || data.scale > 4)) throw Error('scale is for preview or run with expect and must be between 0.1 and 4');
  if (data.data !== undefined && (!run || Buffer.byteLength(JSON.stringify(data.data) ?? '') > 1024 * 1024)) throw Error('data is only for run; JSON <= 1 MiB (UTF-8)');
  if (data.label !== undefined && (typeof data.label !== 'string' || !data.label.trim() || data.label.length > 200)) throw Error('label must be non-empty text of <= 200 characters');
  const risk = normalizeRisk(data.risk);
  if (data.risk !== undefined && !['normal', 'high'].includes(data.risk?.level)) throw Error('Invalid risk declaration');
  if (risk.level === 'high' && (!run || typeof risk.reason !== 'string' || !risk.reason.trim() || risk.reason.length > 1000)) throw Error('A high-risk declaration is only for run and needs a reason of <= 1000 characters');
  if (data.requestId !== undefined && !isJobId(data.requestId)) throw Error('requestId must be a UUID');
  const optional = Object.fromEntries(['libs', 'targetNodeId', 'snapshotDepth', 'nodes', 'scale', 'label', 'data', 'expect', 'tolerance'].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  const code = run ? data.code : '';
  return { id: data.requestId ?? crypto.randomUUID(), operation: data.operation, code, ...optional, risk, state: 'queued', createdAt: new Date().toISOString(),
    scriptHash: hash(JSON.stringify([data.libs ?? [], code])), bindingId: binding.id };
}

// Long polling: /poll waits up to 10 s without available work and wakes on enqueue. Hidden plugin panels throttle timers to roughly one minute,
// but network-driven continuation is unaffected. Poll duration stays below the 15 s foreground lease, keeping connection state fresh.
const POLL_HOLD_MS = 10000;
// A plugin task belongs to another project, since the global plugin serves all projects: retain the result in the plugin until its original bridge returns.
const FOREIGN_JOB = { code: 'FOREIGN_JOB', error: 'The plugin holds a job from another project; run connect in that project to deliver its result before this project\'s jobs can be claimed' };

export async function start(cwd, port = DEFAULT_PORT, { pluginToken, pollHoldMs = POLL_HOLD_MS, ...connectionOptions } = {}) {
  const dir = root(cwd), binding = await readBinding(cwd);
  if (!/^[a-f0-9]{64}$/.test(pluginToken ?? '')) throw Error('Invalid plugin pairing token');
  const tokens = { cli: crypto.randomBytes(32).toString('hex'), plugin: pluginToken };
  const sessionId = crypto.randomUUID(), connection = createConnection(connectionOptions);
  const main = await fs.readFile(path.join(assets, 'main.js'), 'utf8'), uiTemplate = await fs.readFile(path.join(assets, 'ui.html'), 'utf8');
  // Version handshake: every plugin request carries the asset hash. Reject old instances after updates so old semantics cannot execute a new protocol.
  const version = hash(main + uiTemplate).slice(0, 16);
  // pluginIssues records recent request rejection times per reason for status and doctor, covering plugins that reached the bridge but could not acquire a connection.
  // Concurrent instances can have different causes (a foreign task in the bound file and an idle plugin in another file); one shared slot would overwrite evidence.
  let active = null, stopping = false;
  const pluginIssues = {}, noteIssue = code => { pluginIssues[code] = new Date().toISOString(); };
  // Response headers tell the global plugin which project and binding this bridge serves; bindings no longer live in generated plugin files.
  // Headers must be ASCII: project directory names may contain non-ASCII characters, encoded as JSON \uXXXX escapes and restored by plugin JSON.parse.
  const bindingHeader = JSON.stringify({ fileKey: binding.fileKey, nodeId: binding.nodeId, project: path.basename(path.resolve(cwd)) })
    .replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const jobs = new Map(), unresolved = new Set();
  const completing = new Map(), checkpoints = new Map(), approvals = new Map(), deliveries = new Map(), waiters = new Set();
  const wakePolls = () => { for (const wake of [...waiters]) wake(); };
  const runDir = id => path.join(dir, 'runs', id);
  const optional = async file => { try { return await json(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

  // -- File-backed evidence -----------------------------------------------
  const bytesOf = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error('Invalid binary data');
    return Buffer.from(value, 'base64');
  };
  const writeFile = async (job, file, bytes) => {
    await fs.mkdir(path.dirname(path.join(runDir(job.id), file)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(runDir(job.id), file), bytes, { mode: 0o600 });
    return { file, bytes: bytes.length, sha256: hash(bytes) };
  };
  const pixelSummary = (bytes, budget) => {
    try {
      const { width, height } = pngSize(bytes);
      if (width * height > PIXEL_LIMIT || budget.used + width * height > JOB_PIXEL_LIMIT) return { pixels: { skipped: 'too-large' } };
      budget.used += width * height;
      return { pixels: imageStats(bytes) };
    } catch { return {}; }
  };
  // preview writes images/ in request order; results contain only paths, dimensions and pixel summaries.
  async function saveImages(job, data, budget) {
    const expected = job.nodes ?? [job.targetNodeId ?? binding.nodeId];
    if (job.operation !== 'preview' || !Array.isArray(data.images) || data.images.length !== expected.length || data.images.some((image, i) => image?.nodeId !== expected[i])) throw Error('Preview images do not match the requested nodes');
    data.images = await Promise.all(data.images.map(async (image, i) => {
      const bytes = bytesOf(image.base64), size = pngSize(bytes);
      return { nodeId: image.nodeId, name: String(image.name ?? '').slice(0, 200), ...await writeFile(job, `images/${i + 1}-${image.nodeId.replace(/[^0-9A-Za-z]+/g, '-')}.png`, bytes), ...size, ...pixelSummary(bytes, budget) };
    }));
  }
  // Persist run byte arrays as files/output-<n>.<ext> and replace placeholders with file descriptors.
  // Scripts have already executed, so content defects must not block evidence persistence: record invalid data or placeholders in binaryErrors and save the rest.
  async function saveBinaries(job, data, budget) {
    const errors = [], list = job.operation === 'run' && Array.isArray(data.binaries) ? data.binaries.slice(0, 200) : [];
    if (list.length !== (Array.isArray(data.binaries) ? data.binaries.length : -1)) errors.push('Binary return values are invalid or exceed 200');
    const saved = await Promise.all(list.map(async (value, i) => {
      let bytes;
      try { bytes = bytesOf(value); } catch { errors.push(`Binary value ${i + 1} is invalid`); return null; }
      const head = bytes.subarray(0, 8).toString('latin1');
      let size = null;
      if (head.startsWith('\x89PNG')) { try { size = pngSize(bytes); } catch { size = null; } }
      const type = size ? 'png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' : head.startsWith('%PDF') ? 'pdf' : /^\s*(?:<\?xml|<svg)/.test(bytes.subarray(0, 64).toString('utf8')) ? 'svg' : 'bin';
      return { ...await writeFile(job, `files/output-${i + 1}.${type}`, bytes), type, ...(size ? { ...size, ...pixelSummary(bytes, budget) } : {}) };
    }));
    const used = new Set();
    const replace = value => {
      if (Array.isArray(value)) return value.map(replace);
      if (!value || typeof value !== 'object') return value;
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === BINARY_KEY) {
        const file = Number.isInteger(value[BINARY_KEY]) ? saved[value[BINARY_KEY]] : null;
        if (!file) { errors.push('Invalid binary placeholder: ' + JSON.stringify(value[BINARY_KEY])); return { binaryUnavailable: true }; }
        used.add(value[BINARY_KEY]); return file;
      }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    };
    data.output = replace(data.output);
    if (used.size !== saved.filter(Boolean).length) errors.push('Binary return values do not match the placeholders');
    delete data.binaries;
    if (errors.length) data.binaryErrors = errors.slice(0, 20);
  }
  // -- Visual verdict -----------------------------------------------------
  // The plugin exports the target before and after the script; compare those images against declared intent. A failed verdict does not change ok:
  // the script completed, but the image missed expectations. CLI returns exit 1 while still forbidding replay.
  async function saveVerdict(job, data) {
    const renders = data.renders;
    delete data.renders;
    if (!job.expect || data.ok !== true) return;
    const tolerance = job.tolerance ?? 0;
    try {
      if (!renders || renders.error) throw Error(renders?.error || 'The plugin did not return before/after renders; rerun the plugin');
      const before = bytesOf(renders.before), after = bytesOf(renders.after);
      for (const size of [pngSize(before), pngSize(after)]) if (size.width * size.height > PIXEL_LIMIT) throw Error('Render exceeds 16 million pixels; lower it with --scale');
      const { image, ...diff } = diffPng(before, after, 0);
      const changed = !diff.sameSize || diff.changedPixels > tolerance;
      const images = { before: (await writeFile(job, 'images/render-before.png', before)).file, after: (await writeFile(job, 'images/render-after.png', after)).file, diff: (await writeFile(job, 'images/render-diff.png', image)).file };
      data.verify = { expect: job.expect, tolerance, pass: job.expect === 'changed' ? changed : !changed, changedPixels: diff.changedPixels, changedRatio: diff.changedRatio,
        changedBounds: diff.changedBounds, maxChannelDelta: diff.maxChannelDelta, sameSize: diff.sameSize, before: diff.before, after: diff.after, images };
    } catch (error) { data.verify = { expect: job.expect, tolerance, pass: false, error: 'Visual check unavailable: ' + error.message }; }
  }
  // -- Commit point -------------------------------------------------------
  // Atomic result.json persistence means completion; job.json is then a derived status update. session repairs it after a crash between the two writes.
  async function persistCompletion(job, data) {
    let result = await optional(path.join(runDir(job.id), 'result.json'));
    if (result && (result.id !== job.id || typeof result.ok !== 'boolean')) throw Error('Existing result.json is invalid; keep the evidence and inspect it');
    if (!result) {
      const budget = { used: 0 };
      if (data.images !== undefined) await saveImages(job, data, budget);
      if (data.binaries !== undefined) await saveBinaries(job, data, budget);
      if (data.renders !== undefined || job.expect) await saveVerdict(job, data);
      if (job.operation === 'run' && data.before !== undefined && data.after !== undefined) {
        try { data.changes = changeSet(data.before, data.after, job.snapshotDepth); }
        catch (error) { data.changes = { unavailable: error.message }; }
      } else if (job.operation === 'run' && data.ok === true && typeof data.afterError === 'string') data.changes = { unavailable: `After-snapshot unavailable (${data.afterError.slice(0, 300)}); verify with preview or inspect --node` };
      delete data.afterError;
      // before already lives in the write-ahead before.json; retain after only for failures after execution, documenting partial writes.
      if (!(data.ok === false && data.executionStarted === true)) delete data.after;
      delete data.before;
      result = { ...data, finishedAt: new Date().toISOString() };
      await save(path.join(runDir(job.id), 'result.json'), result, true);
    }
    const state = result.ok ? 'done' : 'failed';
    await save(path.join(runDir(job.id), 'job.json'), { ...job, state, finishedAt: result.finishedAt }, true);
    Object.assign(job, { state, finishedAt: result.finishedAt });
    unresolved.delete(job.id);
    if (active === job.id) active = null;
  }

  let close;
  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Session-Token,X-Plugin-Version');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Figma-Session,X-Figma-Binding,X-Long-Poll');
    res.setHeader('X-Figma-Session', sessionId);
    if (req.method === 'OPTIONS') return reply(204, null);
    try {
      const u = new URL(req.url, 'http://localhost');
      const role = PLUGIN_ROUTES.has(u.pathname) ? 'plugin' : 'cli';
      if (req.headers['x-session-token'] !== tokens[role]) {
        if (role !== 'plugin') return reply(403, { error: 'Authentication failed' });
        // Invalid plugin credentials usually indicate an old per-project installation with the same name. Record only requests carrying a plugin-version header (simple browser requests cannot set custom headers), and never echo credentials.
        if (req.headers['x-plugin-version']) noteIssue('PAIRING_MISMATCH');
        return reply(403, { code: 'PAIRING_MISMATCH', error: 'Plugin pairing token mismatch: the running plugin is not the Figma Agent Control plugin installed on this machine' });
      }
      if (role === 'plugin' && req.headers['x-plugin-version'] !== version) return reply(409, { code: 'PLUGIN_OUTDATED', error: 'Plugin code has been updated: close the plugin in Figma and run it again' });
      if (role === 'plugin') res.setHeader('X-Figma-Binding', bindingHeader);
      if (req.method === 'GET' && u.pathname === '/status') return reply(200, { sessionId, pid: process.pid, connected: connection.connected, connectionState: connection.state, pollAgeMs: connection.ageMs,
        active, unresolved: [...unresolved], binding, pluginVersion: version, pluginIssues, jobs: [...jobs.values()].slice(-20).map(j => ({ id: j.id, operation: j.operation, state: j.state, ...(j.label ? { label: j.label } : {}) })) });
      if (req.method === 'GET' && ['/poll', '/heartbeat'].includes(u.pathname)) {
        // Only instances in the bound file without foreign tasks acquire the connection. Others receive binding headers for panel guidance but cannot claim tasks or renew leases.
        const file = u.searchParams.get('file');
        if (file !== binding.fileKey) { noteIssue(file ? 'WRONG_FILE' : 'NO_FILE_KEY'); return reply(200, null); }
        const held = u.searchParams.get('job');
        if (held && !jobs.has(held)) { noteIssue('FOREIGN_JOB'); return reply(409, FOREIGN_JOB); }
        const lease = connection.touch(u.searchParams.get('client'), active !== null, u.searchParams.get('visibility') || 'visible');
        if (!lease.ok) return reply(409, { code: lease.code, error: lease.code === 'OPERATION_UNCERTAIN' ? 'The previous operation\'s result is not confirmed yet; repeated execution was blocked' : 'Reconnecting', retryable: lease.code === 'CONNECTION_IN_USE' });
        if (u.pathname === '/heartbeat') return reply(200, { connected: true, active });
        const claimable = () => !stopping && active && jobs.get(active)?.state === 'queued' && !deliveries.has(active);
        if (!claimable() && !stopping && pollHoldMs > 0) {
          await new Promise(resolve => {
            const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
            const timer = setTimeout(wake, pollHoldMs);
            waiters.add(wake);
          });
          // Keep the lease fresh throughout a pending request. If ownership changed unexpectedly, return as though no task exists.
          const client = u.searchParams.get('client');
          if (!connection.owns(client) || !connection.touch(client, active !== null, u.searchParams.get('visibility') || 'visible').ok) return reply(200, null);
          if (!claimable()) { if (!stopping) res.setHeader('X-Long-Poll', '1'); return reply(200, null); }
        }
        const job = active && jobs.get(active);
        if (stopping || !job || job.state !== 'queued' || deliveries.has(job.id)) return reply(200, null);
        // Claim timestamps distinguish queue time from execution time in report summaries.
        const claimedAt = new Date().toISOString();
        const delivery = save(path.join(runDir(job.id), 'job.json'), { ...job, state: 'running', claimedAt }, true);
        deliveries.set(job.id, delivery);
        try { await delivery; Object.assign(job, { state: 'running', claimedAt }); }
        finally { deliveries.delete(job.id); }
        return reply(200, { ...job, binding });
      }
      
      if (req.method !== 'POST') return reply(404, { error: 'Unknown endpoint' });
      const chunks = []; let size = 0;
      // Result uploads may contain images and binary files; all other requests retain a 16 MiB limit.
      const limit = (u.pathname === '/complete' ? 72 : 16) * 1024 * 1024;
      for await (const c of req) { size += c.length; if (size > limit) return reply(413, { error: 'Request too large' }); chunks.push(c); }
      const data = JSON.parse(Buffer.concat(chunks).toString() || 'null') ?? {};
      
      
      
      
      
      
      reply(404, { error: 'Unknown endpoint' });
    } catch (e) { reply(400, { error: e.message }); }
  });

  let sessionTouched = false, plugin;
  // Acquire the single-instance lock after preparation and immediately enter the protected block; the catch below closes and removes the lock on every subsequent failure.
  const { lock, recovered } = await acquireLock(dir);
  try {
    for (const job of await unfinishedOperations(dir, binding.id)) { jobs.set(job.id, job); if (job.operation === 'run') unresolved.add(job.id); }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    port = server.address().port;
    // Plugin configuration contains only port, credentials and version, keeping generated files identical across projects using the same port and version.
    const config = { port, token: tokens.plugin, version };
    // Replace only the script's placeholder line, leaving matching words inside comments alone.
    const ui = uiTemplate.replace('const config = SESSION_CONFIG;', () => `const config = ${JSON.stringify(config)};`);
    if (ui === uiTemplate) throw Error('Plugin UI template is missing the config placeholder');
    const manifest = { name: 'Figma Agent Control', api: '1.0.0', main: 'main.js', ui: 'ui.html', editorType: ['figma'], documentAccess: 'dynamic-page',
      enablePrivatePluginApi: true, networkAccess: { allowedDomains: ['none'], devAllowedDomains: [`http://localhost:${port}`] } };
    plugin = { 'manifest.json': JSON.stringify(manifest, null, 2) + '\n', 'main.js': main, 'ui.html': ui };
    sessionTouched = true;
    await save(path.join(dir, 'session.json'), { port, token: tokens.cli, sessionId, pid: process.pid });
  } catch (error) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (sessionTouched) await fs.rm(path.join(dir, 'session.json'), { force: true });
    await lock.close(); await fs.unlink(path.join(dir, 'bridge.lock'));
    if (error.code === 'EADDRINUSE') throw Object.assign(Error(`Port ${port} is in use: it may be another project's figma-agent-control bridge (run figma-agent-control stop in that directory, or press Ctrl-C in its terminal), or another program (check with lsof -nP -iTCP:${port})`), { code: 'EADDRINUSE' });
    throw error;
  }

  // -- Shutdown -----------------------------------------------------------
  // Wait for active claims, results, snapshots and approvals to persist. If execution remains active, write recovery guidance for unresolved handling on reconnection.
  // Leave plugin files unchanged: pairing credentials survive restart, allowing the plugin to reconnect automatically.
  let closing;
  close = () => closing ??= (async () => {
    stopping = true;
    // Release pending long polls with empty responses before cutting connections.
    wakePolls(); await new Promise(resolve => setImmediate(resolve));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...deliveries.values()]);
    await Promise.allSettled([...completing.values()]);
    await Promise.allSettled([...checkpoints.values()].map(entry => entry.promise));
    await Promise.allSettled([...approvals.values()].map(entry => entry.promise));
    // /poll atomically writes running before delivery; queued here proves the plugin never received the task. Record non-execution without creating an unresolved write.
    const pending = active && jobs.get(active);
    if (pending?.state === 'queued') await persistCompletion(pending, { id: active, ok: false, executionStarted: false, error: NOT_DELIVERED }).catch(() => {});
    else if (active) await save(path.join(runDir(active), 'recovery.json'), { status: 'unknown-after-disconnect', instruction: 'After reconnecting, inspect first; do not replay the script' });
    await fs.rm(path.join(dir, 'session.json'), { force: true });
    await lock.close(); await fs.unlink(path.join(dir, 'bridge.lock'));
  })();
  return { port, close, version, recovered, plugin };
}
