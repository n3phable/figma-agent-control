/**
 * [INPUT]: Uses ./extracts fromJob/readLanded/submit/awaitLanded; ./page assemble/expectedSize/pageFile/readMeta/readRefs/indexPages/writePage;
 *          ./overrides loadOverrides; ./summary totals/exitCode/instruction/stdoutOf/checkStdout/LAUNCH; ./check check/writeEvidence/CHECKER;
 *          injectable ./chrome launch; ./fonts findFont for index warmup; ./generate GENERATOR; ./zoom zoomTarget for preflight;
 *          ../png decodePng for zoom-reference preflight; ../project root/save/json/isJobId; node:fs/promises, node:path, node:url, node:perf_hooks and node:timers/promises.
 * [OUTPUT]: html(cwd, options, deps?) -> { summary, exitCode }, htmlCheck(cwd, files, options?, deps?) -> { summary, exitCode },
 *           glassDefaults(node) -> nodes whose GLASS parameters are all defaults, plus Deps.
 * [POS]: The html/html-check orchestration entry used by bin: validate inputs without writes, then acquire/generate/write/check/record each frame and persist the manifest.
 *        html-check regenerates diagnostic context from page metadata, preflighting --node/--zoom before Chrome. Owns browser lifecycle: lazy html launch, eager html-check launch, replacement after failure,
 *        and no further checks after render timeout. Sibling modules own acquisition, page format, trust validation and output shape; this file decides ordering and where failures are recorded.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fromJob, readLanded, submit, awaitLanded } from './extracts.mjs';
import { assemble, expectedSize, pageFile, readMeta, readRefs, indexPages, writePage } from './page.mjs';
import { loadOverrides } from './overrides.mjs';
import { totals, exitCode, instruction, stdoutOf, checkStdout, LAUNCH } from './summary.mjs';
import { check, writeEvidence, CHECKER } from './check.mjs';
import { launch as launchChrome } from './chrome.mjs';
import { findFont } from './fonts.mjs';
import { GENERATOR } from './generate.mjs';
import { zoomTarget } from './zoom.mjs';
import { decodePng } from '../png.mjs';
import { root, save, json, isJobId } from '../project.mjs';
/** @import { Clock, Stop, Landed } from './extracts.mjs' */
/** @import { FrameRecord, Manifest, PageRecord, Flags } from './summary.mjs' */
/** @import { Approximation, OverrideEntry } from './generate.mjs' */
/** @import { ExtractNode, BinaryFile } from './extract-contract.js' */

/** @typedef {{ clock?: Clock, stderr?: (line: string) => void, launch?: typeof launchChrome, call?: Parameters<typeof submit>[2]['call'] }} Deps
 *   Defaults to real time, process.stderr and chrome.launch. Pass call through to extracts, defaulting to client.call. Tests inject budget/retry/browser control. */

