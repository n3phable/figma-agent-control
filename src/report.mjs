/**
 * [INPUT]: Imports node:fs/promises, node:path, ./project.mjs.
 * [OUTPUT]: Exports report.
 * [POS]: Reads recorded jobs to summarize timings, outcomes and repeated requests.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { root, json, isJobId } from './project.mjs';

// All durations use wall-clock time: totalMs from submission to persisted result; queueMs from submission to plugin claim; pluginMs inside the plugin, including snapshots and exports.
const DAY_MS = 24 * 3600 * 1000;
const between = (from, to) => from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : null;
function stats(values) {
  const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  const at = q => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { count: sorted.length, sumMs: sorted.reduce((a, b) => a + b, 0), medianMs: at(0.5), p90Ms: at(0.9), maxMs: sorted.at(-1) };
}

export async function report(cwd, { since = new Date(Date.now() - DAY_MS).toISOString() } = {}) {
  const dir = path.join(root(cwd), 'runs');
  let entries = [];
  try { entries = (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() && isJobId(e.name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const jobs = [];
  for (const entry of entries) {
    // Filter by directory mtime before reading full history; allow 2 s for file systems that truncate mtime to whole seconds.
    if ((await fs.stat(path.join(dir, entry.name))).mtimeMs < Date.parse(since) - 2000) continue;
    let job;
    try { job = await json(path.join(dir, entry.name, 'job.json')); } catch { continue; }
    if (!(job.createdAt >= since)) continue;
    // Completion time comes from result.json, the sole commit point, regardless of whether job.json has been updated.
    let pluginMs = null, ok = null, finishedAt = null, verify = null;
    try { ({ pluginMs = null, ok = null, finishedAt = null, verify = null } = await json(path.join(dir, entry.name, 'result.json'))); } catch { /* Not completed.*/ }
    jobs.push({ id: job.id, operation: job.operation, state: job.state, label: job.label ?? null, createdAt: job.createdAt, finishedAt, ok, verifyPass: verify ? verify.pass === true : null,
      scriptHash: job.scriptHash, target: job.targetNodeId ?? null, totalMs: between(job.createdAt, finishedAt), queueMs: between(job.createdAt, job.claimedAt), pluginMs });
  }
  jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Gaps run from the previous persisted result to the next submission, representing agent scripting, inspection and organization time.
  const gaps = jobs.slice(1).map((job, i) => ({ gapMs: between(jobs[i].finishedAt, job.createdAt), after: jobs[i], next: job })).filter(g => g.gapMs !== null);
  const describe = job => ({ id: job.id, operation: job.operation, ...(job.label ? { label: job.label } : {}), at: job.createdAt });
  const from = jobs[0]?.createdAt, to = jobs.map(j => j.finishedAt).filter(Boolean).sort().at(-1);
  const total = stats(jobs.map(j => j.totalMs)), wallMs = between(from, to);
  // Repeated scripts on the same target are candidates for rework or staged verification.
  const runs = new Map();
  for (const job of jobs.filter(j => j.operation === 'run')) runs.set(job.scriptHash + ' ' + job.target, [...(runs.get(job.scriptHash + ' ' + job.target) || []), job]);
  const repeats = [...runs.values()].filter(list => list.length > 1).sort((a, b) => b.length - a.length).slice(0, 10)
    .map(list => ({ label: list.at(-1).label, target: list[0].target, count: list.length, at: list.map(j => j.createdAt) }));
  const count = key => Object.fromEntries([...new Set(jobs.map(j => j[key]))].map(v => [String(v), jobs.filter(j => j[key] === v).length]));
  return {
    window: { since, from: from ?? null, to: to ?? null, wallMs },
    // failed means execution failed; verifyFailed means successful execution with a failed or unavailable visual verdict. The two are mutually exclusive.
    jobs: { count: jobs.length, byOperation: count('operation'), byState: count('state'), failed: jobs.filter(j => j.ok === false).length,
      verifyFailed: jobs.filter(j => j.ok === true && j.verifyPass === false).length },
    timing: { total, queue: stats(jobs.map(j => j.queueMs)), plugin: stats(jobs.map(j => j.pluginMs)),
      share: wallMs ? { inJobs: Number(((total.sumMs ?? 0) / wallMs).toFixed(3)), betweenJobs: Number((gaps.reduce((n, g) => n + g.gapMs, 0) / wallMs).toFixed(3)) } : null },
    gaps: { ...stats(gaps.map(g => g.gapMs)), largest: [...gaps].sort((a, b) => b.gapMs - a.gapMs).slice(0, 10).map(g => ({ gapMs: g.gapMs, after: describe(g.after), next: describe(g.next) })) },
    repeats,
    limitation: 'Durations are wall-clock and include plugin polling and delivery; gaps include agent thinking, script writing, image reading and manual work, and cannot be broken down further'
  };
}
