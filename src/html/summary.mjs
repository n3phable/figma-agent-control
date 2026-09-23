/**
 * [INPUT]: Inputs and types declared below; no runtime package dependencies.
 * [OUTPUT]: Exports STDOUT_LIMIT, bytes, quote, fit, LAUNCH, totals, exitCode, batch, instruction, stdoutOf, checkStdout.
 * [POS]: Builds bounded command summaries, exit decisions and resumable instructions.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
/** @import { Stale } from './generate.mjs' */
/** @import { Stop } from './extracts.mjs' */

/**
 * @typedef {{ node: string, rect: number[], share?: number, bakedOver?: string[], px?: number }} RefRecord
 * @typedef {{
 *   node: string, name?: string, source: 'from' | 'node', extract?: string, extracts?: string[], html?: string, check?: string,
 *   size?: { width: number, height: number }, verdict?: string, reason?: string, message?: string, sizeNote?: string,
 *   diffRatio?: number, mismatched?: number, blocks?: number, refs?: RefRecord[], bakedShare?: number,
 *   approximations?: Record<string, number>, needsIsland?: string[], needsExtract?: true,
 *   overrides?: { applied: string[], stale: Stale[] }, fonts?: object[], warnings?: string[], violations?: string[],
 *   error?: { code: string, message: string }, ms?: Record<string, number>
 * }} FrameRecord  Generated frame; errors before page writing contain only node/source, any known name/extract, and error.
 * @typedef {{ frames: number, clean: number, passWithFindings: number, fail: number, unchecked: number, errors: number, stale: number, needsIsland: number,
 *   approximations: Record<string, number> }} Totals  errors and needsIsland count frames; stale counts entries.
 * @typedef {{
 *   schema: 1, generator: string, checker: string, browser?: { version: string, launchMs: number }, overrides: { file: string, sha: string } | 'none', out: string,
 *   frames: FrameRecord[], totals: Totals, done: string[], pending: string[], remaining: string[], stop?: Stop, instruction: string, exitCode: 0 | 1 | 2,
 *   ms: { total: number, fontIndex: number }
 * }} Manifest  <out>/html.json
 * @typedef {{ html: string, node: string, extract: string, verdict: string, reason?: string, message?: string, diffRatio?: number, mismatched?: number,
 *   blocks?: number, refs?: RefRecord[], bakedShare?: number, check?: string }} PageRecord  A page checked by html-check.
 * @typedef {{ overridesFile?: string, noCheck?: true, timeoutSeconds?: number, budgetSeconds?: number }} Flags  Options explicitly supplied by the user (overridesFile is absolute); batch commands preserve only these.
 */

// -- Utilities ----------------------------------------------------------
export const STDOUT_LIMIT = 16 * 1024;
// Match bin output: two-space-indented JSON plus newline, measured in UTF-8 bytes.
/** @param {unknown} value */
export const bytes = value => Buffer.byteLength(JSON.stringify(value, null, 2) + '\n');
// Shell single-quote escaping matches record's jq commands: node IDs contain ';' and paths may contain spaces.
/** @param {unknown} arg */
export const quote = arg => `'${String(arg).replaceAll("'", "'\\''")}'`;
/** @param {string} text @param {number} n */
const clip = (text, n) => text.length > n ? text.slice(0, n - 3) + '...' : text;
/** Evaluate candidates in order and return the first within STDOUT_LIMIT; the final candidate is bounded by construction. @param {...() => object} candidates @returns {object} */
export function fit(...candidates) {
  let value = {};
  for (const make of candidates) if (bytes(value = make()) <= STDOUT_LIMIT) break;
  return value;
}
// Chrome startup error codes stop command from retrying launch. RECHECK covers mid-run browser failure/timeouts recoverable by rerunning html-check.
export const LAUNCH = new Set(['CHROME_NOT_FOUND', 'CHROME_LAUNCH_FAILED']);
const RECHECK = new Set(['CHROME_PROTOCOL', 'CHROME_EXITED', 'RENDER_TIMEOUT']);
/** @param {FrameRecord} f */
const flagged = f => !!(f.overrides?.stale.length || f.needsIsland?.length || f.violations?.length);

