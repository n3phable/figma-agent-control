/**
 * [INPUT]: src/html/attrib figmaPainted/inlinedIslands/raster/frameBox/tally/boxes/rank/GAP_PX/GAP_RATIO; src/html/shift SHIFT/region/search/worth/relocate/advise/moved; src/html/match match/crop; generate; helpers/generate extracted/run.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Chrome-free attribution and shift tests: Figma paint rectangles/order, masks/clipping/islands/skip/ref, vectors and zero-height lines; shared frameBox/generator origins; two-sided ranking and gaps; search regions/reasons/candidates/scales/thresholds, local coordinate conversion including rotated/flipped/singular parents, fixes/hints, and direction text.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { figmaPainted, inlinedIslands, raster, frameBox, tally, boxes, rank, GAP_PX, GAP_RATIO } from '../src/html/attrib.mjs';
import { SHIFT, region, search, worth, relocate, advise, moved } from '../src/html/shift.mjs';
import { generate } from '../src/html/generate.mjs';
import { match, crop } from '../src/html/match.mjs';
import { extracted, run } from './helpers/generate.mjs';

// Handwritten extracted tree: nodes use frame coordinates (x, y), and renderBounds defaults to the node box.
const N = (id, x, y, w, h, extra = {}) => ({ id, name: `\u540d${id}`, type: 'FRAME', transform: [[1, 0, x], [0, 1, y]], width: w, height: h, renderBounds: [x, y, w, h], ...extra });
const doc = (children, extra = {}) => ({ root: N('0:1', 0, 0, 10, 10, { children }), islands: {}, ...extra });
const ctx = (extra = {}) => ({ overrides: {}, inlined: new Set(), refs: [], ...extra });
// Node to its Figma-side painted rectangles ([x0, y0, x1, y1], in output order).
const drawn = painted => {
  const out = {};
  for (let i = 0; i < painted.rects.length; i += 5) {
    const [k, x, y, w, h] = painted.rects.slice(i, i + 5);
    (out[painted.ids[k]] ??= []).push([x, y, x + w, y + h].map(v => Number(v.toFixed(3))));
  }
  return out;
};

describe('attrib: Figma-side attribution and ranking', () => {
  test('Auto-layout reverse stacking matches the generator: first child on top without mutating extraction; non-auto-layout order stays unchanged', () => {
    for (const layoutMode of ['HORIZONTAL', 'VERTICAL', 'NONE']) {
      const output = doc([N('1:1', 0, 0, 10, 10), N('1:2', 0, 0, 10, 10)]);
      Object.assign(output.root, { layoutMode, itemReverseZIndex: true });
      const p = figmaPainted(output, ctx()), owner = raster(p.rects, 10, 10);
      assert.equal(p.ids[owner[55]], layoutMode === 'NONE' ? '1:2' : '1:1');
      assert.deepEqual(output.root.children.map(n => n.id), ['1:1', '1:2']);
    }
  });

  test('figmaPainted covers the root frame, paints parents before children and later siblings on top, and registers each node once', () => {
    const p = figmaPainted(doc([N('1:1', 0, 0, 6, 6, { children: [N('1:2', 1, 1, 2, 2)] }), N('1:3', 4, 4, 6, 6)]), ctx());
    assert.deepEqual(p.ids, ['0:1', '1:1', '1:2', '1:3']);
    assert.deepEqual(p.names, ['\u540d0:1', '\u540d1:1', '\u540d1:2', '\u540d1:3']);
    const owner = raster(p.rects, 10, 10);
    assert.deepEqual([owner[0], owner[1 * 10 + 1], owner[5 * 10 + 5], owner[9 * 10 + 0]], [1, 2, 3, 0]);
  });

  test('Masks intersect following siblings, including successive sibling masks; masks do not paint, skipped masks do nothing, and earlier siblings remain unaffected', () => {
    const mask = (id, x, w, extra = {}) => N(id, x, 0, w, 10, { isMask: true, renderBounds: null, ...extra });
    const p = drawn(figmaPainted(doc([N('1:0', 0, 0, 10, 10), mask('1:1', 0, 6), mask('1:2', 2, 8), N('1:3', 0, 0, 10, 10)]), ctx()));
    assert.deepEqual([p['1:0'], p['1:3'], p['1:1'], p['1:2']], [[[0, 0, 10, 10]], [[2, 0, 6, 10]], undefined, undefined]);
    const skipped = drawn(figmaPainted(doc([mask('1:1', 0, 6), N('1:3', 0, 0, 10, 10)]), ctx({ overrides: { '1:1': { skip: true, note: '' } } })));
    assert.deepEqual(skipped['1:3'], [[0, 0, 10, 10]]);
  });

  test('clipsContent intersects nested descendant clips; unclipped containers do not constrain children, and fully clipped rectangles disappear', () => {
    const tree = doc([N('1:1', 2, 2, 6, 6, { clipsContent: true, children: [N('1:2', 0, 0, 10, 10), N('1:3', 4, 0, 6, 6, { clipsContent: true, children: [N('1:4', 0, 0, 10, 10)] }),
      N('1:5', 9, 9, 1, 1)] }), N('1:6', 0, 0, 3, 3, { children: [N('1:7', 0, 0, 10, 10)] })]);
    const p = drawn(figmaPainted(tree, ctx()));
    assert.deepEqual([p['1:2'], p['1:3'], p['1:4'], p['1:5'], p['1:7']], [[[2, 2, 8, 8]], [[4, 2, 8, 6]], [[4, 2, 8, 6]], undefined, [[0, 0, 10, 10]]]);
  });

  test('Inlined islands paint renderBounds without descending; DOM fallbacks paint individually, and inlinedIslands uses only island keys', () => {
    const tree = () => doc([N('1:1', 2, 2, 4, 4, { renderBounds: [1, 1, 6, 6], children: [N('1:2', 2, 2, 2, 2)] }), N('1:3', 0, 6, 4, 4, { children: [N('1:4', 0, 6, 1, 1)] })],
      { islands: { '1:1': 's0', '1:3': 's1' } });
    const output = tree(), approximations = [{ node: '1:3', kind: 'island-vetoed', detail: 'vector' }, { node: '1:4', kind: 'island-vetoed', detail: 'vector' }];
    const inlined = inlinedIslands(output, approximations);
    assert.deepEqual([...inlined], ['1:1']);
    const p = drawn(figmaPainted(output, ctx({ inlined })));
    assert.deepEqual([p['1:1'], p['1:2'], p['1:3'], p['1:4']], [[[1, 1, 7, 7]], undefined, [[0, 6, 4, 10]], [[0, 6, 1, 7]]]);
    const keyless = tree();
    delete keyless.root.children[0].renderBounds;
    assert.deepEqual(drawn(figmaPainted(keyless, ctx({ inlined })))['1:1'], [[2, 2, 6, 6]], 'Missing renderBounds in offline data falls back to the node box');
    assert.deepEqual([...inlinedIslands(tree(), [{ node: '1:1', kind: 'island-clipped' }, { node: '1:3', kind: 'island-unavailable' }])], []);
  });

  test('skip and null renderBounds suppress subtrees while missing bounds still paint; vectors do not descend, and the zero-height line uses renderBounds', async () => {
    const vector = N('1:5', 6, 6, 3, 3, { type: 'BOOLEAN_OPERATION', children: [N('1:6', 6, 6, 1, 1)] });
    const p = drawn(figmaPainted(doc([N('1:1', 0, 0, 5, 5, { children: [N('1:2', 0, 0, 1, 1)] }), N('1:3', 0, 0, 5, 5, { renderBounds: null, children: [N('1:4', 0, 0, 1, 1)] }),
      N('1:7', 0, 6, 2, 2, { renderBounds: undefined }), vector]), ctx({ overrides: { '1:1': { skip: true, note: '' } } })));
    assert.deepEqual([p['1:1'], p['1:2'], p['1:3'], p['1:4'], p['1:7'], p['1:5'], p['1:6']], [undefined, undefined, undefined, undefined, [[0, 6, 2, 8]], [[6, 6, 9, 9]], undefined]);
    const { output } = await extracted('1:3');
    const line = drawn(figmaPainted(output, ctx({ inlined: inlinedIslands(output, run(output).approximations) })))['4:10'];
    assert.deepEqual(line, [[0, 44.5, 40, 45.5]], 'The 40x0 node box is empty; paint renderBounds [0,44.5,40,1] instead');
  });

  test('ref suppresses the original subtree and paints its reference rectangle last, with multiple refs in supplied order', () => {
    const tree = doc([N('1:1', 0, 0, 4, 4, { children: [N('1:2', 0, 0, 4, 4)] }), N('1:3', 2, 2, 8, 8), N('1:4', 0, 0, 1, 1)]);
    const p = figmaPainted(tree, ctx({ refs: [{ node: '1:1', rect: [0, 0, 5, 5] }, { node: '1:4', rect: [0, 0, 1, 1] }] }));
    assert.deepEqual(p.ids, ['0:1', '1:3', '1:1', '1:4']);
    const owner = raster(p.rects, 10, 10);
    assert.deepEqual([owner[3 * 10 + 3], owner[0], owner[5 * 10 + 5]], [2, 3, 1], 'ref covers later-painted 1:3, and the next ref covers the previous one');
  });

  test('Mock frame 1:3 intersects rotated block 4:4 with both masks; children of the 30-degree group use enclosing rectangles', async () => {
    const { output } = await extracted('1:3'), byId = new Map();
    const walk = n => { byId.set(n.id, n); for (const c of n.children ?? []) walk(c); };
    walk(output.root);
    const p = drawn(figmaPainted(output, ctx({ inlined: inlinedIslands(output, run(output).approximations) })));
    const [x, y, w, h] = frameBox(byId.get('4:4')), [mx, my, mw, mh] = frameBox(byId.get('4:3'));
    assert.ok(w > 20 && h > 20, 'A 45-degree rotated bounding box exceeds 20x20');
    assert.deepEqual(p['4:4'], [[Math.max(x, mx), Math.max(y, my), Math.min(x + w, mx + mw), Math.min(y + h, my + mh)].map(v => Number(v.toFixed(3)))]);
    const [gx, gy, gw, gh] = frameBox(byId.get('4:8'));
    assert.deepEqual(p['4:8'], [[gx, gy, gx + gw, gy + gh].map(v => Number(v.toFixed(3)))]);
    assert.ok(Math.abs(gw - (20 * Math.cos(Math.PI / 6) + 20 * Math.sin(Math.PI / 6))) < 1e-9);
  });

  // frameBox mirrors the generator's private aabb formula: offline inlined islands without renderBounds use it for origin and size. This fails if the formulas diverge.
  test('frameBox matches generator origins and sizes for inlined islands without renderBounds under rotation, reflection, or both', () => {
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const kids = [['5:1', [[c, -s, 40], [s, c, 20]]], ['5:2', [[-1, 0, 120], [0, 1, 30]]], ['5:3', [[-c, s, 90], [s, c, 100]]]]
      .map(([id, transform]) => ({ id, name: id, type: 'RECTANGLE', transform, width: 30, height: 12, fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }] }));
    const output = { schema: 1, islandRule: 2, scale: 1, root: { id: '0:1', name: '\u5e27', type: 'FRAME', transform: [[1, 0, 0], [0, 1, 0]], width: 160, height: 160, children: kids },
      reference: { file: 'r.png', bytes: 1, sha256: 'x', type: 'png', width: 160, height: 160 }, images: {}, svgs: {}, islandsSkipped: [], warnings: [],
      islands: Object.fromEntries(kids.map(k => [k.id, `k${k.id}`])) };
    const { html } = generate(output, { svgs: Object.fromEntries(kids.map(k => [`k${k.id}`, '<svg xmlns="http://www.w3.org/2000/svg"></svg>'])) });
    for (const k of kids) {
      const style = new RegExp(`data-node="${k.id}"[^>]*style="([^"]*)"`).exec(html)?.[1] ?? '';
      const got = [/translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(style)?.slice(1), /width:([\d.]+)px/.exec(style)?.[1], /height:([\d.]+)px/.exec(style)?.[1]].flat().map(Number);
      assert.ok(got.length === 4 && got.every((v, i) => Math.abs(v - frameBox(k)[i]) < 0.01), `${k.id}: page ${style}, frameBox ${frameBox(k)}`);
    }
  });

  test('tally counts mask-1 differences by index; boxes encloses each node\'s rectangle union', () => {
    assert.deepEqual([...tally(Int32Array.from([0, 1, -1, 1]), Uint8Array.from([1, 1, 1, 2]), 2)], [1, 1]);
    assert.deepEqual([...boxes({ ids: ['a', 'b'], names: ['', ''], rects: [0, 1, 1, 2, 2, 1, 0, 0, 1, 1, 0, 5, 0, 1, 4] })], [['a', [1, 0, 6, 4]], ['b', [0, 0, 1, 1]]]);
  });

  test('rank merges both sides by max, excludes root/ref/zero, breaks ties by tree preorder with unknowns last, and checks both gap directions and thresholds', () => {
    const order = new Map(['0:1', '1:1', '1:2', '1:3', '1:4'].map((id, i) => [id, i]));
    const html = { ids: ['0:1', '1:2', '9:9', '1:1', '1:4'], names: ['\u5e27', '\u4e59', '\u624b\u6539', '\u7532', '\u4e01'], rects: [] }, figma = { ids: ['0:1', '1:1', '1:2', '1:3', '1:4'], names: ['\u5e27', '\u7532', '\u4e59', '\u4e19', '\u4e01'], rects: [] };
    const r = rank({ html, htmlPx: Int32Array.from([900, 40, 40, 10, 0]), figma, figmaPx: Int32Array.from([900, 40, 10, 0, 5]), order, exclude: new Set(['0:1', '1:4']) });
    assert.deepEqual(r, [{ node: '1:1', name: '\u7532', htmlPx: 10, figmaPx: 40, px: 40 }, { node: '1:2', name: '\u4e59', htmlPx: 40, figmaPx: 10, px: 40 },
      { node: '9:9', name: '\u624b\u6539', htmlPx: 40, figmaPx: 0, px: 40 }]);
    // Gap: px >= GAP_PX and min <= GAP_RATIO * px.
    const two = (h, f) => rank({ html: { ids: ['1:1'], names: ['\u7532'], rects: [] }, htmlPx: Int32Array.from([h]), figma: { ids: ['1:1'], names: ['\u7532'], rects: [] }, figmaPx: Int32Array.from([f]), order, exclude: new Set() })[0].gap;
    assert.deepEqual([two(0, GAP_PX), two(GAP_PX, 0), two(0, GAP_PX - 1), two(GAP_RATIO * 100, 100), two(GAP_RATIO * 100 + 1, 100)], ['html-missing', 'html-extra', undefined, 'html-missing', undefined]);
  });
});

describe('shift: displacement search and local conversion', () => {
  // Opaque white WxH image; rows paint [x0, x1) near black.
  const bar = (W, H, rows, x0 = 0, x1 = W) => {
    const data = new Uint8Array(W * H * 4).fill(255);
    for (const y of rows) for (let x = x0; x < x1; x++) data.set([20, 20, 20, 255], (y * W + x) * 4);
    return { data, width: W, height: H };
  };
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

  test('region pads, rounds, and clips the union of both boxes, falls back to owned-difference bounds above the area limit, and explains skipped searches', () => {
    const mask = new Uint8Array(100 * 100), all = () => true;
    assert.deepEqual(region([[10.5, 10, 20, 20], [15, 5, 30.2, 12]], all, mask, 100, 100), [8, 3, 33, 22]);
    assert.deepEqual(region([[0, 0, 5, 99]], all, mask, 100, 100, 3), [0, 0, 8, 100]);
    assert.equal(region([], all, mask, 100, 100), 'No painted rectangle for this node in the image; shift search skipped');
    assert.equal(region([[-30, 0, -10, 10]], all, mask, 100, 100), 'No painted rectangle for this node in the image; shift search skipped', 'Entirely outside the image');
    const W = 600, H = 400, big = new Uint8Array(W * H);
    for (const i of [1 * W + 1, 50 * W + 60, 70 * W + 90, 398 * W + 598]) big[i] = 1;
    // The full 240,000 px image exceeds the limit; inspect only owned differences, excluding corner pixels owned by other nodes.
    assert.deepEqual(region([[0, 0, W, H]], i => i !== 1 * W + 1 && i !== 398 * W + 598, big, W, H), [58, 48, 93, 73]);
    assert.equal(region([[0, 0, W, H]], () => true, big, W, H), 'Differences are spread too widely; shift search skipped', 'Difference bounds still exceed 200,000 px');
    assert.equal(region([[0, 0, W, H]], () => false, big, W, H), 'Search region exceeds the area limit and has no differing pixels of this node; shift search skipped');
    assert.equal(SHIFT.area, 200_000);
  });

  test('search at k=1 finds a 2 px downward bar shift with crop/match counts, retains zero for solid colors, breaks ties by smaller movement, and treats out-of-bounds as transparent', () => {
    const ref = bar(40, 20, range(5, 10), 5, 35), act = bar(40, 20, range(7, 12), 5, 35), rect = [3, 3, 37, 15];
    const r = search(ref, act, rect);
    const count = sy => match(crop(ref.data, 40, rect), crop(act.data, 40, [rect[0], rect[1] + sy, rect[2], rect[3] + sy]), 34, 12).mismatched;
    assert.deepEqual(r, { s: [0, 2], before: count(0), after: count(2) });
    assert.deepEqual([r.before, r.after, worth(r)], [120, 0, true]);
    assert.deepEqual(search(bar(40, 20, []), bar(40, 20, []), rect), { s: [0, 0], before: 0, after: 0 });
    // A full-width bar hides horizontal shifts: (+/-1, 2) and (0, 2) both score zero, so prefer smaller |sx| + |sy|.
    assert.deepEqual(search(bar(40, 20, range(5, 10)), bar(40, 20, range(7, 12)), rect).s, [0, 2]);
    const edge = search(bar(40, 20, range(0, 3)), bar(40, 20, range(1, 4)), [0, 0, 40, 15]);
    assert.deepEqual([edge.s, edge.after], [[0, 1], 0]);
  });

  test('search at k=4 refines a 5-device-pixel shift from coarse 4 to fine 5; worth scales thresholds by k squared', () => {
    const r = search(bar(40, 40, range(10, 20), 4, 36), bar(40, 40, range(15, 25), 4, 36), [2, 2, 38, 30], 4);
    assert.deepEqual([r.s, r.before, r.after], [[0, 5], 320, 0]);
    assert.deepEqual([worth(r), worth(r, 4), worth({ before: 800, after: 560 }, 4), worth({ before: 800, after: 561 }, 4), worth({ before: 49, after: 0 })], [true, false, true, false, false]);
  });

  test('relocate adds deltas to translate or matrix translation, converts left/top to flat translate, applies inverse rotated/flipped parent bases, and gives only hints for singular bases', () => {
    const I = [1, 0, 0, 1];
    assert.deepEqual(relocate({ style: 'transform:translate(10px,20px);width:5px', chain: I }, 0, -2),
      { fix: { style: { transform: 'translate(10px,18px)' }, basis: { transform: 'translate(10px,20px)' } }, flat: false });
    assert.deepEqual(relocate({ style: 'transform:matrix(0.866025,0.5,-0.5,0.866025,3,4)', chain: I }, 1, 0, null),
      { fix: { style: { transform: 'matrix(0.866025,0.5,-0.5,0.866025,4,4)' } }, flat: false }, 'Omit basis when it is null');
    assert.deepEqual(relocate({ style: 'left:12px;top:0px;width:5px', chain: I }, 0, 2, 'translate(9px,9px)'),
      { fix: { style: { transform: 'translate(12px,2px)' }, basis: { transform: 'translate(9px,9px)' } }, flat: true, hint: 'Node is written as left/top in the page; still write overrides as transform' });
    // A parent rotated 90 degrees maps canvas (0,2) to local (2,0); horizontal reflection maps canvas (3,0) to local (-3,0).
    assert.equal(relocate({ style: 'transform:translate(0px,0px)', chain: [0, 1, -1, 0] }, 0, 2).fix?.style.transform, 'translate(2px,0px)');
    assert.equal(relocate({ style: 'transform:translate(5px,5px)', chain: [-1, 0, 0, 1] }, 3, 0).fix?.style.transform, 'translate(2px,5px)');
    assert.deepEqual(relocate({ style: 'transform:translate(5px,5px)', chain: [1, 2, 2, 4] }, 3, 0), { flat: false, hint: 'Coordinate parent matrix is not invertible; cannot convert to a local offset' });
    assert.equal(relocate({ style: 'width:5px', chain: I }, 3, 0).fix, undefined);
    assert.equal(relocate({ style: 'padding-top:3px;transform:translate(1px, 2px)', chain: I }, 0.5, 0).fix?.style.transform, 'translate(1.5px,2px)', 'Whitespace and similarly named properties');
  });

  test('advise preserves skip reasons in hints, omits zero shifts, converts by -s/k, reports shift below the gain threshold, and otherwise adds fix with flat left/top guidance', () => {
    const at = { style: 'transform:translate(10px,20px)', chain: [1, 0, 0, 1] };
    assert.deepEqual([advise('Differences are spread too widely; shift search skipped', 1, at), advise({ s: [0, 0], before: 9, after: 9 }, 1, at)], [{ hints: ['Differences are spread too widely; shift search skipped'] }, { hints: [] }]);
    assert.deepEqual(advise({ s: [0, 2], before: 120, after: 0 }, 1, at), { shift: { dx: 0, dy: -2, before: 120, after: 0 },
      fix: { style: { transform: 'translate(10px,18px)' }, basis: { transform: 'translate(10px,20px)' } }, hints: ['After moving up 2px: differing pixels 120->0'] });
    // k=4 means 4 device pixels per CSS pixel; thresholds scale by k squared, so reducing 800 pixels to 600 is insufficient.
    assert.deepEqual(advise({ s: [-4, 0], before: 800, after: 600 }, 4, at), { shift: { dx: 1, dy: 0, before: 800, after: 600 }, hints: ['After moving right 1px: differing pixels 800->600', 'Reduction too small; no fix given'] });
    const flat = advise({ s: [0, -2], before: 100, after: 0 }, 1, { style: 'left:5px;top:6px', chain: [1, 0, 0, 1] }, null);
    assert.deepEqual(flat, { shift: { dx: 0, dy: 2, before: 100, after: 0 }, fix: { style: { transform: 'translate(5px,8px)' } }, flat: true,
      hints: ['After moving down 2px: differing pixels 100->0','Node is written as left/top in the page; still write overrides as transform'] });
  });

  test('moved lists x first, maps signs to right/left and down/up, and preserves decimals', () => {
    assert.deepEqual([moved(0, -2), moved(1, -0.5), moved(-1.25, 3), moved(0, 0)], ['up 2px', 'right 1px, up 0.5px', 'left 1.25px, down 3px', '']);
  });
});
