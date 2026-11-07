/**
 * [INPUT]: Uses ./layout.mjs BLOCKING geometry kinds; otherwise pure ES built-ins and Buffer.byteLength. Accepts html manifests or html-check page records plus explicitly supplied options.
 *          Types come from ./check.mjs TopEntry, ./suggest.mjs Suggestion/Cluster, ./zoom.mjs ZoomResult,
 *          ./generate.mjs Stale/Approximation and ./extracts.mjs Stop.
 * [OUTPUT]: STDOUT_LIMIT, LAUNCH error codes, bytes, quote, fit, totals, exitCode, batch, instruction, stdoutOf, checkStdout;
 *           RefRecord, FrameRecord, FontRecord, FontTotal, Totals, Manifest, PageRecord and Flags types.
 * [POS]: Pure output layer deriving html.json totals, geometry/font summaries, exit codes, complete-batch continuation commands, guidance and 16 KiB stdout projections.
 *        Compact diagnostics allow at most three top/suggest/hints entries per frame and drop them first under pressure. html-check uses four projection levels too. command owns persistence; manifests contain the complete delivery record, while stdout is only a summary.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { BLOCKING } from './layout.mjs';
/** @import { Stale, Approximation } from './generate.mjs' */
/** @import { Stop } from './extracts.mjs' */
/** @import { TopEntry } from './check.mjs' */
/** @import { Suggestion, Cluster } from './suggest.mjs' */
/** @import { ZoomResult } from './zoom.mjs' */

