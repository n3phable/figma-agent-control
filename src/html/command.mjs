/**
 * [INPUT]: Imports node:fs/promises, node:path, node:url, node:perf_hooks, node:timers/promises, ./extracts.mjs, ./page.mjs, ./overrides.mjs, ./summary.mjs, ./check.mjs, ./chrome.mjs, ./fonts.mjs, ./generate.mjs, ../project.mjs.
 * [OUTPUT]: Exports html, htmlCheck.
 * [POS]: Coordinates HTML export/recheck commands, browser ownership and resumable batch state.
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
import { root, save, isJobId } from '../project.mjs';
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
// Shared fields from a check report for frame/page records; remove ref placeholder keys, and take px from the check.
/** @param {Record<string, any>} r */
const fromReport = r => ({ verdict: r.verdict, ...(r.reason ? { reason: r.reason } : {}), ...(r.message ?? r.error ? { message: r.message ?? r.error } : {}),
  ...(r.sizeNote ? { sizeNote: r.sizeNote } : {}), ...(r.diffRatio !== undefined ? { diffRatio: r.diffRatio, mismatched: r.mismatched, blocks: r.blocks.length } : {}),
  ...(r.refs ? { refs: r.refs.map((/** @type {{ key?: string }} */ { key, ...ref }) => ref) } : {}), ...(r.bakedShare !== undefined ? { bakedShare: r.bakedShare } : {}) });

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
  /** @param {Parameters<typeof check>[1]} input @param {string} dir Evidence directory. @returns {Promise<{ report: Record<string, any>, evidence?: string }>} */
  async function run(input, dir) {
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
      const result = await check(page, input), report = /** @type {Record<string, any>} */ (result.report);
      if (report.reason === 'RENDER_TIMEOUT') { healthy = false; blocked = AFTER_TIMEOUT; await retire(); }
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

// ── html ─────────────────────────────────────────────────────────────────
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
      const missing = missingFonts(top), refs = gen.result.refs.map(({ key, ...r }) => r);
      const head = { node, name: top.name, source: rec.source, extract: used.id, ...(extracts.length > 1 ? { extracts } : {}), html: page };
      const tail = { approximations: countBy(approximations.map(a => a.kind)), ...(gen.result.needsIsland.length ? { needsIsland: gen.result.needsIsland } : {}),
        ...(needsExtract ? { needsExtract: /** @type {true} */ (true) } : {}), ...(overridesFile ? { overrides: gen.result.overrides } : {}),
        fonts: gen.result.fonts.map(({ face, ...f }) => ({ ...f, figmaMissing: missing.has(`${f.family}\0${f.style}`) })),
        ...(warnings.length ? { warnings } : {}), ...(gen.violations.length ? { violations: gen.violations } : {}), ms };
      rec = { ...head, size: gen.expected, ...(refs.length ? { refs } : {}), ...tail };
      if (!parked) done.push(used.id);

      // -- Check pages --
      if (!options.noCheck) {
        const reference = await fs.readFile(path.resolve(used.dir, /** @type {BinaryFile} */ (used.output.reference).file)), launched = ck.info.launchMs;
        t = performance.now();
        const { report, evidence } = await ck.run({ url: pathToFileURL(page).href, reference, expected: gen.expected, refs: gen.result.refs }, path.join(root(cwd), 'check', used.id));
        ms.check = Math.max(0, elapsed(t) - (ck.info.launchMs - launched));
        rec = { ...head, ...(evidence ? { check: evidence } : {}), size: gen.expected, ...(refs.length ? { refs } : {}), ...fromReport(report), ...tail };
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

// ── html-check ───────────────────────────────────────────────────────────
// Preflight every page (reject on any invalid page), start Chrome (propagate startup failures), then render/compare each page. No Figma connection, generation, or page writes;
// locate references through each page's extract metadata in the current project. Store evidence beside html-command evidence, replacing the previous check.
/** @param {string} cwd @param {string[]} files @param {Deps} [deps] @returns {Promise<{ summary: object, exitCode: 0 | 1 }>} */
export async function htmlCheck(cwd, files, deps = {}) {
  const pages = [];
  for (const given of files) {
    const file = path.resolve(cwd, given), text = await fs.readFile(file, 'utf8').catch(error => { throw Error(`Cannot read ${file}: ${error.message}`); }), meta = readMeta(text);
    if (!meta) throw Error(`${file} is not a page generated by figma-agent-control (missing meta)`);
    if (!isJobId(meta.extract)) throw Error(`${file} is not a page generated from an extract`);
    if (meta.scale !== 1) throw Error(`${file} has scale ${meta.scale}; html-check only checks 1x pages`);
    const got = await readLanded(cwd, meta.extract).catch(error => ({ failed: { id: meta.extract, message: String(error.message) } }));
    if (!('landed' in got)) throw Error(`${file}: extract job ${meta.extract} is not available in the current project (${'failed' in got ? got.failed.message : 'pending' in got ? 'no result yet' : 'interrupted'}); run in the project directory that generated the page`);
    pages.push({ file, node: meta.node, landed: got.landed, refs: readRefs(text) });
  }
  const ck = checker(deps.launch ?? launchChrome);
  /** @type {PageRecord[]} */
  const records = [];
  try {
    await ck.ready();
    for (const { file, node, landed: { id, output, dir }, refs } of pages) {
      const reference = await fs.readFile(path.resolve(dir, /** @type {BinaryFile} */ (output.reference).file));
      const { report, evidence } = await ck.run({ url: pathToFileURL(file).href, reference, expected: expectedSize(output), refs }, path.join(root(cwd), 'check', id));
      records.push({ html: file, node, extract: id, ...fromReport(report), ...(evidence ? { check: evidence } : {}) });
    }
  } finally { await ck.close(); }
  return { summary: checkStdout({ ...(ck.info.version ? { browser: ck.info.version } : {}), pages: records }), exitCode: records.some(r => r.verdict === 'fail' || r.verdict === 'unchecked') ? 1 : 0 };
}
