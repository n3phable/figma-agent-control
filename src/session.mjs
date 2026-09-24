/**
 * [INPUT]: Imports node:fs/promises, node:path, node:crypto, ./project.mjs.
 * [OUTPUT]: Exports pairingToken, NOT_DELIVERED, ABANDONED, unfinishedOperations, emptyLock, validPid, acquireLock.
 * [POS]: Owns pairing, exclusive bridge locks and recovery of unfinished disk records.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { json, save, writeAtomic, isJobId } from './project.mjs';

// -- Pairing credentials ------------------------------------------------
// Plugin credentials survive bridge restarts, allowing reconnection without reopening the plugin; CLI credentials rotate each startup. Never print the pairing file.
// First creation is exclusive: concurrent connect calls reuse the winner's credential instead of overwriting the one already installed in the plugin.
/** @param {string} dir */
export async function pairingToken(dir) {
  const file = path.join(dir, 'pairing.json');
  const invalid = () => Object.assign(Error(`Pairing token file is corrupt or an invalid link: delete ${file}, rerun figma-agent-control connect, and rerun the plugin in Figma`), { code: 'PAIRING_INVALID' });
  const read = async () => {
    let value;
    try { value = await json(file); }
    catch (error) { if (error instanceof SyntaxError) throw invalid(); if (error.code === 'ENOENT') return null; throw error; }
    if (!/^[a-f0-9]{64}$/.test(value?.token || '')) throw invalid();
    await fs.chmod(file, 0o600);
    return value.token;
  };
  const existing = await read();
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  try { await writeAtomic(file, JSON.stringify({ token }, null, 2) + '\n', { exclusive: true }); return token; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Lost exclusive creation: read the winner's credential. If still unreadable, the path is invalid (for example a dangling symlink); retrying would only spin.
    const winner = await read();
    if (!winner) throw invalid();
    return winner;
  }
}

// Two result.json non-execution reasons: undelivered before shutdown, or a new instance taking over a disconnected read-only task. html extraction matches them exactly as interruptions, not failures.
export const NOT_DELIVERED = 'The bridge stopped before the job was delivered to the plugin; the script did not run; it can be resubmitted';
export const ABANDONED = 'The plugin disconnected while running a read-only job and a new plugin instance took over; the document was not modified; it can be resubmitted';