/**
 * @typedef {{ node: string, rect: number[], share?: number, bakedOver?: string[], px?: number }} RefRecord
 * @typedef {{ family: string, style: string, postScriptName: string, source: string, metrics: boolean, figmaMissing: boolean,
 *   status?: string, chromeUsed?: string, substituted?: boolean }} FontRecord  The last three fields exist only after checking.
 * @typedef {{
 *   node: string, name?: string, source: 'from' | 'node', extract?: string, extracts?: string[], html?: string, check?: string,
 *   size?: { width: number, height: number }, verdict?: string, reason?: string, message?: string, sizeNote?: string,
 *   diffRatio?: number, mismatched?: number, blocks?: number, refs?: RefRecord[], bakedShare?: number,
 *   layout?: Record<string, number>, cause?: string, structure?: { untracked: number, missing: number, textMismatch: number },
 *   top?: TopEntry[], suggest?: Suggestion[], clusters?: Cluster[], hints?: string[],
 *   approximations?: Record<string, number>, approximationNodes?: Approximation[], glassDefaults?: string[], needsIsland?: string[], needsExtract?: true,
 *   overrides?: { applied: string[], stale: Stale[] }, fonts?: FontRecord[], warnings?: string[], violations?: string[],
 *   error?: { code: string, message: string }, ms?: Record<string, number>
 * }} FrameRecord  Generated frame. Errors before writing contain only node/source, known name/extract, and error.
 * @typedef {{ family: string, style: string, postScriptName: string, figmaMissing: boolean, chromeUsed?: string, substituted: boolean, guessed?: true,
 *   frames: number }} FontTotal  Aggregate by (family, style): boolean flags are true if any frame sets them; join distinct chromeUsed values with " | ".
 * @typedef {{ frames: number, clean: number, passWithFindings: number, fail: number, unchecked: number, errors: number, stale: number, needsIsland: number,
 *   approximations: Record<string, number>, layout: Record<string, { frames: number, nodes: number }>, fonts: FontTotal[] }} Totals
 *   errors/needsIsland count frames; stale counts entries. layout covers top nodes only, counting affected frames and summed node findings. Prioritize substituted or Figma-missing fonts.
 * @typedef {{
 *   schema: 1, generator: string, checker: string, browser?: { version: string, launchMs: number }, overrides: { file: string, sha: string } | 'none', out: string,
 *   frames: FrameRecord[], totals: Totals, done: string[], pending: string[], remaining: string[], stop?: Stop, instruction: string, exitCode: 0 | 1 | 2,
 *   ms: { total: number, fontIndex: number }
 * }} Manifest  <out>/html.json
 * @typedef {{ html: string, node: string, extract: string, verdict?: string, reason?: string, message?: string, diffRatio?: number, mismatched?: number,
 *   blocks?: number, refs?: RefRecord[], bakedShare?: number, check?: string, layout?: Record<string, number>, cause?: string,
 *   structure?: { untracked: number, missing: number, textMismatch: number }, top?: TopEntry[], suggest?: Suggestion[], clusters?: Cluster[], hints?: string[],
 *   focus?: TopEntry[], zoom?: ZoomResult, context?: { overrides: 'recovered' | 'none' | 'unavailable', exact: boolean },
 *   fonts?: { family: string, style: string, postScriptName: string, chromeUsed?: string, figmaMissing: boolean }[], warnings?: string[],
 *   error?: { code: string, message: string } }} PageRecord  Full html-check page shape, projected by stdout level; fonts lists substitutions only.
 * @typedef {{ overridesFile?: string, noCheck?: true, timeoutSeconds?: number, budgetSeconds?: number }} Flags  Explicit user options only, with absolute overridesFile; batch commands preserve only these.
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
/** @param {string} a @param {string} b */
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
/** @param {FrameRecord[]} frames @returns {Totals} */
export function totals(frames) {
  /** @param {string} v */
  const count = v => frames.filter(f => f.verdict === v).length, approximations = /** @type {Record<string, number>} */ ({});
  const layout = /** @type {Totals['layout']} */ ({}), fonts = /** @type {Map<string, FontTotal & { used: Set<string> }>} */ (new Map());
  for (const f of frames) {
    for (const [k, n] of Object.entries(f.approximations ?? {})) approximations[k] = (approximations[k] ?? 0) + n;
    for (const [k, n] of Object.entries(f.layout ?? {})) { const t = layout[k] ??= { frames: 0, nodes: 0 }; t.frames++; t.nodes += n; }
    const seen = new Set();
    for (const r of f.fonts ?? []) {
      const key = JSON.stringify([r.family, r.style]);
      let t = fonts.get(key);
      if (!t) fonts.set(key, t = { family: r.family, style: r.style, postScriptName: r.postScriptName, figmaMissing: false, substituted: false, frames: 0, used: new Set() });
      t.figmaMissing ||= r.figmaMissing; t.substituted ||= !!r.substituted;
      if (r.source === 'guess') t.guessed = true;
      if (r.chromeUsed !== undefined) t.used.add(r.chromeUsed);
      if (!seen.has(key)) { seen.add(key); t.frames++; }
    }
  }
  return { frames: frames.length, clean: count('clean'), passWithFindings: count('pass-with-findings'), fail: count('fail'), unchecked: count('unchecked'),
    errors: frames.filter(f => f.error).length, stale: frames.reduce((n, f) => n + (f.overrides?.stale.length ?? 0), 0),
    needsIsland: frames.filter(f => f.needsIsland?.length).length, approximations, layout,
    fonts: [...fonts.values()].map(({ used, substituted, guessed, frames, ...t }) => ({ ...t, ...(used.size ? { chromeUsed: [...used].join(' | ') } : {}), substituted, ...(guessed ? { guessed } : {}), frames }))
      .sort((a, b) => Number(b.substituted || b.figmaMissing) - Number(a.substituted || a.figmaMissing) || order(a.family, b.family) || order(a.style, b.style)) };
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
// use --node for remaining frames, errors without pages, missing islands and all-default GLASS parameters that may indicate unloaded library data.
// List remaining first among --node values, making the mandatory first submission a genuinely unacquired frame.
// If a second extraction timed out, its pending complete result is already included in --from. Do not also add --node for the same missing-island frame; duplicates fail preflight.
/** @param {Pick<Manifest, 'frames' | 'done' | 'pending' | 'remaining' | 'out'>} m @param {Flags} flags @param {{ overridesPlaceholder?: boolean }} [extra] @returns {string} */
export function batch({ frames, done, pending, remaining, out }, flags, { overridesPlaceholder = false } = {}) {
  const used = new Map(frames.filter(f => f.extract).map(f => [f.extract, f]));
  /** @param {FrameRecord | undefined} f */
  const again = f => !!(f?.needsIsland?.length || f?.glassDefaults?.length);
  const from = [...done.filter(id => !again(used.get(id))), ...pending];
  const covered = new Set(frames.filter(f => [f.extract, ...f.extracts ?? []].some(id => id && from.includes(id))).map(f => f.node));
  const nodes = [...new Set([...remaining, ...frames.filter(f => f.error && !f.html).map(f => f.node), ...frames.filter(again).map(f => f.node)])]
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

// When continuation is pending, give only continuation instructions; other issues will be reported afterward. Otherwise address each category, joining sentences with ". " and using "; " internally.
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
  const fail = has(f => f.verdict === 'fail'), proposed = has(f => f.suggest?.length);
  if (fail) said.push('For failing frames, first read top and the evidence directory\'s block-<n>.png and check.json; write top[].fix into that frame\'s group in overrides (top-level key is the frame node ID): '
    + 'if the node already has an entry, replace only its style.transform and basis.transform, otherwise create one; add a note'
    + (has(f => f.verdict === 'fail' && f.top?.some(e => e.fix && e.flat)) ? '; always write fix as transform, even for nodes written as left/top in the page; do not copy left/top from the HTML' : ''));
  if (has(f => f.structure?.untracked)) said.push('Page has data-node elements outside the extract tree (untracked): the page was hand-edited; regenerate it and put fixes only in overrides');
  if (has(f => f.structure?.missing || f.structure?.textMismatch)) said.push('Page is missing nodes or its text differs from Figma (missing, textMismatch; details in check.json): this is a generator defect, report it');
  const swapped = m.totals.fonts.filter(r => r.substituted);
  if (swapped.length) said.push(fontAdvice(swapped, 'see totals.fonts'));
  if (Object.keys(m.totals.layout).some(k => BLOCKING.has(k)))
    said.push('Some top nodes differ from Figma in geometry or line wrapping (totals.layout; details in check.json): the same kind of finding in two or more frames is a generator issue, report it; fix single nodes with top[].fix');
  if (has(f => f.glassDefaults?.length)) said.push('Some frames have all-default GLASS parameters (glassDefaults): library variables may not have loaded; browse that page in Figma first; the command below re-extracts these frames with --node');
  if (proposed) said.push(bakeAdvice('suggest; full list in html.json'));
  if (has(f => f.overrides?.stale.length)) said.push('Stale overrides entries were not applied: for missing, correct or remove the node ID; for changed, verify basis; for invalid, see reason (details in html.json)');
  if (has(f => f.needsIsland?.length)) said.push('Some frames lack islands exported by Figma (needsIsland; --from frames are marked needsExtract; why the second extract failed is in the frame\'s warnings); the command below re-extracts them');
  if (has(f => f.error)) said.push(`For frames with errors, see error in html.json${has(f => f.error && !f.html) ? '; the command below re-extracts frames that have no page' : ''}`);
  if (said.length) said.push(`Then run ${batch(m, flags, { overridesPlaceholder: fail || proposed })}`);
  said.push(...uncheckedAdvice(frames.map(f => f.reason ?? ''), 'run figma-agent-control html-check on the pages (page paths in html.json)', 'retry with figma-agent-control html-check on these pages'));
  if (has(f => f.violations?.length)) said.push('Generated output violates output invariants (violations in html.json); report this generator defect');
  if (!said.length) said.push(flags.noCheck ? `Generated, not checked (--no-check); you can run figma-agent-control html-check; ${manifest} is the manifest of this batch` : `All frames pass; ${manifest} is the manifest of this batch`);
  return said.join('. ');
}

// Shared html/html-check guidance for bake:"ref" suggestions.
/** @param {string} where Source label displayed in parentheses. */
const bakeAdvice = where => `Background-dependent approximations got bake:"ref" suggestions (${where}): review the block crops and add a note before writing them into overrides, and delete or rewrite the entries listed in replaces beforehand; fix text and position first and use ref only as a last step`;
// Font-substitution guidance lists at most three entries and truncates strings to 64 characters, keeping even the smallest stdout projection bounded.
/** @param {{ family: string, style: string, postScriptName: string, chromeUsed?: string, figmaMissing: boolean }[]} rows @param {string} where Source label displayed in parentheses. */
const fontAdvice = (rows, where) => `Local fonts do not match the declared fonts: ${rows.slice(0, 3).map(r => `${clip(r.family, 64)} ${clip(r.style, 64)} (${clip(r.postScriptName, 64)} -> ${clip(r.chromeUsed ?? 'not loaded', 64)})`).join(', ')}`
  + ` (${where}): install or fix the local fonts, then rerun${rows.some(r => r.figmaMissing) ? '; fonts with figmaMissing true are missing in Figma too, so the reference image itself uses a substitute font' : ''}`;

// Give one remedy per unchecked category: missing Chrome, browser failure/render timeout, and incorrect reference dimensions.
/** @param {string[]} reasons @param {string} afterInstall @param {string} retry */
function uncheckedAdvice(reasons, afterInstall, retry) {
  const said = [];
  if (reasons.some(r => LAUNCH.has(r))) said.push(`Install Chrome or set FIGMA_AGENT_CONTROL_CHROME, then ${afterInstall}`);
  if (reasons.some(r => RECHECK.has(r))) said.push(`Chrome failed midway or rendering timed out; ${retry}`);
  if (reasons.includes('REFERENCE_SIZE')) said.push('Reference image and extract tree sizes differ by more than 1 px (see expected and reference in check.json): for very large frames this is usually Figma downsampling, so split them into smaller child nodes with --node; re-extract only if the design was just changed in Figma');
  return said;
}

// -- stdout ---------------------------------------------------------------
// Frames needing attention have errors, non-clean or absent verdicts, stale entries, missing islands or violations. Lower sort keys come first; ties retain processing order.
/** @param {FrameRecord} f */
const rank = f => f.error ? 0 : f.verdict === 'fail' ? 1 : f.verdict === 'unchecked' ? 2 : flagged(f) ? 3 : f.verdict === 'pass-with-findings' ? 4 : f.verdict ? 6 : 5;
// Compact top/focus/suggest shapes include only bakedOver counts; full detail remains in html.json/check.json.
/** @param {TopEntry} e */
const entry = ({ node, name, px, htmlPx, figmaPx, hint, fix, flat }) => ({ node, name: clip(name, 60), px, htmlPx, figmaPx, ...(hint ? { hint: clip(hint, 400) } : {}),
  ...(fix ? { fix } : {}), ...(flat ? { flat } : {}) });
/** @param {Suggestion} s */
const proposal = ({ node, entry, rect, share, textNodes, bakedOver }) => ({ node, entry, rect, share, textNodes, bakedOver: bakedOver.length });
// hints explain triggered clusters without suggestions (root, area or text mismatch) and seam warnings. These alone prevent clean, so summaries must expose the reason.
/** At most three top, three suggest and three hints entries per frame/page. @param {{ top?: TopEntry[], suggest?: Suggestion[], hints?: string[] }} f */
const details = ({ top = [], suggest = [], hints = [] }) => ({ ...(top.length ? { top: top.slice(0, 3).map(entry), ...(top.length > 3 ? { topOmitted: top.length - 3 } : {}) } : {}),
  ...(suggest.length ? { suggest: suggest.slice(0, 3).map(proposal), ...(suggest.length > 3 ? { suggestOmitted: suggest.length - 3 } : {}) } : {}),
  ...(hints.length ? { hints: hints.slice(0, 3).map(h => clip(h, 400)), ...(hints.length > 3 ? { hintsOmitted: hints.length - 3 } : {}) } : {}) });
/** @param {FrameRecord} f @param {boolean} detail */
function brief(f, detail) {
  const refs = f.refs ?? [], stale = f.overrides?.stale ?? [];
  return { node: f.node, ...(f.name !== undefined ? { name: clip(f.name, 100) } : {}), ...(f.extract ? { extract: f.extract } : {}),
    ...(f.verdict ? { verdict: f.verdict } : {}), ...(f.reason ? { reason: f.reason } : {}), ...(f.diffRatio !== undefined ? { diffRatio: f.diffRatio } : {}),
    ...(f.cause ? { cause: f.cause } : {}),
    ...(f.blocks !== undefined ? { blocks: f.blocks } : {}), ...(f.html ? { html: f.html } : {}),
    ...(refs.length ? { refs: refs.slice(0, 3).map(({ node, rect, share }) => ({ node, rect, share })), ...(refs.length > 3 ? { refsOmitted: refs.length - 3 } : {}) } : {}),
    ...(f.bakedShare !== undefined ? { bakedShare: f.bakedShare } : {}),
    ...(stale.length ? { stale: stale.slice(0, 3).map(({ node, kind }) => ({ node, kind })), ...(stale.length > 3 ? { staleOmitted: stale.length - 3 } : {}) } : {}),
    ...(f.needsIsland?.length ? { needsIsland: f.needsIsland.length } : {}), ...(f.needsExtract ? { needsExtract: true } : {}),
    ...(f.error ? { error: { code: f.error.code, message: clip(f.error.message, 600) } } : {}), ...(detail ? details(f) : {}) };
}

// Four progressively smaller candidates: full shape with at most ten frames and diagnostics; frames without diagnostics; no frame list; then no continuation lists and only manifest-directed guidance.
// The last candidate has bounded fields only. stdout font totals allow ten rows, counting extras as fontsOmitted; strings truncate at 64 characters. html.json retains everything.
/** @param {Manifest} m @returns {object} */
export function stdoutOf(m) {
  const watch = m.frames.map((f, i) => ({ f, i })).filter(({ f }) => rank(f) < 6).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(({ f }) => f);
  const summary = `${m.out}/html.json`, resume = m.pending.length || m.remaining.length, fonts = m.totals.fonts;
  const short = { ...m.totals, fonts: fonts.slice(0, 10).map(r => ({ ...r, family: clip(r.family, 64), style: clip(r.style, 64), postScriptName: clip(r.postScriptName, 64),
    ...(r.chromeUsed !== undefined ? { chromeUsed: clip(r.chromeUsed, 64) } : {}) })), ...(fonts.length > 10 ? { fontsOmitted: fonts.length - 10 } : {}) };
  const head = { ...(m.browser ? { browser: m.browser.version } : {}), totals: short };
  const stop = m.stop ? { stop: { code: m.stop.code, message: clip(m.stop.message, 600), ...(m.stop.active ? { active: m.stop.active } : {}) } } : {};
  const lists = resume ? { done: m.done, pending: m.pending, remaining: m.remaining } : {};
  /** @param {boolean} detail */
  const listed = detail => ({ ...head, frames: watch.slice(0, 10).map(f => brief(f, detail)), omittedFrames: Math.max(0, watch.length - 10), ...lists, ...stop, summary, instruction: m.instruction });
  return fit(() => listed(true), () => listed(false),
    () => ({ ...head, omittedFrames: watch.length, ...lists, ...stop, summary, instruction: m.instruction }),
    () => ({ ...head, omittedFrames: watch.length, ...stop, summary, instruction: `Instruction too long; see instruction in ${summary} for the full text` }));
}

// html-check projection levels: all pages with detail (up to three top/suggest/hints, all focus, zoom numbers/errors/warnings and up to three page warnings);
// then all pages without detail (zoom keeps node/dir); then only non-clean pages without details/warnings and error code only; finally no page list.
// Substituted fonts appear only in guidance; full diagnostics remain in each check.json. Guidance omits page paths to bound length.
/** @param {{ browser?: string, pages: PageRecord[] }} input @returns {object} */
export function checkStdout({ browser, pages }) {
  /** @param {string} v */
  const count = v => pages.filter(p => p.verdict === v).length;
  const head = { ...(browser ? { browser } : {}), totals: { pages: pages.length, clean: count('clean'), passWithFindings: count('pass-with-findings'), fail: count('fail'),
    unchecked: count('unchecked'), errors: pages.filter(p => p.error).length } };
  const swapped = [...new Map(pages.flatMap(p => p.fonts ?? []).map(r => [JSON.stringify([r.family, r.style]), r])).values()];
  const said = [...(count('fail') ? ['For failing pages, read check.json and diff.png'] : []), ...(pages.some(p => p.error) ? ['For pages with errors, see error'] : []),
    ...(swapped.length ? [fontAdvice(swapped, 'see fonts in each page\'s check.json')] : []), ...(pages.some(p => p.suggest?.length) ? [bakeAdvice('pages[].suggest; full list in each page\'s check.json')] : []),
    ...(pages.some(p => p.focus || p.zoom) ? ['--node and --zoom results are in pages[].focus and pages[].zoom; zoomed images are in zoom-<node>/ in the evidence directory'] : []),
    ...uncheckedAdvice(pages.map(p => p.reason ?? ''), 'rerun html-check', 'rerun html-check')];
  const instruction = said.join('. ') || 'All pages pass', dirty = pages.filter(p => p.verdict !== 'clean');
  /** @param {PageRecord} p @param {0 | 1 | 2} level 0 includes detail; 1 omits detail; 2 also omits warnings and error.message. */
  const shown = ({ top, suggest, clusters, hints, focus, zoom, fonts, warnings, error, ...p }, level) => ({ ...p,
    ...(level === 0 ? { ...details({ top, suggest, hints }), ...(focus ? { focus: focus.map(entry) } : {}) } : {}),
    ...(zoom ? { zoom: level === 0 ? zoomBrief(zoom) : { node: zoom.node, dir: zoom.dir } } : {}),
    ...(warnings?.length && level < 2 ? { warnings: warnings.slice(0, 3).map(w => clip(w, 400)) } : {}),
    ...(error ? { error: level < 2 ? { code: error.code, message: clip(error.message, 600) } : { code: error.code } } : {}) });
  return fit(
    () => ({ ...head, pages: pages.map(p => shown(p, 0)), omittedPages: 0, instruction }),
    () => ({ ...head, pages: pages.map(p => shown(p, 1)), omittedPages: 0, instruction }),
    () => ({ ...head, pages: dirty.map(p => shown(p, 2)), omittedPages: pages.length - dirty.length, instruction }),
    () => ({ ...head, omittedPages: pages.length, instruction }));
}
/** @param {ZoomResult} z */
const zoomBrief = ({ node, scale, size, mismatched, diffRatio, shift, fix, hint, reason, error, warnings, dir }) => ({ node, scale, size, ...(mismatched !== undefined ? { mismatched, diffRatio } : {}),
  ...(shift ? { shift } : {}), ...(fix ? { fix } : {}), ...(hint ? { hint: clip(hint, 400) } : {}), ...(reason ? { reason } : {}), ...(error ? { error: clip(error, 400) } : {}),
  ...(warnings?.length ? { warnings: warnings.slice(0, 3).map(w => clip(w, 400)) } : {}), dir });
