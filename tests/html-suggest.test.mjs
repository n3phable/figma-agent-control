/**
 * [INPUT]: src/html/suggest suggest/seams/seamLimit/hardEdge/BACKGROUND/SPAN/SEAM_STEP; src/html/attrib figmaPainted/raster; src/html/generate generate; src/html/overrides invalidOverrides; helpers/generate extracted/run.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Chrome-free bake suggestion and seam tests: clustering, component-level targets/merging, structural-block and ownPx triggers with injected thresholds, hint-only root/area/text-mismatch cases, replaces, generator-consistent rectangles/bakedOver, seam edge/mean/max metrics including other refs and premultiplied transparency, and exact SEAM_STEP boundaries.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest, seams, seamLimit, hardEdge, BACKGROUND, SPAN, SEAM_STEP } from '../src/html/suggest.mjs';
import { figmaPainted, raster } from '../src/html/attrib.mjs';
import { generate } from '../src/html/generate.mjs';
import { invalidOverrides } from '../src/html/overrides.mjs';
import { extracted, run } from './helpers/generate.mjs';

// -- Fixtures -------------------------------------------------------------
// A 160x160 frame contains glass-button INSTANCE 1:1, whose BG 1:2 holds overlapping Glass Effect, node-blended Tint, and blended Fill + Shadow layers, covered by TEXT 1:6;
// separate GLASS layer 2:1 sits farther away. more adds children to 1:1; extra adds root children.
const W = 160, N = (id, name, type, x, y, w, h, more = {}) => ({ id, name, type, transform: [[1, 0, x], [0, 1, y]], width: w, height: h, renderBounds: [x, y, w, h], ...more });
const fixture = ({ more = [], extra = [] } = {}) => ({
  schema: 1, scale: 1, islands: {}, svgs: {}, images: {}, reference: { file: 'r.png', bytes: 1, sha256: 'x', type: 'png', width: W, height: W },
  root: N('0:1', '\u5e27', 'FRAME', 0, 0, W, W, { children: [
    N('1:1', '\u73bb\u7483\u6309\u94ae', 'INSTANCE', 10, 10, 60, 30, { children: [
      N('1:2', 'BG', 'FRAME', 10, 10, 60, 30, { children: [N('1:3', 'Glass Effect', 'RECTANGLE', 10, 10, 60, 30), N('1:4', 'Tint', 'RECTANGLE', 12, 12, 56, 26),
        N('1:5', 'Fill + Shadow', 'RECTANGLE', 10, 10, 60, 30)] }),
      N('1:6', '\u6807\u7b7e', 'TEXT', 20, 15, 40, 20, { characters: 'Go' }), ...more] }),
    N('2:1', '\u5355\u72ec\u73bb\u7483', 'RECTANGLE', 100, 100, 20, 20), ...extra] }) });
const APPROX = [{ node: '1:3', kind: 'glass' }, { node: '1:3', kind: 'isolation' }, { node: '1:4', kind: 'blend-mode', detail: 'node' }, { node: '1:5', kind: 'blend-shadow' },
  { node: '1:6', kind: 'blend-mode', detail: 'node' }, { node: '2:1', kind: 'glass' }];
// Difference mask paints rects with v (1=difference, 2=antialiasing); compute Figma ownership raster from the extracted tree.
const maskOf = (...rects) => {
  const m = new Uint8Array(W * W);
  for (const [x0, y0, x1, y1, v = 1] of rects) for (let y = y0; y < y1; y++) m.fill(v, y * W + x0, y * W + x1);
  return m;
};
const go = ({ output = fixture(), approximations = APPROX, overrides = {}, refs = [], textMismatch = [], mask = maskOf(), blocks = [], threshold } = {}) => {
  const figma = figmaPainted(output, { overrides, inlined: new Set(), refs: refs.map(node => ({ node, rect: [0, 0, 0, 0] })) });
  return suggest(output, { approximations, overrides, refs: refs.map(node => ({ node })), textMismatch: new Set(textMismatch) },
    { mask, width: W, height: W, blocks, figma: { owner: raster(figma.rects, W, W), ids: figma.ids } }, threshold);
};
const outcomes = r => r.clusters.map(c => [c.target, c.outcome]);

// -- Clusters and targets -------------------------------------------------
test('Three background layers cluster without TEXT or nonbackground approximations; standalone GLASS forms its own cluster; targets lift to the button INSTANCE or remain standalone, with idle clusters omitted from suggestions', () => {
  const r = go();
  assert.deepEqual(r.clusters, [
    { members: ['1:3', '1:4', '1:5'], kinds: ['glass', 'blend-shadow', 'blend-mode'], target: '1:1', rect: [10, 10, 70, 40], ownPx: 0, block: false, triggered: false, outcome: 'idle' },
    { members: ['2:1'], kinds: ['glass'], target: '2:1', rect: [100, 100, 120, 120], ownPx: 0, block: false, triggered: false, outcome: 'idle' }]);
  assert.deepEqual([r.suggest, r.hints], [[], []]);
});

test('When other layers are already inside an effective ref, remaining Tint still targets the component; replaces lists redundant subtree refs and hints explain inside-ref', () => {
  const overrides = { '1:3': { bake: 'ref', note: 'n' }, '1:4': { style: { opacity: '0.5' }, note: 'n' }, '2:1': { style: { opacity: '1' }, note: 'n' } };
  const r = go({ refs: ['1:3', '1:5'], overrides, blocks: [{ x: 60, y: 30, w: 16, h: 16 }] });
  assert.deepEqual(outcomes(r), [['1:1', 'suggest'], ['2:1', 'idle']]);
  assert.deepEqual([r.clusters[0].members, r.suggest[0].members, r.suggest[0].replaces], [['1:4'], ['1:4'], ['1:3', '1:4']]);
  assert.deepEqual(r.hints, ['Before writing bake:"ref" for 1:1, delete or rewrite these entries: 1:3, 1:4; subtree style, skip and bake:"svg" entries would become invalid inside-ref entries (exit code 1) and subtree bake:"ref" entries redundant']);
});

test('Disjoint icon and background clusters with the same button target merge, combining kinds/notes in BACKGROUND order', () => {
  const icon = N('1:7', '\u56fe\u6807', 'VECTOR', 75, 15, 10, 10);
  const output = fixture({ more: [icon] });
  output.root.children[0].width = 80; output.root.children[0].renderBounds = [10, 10, 80, 30];
  const r = go({ output, approximations: [...APPROX, { node: '1:7', kind: 'island-vetoed', detail: 'vector' }, { node: '1:7', kind: 'blend-mode' }], blocks: [{ x: 0, y: 0, w: 16, h: 16 }] });
  assert.deepEqual(r.clusters[0].members, ['1:3', '1:4', '1:5', '1:7']);
  assert.deepEqual([r.clusters[0].kinds, r.suggest[0].entry], [['glass', 'blend-shadow', 'blend-mode', 'island-vetoed'], { bake: 'ref', note: 'glass,blend-shadow,blend-mode,island-vetoed' }]);
  assert.equal(BACKGROUND.indexOf('blend-mode') < BACKGROUND.indexOf('island-vetoed'), true);
});

// -- Triggers -------------------------------------------------------------
test('Structural-block intersection triggers suggestions; ownPx must exceed its threshold and excludes antialiasing and differences covered by TEXT rectangles', () => {
  assert.deepEqual(outcomes(go({ blocks: [{ x: 60, y: 35, w: 16, h: 16 }] })), [['1:1', 'suggest'], ['2:1', 'idle']]);
  assert.deepEqual(outcomes(go({ blocks: [{ x: 70, y: 40, w: 16, h: 16 }] })), [['1:1', 'idle'], ['2:1', 'idle']], 'Touching only rectangle edges is not intersection');
  // A 5x10 difference on the button's left belongs to Fill + Shadow rather than TEXT; a separate patch is antialiased.
  const mask = maskOf([11, 11, 16, 21], [11, 30, 16, 35, 2]);
  assert.equal(go({ mask }).clusters[0].ownPx, 50);
  assert.deepEqual(outcomes(go({ mask, threshold: 50 })), [['1:1', 'idle'], ['2:1', 'idle']]);
  const hit = go({ mask, threshold: 49 });
  assert.deepEqual([outcomes(hit), hit.clusters[0].triggered, hit.clusters[0].block], [[['1:1', 'suggest'], ['2:1', 'idle']], true, false]);
  const text = go({ mask: maskOf([25, 20, 45, 30]), threshold: 0 });
  assert.deepEqual([text.clusters[0].ownPx, text.clusters[0].outcome, text.hints], [0, 'idle', []]);
});

// -- Hint-only cases ------------------------------------------------------
test('A root common ancestor yields outcome root and a hint without suggestion, with ownPx 0', () => {
  const r = go({ output: fixture({ extra: [N('3:1', '\u53e6\u4e00\u5757\u73bb\u7483', 'RECTANGLE', 110, 110, 20, 20)] }), approximations: [...APPROX, { node: '3:1', kind: 'background-blur' }],
    mask: maskOf([100, 100, 130, 130]), blocks: [{ x: 104, y: 104, w: 16, h: 16 }] });
  assert.deepEqual(r.clusters.find(c => c.target === '0:1'), { members: ['2:1', '3:1'], kinds: ['glass', 'background-blur'], target: '0:1', rect: null, ownPx: 0, block: true, triggered: true, outcome: 'root' });
  assert.deepEqual([r.suggest, r.hints], [[], ['Approximations glass,background-blur (2 node(s), e.g. 2:1): common ancestor is the root node; bake:"ref" not suggested']]);
});

test(`Target area above ${SPAN} times the clipped member union yields only a hint; exactly ${SPAN} times suggests, clipping members to the target before comparison`, () => {
  const card = (id, w, layer) => N(id, '\u5361\u7247', 'INSTANCE', 0, 120, w, 40, { children: [layer] });
  const at = (output, layer) => go({ output, approximations: [{ node: layer, kind: 'glass' }], blocks: [{ x: 0, y: 120, w: 16, h: 16 }, { x: 30, y: 120, w: 16, h: 16 }] }).clusters[0];
  assert.equal(at(fixture({ extra: [card('4:1', 160, N('4:2', '\u73bb\u7483', 'RECTANGLE', 0, 120, 10, 10))] }), '4:2').outcome, 'span', '6400 > 4 × 100');
  assert.equal(at(fixture({ extra: [card('4:1', 40, N('4:2', '\u73bb\u7483', 'RECTANGLE', 0, 120, 20, 20))] }), '4:2').outcome, 'suggest', '1600 = 4 × 400');
  // Member [30,120,50,140] extends beyond card [0,120,40,160]: clipped area is 200, so 1600 > 800; unclipped area 400 would incorrectly equal the 4x threshold.
  const out = fixture({ extra: [card('4:1', 40, N('4:2', '\u73bb\u7483', 'RECTANGLE', 30, 120, 20, 20))] });
  assert.equal(at(out, '4:2').outcome, 'span');
  const r = go({ output: out, approximations: [{ node: '4:2', kind: 'glass' }], blocks: [{ x: 30, y: 120, w: 16, h: 16 }] });
  assert.deepEqual(r.hints, ['Approximations glass (1 node(s), e.g. 4:2): target 4:1 rectangle covers 6.25% of the canvas, 8x the union of member rectangles (limit 4x); bake:"ref" not suggested']);
});

test('Text mismatches within the target subtree produce text-mismatch and listed hints without suggestions; outside nodes do not count', () => {
  const blocks = [{ x: 60, y: 35, w: 16, h: 16 }], r = go({ blocks, textMismatch: ['1:6', '9:9'] });
  assert.deepEqual([outcomes(r)[0], r.suggest], [['1:1', 'text-mismatch'], []]);
  assert.deepEqual(r.hints, ['Text in the subtree of 1:1 differs from Figma (1:6): act on the structure check report first; baking would freeze the wrong text into the bitmap and the structure check would stop reporting it']);
});

// -- Suggestion contents --------------------------------------------------
test('Suggested rect/share/bakedOver match generated refs after applying overrides and the local formula; textNodes includes overlapping nondescendant TEXT, and effective refs suppress members', () => {
  // Fractional button renderBounds include shadow expansion: 40.0004 minus epsilon does not cross 40; a nearby nondescendant TEXT overlaps.
  const output = fixture({ extra: [N('5:1', '\u89d2\u6807', 'TEXT', 65, 35, 20, 10, { characters: '9' })] });
  output.root.children[0].renderBounds = [9.5, 10.0004, 60.6, 30];
  const overrides = { '2:1': { style: { opacity: '1' }, note: 'n' } }, blocks = [{ x: 60, y: 30, w: 16, h: 16 }, { x: 100, y: 100, w: 16, h: 16 }];
  const r = go({ output, overrides, blocks });
  assert.deepEqual(r.suggest.map(s => s.node), ['1:1', '2:1']);
  const refs = generate(output, { overrides: { ...overrides, '1:1': { bake: 'ref', note: 'x' }, '2:1': { bake: 'ref', note: 'x' } } }).refs;
  for (const s of r.suggest) {
    const p = refs.find(x => x.node === s.node);
    assert.deepEqual([s.rect, s.share, s.bakedOver], [p.rect, p.share, p.bakedOver], s.node);
    assert.deepEqual(s.rect, r.clusters.find(c => c.target === s.node).rect, 'Matches the local formula');
  }
  assert.deepEqual([r.suggest[0].rect, r.suggest[0].name, r.suggest[0].textNodes, r.suggest[0].bakedOver, r.suggest[1].replaces], [[9, 10, 71, 40], '\u73bb\u7483\u6309\u94ae', 2, ['5:1'], ['2:1']]);
  // The button is already an effective ref, so its members no longer cluster.
  assert.deepEqual(outcomes(go({ output, refs: ['1:1'], blocks })), [['2:1', 'suggest']]);
});

test('Real-generator approximations in mock frame 1:2 form separate self-targeted clusters; a block on 3:1 suggests only 3:1 and passes per-entry override validation', async () => {
  const { output } = await extracted('1:2'), { approximations } = run(output);
  const r = go({ output, approximations, blocks: [{ x: 2, y: 62, w: 16, h: 16 }] });
  assert.deepEqual(r.clusters.map(c => [c.target, c.members.join(), c.outcome]), [['3:1', '3:1', 'suggest'], ['3:4', '3:4', 'idle'], ['3:5', '3:5', 'idle'], ['3:6', '3:6', 'idle'],
    ['3:8', '3:8', 'idle']]);
  assert.deepEqual(r.suggest.map(s => [s.node, s.entry]), [['3:1', { bake: 'ref', note: 'glass' }]]);
  assert.equal(invalidOverrides({ '1:2': { [r.suggest[0].node]: r.suggest[0].entry } }), null);
});

// -- Seams ----------------------------------------------------------------
test('seams is zero for identical renders; hard outer edges set hard=edges and max=jump; exact SEAM_STEP excess is excluded but one more counts; ignore overflow, other refs, and alpha-zero canvas jumps', () => {
  const S = 10, img = (fn = () => [128, 128, 128, 255]) => { const d = new Uint8Array(S * S * 4); for (let i = 0; i < S * S; i++) d.set(fn(i % S, Math.floor(i / S)), i * 4); return d; };
  const inside = r => (x, y) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
  const a = [2, 2, 6, 6], ref = img(), dark = img((x, y) => inside(a)(x, y) ? [0, 0, 0, 255] : [128, 128, 128, 255]);
  assert.deepEqual(seams(ref, ref, S, S, [{ rect: a }]), [{ edges: 16, mean: 0, hard: 0, max: 0 }]);
  assert.deepEqual(seams(ref, dark, S, S, [{ rect: a }]), [{ edges: 16, mean: 128, hard: 16, max: 128 }]);
  // hard counts only excess strictly greater than SEAM_STEP.
  const step = v => img((x, y) => inside(a)(x, y) ? [v, v, v, 255] : [128, 128, 128, 255]);
  assert.deepEqual([SEAM_STEP, seams(ref, step(128 - SEAM_STEP), S, S, [{ rect: a }]), seams(ref, step(127 - SEAM_STEP), S, S, [{ rect: a }])],
    [8, [{ edges: 16, mean: 8, hard: 0, max: 8 }], [{ edges: 16, mean: 9, hard: 16, max: 9 }]]);
  // At the upper-left image corner there are no outside pixels above or left; the right outside pixels lie in the neighboring ref.
  const corner = [0, 0, 4, 4], next = [4, 0, 6, 4], both = seams(ref, dark, S, S, [{ rect: corner }, { rect: next }]);
  assert.deepEqual(both.map(s => s.edges), [4, 2 + 4], 'The corner ref retains only its bottom edge; the neighbor lacks a top edge and its left outside edge lies inside the corner ref');
  // On a transparent canvas arbitrary RGB at alpha 0 produces no premultiplied jump.
  const clear = img((x, y) => inside(a)(x, y) ? [0, 0, 255, 0] : [255, 0, 0, 0]);
  assert.deepEqual(seams(img(() => [0, 0, 0, 0]), clear, S, S, [{ rect: a }]), [{ edges: 16, mean: 0, hard: 0, max: 0 }]);
});

test('hardEdge and seamLimit normalize by edge length with a minimum and accept injected thresholds', () => {
  const s = (hard, edges) => ({ edges, mean: 0, hard, max: 0 });
  assert.deepEqual([seamLimit(40), seamLimit(176), seamLimit(800), seamLimit(1100, 4, 0.005)], [4, 4, 16, 6]);
  assert.deepEqual([hardEdge(s(3, 40)), hardEdge(s(6, 176)), hardEdge(s(8, 1100)), hardEdge(s(0, 0)), hardEdge(s(36, 800)), hardEdge(s(2, 296))],
    [false, true, false, false, true, false]);
  assert.deepEqual([hardEdge(s(3, 40), 3, 0.02), hardEdge(s(8, 1100), 4, 0.005)], [true, true]);
});