/** @param {number} t */
const elapsed = t => Math.round(performance.now() - t);
/** @param {Record<string, OverrideEntry> | undefined} group This frame's bake:"svg" node IDs to export from Figma, in key order. */
const svgBakes = group => Object.keys(group ?? {}).filter(id => group?.[id].bake === 'svg');
/** @param {string[]} keys */
function countBy(keys) {
  const counts = /** @type {Record<string, number>} */ ({});
  for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  return counts;
}
// Families/styles used by TEXT with hasMissingFont: Figma also lacks these fonts, so reference glyphs use substitutes.
/** @param {ExtractNode} node @param {Set<string>} [found] */
function missingFonts(node, found = new Set()) {
  if (node.hasMissingFont === true) for (const s of node.segments ?? []) found.add(`${s.fontName.family}\0${s.fontName.style}`);
  for (const child of node.children ?? []) missingFonts(child, found);
  return found;
}
// Visible GLASS effects with library-variable bindings but all-default parameters (radius, refraction, lightAngle, lightIntensity, dispersion, splay = 0; depth = 1; missing keys use defaults)
// may have been extracted before library data finished loading. Traverse only the extract tree and return node IDs in preorder.
const GLASS_ZERO = /** @type {const} */ (['radius', 'refraction', 'lightAngle', 'lightIntensity', 'dispersion', 'splay']);
/** @param {ExtractNode} node @param {string[]} [found] @returns {string[]} */
export function glassDefaults(node, found = []) {
  if ((node.effects ?? []).some(e => e.type === 'GLASS' && e.visible !== false && Object.keys(e.boundVariables ?? {}).length > 0
    && GLASS_ZERO.every(k => (e[k] ?? 0) === 0) && (e.depth ?? 1) === 1)) found.push(node.id);
  for (const child of node.children ?? []) glassDefaults(child, found);
  return found;
}
// Shared check-report fields for frame/page records: refs omit placeholder keys, while px/seam come from checks. layout counts top-node geometry findings, including advisory ink-offset;
// structure counts its three categories, omitted when all zero, with full lists in check.json. Preserve top/focus/suggest/clusters/hints/zoom; summary compresses stdout.
/** @param {Record<string, any>} r */
const fromReport = r => ({ verdict: r.verdict, ...(r.reason ? { reason: r.reason } : {}), ...(r.message ?? r.error ? { message: r.message ?? r.error } : {}),
  ...(r.sizeNote ? { sizeNote: r.sizeNote } : {}), ...(r.diffRatio !== undefined ? { diffRatio: r.diffRatio, mismatched: r.mismatched, blocks: r.blocks.length } : {}),
  ...(r.refs ? { refs: r.refs.map((/** @type {{ key?: string }} */ { key, ...ref }) => ref) } : {}), ...(r.bakedShare !== undefined ? { bakedShare: r.bakedShare } : {}),
  ...(r.top ? { layout: countBy(r.top.flatMap((/** @type {{ layout?: { kind: string }[] }} */ e) => (e.layout ?? []).map(f => f.kind))) } : {}),
  ...(r.cause ? { cause: r.cause } : {}),
  ...(r.untracked?.length || r.missing?.length || r.textMismatch?.length ? { structure: { untracked: r.untracked.length, missing: r.missing.length, textMismatch: r.textMismatch.length } } : {}),
  ...(r.top ? { top: r.top } : {}), ...(r.focus ? { focus: r.focus } : {}), ...(r.suggest ? { suggest: r.suggest, clusters: r.clusters, hints: r.hints } : {}), ...(r.zoom ? { zoom: r.zoom } : {}) });

// -- Browser lifecycle --------------------------------------------------
// Launch lazily; remember startup failure so later frames become unchecked directly. Create one page per frame and close in finally; close failure only retires the browser.
// Pipe/process failure makes only this frame unchecked, retiring Chrome for replacement on the next frame. After render timeout, stop checking this batch: each timeout costs 30 s plus shutdown,
// so repeated frame retries could exceed the agent command deadline. Closing a hung page may also wait 30 s; in either failure case, retire the browser directly without page close.
const MIDWAY = new Set(['CHROME_PROTOCOL', 'CHROME_EXITED']);
const AFTER_TIMEOUT = { reason: 'RENDER_TIMEOUT', message: 'A frame already timed out rendering in this run, so this frame was not checked; retry with html-check' };
/** @param {typeof launchChrome} launch */
function checker(launch) {
  /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
  let browser = null;
  /** @type {{ reason: string, message: string } | null} */
  let blocked = null;
  const info = { version: '', launchMs: 0 };
  const retire = async () => { const b = browser; browser = null; await b?.close().catch(() => {}); };
  async function ready() {
    if (browser) return browser;
    const t = performance.now();
    try { browser = await launch(); } finally { info.launchMs += elapsed(t); }
    info.version = browser.version;
    return browser;
  }
  /** @param {Parameters<typeof check>[1]} input @param {string} dir Evidence directory. @param {Record<string, unknown>} [extra] Additional report fields, such as html-check context.
   *  @returns {Promise<{ report: Record<string, any>, evidence?: string }>} */
  async function run(input, dir, extra = {}) {
    if (blocked) return { report: { verdict: 'unchecked', ...blocked } };
    let b;
    try { b = await ready(); } catch (error) {
      if (!LAUNCH.has(error.code)) throw error;
      blocked = { reason: error.code, message: error.message };
      return { report: { verdict: 'unchecked', ...blocked } };
    }
    /** @type {Awaited<ReturnType<typeof b.page>> | undefined} */
    let page;
    let healthy = true;
    try {
      page = await b.page();
      const result = await check(page, input), report = /** @type {Record<string, any>} */ ({ ...result.report, ...extra });
      // Zoom timeouts remain in zoom and preserve the 1x report. Retire Chrome, but continue later pages: at most one zoom comparison per invocation avoids repeated per-page timeouts.
      const late = report.reason === 'RENDER_TIMEOUT';
      if (late || report.zoom?.reason === 'RENDER_TIMEOUT') { healthy = false; if (late) blocked = AFTER_TIMEOUT; await retire(); }
      await writeEvidence(dir, report, 'images' in result ? result.images : undefined);
      return { report, evidence: path.join(dir, 'check.json') };
    } catch (error) {
      if (error.code !== 'RENDER_TIMEOUT' && !MIDWAY.has(error.code)) throw error;
      healthy = false;
      if (error.code === 'RENDER_TIMEOUT') blocked = AFTER_TIMEOUT;
      await retire();
      return { report: { verdict: 'unchecked', reason: error.code, message: error.message } };
    } finally { if (healthy && page) await page.close().catch(retire); }
  }
  return { ready, run, close: retire, info };
}

