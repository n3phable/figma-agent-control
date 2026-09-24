/**
 * [INPUT]: Imports node:path, ../client.mjs, ../record.mjs, ../session.mjs, ../project.mjs.
 * [OUTPUT]: Exports RETRY_MS, fromJob, readLanded, submit, awaitLanded.
 * [POS]: Submits extraction jobs and classifies their persisted outcomes for command workflows.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import path from 'node:path';
import { call as bridgeCall } from '../client.mjs';
import { localResult, waitForResult } from '../record.mjs';
import { NOT_DELIVERED, ABANDONED } from '../session.mjs';
import { root, json, readBinding } from '../project.mjs';
/** @import { LandedExtractOutput } from './extract-contract.js' */

/** @typedef {{ now(): number, sleep(ms: number): Promise<unknown> }} Clock  Matches record.waitForResult's clock shape. */
/** @typedef {{ kind: 'retry' | 'fatal', code: string, message: string, active?: string }} Stop  Why submission stopped: retry permits continuation; fatal requires environment repair first. */
/** @typedef {{ id: string, output: LandedExtractOutput, dir: string }} Landed  dir is the task directory, the base for file descriptors. */
/** @typedef {{ landed: Landed } | { failed: { id: string, message: string } } | { pending: { id: string } } | { interrupted: { id: string } }} Outcome */

// Retry disconnected plugins, including outdated instances reconnecting, after 1, 2 and 4 s. Hot reload and newly opened panels commonly recover quickly.
export const RETRY_MS = [1000, 2000, 4000];

// -- Reading evidence ---------------------------------------------------
// --from preflight reads only job.json and binding for an omitted target. Read results per frame later so failures affect only that frame.
/** @param {string} cwd @param {string} id @returns {Promise<{ id: string, node: string }>} */
export async function fromJob(cwd, id) {
  const job = await json(path.join(root(cwd), 'runs', id, 'job.json')).catch(() => null);
  if (job?.id !== id) throw Error(`--from job does not exist or its evidence is incomplete: ${id}`);
  if (job.operation !== 'extract') throw Error(`--from only accepts extract jobs: ${id} is ${job.operation}`);
  const scale = job.scale ?? 1;
  if (scale !== 1) throw Error(`--from only accepts extracts with scale 1: ${id} has scale ${scale}`);
  return { id, node: job.targetNodeId ?? (await readBinding(cwd)).nodeId };
}

// Classify interruption using exact bridge-generated completion messages before handling deterministic failures.
// Other failures, such as budget violations, are deterministic and would simply repeat; do not treat them as interruptions. executionStarted cannot distinguish them because all extract failures report false.
/** @param {Awaited<ReturnType<typeof localResult>>} record @returns {Outcome} */
function classify({ job, result, recovery, resolution, evidence }) {
  const id = job.id;
  if (result?.ok === true && !result.binaryErrors?.length) return { landed: { id, output: /** @type {LandedExtractOutput} */ (result.output), dir: evidence } };
  if (result?.ok === false && (result.error === NOT_DELIVERED || result.error === ABANDONED)) return { interrupted: { id } };
  if (result) return { failed: { id, message: result.ok === false ? String(result.error) : `Binary files not fully written to disk: ${result.binaryErrors[0]}` } };
  if (recovery || resolution) return { interrupted: { id } };
  return { pending: { id } };
}

/** Read a persisted task without waiting. @param {string} cwd @param {string} id @returns {Promise<Outcome>} */
export const readLanded = async (cwd, id) => classify(await localResult(cwd, id));

// -- Submission ---------------------------------------------------------
// On success, write one task-ID receipt to stderr, as other submission commands do. External timeouts can then resume with wait or --from without resubmission.
// 409: exhausted RECONNECTING retries and ACTIVE_JOB permit continuation without preemption. Other 409s, such as BRIDGE_STOPPING, and bridge access failures require environment repair.
// Other non-2xx responses reject invalid request content and affect only this frame.
/**
 * @param {string} cwd @param {{ node: string, islands?: string[] }} request Omit islands when empty.
 * @param {{ clock: Clock, stderr: (line: string) => void, call?: typeof bridgeCall }} deps
 * @returns {Promise<{ id: string } | { stop: Stop } | { rejected: string }>}
 */
export async function submit(cwd, { node, islands = [] }, { clock, stderr, call = bridgeCall }) {
  const body = { operation: 'extract', targetNodeId: node, ...(islands.length ? { islands } : {}) };
  for (let attempt = 0; ; attempt++) {
    let response;
    try { response = await call(cwd, '/job', body); }
    catch (error) { return { stop: { kind: 'fatal', code: error.code ?? 'COMMAND_FAILED', message: error.message } }; }
    const { status, ok, data } = response;
    if (ok) {
      stderr(JSON.stringify({ submitted: data.id, next: `figma-agent-control wait ${data.id}` }));
      return { id: data.id };
    }
    if (status !== 409) return { rejected: data?.error ?? `Bridge rejected the request (HTTP ${status})` };
    const code = String(data?.code ?? 'CONFLICT');
    if (code === 'RECONNECTING' && attempt < RETRY_MS.length) { await clock.sleep(RETRY_MS[attempt]); continue; }
    return { stop: { kind: code === 'RECONNECTING' || code === 'ACTIVE_JOB' ? 'retry' : 'fatal', code, message: data?.error ?? `HTTP 409 ${code}`, ...(data?.active ? { active: data.active } : {}) } };
  }
}

// -- Waiting ------------------------------------------------------------
// Observe evidence files only; classify returns pending when the deadline arrives without a result or recovery guidance.
/** @param {string} cwd @param {string} id @param {number} seconds Integer from 1 to 300. @param {Clock} clock @returns {Promise<Outcome>} */
export async function awaitLanded(cwd, id, seconds, clock) {
  return classify(await waitForResult(cwd, id, seconds, /** @type {Parameters<typeof waitForResult>[3]} */ (clock)));
}
