/**
 * [INPUT]: src/html/layout collect/findings/fontRows/substitutedNodes/BLOCKING; structure; attrib inlinedIslands; chrome findChrome/launch; fonts findFont; generate embed/dataUri; png decodePng; helpers/generate extracted/run; local Chrome and Helvetica.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Page-fact and structure tests. Pure cases cover box/wrap/first-line/overflow/ink boundaries, box-only rotated/reflected text, font substitution rules and unused faces, and structural exemptions. Chrome cases collect geometry/bases/mask wrappers, text lines/ink/clipping, font status and CDP usage, and generated-document structure. Missing Chrome or required Helvetica skips with a reason; profiles/processes remain suite-owned.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect, findings, fontRows, substitutedNodes, BLOCKING } from '../src/html/layout.mjs';
import { structure } from '../src/html/structure.mjs';
import { inlinedIslands } from '../src/html/attrib.mjs';
import { findChrome, launch } from '../src/html/chrome.mjs';
import { findFont } from '../src/html/fonts.mjs';
import { embed, dataUri } from '../src/html/generate.mjs';
import { decodePng } from '../src/png.mjs';
import { extracted, run } from './helpers/generate.mjs';

// -- Fixtures -------------------------------------------------------------
// Place nodes by translation in frame coordinates (x, y); renderBounds defaults to the transformed box.
const N = (id, type, x, y, w, h, extra = {}) => ({ id, name: id, type, transform: [[1, 0, x], [0, 1, y]], width: w, height: h, renderBounds: [x, y, w, h], ...extra });
const facts = (box, text) => ({ found: true, box, style: '', chain: [1, 0, 0, 1], ...(text ? { text } : {}) });
const plain = { island: false, moved: false, approx: [] };
const kinds = list => list.map(f => f.kind);

// -- Geometry findings ----------------------------------------------------
test('Box findings ignore 0.49 differences but report 0.5, compare islands using renderBounds and ceil(size - 1e-3), and exempt nodes with applied ancestor/self style overrides', () => {
  const n = N('1:1', 'FRAME', 10, 20, 30, 40);
  assert.deepEqual(findings(n, facts([10.49, 20, 30, 40]), plain), []);
  assert.deepEqual(findings(n, facts([10.5, 20, 30, 40.004]), plain), [{ kind: 'box', html: [10.5, 20, 30, 40], figma: [10, 20, 30, 40] }]);
  assert.deepEqual(findings(n, facts([10, 25, 30, 40]), { ...plain, moved: true }), []);
  const island = N('1:2', 'GROUP', 0, 0, 10, 10, { renderBounds: [4.5, 5, 10.0005, 9.2] });
  assert.deepEqual(findings(island, facts([4.5, 5, 10, 10]), { ...plain, island: true }), [], 'SVG size is ceil(10.0005 - 1e-3) x ceil(9.2 - 1e-3) = 10x10');
  assert.equal(findings(island, facts([4.5, 5, 10, 10]), plain).length, 1, 'Non-islands compare frame-space bounding boxes');
  assert.deepEqual(findings(n, { found: false }, plain), []);
});

// Auto-height text has matching page boxes and line height 20.
const T = (extra = {}) => N('2:1', 'TEXT', 0, 0, 100, 40, { textAutoResize: 'HEIGHT', textAlignVertical: 'TOP', renderBounds: [1, 3, 80, 30], ...extra });
const text = (extra = {}) => facts([0, 0, 100, (extra.h ?? 40)], { lh: 20, lines: 2, firstTop: 0, ink: [1, 3, 81, 33], linear: [1, 0, 0, 1], ...extra });

test('Wrap findings compare line counts only near integer H/lh without text-layout approximations; ENDING truncation uses min(lines, maxLines)', () => {
  assert.deepEqual(findings(T(), text(), plain), []);
  assert.deepEqual(findings(T(), text({ lines: 3 }), plain).filter(f => f.kind === 'wrap'), [{ kind: 'wrap', figma: 2, html: 3 }]);
  assert.deepEqual(kinds(findings(T({ height: 50 }), text({ h: 50, lines: 3 }), plain)), [], 'H/lh=2.5 cannot establish Figma line count; infer first-line top from HTML lines');
  assert.deepEqual(kinds(findings(T(), text({ lines: 3 }), { ...plain, approx: ['text-layout'] })), []);
  assert.deepEqual(kinds(findings(T({ textTruncation: 'ENDING', maxLines: 2 }), text({ lines: 3 }), plain)), [], 'Truncated lines still participate in layout and Range results');
  assert.deepEqual(kinds(findings(T({ textAutoResize: 'NONE' }), text({ lines: 3 }), plain)), [], 'Fixed-size text does not compare line counts');
});

test('Content-offset infers first-line top from vertical alignment, reports CENTER line-count differences, uses zero for TOP without a wrapper, and skips text-layout approximations', () => {
  const center = T({ textAlignVertical: 'CENTER', height: 60 });
  // Figma has 3 lines (60/20), HTML 2: HTML first-line top is (60-40)/2=10, versus expected 0.
  assert.deepEqual(findings(center, text({ h: 60, firstTop: 10 }), plain).filter(f => f.kind === 'content-offset'), [{ kind: 'content-offset', dy: 10 }]);
  assert.deepEqual(kinds(findings(center, text({ h: 60, lines: 3, firstTop: 0.4 }), plain)), [], '0.4 is below tolerance');
  assert.deepEqual(kinds(findings(T({ textAlignVertical: 'BOTTOM', height: 60 }), text({ h: 60, lines: 3 }), plain)), []);
  assert.deepEqual(kinds(findings(T(), text({ firstTop: 0 }), plain)), []);
  assert.deepEqual(kinds(findings(center, text({ h: 60, firstTop: 10 }), { ...plain, approx: ['text-layout'] })), [], 'Paragraph spacing can make H differ from n * lh');
  assert.deepEqual(kinds(findings(T(), text({ lh: null, lines: 5 }), plain)), [], 'Skip line-height:normal');
});

test('Overflow reports HTML-only excess ink, ignores matching excess, and applies informational ink-offset thresholds', () => {
  const out = findings(T(), text({ ink: [1, 3, 104, 33] }), plain);
  assert.deepEqual(out.filter(f => f.kind === 'overflow'), [{ kind: 'overflow', html: 4, figma: 0 }]);
  const both = T({ renderBounds: [1, 3, 103, 30] });
  assert.deepEqual(kinds(findings(both, text({ ink: [1, 3, 104, 33] }), plain)), [], 'Both sides overflow by 4 px');
  assert.deepEqual(findings(T(), text({ ink: [1.49, 3, 81, 33] }), plain), []);
  assert.deepEqual(findings(T(), text({ ink: [1.5, 3, 81, 33.5] }), plain), [{ kind: 'ink-offset', dx: 0.5, dy: 0, dw: -0.5, dh: 0.5 }]);
  assert.deepEqual([BLOCKING.has('ink-offset'), [...BLOCKING].sort()], [false, ['box', 'content-offset', 'overflow', 'wrap']]);
});

test('Rotated or reflected text checks boxes only, ignoring intentionally wrong line counts, first-line top, and ink', () => {
  const wrong = { lines: 7, firstTop: 9, ink: [50, 50, 300, 300] };
  for (const linear of [[0, 1, -1, 0], [1, 0, 0, -1], [-1, 0, 0, 1]])
    assert.deepEqual(findings(T(), text({ ...wrong, linear }), plain), [], JSON.stringify(linear));
  assert.deepEqual(kinds(findings(T(), text({ ...wrong, linear: [0, 1, -1, 0] }), plain).concat(findings(T(), { ...text(wrong), box: [0, 3, 100, 40] }, plain))),
    ['box', 'wrap', 'content-offset', 'overflow', 'ink-offset'], 'Boxes are still checked; the same unrotated data reports every finding');
});

// -- Font findings --------------------------------------------------------
test('fontRows treats unloaded/wrong-weight fonts as substitutes, accepts second local names and same-family variable instances, skips unused faces, and preserves guessed-name provenance', () => {
  const use = (postScriptName, face, source = 'segment') => ({ family: 'Kanit', style: postScriptName.split('-')[1], postScriptName, source, metrics: true, face });
  const uses = [use('Kanit-Light', 'f0'), use('Kanit-Regular', 'f1'), use('Kanit-Medium', 'f2', 'file'), use('Kanit-Bold', 'f3', 'guess'), use('SFPro-Semibold', 'f4'),
    use('SFPro-Thin', 'f5'), use('Kanit-Black', 'f6')];
  const audit = { faces: {
    f0: { status: 'loaded', names: ['Kanit-Light'], chromeUsed: 'Kanit-Thin' }, f1: { status: 'error', names: ['Kanit-Regular'], chromeUsed: 'Kanit-Regular' },
    f2: { status: 'loaded', names: ['Kanit-Medium500', 'Kanit-Medium'], chromeUsed: 'Kanit-Medium' }, f3: { status: 'loaded', names: ['Kanit-Bold'] },
    f4: { status: 'loaded', names: ['SFPro-Semibold'], chromeUsed: 'SFPro-Regular_wdth_opsz110000_wght24E0000' },
    f5: { status: 'loaded', names: ['SFPro-Thin'], chromeUsed: 'SFNS-Regular_wght12C0000' }, f6: { status: 'error', names: ['Kanit-Black'] } },
  uses: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'].map((face, i) => ({ node: `3:${i}`, face })).concat({ node: '3:9', face: 'f0' }) };
  const rows = fontRows(uses, audit);
  assert.deepEqual(rows.map(r => [r.face, r.substituted, r.status, r.chromeUsed]), [['f0', true, 'loaded', 'Kanit-Thin'], ['f1', true, 'error', 'Kanit-Regular'],
    ['f2', false, 'loaded', 'Kanit-Medium'], ['f3', false, 'loaded', undefined], ['f4', false, 'loaded', 'SFPro-Regular_wdth_opsz110000_wght24E0000'],
    ['f5', true, 'loaded', 'SFNS-Regular_wght12C0000'], ['f6', false, undefined, undefined]]);
  assert.deepEqual([rows[3].source, 'status' in rows[6]], ['guess', false], 'No element uses f6, so it is not evaluated');
  assert.deepEqual([...substitutedNodes(audit, rows)].sort(), ['3:0', '3:1', '3:5', '3:9']);
});

// -- Structure checks -----------------------------------------------------
test('structure reports untracked nodes, exempts six missing-node cases, retains missing-key/DOM-island descendants, and normalizes whitespace for textMismatch', () => {
  const kids = (n, ...children) => ({ ...n, children });
  const root = kids(N('0:1', 'FRAME', 0, 0, 100, 100),
    kids(N('1:1', 'GROUP', 0, 0, 10, 10), N('1:2', 'RECTANGLE', 0, 0, 5, 5)),                       // skip
    kids(N('2:1', 'GROUP', 0, 0, 10, 10, { renderBounds: null }), N('2:2', 'RECTANGLE', 0, 0, 5, 5)), // No paint.
    kids(N('3:1', 'RECTANGLE', 0, 0, 10, 10, { isMask: true, renderBounds: null }), N('3:2', 'RECTANGLE', 0, 0, 5, 5)),
    kids(N('4:1', 'GROUP', 0, 0, 10, 10), N('4:2', 'TEXT', 0, 0, 5, 5, { characters: '\u5b64\u5c9b\u91cc' })),     // Inlined island.
    kids(N('5:1', 'GROUP', 0, 0, 10, 10), N('5:2', 'RECTANGLE', 0, 0, 5, 5)),                       // ref
    kids(N('6:1', 'BOOLEAN_OPERATION', 0, 0, 10, 10), N('6:2', 'VECTOR', 0, 0, 5, 5)),
    kids(N('7:1', 'GROUP', 0, 0, 10, 10), N('7:2', 'RECTANGLE', 0, 0, 5, 5)),                       // Island falls back to DOM.
    N('8:1', 'RECTANGLE', 0, 0, 5, 5, { renderBounds: undefined }),                                   // Missing key.
    N('9:1', 'TEXT', 0, 0, 50, 20, { characters: 'Line  two  words ' }), N('9:2', 'TEXT', 0, 0, 50, 20, { segments: [{ characters: 'A' }, { characters: 'B' }] }),
    N('9:3', 'TEXT', 0, 0, 50, 20, { characters: 'ref \u76ee\u6807' }), N('9:4', 'TEXT', 0, 0, 50, 20, { characters: '\u6ca1\u6709\u6587\u5b57\u5143\u7d20' }));
  const ctx = { overrides: { '1:1': { skip: true, note: 'n' } }, refs: [{ node: '5:1' }, { node: '9:3' }], inlined: new Set(['4:1']) };
  const dom = { nodes: ['0:1', '4:1', '5:1', '6:1', '7:1', '9:1', '9:2', '9:3', '9:4', '0:9'], texts: { '9:1': 'Line\n two words', '9:2': 'A C', '4:2': '?' } };
  assert.deepEqual(structure({ root }, ctx, dom), { untracked: ['0:9'], missing: ['7:2', '8:1'], textMismatch: [{ node: '9:2', figma: 'AB', html: 'A C' }] });
  const long = structure({ root: kids(N('0:1', 'FRAME', 0, 0, 1, 1), N('9:1', 'TEXT', 0, 0, 1, 1, { characters: 'x'.repeat(100) })) }, { overrides: {}, refs: [], inlined: new Set() },
    { nodes: ['0:1', '9:1'], texts: { '9:1': 'y' } });
  assert.deepEqual(long.textMismatch.map(t => [t.figma.length, t.figma.endsWith('...')]), [[80, true]]);
});

// -- Requires Chrome ------------------------------------------------------
let chrome = null, reason = '';
try { chrome = findChrome(); } catch (error) { reason = `${error.code}: ${error.message}`; }
const needs = { skip: chrome ? false : reason };
const helvetica = findFont({ postScriptName: 'Helvetica', family: 'Helvetica', style: 'Regular' });
const needsFont = { skip: !chrome ? reason : helvetica ? false : 'Helvetica is not installed locally' };

const page = (body, style = '') => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}
#canvas{position:relative;width:200px;height:200px;overflow:hidden} .n{position:absolute;left:0;top:0;transform-origin:0 0}
.t{white-space:pre-wrap;font:16px Helvetica;line-height:20px;color:#000} ${style}</style></head><body><div id="canvas" data-node="0:1">${body}</div></body></html>`;
// Normalize -0 to 0 and round floats to six decimals.
const z = list => list.map(v => Number(v.toFixed(6)) + 0);

describe('Page fact collection (requires Chrome)', () => {
  let browser, tab, dir, tmp;
  const open = async (name, html, w = 200, h = 200) => { const file = path.join(dir, name); fs.writeFileSync(file, html); await tab.open(pathToFileURL(file).href, w, h); };
  before(async () => {
    if (!chrome) return;
    // Keep profiles in this suite's temporary directory; other suites count fac-chrome-* in system temporary storage.
    tmp = process.env.TMPDIR; process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-html-layout-'));
    dir = process.env.TMPDIR;
    browser = await launch({ executable: chrome });
    tab = await browser.page();
  });
  after(async () => {
    if (!chrome) return;
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp;
  });

  test('Collect boxes, raw styles, accumulated parent bases, left/top, reflected mask wrappers, missing IDs, and rotated-text linear transforms', needs, async () => {
    await open('geo.html', page(`<div class="n" data-node="2:1" style="transform:matrix(0,1,-1,0,100,10);width:50px;height:50px">
<div class="n" data-node="2:2" style="transform:translate(5px,5px);width:10px;height:20px;background:#000"></div></div>
<div class="n" data-node="2:3" style="left:20px;top:100px;width:30px;height:10px;background:#000"></div>
<div class="n" data-node="2:4" style="transform:translate(60px,100px);width:40px;height:40px"><div class="n" data-mask="2:5" style="transform:matrix(-1,0,0,1,10,0);width:10px;height:10px">
<div class="n" data-node="2:6" style="width:10px;height:10px;background:#000"></div></div></div>
<div class="n" data-node="2:7" data-layer="backdrop" style="transform:translate(1px,1px);width:1px;height:1px"></div>
<div class="n t" data-node="2:7" style="transform:matrix(0,1,-1,0,150,120);width:40px;height:20px">Turn</div>`));
    const { facts: f } = await collect(tab, ['2:2', '2:3', '2:6', '2:7', '9:9']);
    assert.deepEqual([z(f['2:2'].box), z(f['2:2'].chain), f['2:2'].style], [[75, 15, 20, 10], [0, 1, -1, 0], 'transform:translate(5px,5px);width:10px;height:20px;background:#000']);
    assert.deepEqual([z(f['2:3'].box), z(f['2:3'].chain), f['2:3'].style], [[20, 100, 30, 10], [1, 0, 0, 1], 'left:20px;top:100px;width:30px;height:10px;background:#000']);
    assert.deepEqual([z(f['2:6'].box), z(f['2:6'].chain), 'text' in f['2:6']], [[60, 100, 10, 10], [-1, 0, 0, 1], false]);
    assert.deepEqual([z(f['2:7'].box), z(f['2:7'].text.linear)], [[130, 120, 20, 40], [0, 1, -1, 0]], 'A background-blur layer is not the primary element');
    assert.deepEqual(f['9:9'], { found: false });
  });

  test('Text collection counts single/wrapped/blank lines, matches isolated screenshot ink bounds within 1 px, and clips ink to ancestors', needsFont, async () => {
    await open('text.html', page(`<div class="n t" data-node="1:1" style="transform:translate(10px,10px);width:180px;height:20px">Hello</div>
<div class="n t" data-node="1:2" style="transform:translate(10px,40px);width:60px;height:60px">Hello world wraps here</div>
<div class="n t" data-node="1:3" style="transform:translate(100px,40px);width:60px;height:80px">A\nB\n\nC</div>
<div class="n" style="transform:translate(10px,150px);width:30px;height:30px;overflow:hidden"><div class="n t" data-node="1:4" style="width:100px;height:20px">Clipped text</div></div>`));
    const { facts: f } = await collect(tab, ['1:1', '1:2', '1:3', '1:4']);
    assert.deepEqual([f['1:1'].text.lines, f['1:2'].text.lines >= 2, f['1:3'].text.lines, f['1:1'].text.lh, f['1:1'].text.firstTop], [1, true, 4, 20, 10]);
    assert.ok(f['1:4'].text.ink[2] <= 40 && f['1:4'].text.ink[0] < 40, JSON.stringify(f['1:4'].text.ink));
    await tab.evaluate(`document.querySelectorAll('[data-node]').forEach(e => { if (e.id !== 'canvas' && e.dataset.node !== '1:1') e.style.visibility = 'hidden'; })`);
    const img = decodePng(await tab.shot());
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (img.data[(y * 200 + x) * 4 + 3]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
    assert.ok(f['1:1'].text.ink.every((v, i) => Math.abs(v - [x0, y0, x1, y1][i]) <= 1), `ink ${f['1:1'].text.ink}, screenshot ${[x0, y0, x1, y1]}`);
  });

  test('Font/structure scanning reports loaded/error and CDP font usage, falls back to status without CDP, deduplicates data-node in document order, and records textContent only for text elements', needsFont, async () => {
    const fonts = "@font-face{font-family:'f0';src:local('Helvetica')} @font-face{font-family:'f1';src:local('NoSuchFont-FAC')}";
    await open('fonts.html', page(`<div class="n t" data-node="1:5" style="font-family:'f0';width:90px;height:20px">Face</div>
<div class="n" data-node="1:6" data-layer="backdrop"></div><div class="n t" data-node="1:6" style="font-family:'f1';transform:translate(0,30px);width:90px;height:20px">Gone<span>!</span></div>
<div class="n" data-node="1:7">\u4e0d\u662f\u6587\u5b57</div>`, fonts));
    const got = await collect(tab, []);
    assert.deepEqual([got.audit.faces.f0, got.audit.faces.f1.status, got.audit.faces.f1.names], [{ status: 'loaded', names: ['Helvetica'], chromeUsed: 'Helvetica' }, 'error', ['NoSuchFont-FAC']]);
    assert.deepEqual(got.audit.uses, [{ node: '1:5', face: 'f0' }, { node: '1:6', face: 'f1' }]);
    assert.deepEqual(got.dom, { nodes: ['0:1', '1:5', '1:6', '1:7'], texts: { '1:5': 'Face', '1:6': 'Gone!' } });
    const bare = await collect({ evaluate: expression => tab.evaluate(expression) }, []);
    assert.deepEqual([bare.audit.faces.f0, bare.audit.faces.f1], [{ status: 'loaded', names: ['Helvetica'] }, { status: 'error', names: ['NoSuchFont-FAC'] }]);

    // Generated mock frame 1:3 has no structural findings; insert an untracked data-node and change a text segment.
    const { output, bytes } = await extracted('1:3'), result = run(output), ctx = { overrides: {}, refs: result.refs, inlined: inlinedIslands(output, result.approximations) };
    const html = embed(result.html, Object.fromEntries(Object.entries(bytes).map(([k, b]) => [k, dataUri('png', b)]))).html;
    await open('doc.html', html, 160, 160);
    assert.deepEqual(structure(output, ctx, (await collect(tab, [])).dom), { untracked: [], missing: [], textMismatch: [] });
    assert.ok(html.includes('>Upper<'));
    await open('doc2.html', html.replace('>Upper<', '>Uppr<').replace('</body>', '<div data-node="9:9"></div></body>'), 160, 160);
    assert.deepEqual(structure(output, ctx, (await collect(tab, [])).dom), { untracked: ['9:9'], missing: [], textMismatch: [{ node: '4:25', figma: 'Upper', html: 'Uppr' }] });
  });
});
