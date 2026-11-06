/**
 * [INPUT]: src/html/summary STDOUT_LIMIT/bytes/totals/exitCode/batch/instruction/stdoutOf/checkStdout.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Pure output-layer tests with synthetic manifests, no bridge or browser: 16 KiB progressive stdout compression, frame ordering/truncation, top/suggest/hints/font limits, four-level html-check projection and zoom diagnostics, exit codes, layout/font totals, batch resume commands, and fix/structure/font/geometry/GLASS/suggestion guidance.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STDOUT_LIMIT, bytes, totals, exitCode, batch, instruction, stdoutOf, checkStdout } from '../src/html/summary.mjs';

// -- Output layer: synthetic manifests and pure functions -------------------
const id = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const frame = (i, extra = {}) => ({ node: `1:${i}`, name: `\u5e27${i}`, source: 'from', extract: id(i), html: `/o/\u5e27${i}__1-${i}.html`, size: { width: 10, height: 10 },
  verdict: 'pass-with-findings', approximations: {}, ...extra });
const manifest = (frames, extra = {}) => {
  const m = { schema: 1, generator: 'g', checker: 'c', overrides: 'none', out: '/o', frames, totals: totals(frames), done: frames.filter(f => f.html).map(f => f.extract),
    pending: [], remaining: [], instruction: '', exitCode: 0, ms: { total: 1, fontIndex: 1 }, ...extra };
  return { ...m, instruction: instruction(m, extra.flags ?? {}), exitCode: exitCode(m) };
};
const fits = value => { assert.ok(bytes(value) <= STDOUT_LIMIT, `${bytes(value)} bytes`); return value; };
const long = (c, n = 1000) => c.repeat(n);

// -- 16 KiB stdout limit --------------------------------------------------
test('stdoutOf lists at most 10 attention frames ordered error, fail, unchecked, stale, pass-with-findings, then unjudged; omits clean frames and caps lists at 3', () => {
  const frames = [...Array.from({ length: 20 }, (_, i) => frame(i)), ...Array.from({ length: 10 }, (_, i) => frame(20 + i, { verdict: 'fail' })),
    ...Array.from({ length: 5 }, (_, i) => frame(30 + i, { verdict: 'clean' }))];
  const a = fits(stdoutOf(manifest(frames)));
  assert.deepEqual([a.frames.length, a.omittedFrames, a.frames.every(f => f.verdict === 'fail')], [10, 20, true]);
  assert.equal('done' in a, false, 'Omit done when there is no resume work');
  const order = [frame(1, { verdict: undefined }), frame(2), frame(3, { violations: ['v'] }), frame(4, { verdict: 'unchecked', reason: 'CHROME_NOT_FOUND' }),
    frame(5, { verdict: 'fail' }), frame(6, { html: undefined, verdict: undefined, error: { code: 'EXTRACT_FAILED', message: long('\u957f', 800) } }), frame(7, { verdict: 'clean' })];
  const b = fits(stdoutOf(manifest(order)));
  assert.deepEqual(b.frames.map(f => f.node), ['1:6', '1:5', '1:4', '1:3', '1:2', '1:1']);
  assert.equal(b.frames[0].error.message.length, 600);
  const refs = Array.from({ length: 5 }, (_, i) => ({ node: `2:${i}`, rect: [0, 0, 1, 1], share: 0.01, bakedOver: [], px: 0 }));
  const stale = Array.from({ length: 5 }, (_, i) => ({ node: `3:${i}`, kind: 'missing' }));
  const c = fits(stdoutOf(manifest([frame(1, { refs, overrides: { applied: [], stale } })]))).frames[0];
  assert.deepEqual([c.refs.length, c.refsOmitted, c.stale.length, c.staleOmitted, c.refs[0]], [3, 2, 3, 2, { node: '2:0', rect: [0, 0, 1, 1], share: 0.01 }]);
});

test('Above 16 KiB, stdoutOf and checkStdout remove frame details, then resume lists, and replace guidance with a short html.json pointer', () => {
  const heavy = Array.from({ length: 10 }, (_, i) => frame(i, { verdict: 'fail', html: `/o/${long('a')}${i}.html`,
    refs: [0, 1, 2].map(k => ({ node: long(String(k)), rect: [0, 0, 1, 1], share: 0.1, bakedOver: [] })) }));
  const c = fits(stdoutOf(manifest(heavy)));
  assert.deepEqual([c.frames, c.omittedFrames, c.instruction.includes('figma-agent-control html')], [undefined, 10, true]);
  const nodes = Array.from({ length: 50 }, (_, i) => 'I' + Array.from({ length: 190 }, (_, k) => `${i}:${k}`).join(';'));
  const d = fits(stdoutOf(manifest([], { remaining: nodes, stop: { kind: 'retry', code: 'BUDGET_EXPIRED', message: '\u65f6\u957f\u9884\u7b97\u5df2\u5230' } })));
  assert.deepEqual([d.remaining, d.done, d.stop.code], [undefined, undefined, 'BUDGET_EXPIRED']);
  assert.equal(d.instruction, 'Instruction too long; see instruction in /o/html.json for the full text');
  const pages = Array.from({ length: 50 }, (_, i) => ({ html: `/o/${long('p')}${i}.html`, node: `1:${i}`, extract: id(i), verdict: 'fail', diffRatio: 0.1 }));
  const e = fits(checkStdout({ browser: 'Chrome/1', pages }));
  assert.deepEqual([e.pages, e.omittedPages, e.totals], [undefined, 50, { pages: 50, clean: 0, passWithFindings: 0, fail: 50, unchecked: 0, errors: 0 }]);
  const mixed = checkStdout({ pages: [{ html: '/a', node: '1:1', extract: id(1), verdict: 'clean' }, { html: '/b', node: '1:2', extract: id(2), verdict: 'unchecked', reason: 'CHROME_EXITED' }] });
  assert.deepEqual([mixed.pages.length, mixed.omittedPages, mixed.instruction], [2, 0, 'Chrome failed midway or rendering timed out; rerun html-check']);
});

// -- Exit codes, totals, and instructions ----------------------------------
test('Fatal stops outrank resume work, which outranks unmet criteria; stale, needsIsland, violations, errors, and unchecked exit 1 independently, while --no-check frames do not', () => {
  const fatal = { kind: 'fatal', code: 'NO_SESSION', message: 'm' };
  assert.equal(exitCode({ stop: fatal, pending: [], remaining: ['1:2'], frames: [] }), 1);
  assert.equal(exitCode({ pending: [id(1)], remaining: [], frames: [frame(1, { verdict: 'fail' })] }), 2);
  for (const extra of [{ verdict: 'fail' }, { verdict: 'unchecked' }, { overrides: { applied: [], stale: [{ node: '1:9', kind: 'missing' }] } }, { needsIsland: ['4:1'] },
    { violations: ['v'] }, { error: { code: 'EXTRACT_FAILED', message: 'm' } }, { verdict: undefined, approximations: { 'second-extract-failed': 1 }, needsIsland: ['4:1'] }])
    assert.equal(exitCode({ pending: [], remaining: [], frames: [frame(1, extra)] }), 1, JSON.stringify(extra));
  assert.equal(exitCode({ pending: [], remaining: [], frames: [frame(1), frame(2, { verdict: undefined }), frame(3, { verdict: 'clean' })] }), 0);
  const t = totals([frame(1, { approximations: { glass: 2 }, overrides: { applied: [], stale: [{}, {}] } }), frame(2, { verdict: 'clean', approximations: { glass: 1, 'second-extract-failed': 4 }, needsIsland: ['4:1'] }),
    frame(3, { verdict: 'unchecked' }), { node: '1:4', source: 'node', error: { code: 'EXTRACT_REJECTED', message: 'm' } }]);
  assert.deepEqual(t, { frames: 4, clean: 1, passWithFindings: 1, fail: 0, unchecked: 1, errors: 1, stale: 2, needsIsland: 1, approximations: { glass: 3, 'second-extract-failed': 4 }, layout: {}, fonts: [] });
});

test('totals includes layout and fonts; stdout caps font tables at 10 rows and strings at 64 characters; guidance covers fonts including figmaMissing and geometry, with cause on frame summaries', () => {
  const row = (family, style, extra = {}) => ({ family, style, postScriptName: `${family}-${style}`, source: 'segment', metrics: true, figmaMissing: false, ...extra });
  const frames = [frame(1, { layout: { box: 1, 'ink-offset': 2 }, cause: 'font-substitution', fonts: [row('Kanit', 'Light', { status: 'loaded', chromeUsed: 'Kanit-Thin', substituted: true }),
    row('Inter', 'Regular', { source: 'guess', status: 'loaded', chromeUsed: 'Inter-Regular', substituted: false })] }),
  frame(2, { layout: { 'ink-offset': 1 }, fonts: [row('Kanit', 'Light', { figmaMissing: true, status: 'loaded', chromeUsed: 'Kanit-Light', substituted: false }), row('Abel', 'Regular')] }), frame(3)];
  const t = totals(frames);
  assert.deepEqual(t.layout, { box: { frames: 1, nodes: 1 }, 'ink-offset': { frames: 2, nodes: 3 } });
  assert.deepEqual(t.fonts, [{ family: 'Kanit', style: 'Light', postScriptName: 'Kanit-Light', figmaMissing: true, chromeUsed: 'Kanit-Thin | Kanit-Light', substituted: true, frames: 2 },
    { family: 'Abel', style: 'Regular', postScriptName: 'Abel-Regular', figmaMissing: false, substituted: false, frames: 1 },
    { family: 'Inter', style: 'Regular', postScriptName: 'Inter-Regular', figmaMissing: false, chromeUsed: 'Inter-Regular', substituted: false, guessed: true, frames: 1 }]);
  const m = manifest(frames);
  assert.match(m.instruction, /^Local fonts do not match the declared fonts: Kanit Light \(Kanit-Light -> Kanit-Thin \| Kanit-Light\) \(see totals\.fonts\): install or fix the local fonts, then rerun; fonts with figmaMissing true are missing in Figma too, so the reference image itself uses a substitute font\. Some top nodes differ from Figma in geometry or line wrapping \(totals\.layout/);
  assert.equal(m.exitCode, 0, 'Font/geometry-only pass-with-findings frames do not affect the exit code');
  assert.doesNotMatch(manifest([frame(2, { layout: { 'ink-offset': 1 } })]).instruction, /geometry/, 'ink-offset is informational only');
  assert.equal(fits(stdoutOf(m)).frames[0].cause, 'font-substitution');
  const many = Array.from({ length: 12 }, (_, i) => row(`${long('F', 100)}${i}`, 'Regular', { postScriptName: long('P', 100), chromeUsed: long('C', 100), substituted: false }));
  const s = fits(stdoutOf(manifest([frame(1, { fonts: many })])));
  assert.deepEqual([s.totals.fonts.length, s.totals.fontsOmitted, s.totals.fonts[0].family.length, s.totals.fonts[0].postScriptName.length, s.totals.fonts[0].chromeUsed.length], [10, 2, 64, 64, 64]);
});

test('batch and instruction resume all frames; missing islands, default-only GLASS, and error frames without pages use deduplicated --node after remaining work, preserving supplied options', () => {
  const frames = [frame(1), frame(2, { needsIsland: ['4:1'], needsExtract: true }), { node: '1:3', source: 'node', error: { code: 'EXTRACT_FAILED', message: 'm' } },
    { node: '1:5', source: 'from', extract: id(5), error: { code: 'EXTRACT_INTERRUPTED', message: 'm' } }];
  const m = { frames, out: "/o/it's", done: [id(1), id(2)], pending: [id(9)], remaining: ['1:5', '1:4'] };
  assert.equal(batch(m, {}), `figma-agent-control html --from '${id(1)}' --from '${id(9)}' --node '1:5' --node '1:4' --node '1:3' --node '1:2' --out '/o/it'\\''s'`);
  assert.equal(batch(m, { overridesFile: '/x.json', noCheck: true, timeoutSeconds: 5, budgetSeconds: 60 }, { overridesPlaceholder: true }).split("--node '1:2' ")[1],
    "--overrides '/x.json' --out '/o/it'\\''s' --no-check --timeout '5' --budget '60'");
  assert.match(batch(m, {}, { overridesPlaceholder: true }), / --overrides <overrides file> --out /);
  // A timed-out second extraction resumes its pending task with --from, without also repeating the frame through --node.
  const waiting = { frames: [frame(1, { extracts: [id(1), id(2)], needsIsland: ['4:1'] })], out: '/o', done: [], pending: [id(2)], remaining: [] };
  assert.equal(batch(waiting, {}), `figma-agent-control html --from '${id(2)}' --out '/o'`);
  // Default-only GLASS frames require viewing and re-extracting: the batch command uses --node instead of rereading the same task through --from.
  const glass = [frame(1), frame(2, { glassDefaults: ['3:1'] })];
  assert.equal(batch({ frames: glass, out: '/o', done: [id(1), id(2)], pending: [], remaining: [] }, {}), `figma-agent-control html --from '${id(1)}' --node '1:2' --out '/o'`);
  assert.match(manifest(glass).instruction, /^Some frames have all-default GLASS parameters \(glassDefaults\): .*the command below re-extracts these frames with --node\. Then run figma-agent-control html --from '[^']+' --node '1:2' --out '\/o'$/);

  const go = (frames, extra = {}, flags = {}) => manifest(frames, { ...extra, flags }).instruction;
  assert.equal(go([frame(1)]), 'All frames pass; /o/html.json is the manifest of this batch');
  assert.equal(go([frame(1, { verdict: undefined })], {}, { noCheck: true }), 'Generated, not checked (--no-check); you can run figma-agent-control html-check; /o/html.json is the manifest of this batch');
  const failing = go([frame(1, { verdict: 'fail' })]);
  assert.match(failing, /^For failing frames, first read top and the evidence directory's block-<n>\.png and check\.json; .*add a note\. Then run figma-agent-control html --from '.*' --overrides <overrides file> --out '\/o'$/);
  assert.match(go([frame(1, { verdict: 'unchecked', reason: 'REFERENCE_SIZE' }), frame(2, { verdict: 'unchecked', reason: 'CHROME_NOT_FOUND' })]), /^Install Chrome.*\. Reference image and extract tree sizes differ by more than 1 px/);
  const wait = { kind: 'retry', code: 'ACTIVE_JOB', message: 'm', active: id(9) };
  assert.equal(go([], { pending: [id(9)], remaining: ['1:2'], stop: wait }), `First run figma-agent-control wait ${id(9)}, then run figma-agent-control html --from '${id(9)}' --node '1:2' --out '/o'`);
  assert.match(go([], { remaining: ['1:2'], stop: { ...wait, active: id(8) } }), new RegExp(`^Another job is in progress \\(${id(8)}\\); after it finishes, run figma-agent-control html --node '1:2'`));
  assert.match(go([], { remaining: ['1:2'], stop: { kind: 'fatal', code: 'BRIDGE_STOPPING', message: '\u6865\u63a5\u6b63\u5728\u505c\u6b62' } }), /^\u6865\u63a5\u6b63\u5728\u505c\u6b62\. Rerun figma-agent-control connect\. Run figma-agent-control html --node '1:2'/);
  assert.match(go([], { remaining: ['1:2'] }), /^Interrupted extracts are re-extracted with --node; run /);
});


// -- Diagnostic output: top, suggest, focus, zoom ---------------------------
const top = (i, extra = {}) => ({ node: `5:${i}`, name: long('\u540d', 100), px: 100 - i, htmlPx: 90 - i, figmaPx: 100 - i, layout: [], approximations: ['glass'], hint: long('h', 600),
  fix: { style: { transform: `translate(${i}px,0px)` }, basis: { transform: 'translate(0px,0px)' } }, ...extra });
const proposal = (i, extra = {}) => ({ node: `6:${i}`, name: '\u6309\u94ae', entry: { bake: 'ref', note: 'glass' }, rect: [0, 0, 10, 10], share: 0.01, textNodes: 1, bakedOver: ['7:1', '7:2'],
  members: ['6:9'], replaces: [], ...extra });

test('stdoutOf caps top/suggest at 3 each with compact fields and truncation; above 16 KiB remove details before the frame list', () => {
  const f = frame(1, { top: [0, 1, 2, 3, 4].map(i => top(i, i === 1 ? { flat: true } : {})), suggest: [0, 1, 2, 3].map(i => proposal(i)) });
  const a = fits(stdoutOf(manifest([f]))).frames[0];
  assert.deepEqual([a.top.length, a.topOmitted, a.suggest.length, a.suggestOmitted], [3, 2, 3, 1]);
  assert.deepEqual(Object.keys(a.top[0]), ['node', 'name', 'px', 'htmlPx', 'figmaPx', 'hint', 'fix']);
  assert.deepEqual([a.top[0].name.length, a.top[0].hint.length, a.top[1].flat, a.suggest[0]], [60, 400, true,
    { node: '6:0', entry: { bake: 'ref', note: 'glass' }, rect: [0, 0, 10, 10], share: 0.01, textNodes: 1, bakedOver: 2 }]);
  // Ten frames with long top node IDs exceed the full limit; remove top/suggest first while retaining frames.
  const heavy = Array.from({ length: 10 }, (_, i) => frame(i, { top: [0, 1, 2].map(k => top(k, { node: long('I', 600) })), suggest: [proposal(0, { node: long('J', 600) })] }));
  const b = fits(stdoutOf(manifest(heavy)));
  assert.deepEqual([b.frames.length, b.frames.some(x => 'top' in x || 'suggest' in x || 'topOmitted' in x), b.omittedFrames], [10, false, 0]);
});

test('stdoutOf and checkStdout include hint-only clusters and seam warnings, capped at 3 x 400 characters and removed at level two with top/suggest', () => {
  const hints = ['\u6839\u8282\u70b9', '\u9762\u79ef', long('\u6587'), '\u63a5\u7f1d'];
  const a = fits(stdoutOf(manifest([frame(1, { hints })]))).frames[0];
  assert.deepEqual([a.hints.length, a.hintsOmitted, a.hints[2].length], [3, 1, 400]);
  const heavy = Array.from({ length: 10 }, (_, i) => frame(i, { hints: [0, 1, 2].map(() => long('\u63d0', 200)), top: [top(0, { node: long('I', 600) })] }));
  assert.equal(fits(stdoutOf(manifest(heavy))).frames.some(x => 'hints' in x), false);
  const page = fits(checkStdout({ pages: [{ file: '/o/p.html', verdict: 'pass-with-findings', hints: ['\u6839\u8282\u70b9'] }] })).pages[0];
  assert.deepEqual(page.hints, ['\u6839\u8282\u70b9']);
});

test('instruction points failures to top/block images, replaces only transform fields, explains left/top fixes and suggestion overrides, and keeps suggestion-only frames at exit 0', () => {
  const failing = manifest([frame(1, { verdict: 'fail', top: [top(0)] })]).instruction;
  assert.match(failing, /^For failing frames, first read top and the evidence directory's block-<n>\.png and check\.json; write top\[\]\.fix into that frame's group in overrides \(top-level key is the frame node ID\): if the node already has an entry, replace only its style\.transform and basis\.transform, otherwise create one; add a note\. Then run /);
  assert.match(manifest([frame(1, { verdict: 'fail', top: [top(0, { flat: true })] })]).instruction, /add a note; always write fix as transform, even for nodes written as left\/top in the page; do not copy left\/top from the HTML\. Then run /);
  const m = manifest([frame(1, { suggest: [proposal(0)] })]);
  assert.match(m.instruction, /^Background-dependent approximations got bake:"ref" suggestions \(suggest; full list in html\.json\): review the block crops and add a note before writing them into overrides, and delete or rewrite the entries listed in replaces beforehand; fix text and position first and use ref only as a last step\. Then run figma-agent-control html --from '.*' --overrides <overrides file> --out '\/o'$/);
  assert.equal(m.exitCode, 0);
  assert.equal(fits(stdoutOf(m)).frames[0].suggest[0].node, '6:0');
});

test('checkStdout includes page top/suggest/focus/zoom/warnings/error across four projections under 16 KiB; level three omits clean pages and warning/error details, with error/font/suggestion/zoom guidance', () => {
  const zoom = { node: '3:1', extract: id(9), scale: 4, size: [160, 80], dir: 'zoom-3-1', mismatched: 12, aa: 3, diffRatio: 0.001, shift: { dx: 0, dy: -0.5, before: 900, after: 10 },
    fix: { style: { transform: 'translate(0px,0px)' } }, hint: long('h', 600), warnings: ['w'] };
  const page = (i, extra = {}) => ({ html: `/o/${long('p', 120)}${i}.html`, node: `1:${i}`, extract: id(i), verdict: 'pass-with-findings', diffRatio: 0.01, mismatched: 10, blocks: 0,
    context: { overrides: 'none', exact: true }, top: [0, 1, 2, 3].map(k => top(k)), suggest: [proposal(0)], clusters: [{ target: '6:0' }], hints: ['h'], focus: [top(7)], zoom,
    fonts: [{ family: long('F', 100), style: 'Light', postScriptName: long('P', 100), chromeUsed: long('C', 100), figmaMissing: true }],
    warnings: [long('w', 600), long('x', 600), long('y', 600), 'x'], check: '/c.json', ...extra });
  const light = { warnings: [long('w', 600), 'b', 'c', 'x'] };
  const small = fits(checkStdout({ pages: [page(1, light), page(2, { ...light, verdict: undefined, error: { code: 'COMMAND_FAILED', message: long('e', 800) } })] }));
  const [p, q] = small.pages;
  assert.deepEqual([p.top.length, p.topOmitted, p.suggest.length, p.focus.length, Object.keys(p.zoom), p.zoom.warnings, p.warnings.length, p.warnings[0].length, 'clusters' in p, 'fonts' in p],
    [3, 1, 1, 1, ['node', 'scale', 'size', 'mismatched', 'diffRatio', 'shift', 'fix', 'hint', 'warnings', 'dir'], ['w'], 3, 400, false, false]);
  // Zoom screenshots differing from reference size by more than 1 px expose error/warnings in projection, each capped at 400 characters.
  const failed = fits(checkStdout({ pages: [page(3, { zoom: { node: '3:1', extract: id(9), scale: 4, size: [160, 80], dir: 'zoom-3-1', error: long('d', 600), warnings: [long('s', 600)] } })] })).pages[0].zoom;
  assert.deepEqual([Object.keys(failed), failed.error.length, failed.warnings[0].length], [['node', 'scale', 'size', 'error', 'warnings', 'dir'], 400, 400]);
  assert.deepEqual([q.error.code, q.error.message.length, small.totals.errors], ['COMMAND_FAILED', 600, 1]);
  assert.match(small.instruction, /^For pages with errors, see error\. Local fonts do not match the declared fonts: F{61}\.\.\. Light \(P{61}\.\.\. -> C{61}\.\.\.\) \(see fonts in each page's check\.json\): install or fix the local fonts, then rerun; fonts with figmaMissing true are missing in Figma too, so the reference image itself uses a substitute font\. Background-dependent approximations got bake:"ref" suggestions \(pages\[\]\.suggest; full list in each page's check\.json\): review the block crops and add a note before writing them into overrides, and delete or rewrite the entries listed in replaces beforehand; fix text and position first and use ref only as a last step\. --node and --zoom results are in pages\[\]\.focus and pages\[\]\.zoom; zoomed images are in zoom-<node>\/ in the evidence directory$/);
  // Level two: four detailed pages exceed the limit but fit without details. Level three: omit clean pages among 50. Level four: omit all pages.
  assert.ok(bytes(checkStdout({ pages: [page(0)] })) * 4 > STDOUT_LIMIT);
  const second = fits(checkStdout({ pages: Array.from({ length: 4 }, (_, i) => page(i)) }));
  assert.deepEqual([second.pages.length, second.pages.some(x => x.top || x.suggest || x.focus), Object.keys(second.pages[0].zoom), second.pages[0].warnings.length], [4, false, ['node', 'dir'], 3]);
  const many = Array.from({ length: 50 }, (_, i) => page(i, i % 2 ? { verdict: 'clean' } : { error: { code: 'COMMAND_FAILED', message: long('e', 800) } }));
  const third = fits(checkStdout({ pages: many }));
  assert.deepEqual([third.pages.length, third.omittedPages, third.pages.some(x => x.warnings || x.error.message), third.pages[0].error], [25, 25, false, { code: 'COMMAND_FAILED' }]);
  const fourth = fits(checkStdout({ pages: many.map(x => ({ ...x, html: `/o/${long('q', 1000)}.html` })) }));
  assert.deepEqual([fourth.pages, fourth.omittedPages, fourth.totals.errors], [undefined, 50, 25]);
});
