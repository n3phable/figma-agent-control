/**
 * [INPUT]: Uses ./record.mjs localResult, ./project.mjs json/readBinding and node:path.
 * [OUTPUT]: CLEAN_SCRIPT and cleanJob(cwd, id) -> a run request body for /job, or null when nothing needs removal.
 * [POS]: Deferred cleanup translates a failed run's created evidence into a normal run (fixed script plus removal list; data and snapshot limits are checked before submission). Bridge and plugin need no clean operation; write-ahead logging, both Undo boundaries and unresolved-write checks remain unchanged.
 *        Called by bin submission. record recognizes cleanup by label and data.task to produce specialized instructions and exit codes, without importing this module and creating a cycle.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import path from 'node:path';
import { localResult } from './record.mjs';
import { json, readBinding } from './project.mjs';

// -- Cleanup script -----------------------------------------------------
// Revalidate each node before deletion. Mismatches or deletion errors are skipped without stopping other nodes; missing nodes are gone, making repeated clean safe.
// Exclude instance-internal layers (IDs beginning with I) from subtree size: main-component changes would otherwise make untouched leftovers look modified. Leaf nodes lack findAll and count as zero.
// Use the same size rule as plugin/main.js created evidence; tests keep both sides aligned because CLI and plugin cannot share this code. Created entries never nest, so deletion order is irrelevant.
export const CLEAN_SCRIPT = `const own = n => 'findAll' in n ? n.findAll(c => !c.id.startsWith('I')).length : 0;
const out = { task: data.task, cleaned: [], gone: [], skipped: [] };
for (const e of data.nodes) {
  const n = await figma.getNodeByIdAsync(e.id), info = { id: e.id, name: e.name, type: e.type };
  if (!n || n.removed) { out.gone.push(info); continue; }
  let p = n; while (p && p.type !== 'PAGE') p = p.parent;
  const reason = p?.id !== data.pageId ? 'no longer on the page where the failure happened'
    : n.type !== e.type || n.name !== e.name ? 'changed to ' + n.type + ' "' + n.name + '"'
    : e.parentId == null ? 'the failure record has no parent or subtree size (old plugin version); inspect, then delete manually'
    : n.parent.id !== e.parentId ? 'moved to ' + n.parent.id
    : own(n) !== e.size ? 'subtree node count ' + e.size + ' -> ' + own(n) + ', changed after the failure' : null;
  if (reason) { out.skipped.push({ ...info, reason }); continue; }
  try { n.remove(); out.cleaned.push(info); } catch (error) { out.skipped.push({ ...info, reason: String(error) }); }
}
return out;
`;

// -- Task body ----------------------------------------------------------
// Accept only failed runs that started executing and list created nodes. Reject all others before submission. Pending removal is created minus cleaned minus cleanFailed; protection rules intentionally preserve cleanFailed nodes, including during deferred cleanup.
// Read page ID from before.json bindingVerified, persisted before execution; failure results omit it. Omit targetNodeId to target the binding. A depth-1 snapshot captures removed direct children; output.cleaned records deeper deletions.
// Enforce two limits before submission: exceeding the bridge's 1 MiB data limit would blame a --data option the user never supplied. Depth-1 snapshots count the binding plus direct children, so 2000 removal candidates already exceed the plugin budget and guarantee pre-execution failure.
// Existing children are visible only to the plugin; here, reject only when the removal list alone reaches the limit.
/** @param {string} cwd @param {string} id */
export async function cleanJob(cwd, id) {
  const refuse = (/** @type {string} */ why) => { throw Error(`Cannot clean up job ${id}: ${why}`); };
  const { job, result, evidence } = await localResult(cwd, id).catch(error => { if (error?.code === 'ENOENT') refuse(`no local evidence for this job (runs/${id}/job.json)`); throw error; });
  if (job.operation !== 'run') refuse(`it is ${job.operation}; only run leaves nodes behind`);
  if (!result) refuse('the original job has no result yet (running or unresolved); wait first, and if unresolved verify it through the resolve flow');
  if (result.ok !== false) refuse('the original job succeeded; no nodes were left by a failure');
  if (result.executionStarted !== true) refuse('the script did not run; nothing was left behind');
  if (!Array.isArray(result.created)) refuse('the result has no created (the listener was unavailable, or the failure happened after the script finished); inspect, then handle manually');
  const handled = new Set([...(result.cleaned ?? []), ...(result.cleanFailed ?? [])].map(node => node?.id));
  const nodes = result.created.filter((/** @type {{ id: string }} */ node) => !handled.has(node.id));
  if (!nodes.length) return null;
  const pageId = (await json(path.join(evidence, 'before.json')).catch(() => null))?.bindingVerified?.pageId;
  if (typeof pageId !== 'string') refuse('the checkpoint before.json is missing or has no page ID; inspect, then handle manually');
  const { nodeId } = await readBinding(cwd), data = { task: id, pageId, nodes };
  if (nodes.filter((/** @type {{ parentId?: string }} */ node) => node.parentId === nodeId).length >= 2000) refuse('2000 or more nodes in the deletion list sit directly under the bound node, too many for the before-snapshot of clean; inspect, then delete manually');
  if (Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024) refuse('the deletion list exceeds the 1 MiB data limit of run; inspect, then delete manually');
  return { operation: 'run', code: CLEAN_SCRIPT, label: `clean ${id}`, snapshotDepth: 1, data };
}