// -- Totals and exit codes ----------------------------------------------
/** @param {FrameRecord[]} frames @returns {Totals} */
export function totals(frames) {
  /** @param {string} v */
  const count = v => frames.filter(f => f.verdict === v).length, approximations = /** @type {Record<string, number>} */ ({});
  for (const f of frames) for (const [k, n] of Object.entries(f.approximations ?? {})) approximations[k] = (approximations[k] ?? 0) + n;
  return { frames: frames.length, clean: count('clean'), passWithFindings: count('pass-with-findings'), fail: count('fail'), unchecked: count('unchecked'),
    errors: frames.filter(f => f.error).length, stale: frames.reduce((n, f) => n + (f.overrides?.stale.length ?? 0), 0),
    needsIsland: frames.filter(f => f.needsIsland?.length).length, approximations };
}

// Fatal stop returns 1 for environment repair; pending continuation returns 2; incomplete or failing frames return 1. Use needsIsland, not just needsExtract:
// otherwise failed second extraction could return 0 while --from on the same evidence returns 1 for the identical page. --no-check frames have no verdict and do not affect exit code.
/** @param {Pick<Manifest, 'stop' | 'pending' | 'remaining' | 'frames'>} m @returns {0 | 1 | 2} */
export function exitCode({ stop, pending, remaining, frames }) {
  if (stop?.kind === 'fatal') return 1;
  if (pending.length || remaining.length) return 2;
  return frames.some(f => f.error || f.verdict === 'fail' || f.verdict === 'unchecked' || flagged(f)) ? 1 : 0;
}

// -- Batch commands and guidance ----------------------------------------
// Every continuation/correction command includes the entire batch, keeping the resulting manifest complete. Rebuild complete done pages and pending extracts with --from;
// Re-extract remaining nodes, error frames without pages, and missing-island frames through --node. List remaining first so the mandatory first submission addresses truly unfinished work.
// If a second extraction timed out, its pending complete result is already included in --from. Do not also add --node for the same missing-island frame; duplicates fail preflight.
/** @param {Pick<Manifest, 'frames' | 'done' | 'pending' | 'remaining' | 'out'>} m @param {Flags} flags @param {{ overridesPlaceholder?: boolean }} [extra] @returns {string} */
export function batch({ frames, done, pending, remaining, out }, flags, { overridesPlaceholder = false } = {}) {
  const used = new Map(frames.filter(f => f.extract).map(f => [f.extract, f]));
  const from = [...done.filter(id => !used.get(id)?.needsIsland?.length), ...pending];
  const covered = new Set(frames.filter(f => [f.extract, ...f.extracts ?? []].some(id => id && from.includes(id))).map(f => f.node));
  const nodes = [...new Set([...remaining, ...frames.filter(f => f.error && !f.html).map(f => f.node), ...frames.filter(f => f.needsIsland?.length).map(f => f.node)])]
    .filter(node => !covered.has(node));
  const args = [...from.flatMap(id => ['--from', quote(id)]), ...nodes.flatMap(node => ['--node', quote(node)])];
  if (flags.overridesFile) args.push('--overrides', quote(flags.overridesFile));
  else if (overridesPlaceholder) args.push('--overrides', '<overrides file>');
  args.push('--out', quote(out));
  if (flags.noCheck) args.push('--no-check');
  if (flags.timeoutSeconds !== undefined) args.push('--timeout', quote(flags.timeoutSeconds));
  if (flags.budgetSeconds !== undefined) args.push('--budget', quote(flags.budgetSeconds));
  return ['figma-agent-control html', ...args].join(' ');
}