/** @param {string} file */
async function optional(file) {
  try { return await json(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// List tasks whose logs remain running; repair status when result.json already exists, since the result file is the commit point.
// A task directory without job.json means /job stopped before logging and never reached the plugin; skip it.
// /poll atomically persists running before delivery, so queued proves the plugin never received the task; persist a failed result with executed false.
/** @param {string} dir */
async function openRuns(dir) {
  let entries;
  try { entries = await fs.readdir(path.join(dir, 'runs'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const open = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isJobId(entry.name)) continue;
    const run = path.join(dir, 'runs', entry.name);
    const job = await optional(path.join(run, 'job.json'));
    if (!job) continue;
    if (job.id !== entry.name) throw Error('Job record is corrupt and needs checking: ' + entry.name);
    if (!['queued', 'running'].includes(job.state)) continue;
    const result = await optional(path.join(run, 'result.json'));
    if (result) {
      if (result.id !== job.id || typeof result.ok !== 'boolean') throw Error('Job result is corrupt and needs checking: ' + job.id);
      await save(path.join(run, 'job.json'), { ...job, state: result.ok ? 'done' : 'failed', finishedAt: result.finishedAt }, true);
      continue;
    }
    if (job.state === 'queued') {
      const finishedAt = new Date().toISOString();
      await save(path.join(run, 'result.json'), { id: job.id, ok: false, executionStarted: false, error: NOT_DELIVERED, finishedAt }, true);
      await save(path.join(run, 'job.json'), { ...job, state: 'failed', finishedAt }, true);
      continue;
    }
    open.push({ job, run });
  }
  return open;
}

// -- Unresolved tasks ---------------------------------------------------
// Load result-less tasks from the prior session for this binding as recovered, except resolved writes. Late results from old plugins may persist, but tasks cannot be redelivered, approved or started again.
// Writes may have executed without proof, so bridge adds them to unresolved and forbids automatic delivery or replay. Read-only tasks can be resubmitted and do not block new runs.
// Never reload writes with resolution records, regardless of binding (mismatched records fail startup; late results after restart are treated as foreign). Unresolved writes for other bindings fail startup; foreign read-only tasks are ignored.
/** @param {string} dir @param {string} bindingId */
export async function unfinishedOperations(dir, bindingId) {
  const pending = [];
  for (const { job, run } of await openRuns(dir)) {
    if (job.operation === 'run') {
      const resolution = await optional(path.join(run, 'resolution.json'));
      if (resolution) {
        if (resolution.id !== job.id || resolution.bindingId !== job.bindingId || resolution.status !== 'reviewed-without-replay' || resolution.previousPluginStopped !== true || !isJobId(resolution.inspectId)) throw Error('Job verification record is corrupt and needs checking: ' + job.id);
        continue;
      }
      if (job.bindingId !== bindingId) throw Error('An unconfirmed write job for another target exists; check it first');
    } else if (job.bindingId !== bindingId) continue;
    pending.push({ ...job, state: 'running', recovered: true });
  }
  return pending;
}

// -- Single-instance lock -----------------------------------------------
// Only ESRCH proves process exit; EPERM and other errors count as alive. PIDs may be reused, so the tool never kills processes.
/** @param {string} pid */
const running = pid => Object.assign(Error(pid
  ? `PID ${pid} recorded in bridge.lock is still alive: to restart, run figma-agent-control stop first; if stop reports BRIDGE_DOWN or no session, and ps -p ${pid} shows something other than figma-agent-control (the PID was reused), delete .figma-agent-control/bridge.lock and retry`
  : 'Another connect is reclaiming the old lock; retry shortly. If no other figma-agent-control process exists, delete .figma-agent-control/bridge.lock.takeover and retry'), { code: 'BRIDGE_RUNNING' });
// An empty lock means another connect is between creation and writing its PID, not an absent session or reclaimable stale lock. client.stop and doctor use the same conclusion.
export const emptyLock = () => Object.assign(Error('bridge.lock is empty: another connect may be writing its PID; retry shortly. If no other figma-agent-control process exists, delete .figma-agent-control/bridge.lock and retry'), { code: 'BRIDGE_RUNNING' });
// Valid PIDs are positive safe integers. Never probe invalid values: Number('0') would make kill(0, 0) target this process group. doctor shares the predicate.
/** @param {string} raw */
export const validPid = raw => /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw));
/** @param {string} raw */
function alive(raw) {
  if (!validPid(raw)) throw Error('Invalid PID in bridge.lock; check it manually. No files were cleaned up');
  try { process.kill(Number(raw), 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** @param {string} file */
async function openLock(file) {
  let lock;
  try { lock = await fs.open(file, 'wx', 0o600); }
  catch (error) { throw error.code === 'EEXIST' ? running('') : error; }
  try { await lock.writeFile(String(process.pid)); return lock; }
  catch (error) { await lock.close(); await fs.unlink(file); throw error; }
}

// After an abnormal bridge exit, add recovery guidance to unfinished tasks (wait immediately returns pending verification), archive the lock and report, then reacquire the lock.
/** @param {string} dir @param {string} raw */
async function archiveStale(dir, raw) {
  const recoveryId = crypto.randomUUID(), recoveredAt = new Date().toISOString(), archive = path.join(dir, 'recoveries', recoveryId);
  const unfinished = [];
  for (const { job, run } of await openRuns(dir)) {
    if (await optional(path.join(run, 'resolution.json')) || await optional(path.join(run, 'recovery.json'))) continue;
    await save(path.join(run, 'recovery.json'), { status: 'needs-document-review', recoveredAt, recoveryId, recordedState: job.state,
      instruction: 'The previous bridge exited and the result is unresolved; after reconnecting, inspect the document first; do not replay the script' });
    unfinished.push(job.id);
  }
  await save(path.join(archive, 'report.json'), { recoveryId, recoveredAt, previousPid: Number(raw), unfinishedRunIds: unfinished, documentModified: false });
  await fs.rename(path.join(dir, 'bridge.lock'), path.join(archive, 'bridge.lock'));
  return { recoveryId, unfinished };
}

// Serialize takeover: only the process that exclusively creates the takeover marker may archive. Reread the lock afterward; changed content means another process already took over.
// ponytail: A crash during takeover leaves the marker behind; later connect reports BRIDGE_RUNNING with manual removal guidance. Add a PID to the marker if this occurs in practice.
/** @param {string} dir */
export async function acquireLock(dir) {
  const file = path.join(dir, 'bridge.lock'), takeover = file + '.takeover';
  try { return { lock: await openLock(file), recovered: null }; }
  catch (error) { if (error.code !== 'BRIDGE_RUNNING') throw error; }
  const read = () => fs.readFile(file, 'utf8').then(text => text.trim(), error => { if (error.code === 'ENOENT') return ''; throw error; });
  const raw = await read();
  if (!raw) throw emptyLock();
  if (alive(raw)) throw running(raw);
  let marker;
  try { marker = await fs.open(takeover, 'wx', 0o600); }
  catch (error) { throw error.code === 'EEXIST' ? running('') : error; }
  try {
    if (await read() !== raw) throw running('');
    const recovered = await archiveStale(dir, raw);
    return { lock: await openLock(file), recovered };
  } finally { await marker.close(); await fs.unlink(takeover); }
}
