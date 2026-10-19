/**
 * [INPUT]: Imports node:fs/promises, node:path, node:util, node:timers/promises, node:perf_hooks, ./project.mjs.
 * [OUTPUT]: Exports changeSet, scriptTrace, localResult, summarizeRecord, exitCode, waitForResult.
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

// -- Script error locations ---------------------------------------------
// plugin/main.js compile nests each library and body inside new Function. The first segment starts at engine line 4, and each segment adds one wrapper line;
// segment k therefore starts at 4 + sum(n_j + 1), where n_j counts preceding lines split by \n. Wrappers add no leading characters, preserving columns.
// Figma QuickJS stacks have no message line and use "at name (<input>:line:column)"; V8 in node:vm uses "at name (eval at compile (...), <anonymous>:line:column)".
// Frames named anonymous belong to new Function bodies (outer wrappers or functions created by the script), outside these segments, so skip them. Named functions created inside those bodies still use body-local lines and can map to unrelated source lines.
// Unnamed frames refer to this source only during compilation (executionStarted false); at runtime they may point into JSON.parse text or a nested new Function syntax error.
// Skip out-of-segment frames until the first mapped frame; later ones belong to outer wrappers, so stop there.
const FRAME = /^\s*at (?:(.+?) \()?(?:<input>|eval at compile \([^()]*\), <anonymous>):(\d+):(\d+)\)?$/, TRACE_LIMIT = 10;
/** @param {{ code: string, libs?: { name: string, code: string }[], label?: string }} job @param {unknown} stack @param {unknown} executionStarted */
export function scriptTrace(job, stack, executionStarted) {
  const trace = /** @type {{ file: string, line: number, column: number, source: string }[]} */ ([]);
  if (typeof stack !== 'string') return trace;
  let next = 4;
  const segments = [...(job.libs ?? []), { name: job.label ?? 'script', code: job.code }].map(({ name, code }) => {
    const lines = code.split('\n'), first = next;
    next += lines.length + 1;
    return { name, lines, first };
  });
  for (const text of stack.split('\n')) {
    const frame = FRAME.exec(text);
    if (!frame || frame[1] === 'anonymous' || (frame[1] === undefined && executionStarted !== false)) continue;
    const line = Number(frame[2]), segment = segments.find(({ lines, first }) => line >= first && line < first + lines.length);
    if (!segment) { if (trace.length) break; continue; }
    trace.push({ file: segment.name, line: line - segment.first + 1, column: Number(frame[3]), source: segment.lines[line - segment.first].trim().slice(0, 200) });
    if (trace.length === TRACE_LIMIT) break;
  }
  return trace;
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
  // progress.json holds the bridge's last execution update, identifying pending work and remaining available for later inspection after completion.
  const progress = await optional(path.join(dir, 'progress.json'));
  return { evidence: dir, job, result, recordedState: job.state, journalComplete: !!result, recovery, resolution, progress,
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
// clean is an ordinary CLI-assembled run (src/clean.mjs), recognized by label and data.task without importing clean and creating a cycle. Submission waiting, wait and result share the same verdict.
const cleanOutput = (/** @type {RunRecord} */ { job, result }) => job?.operation === 'run' && result?.ok === true && isJobId(job.data?.task) && job.label === `clean ${job.data.task}` ? result.output : null;
const cleanSkipped = (/** @type {RunRecord} */ record) => Array.isArray(cleanOutput(record)?.skipped) && cleanOutput(record).skipped.length > 0;
/** @param {RunRecord} record */
function instruction(record) {
  const { result } = record;
  if (result?.ok === false) {
    if (result.executionStarted === false) return 'The script did not run; the document was not modified; fix it and resubmit';
    // After script errors, created lists new nodes; --clean-on-fail also returns cleaned/cleanFailed. These describe new-node disposition only; modified existing nodes still require inspect.
    // New nodes may contain existing layers moved inside them, so inspect subtrees before deletion. cleanFailed covers both failed deletion and intentional preservation of existing content.
    // If cleanup removed nodes and deletedExisting is positive, they may be replacement IDs for existing content; suggest one Undo to recover the cleanup.
    // New variable collections, variables and styles (createdAssets) are outside clean's scope; call them out separately.
    const assets = result.createdAssets && typeof result.createdAssets === 'object' ? Object.values(result.createdAssets).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0) : 0;
    const count = (/** @type {string} */ key) => Array.isArray(result[key]) ? result[key].length : 0;
    const review = (assets ? `also created ${assets} variable collection(s), variable(s) or style(s) (see createdAssets), which clean does not delete; delete them in Figma if unneeded; ` : '') + 'keep the evidence; verify the current state with inspect first; do not replay the script';
    if (!count('cleaned') && count('cleanFailed')) return `The script started running; the document may have been modified; created nodes were not deleted: ${count('cleanFailed')} node(s) kept or failed to delete (reasons in cleanFailed); ${review}`;
    if (count('cleaned')) return `The script started running; deleted ${count('cleaned')} node(s) created by this job${count('cleanFailed') ? `, ${count('cleanFailed')} not deleted (reasons in cleanFailed)` : ''}; modified existing nodes were not rolled back; `
      + (result.deletedExisting > 0 ? `${result.deletedExisting} node(s) that existed before the run were deleted during it (by the script, or replaced with new IDs by detachInstance, flatten or createComponentFromNode), so the cleaned nodes may include their replacements; inspect first, and if needed undo once in Figma to restore what the cleanup deleted; ` : '') + review;
    if (count('created')) return `The script started running; the document may have been modified; at failure it had created ${count('created')} node(s) (see created), which may contain existing layers: inspect their subtrees, then run figma-agent-control clean ${record.job.id}${record.job?.cleanOnFail ? '' : ', or add --clean-on-fail next time'}; ${review}`;
    return 'The script started running; the document may have been modified; ' + review;
  }
  // For non-page targets, pageRoot records added/removed page children outside the target change set. Keep the exit code unchanged but mention new nodes in guidance, including failed verdicts: missing appendChild often explains unchanged frames. Before/after comparison cannot identify provenance, so require inspection before deletion.
  const strays = Array.isArray(result?.pageRoot?.created) ? result.pageRoot.created.length + (result.pageRoot.createdOmitted ?? 0) : 0, stray = strays ? `; ${strays} new node(s) appeared on the page root (see pageRoot), usually from a missing appendChild after create*; this is a before/after comparison that also includes nodes created by collaborators meanwhile and nodes swapped out by flatten or detachInstance (old IDs are in deleted): inspect to confirm they came from this script before deleting or re-parenting them` : '';
  if (result?.verify?.error) return `The script ran, but the visual check did not run (${result.verify.error}); check the rendering with preview or inspect first; do not replay the script${stray}`;
  if (result?.verify && result.verify.pass !== true) return `The script ran, but the visual check failed (expect ${result.verify.expect}); review the diff image in verify; do not replay the script; fix it with a new script${stray}`;
  // Deferred clean never compares candidates with the original pre-run nodes (protected originals never enter its list), so it cannot recognize existing layers moved into new nodes. Suggest review and Undo.
  const clean = cleanOutput(record);
  if (clean) {
    const n = (/** @type {string} */ key) => Array.isArray(clean[key]) ? clean[key].length : 0;
    return `Cleaned up nodes left by job ${record.job.data.task}: ${n('cleaned')} deleted, ${n('gone')} already gone, ${n('skipped')} skipped${n('skipped') ? ' (reasons in output.skipped; inspect, then handle them manually)' : ''}; `
      + (n('cleaned') ? 'the deletion is a single Undo step; before deleting, only name, type, parent and subtree node count were checked, so existing layers moved into created nodes are not recognized: verify with inspect, and undo once in Figma to restore anything deleted by mistake; ' : '')
      + 'existing nodes modified by the original job are not rolled back; clean can run again, re-checks before every deletion, and records already-deleted nodes in gone';
  }
  if (lostBinaries(record)) return 'Binary files were not fully saved (see binaryErrors); the document was not modified; resubmit extract';
  if (skippedIslands(record)) return `${result.output.islandsSkipped.length} explicit island(s) have no result (outside the target's visible subtree, nothing drawn, or export failed; reasons in extract.warnings); the rest of the output is complete; check the node IDs and resubmit`;
  return record.instruction + stray;
}
/** @param {RunRecord} record */
export function summarizeRecord(record) {
  const { job, result } = record, resultFile = path.join(record.evidence, 'result.json');
  /** @type {Record<string, unknown>} */
  const summary = { id: job.id, operation: job.operation, ...(job.label ? { label: job.label } : {}), ...(record.waitStatus ? { waitStatus: record.waitStatus } : {}),
    state: record.recordedState, journalComplete: record.journalComplete, ok: result?.ok ?? null };
  if (result?.ok === false) {
    if (result.error !== undefined) summary.error = clip(String(result.error), 500);
    // Prefer bridge-mapped trace locations for script errors; fall back to the raw stack prefix.
    if (Array.isArray(result.trace)) summary.trace = result.trace;
    else if (typeof result.stack === 'string') summary.stack = clip(result.stack, 500);
    for (const key of ['executionStarted', 'targetMissing', 'missingNodeId', 'fileVerified', 'deletedExisting']) if (result[key] !== undefined) summary[key] = result[key];
    if (result.recovery !== undefined) summary.recoveryHint = result.recovery;
    if (record.checkpointFile) summary.checkpointFile = record.checkpointFile;
    // Limit each created/cleaned list to 50 nodes, matching change-set limits.
    for (const key of ['created', 'cleaned', 'cleanFailed']) if (Array.isArray(result[key])) {
      summary[key] = result[key].slice(0, LIST_LIMIT);
      if (result[key].length > LIST_LIMIT) summary[key + 'Omitted'] = result[key].length - LIST_LIMIT;
    }
    if (result.createdAssets !== undefined) summary.createdAssets = result.createdAssets;
    if (result.warnings !== undefined) summary.warnings = result.warnings;
  }
  // Without a result, expose the last execution update: pending call, script line and report age.
  if (!result && record.progress) summary.progress = record.progress;
  const target = result?.bindingVerified?.nodeId ?? job.targetNodeId;
  if (target) summary.target = target;
  // Extracted trees are not useful in terminal summaries: output always gives shape and a jq command; expose statistics, up to 50 skipped islands and up to 20 warnings separately.
  const extract = job.operation === 'extract';
  if (result && 'output' in result) summary.output = boundedOutput(result.output, resultFile, extract ? 0 : OUTPUT_LIMIT);
  for (const key of ['ancestors', 'changes', 'pageRoot', 'verify', 'binaryErrors']) if (result?.[key] !== undefined) summary[key] = result[key];
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
// Exit 0: success. Exit 1: execution/visual failure, skipped clean nodes, missing explicit islands, extract binary errors, or resolved-but-unknown results where waiting cannot help. Exit 2: still pending, including wait expiry or required verification.
export const exitCode = (/** @type {RunRecord} */ record) => record.result
  ? (record.result.ok === false || (record.result.verify && record.result.verify.pass !== true) || skippedIslands(record) || lostBinaries(record) || cleanSkipped(record) ? 1 : 0)
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
    if (remaining <= 0) return { ...record, waitStatus: 'timeout', instruction: 'Wait timed out; the job state still needs checking; keep the plugin running and read status; do not replay the script. For a running run, check progress: if it stays on the same call for a long time, keep waiting with wait, or stop it with cancel' };
    await clock.sleep(Math.min(POLL_MS, remaining));
  }
}