// Prioritize resumable work; report other findings after it completes, with guidance joined in display order.
/** @param {Omit<Manifest, 'instruction' | 'exitCode'>} m @param {Flags} flags @returns {string} */
export function instruction(m, flags) {
  const { stop, pending, remaining, frames } = m, manifest = `${m.out}/html.json`, said = [];
  if (stop?.kind === 'fatal') said.push(stop.message, ...(stop.code === 'BRIDGE_STOPPING' ? ['Rerun figma-agent-control connect'] : []));
  if (pending.length || remaining.length) {
    // remaining without stop can only mean --from points to interrupted work. If ACTIVE_JOB is already in this batch's pending set, the wait instruction below covers it.
    const lead = !stop ? (remaining.length ? 'Interrupted extracts are re-extracted with --node; ' : '')
      : { BUDGET_EXPIRED: 'Time budget expired; ', WAIT_TIMEOUT: 'Wait for extract timed out; ', INTERRUPTED: 'The extract was interrupted; ',
        ACTIVE_JOB: stop.active && !pending.includes(stop.active) ? `Another job is in progress (${stop.active}); after it finishes, ` : '',
        RECONNECTING: 'Plugin not connected: run the plugin in Figma (if the panel says the plugin was updated, close it and run it again), then ' }[stop.code] ?? '';
    const wait = pending.length ? `${lead ? 'first' : 'First'} run ${pending.map(id => `figma-agent-control wait ${id}`).join(', ')}, then ` : '';
    said.push(`${lead}${wait}${lead || wait ? 'run' : 'Run'} ${batch(m, flags)}`);
    return said.join('. ');
  }
  const has = (/** @type {(f: FrameRecord) => unknown} */ test) => frames.some(test);
  const fail = has(f => f.verdict === 'fail');
  if (fail) said.push('For failing frames, read check.json and diff.png in the evidence directory; write corrections into that frame\'s overrides group (top-level key is the frame node ID)');
  if (has(f => f.overrides?.stale.length)) said.push('Stale overrides entries were not applied: for missing, correct or remove the node ID; for changed, verify basis; for invalid, see reason (details in html.json)');
  if (has(f => f.needsIsland?.length)) said.push('Some frames lack islands exported by Figma (needsIsland; --from frames are marked needsExtract; why the second extract failed is in the frame\'s warnings); the command below re-extracts them');
  if (has(f => f.error)) said.push(`For frames with errors, see error in html.json${has(f => f.error && !f.html) ? '; the command below re-extracts frames that have no page' : ''}`);
  if (said.length) said.push(`Then run ${batch(m, flags, { overridesPlaceholder: fail })}`);
  said.push(...uncheckedAdvice(frames.map(f => f.reason ?? ''), 'run figma-agent-control html-check on the pages (page paths in html.json)', 'retry with figma-agent-control html-check on these pages'));
  if (has(f => f.violations?.length)) said.push('Generated output violates output invariants (violations in html.json); report this generator defect');
  if (!said.length) said.push(flags.noCheck ? `Generated, not checked (--no-check); you can run figma-agent-control html-check; ${manifest} is the manifest of this batch` : `All frames pass; ${manifest} is the manifest of this batch`);
  return said.join('. ');
}

// Give one remedy per unchecked category: missing Chrome, browser failure/render timeout, and incorrect reference dimensions.
/** @param {string[]} reasons @param {string} afterInstall @param {string} retry */
function uncheckedAdvice(reasons, afterInstall, retry) {
  const said = [];
  if (reasons.some(r => LAUNCH.has(r))) said.push(`Install Chrome or set FIGMA_AGENT_CONTROL_CHROME, then ${afterInstall}`);
  if (reasons.some(r => RECHECK.has(r))) said.push(`Chrome failed midway or rendering timed out; ${retry}`);
  if (reasons.includes('REFERENCE_SIZE')) said.push('Reference image and extract tree sizes differ by more than 1 px (see expected and reference in check.json): for very large frames this is usually Figma downsampling, so split them into smaller child nodes with --node; re-extract only if the design was just changed in Figma');
  return said;
}