// -- html -----------------------------------------------------------------
// Throw only on input preflight failure, before writing anything. Later issues enter the manifest/exit code. Process --from first, then --node, preserving order within each group.
/** @param {string} cwd @param {import('../args.mjs').Options} options @param {Deps} [deps] @returns {Promise<{ summary: object, exitCode: 0 | 1 | 2 }>} */
export async function html(cwd, options, deps = {}) {
  const started = performance.now(), clock = deps.clock ?? { now: () => performance.now(), sleep: delay };
  const ctx = { clock, stderr: deps.stderr ?? (line => { process.stderr.write(line + '\n'); }), call: deps.call };
  // -- Preflight --
  const from = [];
  for (const id of options.fromIds ?? []) from.push(await fromJob(cwd, id));
  const overridesFile = options.overridesFile === undefined ? undefined : path.resolve(cwd, options.overridesFile);
  const { groups, sha } = overridesFile ? loadOverrides(overridesFile) : { groups: {}, sha: 'none' };
  const frames = [...from.map(f => ({ node: f.node, from: f.id })), ...(options.nodes ?? (options.targetNodeId ? [options.targetNodeId] : [])).map(node => ({ node, from: '' }))];
  const seen = new Set();
  for (const { node } of frames) {
    if (seen.has(node)) throw Error(`Same frame given twice: ${node}`);
    seen.add(node);
    const n = svgBakes(groups[node]).length;
    if (n > 500) throw Error(`Invalid --overrides: ${JSON.stringify([node])}: ${n} bake:"svg" entries, at most 500 per frame (extract islands limit)`);
  }
  const out = path.resolve(cwd, /** @type {string} */ (options.outDir));
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const index = await indexPages(out), t0 = clock.now(), tf = performance.now();
  findFont({});   // Build the process-local font index once and time it separately from the first frame.
  const fontIndex = elapsed(tf), budget = options.budgetSeconds ?? 90, timeout = options.timeoutSeconds ?? 30;
  // Budget constrains initial submission/waiting for new frames only. Wait for the smaller of --timeout and remaining budget, with a 1 s minimum.
  const left = () => budget * 1000 - (clock.now() - t0), wait = () => Math.min(timeout, Math.max(1, Math.ceil(left() / 1000)));
  /** @param {string} id @returns {Stop} */
  const expired = id => left() <= 0 ? { kind: 'retry', code: 'BUDGET_EXPIRED', message: `Time budget of ${budget} s expired; extract ${id} is still running` }
    : { kind: 'retry', code: 'WAIT_TIMEOUT', message: `Wait for extract ${id} timed out; it is still running` };
  /** @param {string} id @returns {Stop} */
  const interrupted = id => ({ kind: 'retry', code: 'INTERRUPTED', message: `extract ${id} was interrupted and has no result` });
  const cache = new Map(), ck = checker(deps.launch ?? launchChrome);
  /** @type {FrameRecord[]} */
  const records = [];
  // done contains extracts for written pages needing no reacquisition; pending contains active extracts; remaining contains frames requiring fresh --node extraction.
  const done = /** @type {string[]} */ ([]), pending = /** @type {string[]} */ ([]), remaining = /** @type {string[]} */ ([]);
  /** @type {Stop | undefined} */
  let stop;
  let accepted = 0;

  // Per frame: acquire -> generate (re-extract for missing islands) -> write -> check -> record. Failures stay local; errors after writing retain existing fields and include the ID in done.
  /** @param {{ node: string, from: string }} frame */
  async function one({ node, from }) {
    const ms = { extract: 0, generate: 0, write: 0, check: 0 }, group = groups[node] ?? {}, svg = svgBakes(group);
    /** @type {FrameRecord} */
    let rec = { node, source: from ? 'from' : 'node', ...(from ? { extract: from } : {}) };
    let parked = false;   // Frames already recorded in pending or remaining do not also enter done.
    try {
      // -- Acquire the first result --
      let t = performance.now(), got;
      if (from) {
        got = await readLanded(cwd, from);
        if ('pending' in got) { pending.push(from); return; }
        if ('interrupted' in got) {
          remaining.push(node);
          records.push({ ...rec, error: { code: 'EXTRACT_INTERRUPTED', message: `extract ${from} was interrupted and has no result; re-extract with --node` } });
          return;
        }
      } else {
        // Submit at least one frame successfully per invocation so continuation always advances.
        if (accepted > 0 && left() < 1000) { stop = { kind: 'retry', code: 'BUDGET_EXPIRED', message: `Time budget of ${budget} s expired; remaining frames were not submitted` }; remaining.push(node); return; }
        const s = await submit(cwd, { node, islands: svg }, ctx);
        if ('stop' in s) { stop = s.stop; remaining.push(node); return; }
        if ('rejected' in s) { records.push({ ...rec, error: { code: 'EXTRACT_REJECTED', message: s.rejected } }); return; }
        accepted++; rec.extract = s.id;
        got = await awaitLanded(cwd, s.id, wait(), clock);
        if ('pending' in got) { stop = expired(s.id); pending.push(s.id); return; }
        if ('interrupted' in got) { stop = interrupted(s.id); remaining.push(node); return; }
      }
      if ('failed' in got) { records.push({ ...rec, error: { code: 'EXTRACT_FAILED', message: got.failed.message } }); return; }
      ms.extract += elapsed(t);
      rec.name = got.landed.output.root.name;

      // -- Generate and re-extract missing islands plus valid bake:"svg" entries --
      /** @param {Landed} landed */
      const build = landed => { const t = performance.now(), g = assemble(landed.output, { dir: landed.dir, extract: landed.id, overrides: group, overridesHash: sha, cache }); ms.generate += elapsed(t); return g; };
      let used = got.landed, gen = build(used), warnings = [...used.output.warnings ?? []];
      const first = gen, extracts = [used.id];
      /** @type {Approximation[]} */
      let approximations = [...first.result.approximations];
      let needsExtract = false;
      if (first.result.needsIsland.length && from) needsExtract = true;
      else if (first.result.needsIsland.length) {
        const stale = new Set(first.result.overrides.stale.map(s => s.node));
        const islands = [...new Set([...first.result.needsIsland, ...svg.filter(id => !stale.has(id))])];
        let detail = '', why = '';
        if (islands.length > 500) [detail, why] = ['too-many-islands', `${islands.length} island(s) needed, over the extract limit of 500; not submitted`];
        else {
          const s = await submit(cwd, { node, islands }, ctx);
          if ('stop' in s) { stop = s.stop; remaining.push(node); parked = true; [detail, why] = ['stopped', s.stop.message]; }
          else if ('rejected' in s) [detail, why] = ['rejected', s.rejected];
          else {
            extracts.push(s.id);
            rec.extracts = extracts;   // Errors before page writing still reference the second task being awaited, so the batch command includes this frame through --from.
            t = performance.now();
            const o = await awaitLanded(cwd, s.id, wait(), clock);
            ms.extract += elapsed(t);
            if ('landed' in o) {
              const second = build(o.landed);
              if (second.result.needsIsland.length) [detail, why] = ['islands-missing', `Still missing island(s) ${second.result.needsIsland.join(', ')} (see warnings of extract ${s.id} for the cause)`];
              else { used = o.landed; gen = second; warnings = [...used.output.warnings ?? []]; approximations = [...second.result.approximations]; }
            } else if ('failed' in o) [detail, why] = ['extract-failed', o.failed.message];
            else if ('pending' in o) { stop = expired(s.id); pending.push(s.id); parked = true; [detail, why] = ['wait-timeout', stop.message]; }
            else { stop = interrupted(s.id); remaining.push(node); parked = true; [detail, why] = ['stopped', stop.message]; }
          }
        }
        // Fall back to the first extract, keeping tree/reference from the same snapshot; record each missing island as an approximation and explain why in warnings.
        if (detail) {
          approximations.push(...first.result.needsIsland.map(id => ({ node: id, kind: 'second-extract-failed', detail })));
          warnings.push(`Second extract did not complete (${detail}): ${why}`);
        }
      }

      // -- Write pages --
      const top = used.output.root, file = pageFile(top.name, top.id), page = path.join(out, file);
      t = performance.now();
      await writePage(out, file, top.id, gen.html, index);
      ms.write = elapsed(t);
      const missing = missingFonts(top), refs = gen.result.refs.map(({ key, ...r }) => r), glass = glassDefaults(top);
      if (glass.length) warnings.push(`GLASS parameters are all defaults while bound to library variables (${glass.length} node(s), e.g. ${glass.slice(0, 3).join(', ')}): library data may not have finished loading; the reference image and extract tree still come from the same job; `
        + 'browse that page in Figma, then re-extract with --node');
      // Merge font diagnostics by index after checking; report.fonts is derived entry-for-entry from the same gen.result.fonts.
      /** @param {{ status?: string, chromeUsed?: string, substituted: boolean }[]} [audited] */
      const fonts = audited => gen.result.fonts.map(({ face, ...f }, i) => {
        const a = audited?.[i];
        return { ...f, figmaMissing: missing.has(`${f.family}\0${f.style}`), ...(a ? { ...(a.status !== undefined ? { status: a.status } : {}),
          ...(a.chromeUsed !== undefined ? { chromeUsed: a.chromeUsed } : {}), substituted: a.substituted } : {}) };
      });
      const head = { node, name: top.name, source: rec.source, extract: used.id, ...(extracts.length > 1 ? { extracts } : {}), html: page };
      const tail = { approximations: countBy(approximations.map(a => a.kind)), approximationNodes: approximations, ...(glass.length ? { glassDefaults: glass } : {}),
        ...(gen.result.needsIsland.length ? { needsIsland: gen.result.needsIsland } : {}),
        ...(needsExtract ? { needsExtract: /** @type {true} */ (true) } : {}), ...(overridesFile ? { overrides: gen.result.overrides } : {}), fonts: fonts(),
        ...(warnings.length ? { warnings } : {}), ...(gen.violations.length ? { violations: gen.violations } : {}), ms };
      rec = { ...head, size: gen.expected, ...(refs.length ? { refs } : {}), ...tail };
      if (!parked) done.push(used.id);

      // -- Check pages --
      if (!options.noCheck) {
        const reference = await fs.readFile(path.resolve(used.dir, /** @type {BinaryFile} */ (used.output.reference).file)), launched = ck.info.launchMs;
        t = performance.now();
        const frame = { output: used.output, result: gen.result, overrides: group };
        const { report, evidence } = await ck.run({ url: pathToFileURL(page).href, reference, expected: gen.expected, refs: gen.result.refs, frame }, path.join(root(cwd), 'check', used.id));
        ms.check = Math.max(0, elapsed(t) - (ck.info.launchMs - launched));
        rec = { ...head, ...(evidence ? { check: evidence } : {}), size: gen.expected, ...(refs.length ? { refs } : {}), ...fromReport(report), ...tail, fonts: fonts(report.fonts) };
      }
      records.push(rec);
    } catch (error) {
      records.push({ ...rec, error: { code: error.code ?? 'COMMAND_FAILED', message: error.message } });
    }
  }

  try {
    for (const frame of frames) {
      if (stop) remaining.push(frame.node);
      else await one(frame);
    }
  } finally { await ck.close(); }

  /** @type {Flags} */
  const flags = { ...(overridesFile ? { overridesFile } : {}), ...(options.noCheck ? { noCheck: options.noCheck } : {}),
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}), ...(options.budgetSeconds !== undefined ? { budgetSeconds: options.budgetSeconds } : {}) };
  /** @type {Manifest} */
  const manifest = { schema: 1, generator: GENERATOR, checker: CHECKER, ...(ck.info.version ? { browser: { version: ck.info.version, launchMs: ck.info.launchMs } } : {}),
    overrides: overridesFile ? { file: overridesFile, sha } : 'none', out, frames: records, totals: totals(records), done, pending, remaining, ...(stop ? { stop } : {}),
    instruction: '', exitCode: 0, ms: { total: 0, fontIndex } };
  manifest.instruction = instruction(manifest, flags);
  manifest.exitCode = exitCode(manifest);
  manifest.ms.total = elapsed(started);
  await save(path.join(out, 'html.json'), manifest);
  return { summary: stdoutOf(manifest), exitCode: manifest.exitCode };
}

