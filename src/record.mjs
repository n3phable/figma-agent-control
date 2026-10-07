/**
 * [INPUT]: Imports node:fs/promises, node:path, node:util, node:timers/promises, node:perf_hooks, ./project.mjs.
 * [OUTPUT]: Exports changeSet, localResult, summarizeRecord, exitCode, waitForResult.
 * [POS]: Interprets persisted jobs and snapshots into outcomes, changes and wait results.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { root, json, isJobId } from './project.mjs';
/** @import { LandedExtractOutput } from './html/extract-contract.js' */
// Plugin snapshot nodes (Snapshot in plugin/main.js): properties vary by node type and depth; only id is required.
/** @typedef {{ id: string, name?: string, truncated?: boolean, children?: SnapshotNode[], [key: string]: unknown }} SnapshotNode */

// -- Change sets --------------------------------------------------------
// Compare snapshots, listing real value changes individually while only counting new variable bindings or layout-induced shifts;
// otherwise one token binding or padding adjustment would overwhelm the list.
const POSITION = new Set(['x', 'y', 'relativeTransform', 'absoluteBoundingBox']);
const PAINTS = new Set(['fills', 'strokes', 'effects']);
const LIST_LIMIT = 50;
/** @param {string} key @param {unknown} value */
const unbound = (key, value) => PAINTS.has(key) && Array.isArray(value)
  ? value.map(paint => { if (!paint || typeof paint !== 'object') return paint; const { boundVariables, ...rest } = paint; return rest; })
  : value;

/** @param {SnapshotNode | null | undefined} tree */
function indexTree(tree) {
  const nodes = /** @type {Map<string, { properties: Record<string, unknown>, parentId: string | null }>} */ (new Map()), order = /** @type {Map<string, string[]>} */ (new Map());
  let truncated = false;
  /** @param {SnapshotNode} node @param {string | null} [parentId] */
  const visit = (node, parentId = null) => {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id)) throw Error('A snapshot node is missing its ID or has a duplicate ID');
    const { children, ...properties } = node;
    truncated ||= node.truncated === true;
    nodes.set(node.id, { properties, parentId });
    const kids = Array.isArray(children) ? children : [];
    order.set(node.id, kids.map(child => child?.id));
    for (const child of kids) visit(child, node.id);
  };
  if (tree) visit(tree);
  return { nodes, order, truncated };
}

// For siblings present before and after under the same parent, keep the longest order-preserving subsequence and mark the rest as reordered.
// Sibling insertion/deletion does not falsely mark later siblings as moved; swapping two siblings records one move.
// ponytail: O(n^2) dynamic programming is sufficient within the 2000-node budget; switch to O(n log n) patience sorting if sibling counts reach tens of thousands.
/** @param {ReturnType<typeof indexTree>} a @param {ReturnType<typeof indexTree>} b */
function reordered(a, b) {
  const moved = new Set();
  for (const [parentId, after] of b.order) {
    const rank = new Map((a.order.get(parentId) ?? []).map((id, i) => [id, i]));
    const kept = after.filter(id => rank.has(id));
    const seq = kept.map(id => /** @type {number} */ (rank.get(id))), length = seq.map(() => 1), previous = seq.map(() => -1);
    for (let i = 0; i < seq.length; i++) for (let j = 0; j < i; j++) if (seq[j] < seq[i] && length[j] + 1 > length[i]) { length[i] = length[j] + 1; previous[i] = j; }
    const stay = new Set();
    for (let k = length.indexOf(Math.max(...length)); k >= 0; k = previous[k]) stay.add(kept[k]);
    for (const id of kept) if (!stay.has(id)) moved.add(id);
  }
  return moved;
}