// ── stdout ───────────────────────────────────────────────────────────────
// Frames needing attention have errors, non-clean or absent verdicts, stale entries, missing islands or violations. Lower sort keys come first; ties retain processing order.
/** @param {FrameRecord} f */
const rank = f => f.error ? 0 : f.verdict === 'fail' ? 1 : f.verdict === 'unchecked' ? 2 : flagged(f) ? 3 : f.verdict === 'pass-with-findings' ? 4 : f.verdict ? 6 : 5;
/** @param {FrameRecord} f */
function brief(f) {
  const refs = f.refs ?? [], stale = f.overrides?.stale ?? [];
  return { node: f.node, ...(f.name !== undefined ? { name: clip(f.name, 100) } : {}), ...(f.extract ? { extract: f.extract } : {}),
    ...(f.verdict ? { verdict: f.verdict } : {}), ...(f.reason ? { reason: f.reason } : {}), ...(f.diffRatio !== undefined ? { diffRatio: f.diffRatio } : {}),
    ...(f.blocks !== undefined ? { blocks: f.blocks } : {}), ...(f.html ? { html: f.html } : {}),
    ...(refs.length ? { refs: refs.slice(0, 3).map(({ node, rect, share }) => ({ node, rect, share })), ...(refs.length > 3 ? { refsOmitted: refs.length - 3 } : {}) } : {}),
    ...(f.bakedShare !== undefined ? { bakedShare: f.bakedShare } : {}),
    ...(stale.length ? { stale: stale.slice(0, 3).map(({ node, kind }) => ({ node, kind })), ...(stale.length > 3 ? { staleOmitted: stale.length - 3 } : {}) } : {}),
    ...(f.needsIsland?.length ? { needsIsland: f.needsIsland.length } : {}), ...(f.needsExtract ? { needsExtract: true } : {}),
    ...(f.error ? { error: { code: f.error.code, message: clip(f.error.message, 300) } } : {}) };
}

// Three progressively smaller candidates: full shape with at most 10 frames, then no frame list, then no resume lists and a short manifest pointer. The third contains only bounded fields.
/** @param {Manifest} m @returns {object} */
export function stdoutOf(m) {
  const watch = m.frames.map((f, i) => ({ f, i })).filter(({ f }) => rank(f) < 6).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(({ f }) => f);
  const summary = `${m.out}/html.json`, resume = m.pending.length || m.remaining.length;
  const head = { ...(m.browser ? { browser: m.browser.version } : {}), totals: m.totals };
  const stop = m.stop ? { stop: { code: m.stop.code, message: clip(m.stop.message, 300), ...(m.stop.active ? { active: m.stop.active } : {}) } } : {};
  const lists = resume ? { done: m.done, pending: m.pending, remaining: m.remaining } : {};
  return fit(
    () => ({ ...head, frames: watch.slice(0, 10).map(brief), omittedFrames: Math.max(0, watch.length - 10), ...lists, ...stop, summary, instruction: m.instruction }),
    () => ({ ...head, omittedFrames: watch.length, ...lists, ...stop, summary, instruction: m.instruction }),
    () => ({ ...head, omittedFrames: watch.length, ...stop, summary, instruction: `Instruction too long; see instruction in ${summary} for the full text` }));
}

// html-check counts verdicts only and tries all pages, then non-clean pages, then no page list. Instructions omit IDs to keep their length bounded.
/** @param {{ browser?: string, pages: PageRecord[] }} input @returns {object} */
export function checkStdout({ browser, pages }) {
  /** @param {string} v */
  const count = v => pages.filter(p => p.verdict === v).length;
  const head = { ...(browser ? { browser } : {}), totals: { pages: pages.length, clean: count('clean'), passWithFindings: count('pass-with-findings'), fail: count('fail'), unchecked: count('unchecked') } };
  const said = [...(count('fail') ? ['For failing pages, read check.json and diff.png'] : []), ...uncheckedAdvice(pages.map(p => p.reason ?? ''), 'rerun html-check', 'rerun html-check')];
  const instruction = said.join('. ') || 'All pages pass', dirty = pages.filter(p => p.verdict !== 'clean');
  return fit(
    () => ({ ...head, pages, omittedPages: 0, instruction }),
    () => ({ ...head, pages: dirty, omittedPages: pages.length - dirty.length, instruction }),
    () => ({ ...head, omittedPages: pages.length, instruction }));
}