// -- html-check -----------------------------------------------------------
// Preflight every page (any failure throws), then --node/--zoom, launch Chrome (failure throws), and render/compare/diagnose each page. No Figma connection or page rewriting;
// locate references through each page's extract metadata in the current project. Store evidence beside html-command evidence, replacing the previous check.
// Recover approximation/font/overrides.applied context by regenerating from metadata. For overridden pages, read a matching-fingerprint group from the overrides file recorded in adjacent html.json;
// if unavailable, diagnose without overrides and mark context.overrides unavailable. Regeneration differing from the page, through manual edits or generator drift, sets exact false.
// context is the sole structured representation; warnings add one sentence for each condition. Non-Chrome page errors use the same error shape as html frame records, then continue to the next page.
/** @param {Awaited<ReturnType<typeof readLanded>>} got A non-landed outcome. */
const unusable = got => 'failed' in got ? got.failed.message : 'pending' in got ? 'no result yet' : 'interrupted';
/** @param {string} file @param {{ node: string, overrides: string }} meta @returns {Promise<Record<string, OverrideEntry> | null>} */
async function recover(file, meta) {
  try {
    const { groups, sha } = loadOverrides((await json(path.join(path.dirname(file), 'html.json'))).overrides.file);
    return sha === meta.overrides ? groups[meta.node] ?? {} : null;
  } catch { return null; }
}
/** @param {string} cwd @param {string[]} files @param {import('../args.mjs').Options} [options] @param {Deps} [deps] @returns {Promise<{ summary: object, exitCode: 0 | 1 }>} */
export async function htmlCheck(cwd, files, options = {}, deps = {}) {
  const pages = [];
  for (const given of files) {
    const file = path.resolve(cwd, given), text = await fs.readFile(file, 'utf8').catch(error => { throw Error(`Cannot read ${file}: ${error.message}`); }), meta = readMeta(text);
    if (!meta) throw Error(`${file} is not a page generated by figma-agent-control (missing meta)`);
    if (!isJobId(meta.extract)) throw Error(`${file} is not a page generated from an extract`);
    if (meta.scale !== 1) throw Error(`${file} has scale ${meta.scale}; html-check only checks 1x pages`);
    const got = await readLanded(cwd, meta.extract).catch(error => ({ failed: { id: meta.extract, message: String(error.message) } }));
    if (!('landed' in got)) throw Error(`${file}: extract job ${meta.extract} is not available in the current project (${unusable(got)}); run in the project directory that generated the page`);
    const { output, dir } = got.landed, ids = new Set(), warnings = [];
    /** @param {ExtractNode} n */
    const walk = n => { ids.add(n.id); for (const c of n.children ?? []) walk(c); };
    walk(output.root);
    const group = meta.overrides === 'none' ? {} : await recover(file, meta);
    if (!group) warnings.push(`Page has overrides (${meta.overrides}) but no file with the same fingerprint was found; diagnostics use the output generated without overrides`);
    const gen = assemble(output, { dir, extract: meta.extract, overrides: group ?? {}, overridesHash: meta.overrides }), exact = gen.html === text;
    if (!exact) warnings.push(`Page differs from the regenerated output (${meta.generator === GENERATOR ? 'page was edited' : `generator ${meta.generator} -> ${GENERATOR}`}); diagnostics use the regenerated output`);
    const context = { overrides: /** @type {'none' | 'recovered' | 'unavailable'} */ (meta.overrides === 'none' ? 'none' : group ? 'recovered' : 'unavailable'), exact };
    pages.push({ file, node: meta.node, landed: got.landed, refs: readRefs(text), ids, group: group ?? {}, result: gen.result, context, warnings });
  }
  const nodes = options.nodes ?? (options.targetNodeId ? [options.targetNodeId] : []);
  for (const id of nodes) if (!pages.some(p => p.ids.has(id))) throw Error(`--node ${id} is not inside any page's frame`);
  // --zoom compares the zoom extract root on the first page containing it.
  let zoom = null;
  if (options.zoomId) {
    const id = options.zoomId, job = await json(path.join(root(cwd), 'runs', id, 'job.json')).catch(() => null);
    if (job?.id !== id) throw Error(`--zoom job does not exist or its evidence is incomplete: ${id}`);
    if (job.operation !== 'extract') throw Error(`--zoom only accepts extract jobs: ${id} is ${job.operation}`);
    const got = await readLanded(cwd, id).catch(error => ({ failed: { id, message: String(error.message) } }));
    if (!('landed' in got)) throw Error(`--zoom extract job ${id} is not available in the current project (${unusable(got)})`);
    const z = got.landed.output, host = pages.find(p => p.ids.has(z.root.id)) ?? pages[0], target = zoomTarget(host.landed.output, z);
    const reference = await fs.readFile(path.resolve(got.landed.dir, /** @type {BinaryFile} */ (z.reference).file));
    // Decode reference errors during preflight: failures inside zoom would mark the whole page error and lose its completed 1x report.
    try { decodePng(reference); } catch (error) { throw Error(`Cannot decode the --zoom reference image (${error.message}): ${id}`); }
    zoom = { host, target, extract: id, reference };
  }
  const ck = checker(deps.launch ?? launchChrome);
  /** @type {PageRecord[]} */
  const records = [];
  try {
    await ck.ready();
    for (const p of pages) {
      const { file, node, landed: { id, output, dir }, refs, group, result, context, warnings } = p, focus = nodes.filter(n => p.ids.has(n));
      const rec = { html: file, node, extract: id, context, ...(warnings.length ? { warnings } : {}) };
      try {
        const reference = await fs.readFile(path.resolve(dir, /** @type {BinaryFile} */ (output.reference).file));
        const frame = { output, result, overrides: group, ...(focus.length ? { focus } : {}), ...(zoom?.host === p ? { zoom: { target: zoom.target, extract: zoom.extract, reference: zoom.reference } } : {}) };
        const { report, evidence } = await ck.run({ url: pathToFileURL(file).href, reference, expected: expectedSize(output), refs, frame }, path.join(root(cwd), 'check', id), { context });
        // Keep only instruction-relevant fields for substituted fonts; figmaMissing matches html font-row semantics.
        const missing = missingFonts(output.root), fonts = (report.fonts ?? []).filter((/** @type {{ substituted: boolean }} */ r) => r.substituted)
          .map((/** @type {{ family: string, style: string, postScriptName: string, chromeUsed?: string }} */ { family, style, postScriptName, chromeUsed }) =>
            ({ family, style, postScriptName, ...(chromeUsed !== undefined ? { chromeUsed } : {}), figmaMissing: missing.has(`${family}\0${style}`) }));
        records.push({ ...rec, ...fromReport(report), ...(fonts.length ? { fonts } : {}), ...(evidence ? { check: evidence } : {}) });
      } catch (error) { records.push({ ...rec, error: { code: error.code ?? 'COMMAND_FAILED', message: error.message } }); }
    }
  } finally { await ck.close(); }
  return { summary: checkStdout({ ...(ck.info.version ? { browser: ck.info.version } : {}), pages: records }),
    exitCode: records.some(r => r.error || r.verdict === 'fail' || r.verdict === 'unchecked') ? 1 : 0 };
}