/** @param {SnapshotNode | null | undefined} before @param {SnapshotNode | null | undefined} after @param {number} [depth] */
export function changeSet(before, after, depth) {
  const scope = depth ? `depth-${depth}` : 'subtree';
  const a = indexTree(before), b = indexTree(after);
  if ((a.truncated || b.truncated) && !depth) return { scope, unavailable: 'Snapshot truncated; created or deleted nodes cannot be determined reliably; target a shallower node that still covers all writes, or declare --depth' };
  const shuffled = reordered(a, b), listed = [], counts = { created: 0, deleted: 0, moved: 0, updated: 0, bindingOnly: 0, positionOnly: 0 };
  for (const [id, old] of a.nodes) {
    const next = b.nodes.get(id);
    if (!next) { counts.deleted++; listed.push({ id, name: old.properties.name, change: 'deleted' }); continue; }
    const moved = old.parentId !== next.parentId || shuffled.has(id);
    const keys = [...new Set([...Object.keys(old.properties), ...Object.keys(next.properties)])].filter(key => !isDeepStrictEqual(old.properties[key], next.properties[key]));
    const values = keys.filter(key => key !== 'boundVariables' && !POSITION.has(key) && !isDeepStrictEqual(unbound(key, old.properties[key]), unbound(key, next.properties[key])));
    if (moved) counts.moved++;
    if (values.length) counts.updated++;
    // Omit layout position fields from listed nodes; retain bindings to show whether value changes accompany binding changes.
    if (values.length || moved) listed.push({ id, name: next.properties.name, change: moved ? 'moved' : 'updated', keys: keys.filter(key => !POSITION.has(key)).sort() });
    else if (keys.length && keys.every(key => POSITION.has(key))) counts.positionOnly++;
    else if (keys.length) counts.bindingOnly++;
  }
  for (const [id, node] of b.nodes) if (!a.nodes.has(id)) { counts.created++; listed.push({ id, name: node.properties.name, change: 'created' }); }
  return { scope, counts, nodes: listed.slice(0, LIST_LIMIT), ...(listed.length > LIST_LIMIT ? { omitted: listed.length - LIST_LIMIT } : {}),
    ...(depth ? { limitation: `Compares only ${depth} level(s) below the target; deeper changes are not visible` } : {}) };
}

// -- Reading evidence ---------------------------------------------------
// result.json is the sole commit point: its presence means completion. job.json status is derived and repaired on restart after a crash between writes.
/** @param {string} file */
async function optional(file) {
  try { return await json(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** @param {string} file */
async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// job and result are JSON read from evidence; extract output is interpreted by contract during summarization.
/** @param {string} cwd @param {string} id */
export async function localResult(cwd, id) {
  if (!isJobId(id)) throw Error('Invalid job ID');
  const dir = path.join(root(cwd), 'runs', id);
  const job = await json(path.join(dir, 'job.json'));
  if (job.id !== id) throw Error('Evidence job ID mismatch');
  const result = await optional(path.join(dir, 'result.json'));
  if (result && (result.id !== id || typeof result.ok !== 'boolean')) throw Error('Invalid result file: ' + id);
  const recovery = await optional(path.join(dir, 'recovery.json')), resolution = await optional(path.join(dir, 'resolution.json'));
  return { evidence: dir, job, result, recordedState: job.state, journalComplete: !!result, recovery, resolution,
    checkpointFile: await exists(path.join(dir, 'before.json')) ? path.join(dir, 'before.json') : null,
    instruction: result ? 'Result read from saved evidence' : resolution ? resolution.instruction
      : recovery ? (job.operation === 'run' ? recovery.instruction ?? 'The job has a recovery note; check the document and the bridge first; do not replay the script' : 'Read-only job interrupted; the document was not modified; resubmit it')
      : 'No persisted result yet; check the connection and read back the document first; do not blindly replay the script' };
}

// -- Summaries ----------------------------------------------------------
// Default CLI output includes fields needed for the next decision. Full snapshots and output remain in runs/<id>/, accessible with --full or jq.
// The 16 KiB UTF-8 limit applies only to output; changes, images and other fields have separate item-count limits.
const OUTPUT_LIMIT = 16 * 1024;
/** @typedef {Awaited<ReturnType<typeof localResult>> & { waitStatus?: string }} RunRecord */
/** @param {unknown} value @param {number} limit */
const clip = (value, limit) => typeof value === 'string' && value.length > limit ? value.slice(0, limit - 3) + '...' : value;
/** @param {string | undefined} from @param {string | undefined} to */
const elapsed = (from, to) => from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : null;
/** @param {unknown} output @param {string} resultFile */
function boundedOutput(output, resultFile, limit = OUTPUT_LIMIT) {
  const bytes = Buffer.byteLength(JSON.stringify(output) ?? 'null');
  if (bytes <= limit) return output;
  const shape = Array.isArray(output) ? { length: output.length } : output && typeof output === 'object' ? { keys: Object.keys(output).slice(0, 30) } : { type: typeof output };
  return { omitted: true, bytes, ...shape, read: `jq '.output' '${resultFile.replaceAll("'", "'\\''")}'` };
}
// Successful extracts can still be incomplete through missing explicit islands or binary persistence errors. Named islands require results, and read-only resubmission is harmless,
// so both yield exit 1. Apply only to extract, not coincidentally named run output keys; html handles its internal submissions separately.
const extractOk = (/** @type {RunRecord} */ { job, result }) => job?.operation === 'extract' && result?.ok === true;
const skippedIslands = (/** @type {RunRecord} */ record) => extractOk(record) && Array.isArray(record.result.output?.islandsSkipped) && record.result.output.islandsSkipped.length > 0;
const lostBinaries = (/** @type {RunRecord} */ record) => extractOk(record) && Array.isArray(record.result.binaryErrors) && record.result.binaryErrors.length > 0;
/** @param {RunRecord} record */
function instruction(record) {
  const { result } = record;
  if (result?.ok === false) {
    if (result.executionStarted === false) return 'The script did not run; the document was not modified; fix it and resubmit';
    // After script errors, created lists new nodes; --clean-on-fail also returns cleaned/cleanFailed. These describe new-node disposition only; modified existing nodes still require inspect.
    // New nodes may contain existing layers moved inside them, so inspect subtrees before deletion. cleanFailed covers both failed deletion and intentional preservation of existing content.
    // If cleanup removed nodes and deletedExisting is positive, they may be replacement IDs for existing content; suggest one Undo to recover the cleanup.
    const count = (/** @type {string} */ key) => Array.isArray(result[key]) ? result[key].length : 0, review = 'keep the evidence; verify the current state with inspect first; do not replay the script';
    if (!count('cleaned') && count('cleanFailed')) return `The script started running; the document may have been modified; created nodes were not deleted: ${count('cleanFailed')} node(s) kept or failed to delete (reasons in cleanFailed); ${review}`;
    if (count('cleaned')) return `The script started running; deleted ${count('cleaned')} node(s) created by this job${count('cleanFailed') ? `, ${count('cleanFailed')} not deleted (reasons in cleanFailed)` : ''}; modified existing nodes were not rolled back; `
      + (result.deletedExisting > 0 ? `${result.deletedExisting} node(s) that existed before the run were deleted during it (by the script, or replaced with new IDs by detachInstance, flatten or createComponentFromNode), so the cleaned nodes may include their replacements; inspect first, and if needed undo once in Figma to restore what the cleanup deleted; ` : '') + review;
    if (count('created')) return `The script started running; the document may have been modified; at failure it had created ${count('created')} node(s) (see created), which may contain existing layers: inspect their subtrees, then delete them${record.job?.cleanOnFail ? '' : ', or add --clean-on-fail next time'}; ${review}`;
    return 'The script started running; the document may have been modified; ' + review;
  }
  if (result?.verify?.error) return `The script ran, but the visual check did not run (${result.verify.error}); check the rendering with preview or inspect first; do not replay the script`;
  if (result?.verify && result.verify.pass !== true) return `The script ran, but the visual check failed (expect ${result.verify.expect}); review the diff image in verify; do not replay the script; fix it with a new script`;
  if (lostBinaries(record)) return 'Binary files were not fully saved (see binaryErrors); the document was not modified; resubmit extract';
  if (skippedIslands(record)) return `${result.output.islandsSkipped.length} explicit island(s) have no result (outside the target's visible subtree, nothing drawn, or export failed; reasons in extract.warnings); the rest of the output is complete; check the node IDs and resubmit`;
  return record.instruction;
}
/** @param {RunRecord} record */
export function summarizeRecord(record) {
  const { job, result } = record, resultFile = path.join(record.evidence, 'result.json');
  /** @type {Record<string, unknown>} */
  const summary = { id: job.id, operation: job.operation, ...(job.label ? { label: job.label } : {}), ...(record.waitStatus ? { waitStatus: record.waitStatus } : {}),
    state: record.recordedState, journalComplete: record.journalComplete, ok: result?.ok ?? null };
  if (result?.ok === false) {
    if (result.error !== undefined) summary.error = clip(String(result.error), 500);
    for (const key of ['executionStarted', 'targetMissing', 'missingNodeId', 'fileVerified', 'deletedExisting']) if (result[key] !== undefined) summary[key] = result[key];
    if (result.recovery !== undefined) summary.recoveryHint = result.recovery;
    if (record.checkpointFile) summary.checkpointFile = record.checkpointFile;
    // Limit each created/cleaned list to 50 nodes, matching change-set limits.
    for (const key of ['created', 'cleaned', 'cleanFailed']) if (Array.isArray(result[key])) {
      summary[key] = result[key].slice(0, LIST_LIMIT);
      if (result[key].length > LIST_LIMIT) summary[key + 'Omitted'] = result[key].length - LIST_LIMIT;
    }
    if (result.warnings !== undefined) summary.warnings = result.warnings;
  }
  const target = result?.bindingVerified?.nodeId ?? job.targetNodeId;
  if (target) summary.target = target;
  // Extracted trees are not useful in terminal summaries: output always gives shape and a jq command; expose statistics, up to 50 skipped islands and up to 20 warnings separately.
  const extract = job.operation === 'extract';
  if (result && 'output' in result) summary.output = boundedOutput(result.output, resultFile, extract ? 0 : OUTPUT_LIMIT);
  for (const key of ['ancestors', 'changes', 'verify', 'binaryErrors']) if (result?.[key] !== undefined) summary[key] = result[key];
  if (extract && result?.ok === true && result.output) {
    const { stats, islandsSkipped = [], warnings = [] } = /** @type {LandedExtractOutput} */ (result.output);
    summary.extract = { stats, islandsSkipped: islandsSkipped.slice(0, 50), ...(islandsSkipped.length > 50 ? { islandsSkippedOmitted: islandsSkipped.length - 50 } : {}),
      warnings: warnings.slice(0, 20).map(text => clip(text, 300)), ...(warnings.length > 20 ? { warningsOmitted: warnings.length - 20 } : {}) };
  }
  if (result?.images) summary.images = result.images.map((/** @type {{ nodeId: string, name?: string, file: string, width: number, height: number, pixels?: unknown }} */ { nodeId, name, file, width, height, pixels }) => ({ nodeId, ...(name ? { name } : {}), file: path.join(record.evidence, file), width, height, ...(pixels ? { pixels } : {}) }));
  if (result) summary.timing = { queueMs: elapsed(job.createdAt, job.claimedAt), pluginMs: result.pluginMs ?? null, ...(result.approvalMs ? { approvalMs: result.approvalMs } : {}), totalMs: elapsed(job.createdAt, result.finishedAt) };
  if (record.recovery) summary.recovery = record.recovery.status ?? 'present';
  if (record.resolution) summary.resolution = record.resolution.status;
  return { ...summary, evidence: record.evidence, ...(result ? { resultFile } : {}), instruction: instruction(record) };
}
// Exit 0: success; 1: execution/visual failure, missing explicit extract islands, binary persistence errors, or reviewed-but-unknown results where waiting cannot help; 2: pending, including wait expiry or required review.
export const exitCode = (/** @type {RunRecord} */ record) => record.result
  ? (record.result.ok === false || (record.result.verify && record.result.verify.pass !== true) || skippedIslands(record) || lostBinaries(record) ? 1 : 0)
  : record.resolution ? 1 : 2;

// -- Waiting ------------------------------------------------------------
// Observe evidence files only. Ending a wait neither stops the script nor resubmits it. Expiry returns exit 2 and the task ID for another wait.
// Once connected, hidden panels still claim and return work through network-driven long polling, so foreground and background use the same limit.
const DEFAULT_TIMEOUT_SECONDS = 30, POLL_MS = 100;
// clock replaces timekeeping for tests without changing wait policy.
/** @param {string} cwd @param {string} id */
export async function waitForResult(cwd, id, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, clock = { now: () => performance.now(), sleep: delay }) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw Error('Wait time must be an integer from 1 to 300 seconds');
  const started = clock.now();
  while (true) {
    const record = await localResult(cwd, id);
    if (record.journalComplete) return { ...record, waitStatus: 'completed' };
    if (record.resolution) return { ...record, waitStatus: 'resolved' };
    if (record.recovery) return { ...record, waitStatus: 'needs-review' };
    const remaining = timeoutSeconds * 1000 - (clock.now() - started);
    if (remaining <= 0) return { ...record, waitStatus: 'timeout', instruction: 'Wait timed out; the job state still needs checking; keep the plugin running and read status; do not replay the script' };
    await clock.sleep(Math.min(POLL_MS, remaining));
  }
}
