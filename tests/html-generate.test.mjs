/**
 * [INPUT]: helpers/generate extracted/run/KANIT; src/html/generate fontRequests/embed/dataUri/GENERATOR; pure src/html/css functions.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Browser-free generator contracts. Real VM plugin extraction of mock frames 1:2 and 1:3 becomes file descriptors before generation through helpers/generate. Focused assertions protect each rule; handwritten font metrics make results machine-independent.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extracted, run, KANIT } from './helpers/generate.mjs';
import { fontRequests, embed, dataUri, GENERATOR } from '../src/html/generate.mjs';
import { linearGradient, paintLayer, lineHeight, baselineShift, blend, place, num, svgLinearGradient, bakeReason, maskImage, textBox, segmentStyle, effects } from '../src/html/css.mjs';

// -- Generated-output queries ---------------------------------------------
const find = (tree, id) => tree.id === id ? tree : (tree.children || []).map(c => find(c, id)).find(Boolean);
const walk = (tree, fn) => { fn(tree); for (const c of tree.children || []) walk(c, fn); };
// Node opening tag and style, excluding background-blur layers.
const tag = (html, id) => html.match(new RegExp(`<div class="n[^"]*" data-node="${id.replace(/[;:]/g, '\\$&')}" data-name[^>]*>`))?.[0];
const style = (html, id) => (tag(html, id) ?? '').match(/style="([^"]*)"/)?.[1].replace(/&quot;/g, '"');
const kinds = (r, id) => r.approximations.filter(a => a.node === id).map(a => a.detail ? `${a.kind}:${a.detail}` : a.kind);

test('Two generations of each frame are byte-identical without invariant violations, and metadata records provenance', async () => {
  for (const id of ['1:2', '1:3']) {
    const { output } = await extracted(id);
    const first = run(output), second = run(structuredClone(output));
    assert.equal(first.html, second.html);
    assert.deepEqual(first.violations, []);
    assert.deepEqual(first.refs, []);
  }
  const { output } = await extracted('1:2');
  const r = run(output, { extract: 'job-1', overridesHash: 'abc123def456' });
  assert.match(r.html, new RegExp(`<meta name="figma-agent-control" content="extract=job-1; node=1:2; scale=1; overrides=abc123def456; generator=${GENERATOR}">`));
  assert.match(GENERATOR, /^[0-9a-f]{12}$/);
  assert.match(r.html, /^<!doctype html>\n<html><head><meta charset="utf-8"><title>\u753b\u677f<\/title>/);
  assert.doesNotMatch(r.html, /z-index|-apple-system|1\.193em/);
  // Invariants detect NaN/missing widths and NaN color channels, but ignore NaN text inside SVG base64 payloads.
  find(output.root, '2:4').width = NaN;
  assert.match(run(output).violations[0], /width:NaNpx/);
  delete find(output.root, '2:4').width;
  find(output.root, '1:2').fills[0].color.r = NaN;
  const bad = run(output).violations.join('\n');
  assert.match(bad, /rgba\(NaN,255,255,1\)/);
  assert.match(bad, /width:undefinedpx/);
  const clean = (await extracted('1:2')).output;
  clean.svgs[clean.islands['2:1']] = '<svg width="10" height="10"><image href="data:image/png;base64,AANaNInfinityB="/></svg>';
  assert.deepEqual(run(clean).violations, []);
});

// -- Structure and traversal ----------------------------------------------
test('Structure uses local matrices, translations and rotated-parent coordinates, nested SLOTs, canvas root fills, and omission of unpainted nodes', async () => {
  const { output } = await extracted('1:2'), r = run(output);
  assert.equal(style(r.html, '2:1'), 'transform:translate(5px,5px);width:10px;height:10px', 'Island origin uses renderBounds; SVG already includes reflection');
  assert.match(style(r.html, '2:4'), /^transform:translate\(0px,0px\)/, 'Post-mask siblings are positioned relative to the mask');
  assert.match(r.html, /data-node="2:12"[^>]*><div class="n" data-node="I2:12;4:1"/);
  assert.match(r.html, /<div id="canvas" data-node="1:2" data-name="\u753b\u677f" style="background:linear-gradient\(#FFFFFF,#FFFFFF\);overflow:hidden">/);
  assert.equal(tag(r.html, '3:10'), undefined);
  assert.equal(r.stats.omitted, 1);
  // Offline data without renderBounds still generates normally.
  walk(output.root, n => { delete n.renderBounds; });
  assert.ok(tag(run(output).html, '3:10'));
  // A reflected vector rendered as DOM rather than an island retains its reflected matrix.
  const flat = (await extracted('1:2')).output;
  delete flat.islands['2:1'];
  assert.match(style(run(flat).html, '2:1'), /^transform:matrix\(-1,0,0,1,15,5\)/);

  const gen = (await extracted('1:3')).output, g = run(gen);
  assert.match(g.html, /<div id="canvas" data-node="1:3" data-name="\u751f\u6210\u5668\u753b\u677f" style="background:linear-gradient\(#FAFAFC,#FAFAFC\);overflow:hidden">/);
  assert.match(style(g.html, '4:4'), /^transform:matrix\(0\.707107,0\.707107,-0\.707107,0\.707107,15,-1\)/, 'The second mask at (5,5) is the coordinate parent');
  assert.match(style(g.html, '4:8'), /^transform:translate\(0px,0px\)/, 'Rotated-group children use local coordinates');
  assert.match(style(g.html, '4:9'), /^transform:matrix\(0\.866025,-0\.5,0\.5,0\.866025,20\.669873,12\.5\);width:13\.66px;height:13\.66px$/, 'Island transform is inverse rotated parent times renderBounds translation');
});

test('Masks wrap only following siblings in local bounds, nest in order, use ALPHA opacity or rounded VECTOR geometry, and keep clipping/opacity on the owning node', async () => {
  const r = run((await extracted('1:2')).output);
  assert.match(r.html, /data-node="2:2"[^>]*><div class="n" data-mask="2:3" data-name="\u8499\u7248" style="transform:translate\(0px,0px\);width:20px;height:20px;mask-image:url\(&quot;data:image\/svg\+xml,[^"]+&quot;\);mask-size:100% 100%;mask-repeat:no-repeat"><div class="n" data-node="2:4"[^>]*><\/div><\/div><\/div>/);
  assert.equal(r.stats.masks, 1);
  const g = run((await extracted('1:3')).output), svg = id => decodeURIComponent(g.html.match(new RegExp(`data-mask="${id}"[^>]*mask-image:url\\(&quot;data:image/svg\\+xml,([^&]+)&quot;`))[1]);
  assert.match(g.html, /data-mask="4:2"[^>]*><div class="n" data-mask="4:3"[^>]*><div class="n" data-node="4:4"[^>]*><\/div><\/div><\/div><\/div>/);
  assert.match(svg('4:2'), /<g fill-opacity="0\.5"><ellipse cx="20" cy="20" rx="20" ry="20"\/><\/g>/);
  assert.match(svg('4:3'), /<g fill-opacity="1"><rect width="30" height="30" rx="4"\/><\/g>/);
  assert.deepEqual(kinds(g, '4:3'), ['multi-mask']);
  assert.deepEqual(kinds(g, '4:29'), ['mask-shape:luminance']);
  assert.equal(style(g.html, '4:5'), 'transform:translate(45px,0px);width:40px;height:40px;background:linear-gradient(#E6E6E6,#E6E6E6);border-radius:8px;overflow:hidden');
  assert.match(style(g.html, '4:6'), /transform:translate\(20px,20px\);width:30px;height:30px/, 'Overflowing children still generate and are clipped by their parent');
  const group = g.html.slice(g.html.indexOf('data-node="4:7"'), g.html.indexOf('data-node="4:10"'));
  assert.equal(group.match(/opacity/g).length, 1, 'Group opacity is written once without propagating');
  assert.match(style(g.html, '4:7'), /opacity:0\.5;isolation:isolate/);
});

test('Repeated inline SVGs receive distinct IDs; island wrappers avoid duplicate opacity, use bounding boxes without renderBounds, and fall back to DOM when clipped or backdrop-dependent', async () => {
  const g = run((await extracted('1:3')).output);
  const ids = [...g.html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]).filter(id => id !== 'canvas');
  assert.deepEqual(ids, ['i1-paint0', 'i2-paint0']);
  assert.match(g.html, /fill="url\(#i1-paint0\)"[\s\S]*fill="url\(#i2-paint0\)"/);
  assert.equal(g.stats.islands, 3);

  // Use renderBounds for origin and SVG for size after removing XML declaration; opacity is already in SVG. Without renderBounds, use the transformed bounding box.
  const { output } = await extracted('1:2');
  Object.assign(find(output.root, '2:1'), { opacity: 0.5, renderBounds: [6, 7, 8, 8] });
  output.svgs[output.islands['2:1']] = '<?xml version="1.0"?>\n<svg width="8" height="8"/>';
  assert.match(run(output).html, /<div class="n" data-node="2:1" data-name="\u7ffb\u8f6c\u77e2\u91cf" style="transform:translate\(6px,7px\);width:8px;height:8px"><svg width="8" height="8"\/><\/div>/);
  delete find(output.root, '2:1').renderBounds;
  assert.match(style(run(output).html, '2:1'), /^transform:translate\(5px,5px\);/);
  output.svgs[output.islands['2:1']] = '<svg width="8" height="8"><g id="a"/><use xlink:href="#a"/></svg>';
  assert.match(run(output).html, /<g id="i0-a"\/><use xlink:href="#i0-a"\/>/);

  const clipped = (await extracted('1:3')).output;
  find(clipped.root, '4:11').renderBounds[2] = 8;
  const c = run(clipped);
  assert.deepEqual(kinds(c, '4:11'), ['island-clipped']);
  assert.match(c.html, /data-node="4:11"[^>]*><svg width="10" height="10" overflow="visible"><path d="[^"]+" fill-rule="nonzero" fill="#000000"\/><\/svg>/);

  // Model islandRule 1: GLASS group 3:1 becomes an island but is vetoed for backdrop dependence, so its subtree generates as DOM.
  const vetoed = (await extracted('1:2')).output;
  vetoed.islands['3:1'] = 's0';
  const v = run(vetoed);
  assert.deepEqual(kinds(v, '3:1'), ['island-vetoed', 'glass']);
  assert.match(v.html, /data-node="3:1"[^>]*><div class="n" data-node="3:2"/);
  assert.deepEqual(run(vetoed, { overrides: { '3:1': { bake: 'svg', note: '\u5f3a\u5236' } } }).overrides.applied, ['3:1']);
  // DOM-fallback islands use DOM positioning: blended fill vetoes island 2:5, requiring fill blending through the container and left/top on the container.
  const fill = (await extracted('1:2')).output;
  find(fill.root, '2:5').fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, blendMode: 'MULTIPLY' }];
  const f = run(fill);
  assert.deepEqual(kinds(f, '2:5'), ['island-vetoed']);
  assert.match(style(f.html, '2:5'), /^left:45px;top:0px;width:10px;height:10px$/);
  assert.match(f.html, /data-node="2:5"[^>]*><div data-layer="fill" style="[^"]*mix-blend-mode:multiply"><\/div>/);
});

test('BAKE/needsIsland cover dashed/radial nested shapes, incomplete arcs, translucent ALPHA and LUMINANCE mask parents; vetoed backdrop-dependent vectors render as SVG paths', async () => {
  const g = run((await extracted('1:3')).output);
  assert.deepEqual(g.needsIsland, ['4:1', '4:15', '4:16', '4:28']);
  assert.deepEqual(['4:1', '4:15', '4:14', '4:16', '4:28'].map(id => kinds(g, id)),
    [['needs-island:mask-alpha'], ['needs-island:dash'], ['paint-unsupported:GRADIENT_RADIAL'], ['needs-island:arc'], ['needs-island:mask-luminance']]);
  assert.match(style(g.html, '4:14'), /background:linear-gradient\(#FF0000,#FF0000\)/, 'Radial gradient falls back to its first stop');
  // LINE renders only strokes, omitting fills and empty paths; element blending stays on the container because its own transform does not isolate it.
  assert.deepEqual(kinds(g, '4:10'), ['island-vetoed:vector']);
  assert.match(g.html, /data-node="4:10"[^>]*style="transform:translate\(0px,45px\);width:40px;height:0px;mix-blend-mode:multiply"><svg width="40" height="1" overflow="visible"><path d="M 0 -0\.5 L 40 -0\.5 L 40 0\.5 L 0 0\.5 Z" fill-rule="nonzero" fill="#000000"\/><\/svg><\/div>/);
  assert.doesNotMatch(g.html, /\sd=""/);
  const bare = (await extracted('1:3')).output;
  delete find(bare.root, '4:10').strokeGeometry;
  assert.match(run(bare).html, /data-node="4:10"[^>]*><svg width="40" height="1" overflow="visible"><\/svg><\/div>/);

  const r = run((await extracted('1:2')).output);
  assert.deepEqual(r.needsIsland, []);
  assert.deepEqual(['3:4', '3:5', '3:6'].map(id => kinds(r, id)), [['island-vetoed:vector', 'blend-mode'], ['island-vetoed:vector', 'blend-mode'], ['island-vetoed:vector', 'blend-shadow']]);
  assert.match(r.html, /data-node="3:4"[^>]*style="transform:translate\(0px,0px\);width:10px;height:10px;mix-blend-mode:multiply"><svg width="10" height="10" overflow="visible"><path d="[^"]+" fill-rule="nonzero" fill="#000000"\/>/);
  assert.doesNotMatch(style(r.html, '3:6'), /shadow/, 'Blended inner shadows are not drawn');
  // Containers whose descendants blend through use left/top for pure translation to avoid stacking contexts, such as passthrough group 3:3; vector/self-paint blending does not trigger this;
  // isolated NORMAL containers stay unchanged, and rotations remain matrices.
  assert.deepEqual(['3:3', '3:4', '3:5', '3:7', '2:5'].map(id => style(r.html, id).split(';')[0]),
    ['left:30px', 'transform:translate(0px,0px)', 'transform:translate(12px,0px)', 'transform:translate(36px,0px)', 'transform:translate(45px,0px)']);
  // CSS filter also isolates: adding layer blur to 3:3 stops position rewriting and records isolation:filter for blended fills/descendants.
  const blurred = (await extracted('1:2')).output;
  Object.assign(find(blurred.root, '3:3'), { effects: [{ type: 'LAYER_BLUR', visible: true, radius: 2 }], fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, blendMode: 'MULTIPLY' }] });
  const b = run(blurred);
  assert.match(style(b.html, '3:3'), /^transform:translate\(30px,60px\);.*;filter:blur\(1px\)$/);
  assert.deepEqual([kinds(b, '3:3'), kinds(b, '3:4')], [['isolation:filter'], ['isolation:filter', 'island-vetoed:vector', 'blend-mode']]);
  const normal = (await extracted('1:2')).output;
  find(normal.root, '3:3').blendMode = 'NORMAL';
  assert.match(style(run(normal).html, '3:3'), /^transform:translate\(30px,60px\);.*isolation:isolate$/);
  const turned = (await extracted('1:2')).output;
  find(turned.root, '3:4').transform = [[0, -1, 10], [1, 0, 0]];
  assert.match(style(run(turned).html, '3:4'), /^transform:matrix\(0,1,-1,0,-20,-60\);/);
});

// -- Styles ---------------------------------------------------------------
test('Fills reverse into CSS backgrounds, use layers for translucency/blending, merge single-image opacity, support FILL/FIT/CROP/TILE, and preserve corners/strokes', async () => {
  const g = run((await extracted('1:3')).output);
  assert.match(g.html, /data-node="4:22"[^>]*style="transform:translate\(0px,85px\);width:30px;height:20px"><div data-layer="fill" style="position:absolute;inset:0;border-radius:inherit;background:linear-gradient\(#FFFFFF,#FFFFFF\)"><\/div><div data-layer="fill" style="[^"]*linear-gradient\(90deg,#FF0000 0%,#0000FF 100%\)"><\/div><div data-layer="fill" style="[^"]*no-repeat;opacity:0\.5"><\/div><\/div>/);
  assert.match(style(g.html, '4:21'), /opacity:0\.5;background:url\("fac-asset:[0-9a-f]{64}"\) center\/cover no-repeat$/);
  assert.match(style(g.html, '4:17'), /center\/cover no-repeat$/);
  assert.match(style(g.html, '4:18'), /center\/contain no-repeat$/);
  assert.match(style(g.html, '4:19'), /\) -10px -10px\/40px 40px no-repeat$/);
  assert.match(style(g.html, '4:20'), /\) 0 0\/4px 4px repeat$/);
  assert.match(style(g.html, '4:6'), /outline:2px solid #000000;outline-offset:-1px$/);
  assert.match(style(g.html, '4:24'), /outline:1px solid #000000;outline-offset:0px;box-shadow:0px 2px 4px 3px rgba\(0,0,0,0\.25\)$/);
  assert.match(g.html, /data-node="4:15"[^>]*style="transform:translate\(120px,45px\);width:30px;height:30px"><div class="n" data-node="4:14"[^>]*><\/div><div data-layer="stroke" style="position:absolute;inset:0;border-radius:inherit;outline:1px solid #000000;outline-offset:-1px"><\/div><\/div>/, 'Stroke layers follow children');
  assert.match(style(g.html, '4:13'), /background:linear-gradient\(153\.435deg,#FF0000 0%,#0000FF 100%\)$/);
  const r = run((await extracted('1:2')).output);
  assert.match(style(r.html, '2:4'), /border-radius:4px 0px 4px 0px$/);
  assert.match(r.html, /<div data-layer="stroke" style="position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 1px 0 0 #000000,inset 0 -1px 0 0 #000000"><\/div><\/div>/, 'Unequal edges: 1 px top and bottom INSIDE strokes');
  // Blended container fills become individual layers; left/top lets them blend with the lower backdrop, and the stroke becomes the final layer.
  const { output } = await extracted('1:3');
  Object.assign(find(output.root, '4:23'), { strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1, strokeAlign: 'INSIDE' });
  find(output.root, '4:23').fills[0].blendMode = 'MULTIPLY';
  assert.match(run(output).html, /data-node="4:23" data-name="\u73bb\u7483" style="left:35px;top:85px;[^"]*"><div data-layer="fill" style="position:absolute;inset:0;border-radius:inherit;background:linear-gradient\(rgba\(255,255,255,0\.2\),rgba\(255,255,255,0\.2\)\);mix-blend-mode:multiply"><\/div><div data-layer="stroke" style="[^"]*outline:1px solid #000000;outline-offset:-1px"><\/div><\/div>/);
  // Reverse fill order: Figma's last fill is on top, CSS's first background is on top. Keep outward strokes on clipping containers so overflow does not clip the stroke itself.
  find(output.root, '4:22').fills.pop();
  Object.assign(find(output.root, '4:5'), { strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 2, strokeAlign: 'OUTSIDE' });
  const o = run(output);
  assert.match(style(o.html, '4:22'), /background:linear-gradient\(90deg,#FF0000 0%,#0000FF 100%\),linear-gradient\(#FFFFFF,#FFFFFF\)$/);
  assert.match(style(o.html, '4:5'), /outline:2px solid #000000;outline-offset:0px;overflow:hidden$/);
  // Unavailable bitmaps omit that layer and record an approximation.
  delete output.images.h1;
  assert.deepEqual(kinds(run(output), '4:21'), ['image-unavailable']);
});

test('Background blur and GLASS precede their node as sibling layers, progressive blur uses masks, zero GLASS radius skips blur, and shadows/blending/color profiles are preserved', async () => {
  const r = run((await extracted('1:2')).output);
  assert.match(r.html, /<div class="n" data-node="3:8" data-layer="backdrop" style="transform:translate\(90px,60px\);width:30px;height:20px;backdrop-filter:blur\(4px\);mask-image:linear-gradient\(180deg,rgba\(0,0,0,0\) 0%,#000000 100%\)"><\/div><div class="n" data-node="3:8" data-name/);
  assert.doesNotMatch(style(r.html, '3:8'), /mask/);
  assert.deepEqual(kinds(r, '3:8'), ['background-blur']);
  assert.doesNotMatch(r.html, /data-node="3:1" data-layer/);
  assert.deepEqual(kinds(r, '3:1'), ['glass']);
  const g = run((await extracted('1:3')).output);
  assert.match(g.html, /<div class="n" data-node="4:23" data-layer="backdrop" style="transform:translate\(35px,85px\);width:30px;height:20px;border-radius:10px;backdrop-filter:blur\(3px\)"><\/div>/);
  const { output } = await extracted('1:2');
  output.colorProfile = 'DISPLAY_P3';
  assert.deepEqual(kinds(run(output), '1:2'), ['color-profile']);
  assert.deepEqual([blend('LINEAR_DODGE'), blend('COLOR_BURN'), blend('PASS_THROUGH')], [{ value: 'plus-lighter', approx: 'blend-mode' }, { value: 'color-burn' }, { value: '' }]);
});

test('Real Figma shadows apply spread only to rectangles, ellipses, and filled clipping frames; OUTSIDE/CENTER strokes expand by w/w/2, while inner shadows do not', () => {
  const sh = (spread, type = 'DROP_SHADOW') => ({ type, visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 2 }, spread, blendMode: 'NORMAL' });
  const FILL = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], LINE = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
  const fx = (n, target = 'box') => effects(/** @type {any} */ ({ fills: FILL, effects: [sh(-3)], ...n }), target);
  const box = n => fx(n).style['box-shadow'];
  assert.equal(box({ type: 'RECTANGLE' }), '0px 2px 4px -3px #000000');
  assert.equal(box({ type: 'ELLIPSE' }), '0px 2px 4px -3px #000000');
  assert.equal(box({ type: 'FRAME', clipsContent: true }), '0px 2px 4px -3px #000000');
  assert.equal(box({ type: 'COMPONENT', clipsContent: true }), '0px 2px 4px -3px #000000');
  assert.equal(box({ type: 'INSTANCE', clipsContent: true }), '0px 2px 4px -3px #000000');
  assert.equal(box({ type: 'SLOT', clipsContent: true }), '0px 2px 4px -3px #000000');
  assert.equal(box({ type: 'FRAME' }), '0px 2px 4px #000000', 'Without Clip content, Figma uses zero spread');
  assert.equal(box({ type: 'INSTANCE', clipsContent: false }), '0px 2px 4px #000000');
  assert.equal(box({ type: 'FRAME', clipsContent: true, fills: [], strokes: LINE, strokeWeight: 1, strokeAlign: 'INSIDE' }), '0px 2px 4px #000000', 'No visible fill');
  assert.equal(box({ type: 'FRAME', clipsContent: true, fills: [{ ...FILL[0], visible: false }] }), '0px 2px 4px #000000');
  assert.equal(box({ type: 'FRAME', clipsContent: true, fills: [{ ...FILL[0], opacity: 0 }] }), '0px 2px 4px #000000', 'Zero-opacity fills do not count');
  assert.equal(box({ type: 'FRAME', clipsContent: true, fills: [{ ...FILL[0], opacity: 0.01 }] }), '0px 2px 4px -3px #000000');
  // OUTSIDE/CENTER strokes expand the shadow even when spread is ineffective; INSIDE, unequal-edge, and hidden strokes do not.
  assert.equal(box({ type: 'RECTANGLE', strokes: LINE, strokeWeight: 2, strokeAlign: 'OUTSIDE' }), '0px 2px 4px -1px #000000');
  assert.equal(box({ type: 'FRAME', strokes: LINE, strokeWeight: 2, strokeAlign: 'CENTER' }), '0px 2px 4px 1px #000000');
  assert.equal(box({ type: 'FRAME', strokes: LINE, strokeWeight: 3, strokeAlign: 'OUTSIDE', effects: [sh(0)] }), '0px 2px 4px 3px #000000');
  assert.equal(box({ type: 'RECTANGLE', strokes: LINE, strokeWeight: 2, strokeAlign: 'INSIDE' }), '0px 2px 4px -3px #000000');
  assert.equal(box({ type: 'RECTANGLE', strokes: LINE, strokeWeight: 'MIXED', strokeTopWeight: 2, strokeAlign: 'OUTSIDE' }), '0px 2px 4px -3px #000000');
  assert.equal(box({ type: 'RECTANGLE', strokes: [{ ...LINE[0], visible: false }], strokeWeight: 2, strokeAlign: 'OUTSIDE' }), '0px 2px 4px -3px #000000');
  // Inner shadows also use zero spread on unsupported nodes, without stroke expansion.
  assert.equal(box({ type: 'FRAME', effects: [sh(3, 'INNER_SHADOW')] }), 'inset 0px 2px 4px #000000');
  assert.equal(box({ type: 'RECTANGLE', strokes: LINE, strokeWeight: 2, strokeAlign: 'OUTSIDE', effects: [sh(3, 'INNER_SHADOW')] }), 'inset 0px 2px 4px 3px #000000');
  // Content-shaped drop-shadow cannot express spread; record an approximation when Figma applies it.
  assert.deepEqual(fx({ type: 'RECTANGLE' }, 'image'), { style: { filter: 'drop-shadow(0px 2px 2px #000000)' }, approx: ['shadow-spread'] });
  assert.deepEqual(fx({ type: 'FRAME', fills: [] }, 'image').approx, []);
  assert.deepEqual(fx({ type: 'RECTANGLE', effects: [sh(0)] }, 'image').approx, []);
  assert.deepEqual(fx({ type: 'FRAME', fills: [], effects: [sh(0), sh(0)] }, 'image').approx, ['shadow-chain'], 'Multiple drop-shadows accumulate in sequence');
});

test('Real Figma unclipped opaque frames with painted child geometry outside the box use content-shaped shadows, excluding child shadows from the outline and recording approximations', async () => {
  const { output } = await extracted('1:3');
  const shadow = { type: 'DROP_SHADOW', visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, spread: -2, blendMode: 'NORMAL', showShadowBehindNode: false };
  const frame = find(output.root, '4:15'), kid = find(output.root, '4:14'), at = (x, y) => [[1, 0, x], [0, 1, y]];
  /** Move a 20x20 node by updating both its transform and renderBounds. */
  const put = (n, x, y) => Object.assign(n, { transform: at(x, y), renderBounds: [x, y, 20, 20] });
  const SOLID = { type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1 } };
  Object.assign(frame, { fills: [SOLID], effects: [shadow] });
  const css = () => style(run(output).html, '4:15');
  assert.match(css(), /box-shadow:0px 2px 4px rgba\(0,0,0,0\.25\)$/, 'Children inside the box preserve the box outline without spread');
  // Overflow right, left, or top from a 30x30 frame at (120,45) with a 20x20 child.
  for (const [x, y] of [[140, 50], [110, 50], [125, 35]]) { put(kid, x, y); assert.match(css(), /filter:drop-shadow\(0px 2px 2px rgba\(0,0,0,0\.25\)\)$/, `${x},${y}`); }
  frame.clipsContent = true;
  assert.match(css(), /box-shadow:0px 2px 4px -2px rgba\(0,0,0,0\.25\);overflow:hidden$/, 'Clip content trims overflow and uses the box with spread');
  frame.clipsContent = false;
  // Translucent fills would fade drop-shadow, so retain a box shadow and record an approximation.
  frame.fills = [{ ...SOLID, opacity: 0.5 }];
  let r = run(output);
  assert.match(style(r.html, '4:15'), /box-shadow:0px 2px 4px rgba\(0,0,0,0\.25\)$/);
  assert.ok(kinds(r, '4:15').includes('shadow-spill'));
  frame.fills = [SOLID];
  // Two drop-shadows would accumulate, so retain the box and record an approximation.
  frame.effects = [shadow, { ...shadow, offset: { x: 0, y: 8 } }];
  r = run(output);
  assert.match(style(r.html, '4:15'), /box-shadow:0px 2px 4px rgba\(0,0,0,0\.25\),0px 8px 4px rgba\(0,0,0,0\.25\)$/);
  assert.ok(kinds(r, '4:15').includes('shadow-spill'));
  frame.effects = [shadow];
  // Leaf ink inside the box is not overflow even if its rotated geometry extends outside; masks do not count.
  Object.assign(kid, { transform: [[0.7071, -0.7071, 135], [0.7071, 0.7071, 41.615]], renderBounds: [125, 50, 20, 20] });
  assert.doesNotMatch(css(), /filter/, 'Rotation');
  Object.assign(kid, { isMask: true, maskType: 'ALPHA', transform: at(140, 50), renderBounds: [140, 50, 20, 20] });
  assert.doesNotMatch(css(), /filter/, 'Mask');
  delete kid.isMask; delete kid.maskType; put(kid, 125, 50);
  // LAYER_BLUR alone does not change the shadow target.
  frame.effects = [{ type: 'LAYER_BLUR', visible: true, radius: 2 }];
  assert.doesNotMatch(css(), /drop-shadow/);
  frame.effects = [shadow];
  // Exclude unpainted children, their own shadow overflow, unfilled/unstroked wrapper bounds (inspect descendants instead), and clipped child containers.
  kid.renderBounds = null;
  assert.doesNotMatch(css(), /filter/, 'No paint');
  Object.assign(kid, { transform: at(125, 50), renderBounds: [125, 50, 20, 40], effects: [{ ...shadow, offset: { x: 0, y: 20 }, spread: 0 }] });
  assert.doesNotMatch(css(), /filter/, 'Its own shadow');
  const inner = put({ ...structuredClone(kid), id: '4:99', type: 'RECTANGLE', effects: [], children: undefined }, 125, 50);
  Object.assign(kid, { type: 'FRAME', fills: [], strokes: [], effects: [], transform: at(120, 45), width: 40, height: 30, renderBounds: [120, 45, 40, 30], children: [inner] });
  assert.doesNotMatch(css(), /filter/, 'Wrapper overflows but content stays inside');
  put(inner, 125, 70);
  assert.match(css(), /filter:drop-shadow/, 'An unclipped descendant container overflows');
  kid.clipsContent = true;
  assert.doesNotMatch(css(), /filter/, 'Clipped child container');
  kid.clipsContent = false;
  // Zero-opacity fills do not form an outline: alone they cast no shadow; strokes cast ring shadows with Figma hollowing the fill area, requiring an approximation. Such fills on overflowing children do not count as overflow.
  const solo = output.root.children.find(n => n.id === '4:24'), zero = { ...SOLID, opacity: 0 };
  Object.assign(solo, { fills: [zero], strokes: [], effects: [shadow] });
  r = run(output);
  assert.doesNotMatch(style(r.html, '4:24'), /shadow/);
  solo.strokes = [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0 } }];
  r = run(output);
  assert.match(style(r.html, '4:24'), /filter:drop-shadow/);
  assert.ok(kinds(r, '4:24').includes('shadow-knockout'));
  solo.fills = [SOLID];
  assert.doesNotMatch(style(run(output).html, '4:24'), /filter/);
  inner.fills = [zero];
  assert.doesNotMatch(css(), /filter/, 'Overflowing grandchild has only a zero-opacity fill');
  inner.fills = [SOLID];
  // Content-shaped shadows with visible descendant shadows, including grandchildren, require an approximation; hidden and inner shadows do not count.
  const childShadow = e => { inner.effects = e; return kinds(run(output), '4:15').includes('shadow-children'); };
  assert.equal(childShadow([{ ...shadow, spread: 0 }]), true);
  assert.equal(childShadow([{ ...shadow, visible: false }]), false);
  assert.equal(childShadow([{ ...shadow, type: 'INNER_SHADOW' }]), false);
  Object.assign(frame, { fills: [], effects: [{ type: 'LAYER_BLUR', visible: true, radius: 2 }] });
  assert.match(css(), /filter:blur/);
  assert.equal(childShadow([{ ...shadow, spread: 0 }]), false, 'No shadow on the node itself');
});

test('CSS numeric contracts cover gradient-stop remapping, SVG gradients, CROP conversion, number formatting, and matrices', () => {
  const stops = [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }];
  const g = (m, w, h, opacity) => linearGradient({ gradientTransform: m, gradientStops: stops, opacity }, w, h);
  assert.equal(g([[2, 0, -0.5], [0, 1, 0]], 100, 50), 'linear-gradient(90deg,#FF0000 25%,rgba(0,0,255,0.5) 75%)');
  assert.equal(g([[0.5, 0.5, 0], [-0.5, 0.5, 0.5]], 40, 40, 0.5), 'linear-gradient(135deg,rgba(255,0,0,0.5) 0%,rgba(0,0,255,0.25) 100%)');
  assert.equal(g([[0.5, 0.5, 0], [-0.5, 0.5, 0.5]], 40, 20), 'linear-gradient(153.435deg,#FF0000 0%,rgba(0,0,255,0.5) 100%)');
  assert.equal(g([[0, 0, 0.5], [0, 0, 0]], 10, 10), 'linear-gradient(180deg,#FF0000 0%,rgba(0,0,255,0.5) 100%)', 'Zero gradient preserves original stop positions');
  assert.equal(svgLinearGradient({ gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops }, 20, 10, 'v'),
    '<linearGradient id="v" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0" gradientTransform="matrix(20 0 0 10 0 0)"><stop offset="0" stop-color="#FF0000"/><stop offset="1" stop-color="rgba(0,0,255,0.5)"/></linearGradient>');
  assert.match(svgLinearGradient({ gradientTransform: [[1, 0, 0.25], [0, 1, 0.5]], gradientStops: stops }, 20, 10, 'v'), /gradientTransform="matrix\(20 0 0 10 -5 -5\)"/);
  assert.equal(svgLinearGradient({ gradientTransform: [[0, 0, 0], [0, 0, 0]], gradientStops: stops }, 20, 10, 'v'), '');
  const crop = paintLayer({ type: 'IMAGE', scaleMode: 'CROP', imageHash: 'h', imageTransform: [[1, 0, 0], [0, 0.9386, 0.0589]] }, 20, 20, { url: 'u', width: 4, height: 4 });
  assert.deepEqual(crop, { css: 'url("u") 0px -1.255px/20px 21.308px no-repeat' });
  assert.deepEqual(paintLayer({ type: 'IMAGE', scaleMode: 'TILE', imageHash: 'h' }, 20, 20, { url: 'u', width: 0, height: 0 }), { css: 'url("u") 0 0/auto repeat', approx: 'paint-unsupported', detail: 'TILE' });
  assert.deepEqual([num(-0.0001), num(1.23456), num(2.5000001, 6), num(NaN)], ['0', '1.235', '2.5', 'NaN']);
  assert.equal(place([1, 0, 0, 1, 1.5, -2]), 'translate(1.5px,-2px)');
  assert.equal(place([0, 1, -1, 0, 3, 4]), 'matrix(0,1,-1,0,3,4)');
  // BAKE reasons, EVENODD mask geometry, bottom alignment, and default underline thickness/offset.
  const box = extra => ({ id: '1:1', name: 'n', type: 'RECTANGLE', transform: [[1, 0, 0], [0, 1, 0]], width: 10, height: 10, ...extra });
  const image = extra => ({ type: 'IMAGE', scaleMode: 'FILL', imageHash: 'h', ...extra });
  assert.deepEqual([box({ fills: [image({ rotation: 90 })] }), box({ fills: [image({ filters: { exposure: 0.2 } })] }), box({ effects: [{ type: 'NOISE', visible: true }] }),
    box({ strokes: [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [] }] }), box({ fills: [image({ filters: { exposure: 0 } })] })].map(bakeReason),
  ['image-transform', 'image-filter', 'effect-noise', 'gradient-stroke', null]);
  assert.match(decodeURIComponent(maskImage(box({ fillGeometry: [{ windingRule: 'EVENODD', data: 'M0 0 L1 1' }] }), 0.4)['mask-image']), /<g fill-opacity="0\.4"><path d="M0 0 L1 1" fill-rule="evenodd"\/>/);
  assert.equal(textBox(box({ type: 'TEXT', textAlignVertical: 'BOTTOM' })).style['justify-content'], 'flex-end');
  const u = segmentStyle({ characters: 'x', start: 0, end: 1, fontName: { family: 'F', style: 'Regular' }, fontSize: 10, lineHeight: { unit: 'AUTO' }, fills: [], textDecoration: 'UNDERLINE' },
    { name: 'f0', family: 'F', italic: false }, null, [10, 10]);
  assert.deepEqual([u['text-decoration-thickness'], u['text-underline-offset'], u['text-decoration-skip-ink']], ['1px', '2.5px', 'none']);
});

// -- Text -----------------------------------------------------------------
test('Text uses segment spans and line-box struts, follows line-height fallback order, rounds consistent metrics, and compensates Chromium baseline rounding', async () => {
  const { output } = await extracted('1:2'), r = run(output);
  assert.equal(style(r.html, '2:9'), "transform:translate(0px,0px);width:40px;height:20px;font-family:'f0','SF Pro Text',system-ui,sans-serif;font-size:14px;font-style:normal;line-height:16.707px");
  assert.match(r.html, /<span style="[^"]*line-height:16\.707px;color:#FF0000">Hi <\/span><span style="font-family:'f1','PingFang SC',system-ui,sans-serif;font-size:12px;font-style:normal;line-height:18px;color:transparent">\u4f60\u597d<\/span>/, '2:9 mixes metrics and must not round');
  assert.match(r.html, /line-height:19px;color:#737373">A<\/span><span style="[^"]*line-height:19px;color:#0DC2C2">B</, '2:15 combines REST A and Kanit-metric B consistently, so rounds');
  assert.doesNotMatch(r.html, /<div style="position:relative/, '13/19 does not shift; inconsistent 2:9 segments do not compensate');
  find(output.root, '2:9').segments[0].lineHeightPx = 17;
  assert.match(run(output).html, /line-height:17px;color:#FF0000">Hi </);
  // Different font sizes prevent rounding; compensate only segments sharing size and height, not differing heights.
  const [a, b] = find(output.root, '2:15').segments;
  b.fontSize = 14;
  assert.match(run(output).html, /line-height:19\.435px;color:#737373">A<\/span><span style="[^"]*line-height:20\.93px;color:#0DC2C2">B</);
  for (const seg of [a, b]) Object.assign(seg, { fontSize: 14, lineHeight: { unit: 'PIXELS', value: 18 } });
  assert.match(run(output).html, /data-node="2:15"[^>]*><div style="position:relative;top:1px"><span/);
  b.lineHeight = { unit: 'PIXELS', value: 20 };
  assert.doesNotMatch(run(output).html, /data-node="2:15"[^>]*><div style="position:relative/);
  const g = run((await extracted('1:3')).output);
  assert.match(style(g.html, '4:25'), /line-height:12px/, 'Single line without metrics uses node height');
  assert.match(style(g.html, '4:26'), /line-height:normal/);
  assert.deepEqual(kinds(g, '4:26'), ['line-height-normal']);
  assert.match(g.html, /data-node="4:27"[^>]*><div style="position:relative;top:1px">Kanit<\/div><\/div>/, 'Kanit 14/18 shifts the baseline down 1 px directly on the centered wrapper');
  assert.deepEqual([[14, 18], [13, 19.435], [15, 22.425], [15, 20], [19, 22]].map(([fs, lh]) => baselineShift(KANIT, fs, lh)), [1, 0, 0, 0, 1]);
  const seg = (unit, extra = {}) => ({ characters: 'x', start: 0, end: 1, fontName: { family: 'Kanit', style: 'Light' }, fontSize: 13, lineHeight: { unit, value: 150 }, fills: [], ...extra });
  const node = (height, characters = 'x') => ({ id: '1:1', name: 't', type: 'TEXT', transform: [[1, 0, 0], [0, 1, 0]], width: 10, height, characters, segments: [seg('AUTO')] });
  assert.deepEqual([lineHeight(seg('PERCENT'), node(20), null), lineHeight(seg('AUTO'), node(20), { postScriptName: '', ...KANIT }), lineHeight(seg('AUTO'), node(20), null),
    lineHeight(seg('AUTO'), node(24), null), lineHeight(seg('AUTO'), node(20, 'a\nb'), null), lineHeight(seg('AUTO'), node(20, 'a\u2028b'), null)].map(l => ({ ...l, px: l.px && Number(l.px.toFixed(6)) })),
  [{ px: 19.5, from: 'value' }, { px: 19.435, from: 'metrics' }, { px: 20, from: 'height' }, { px: null, approx: 'line-height-normal' }, { px: null, approx: 'line-height-normal' },
    { px: null, approx: 'line-height-normal' }]);
});

test('Text styles preserve font declarations/provenance, escaped family/names, casing, ligatures, percentage spacing, no-wrap, truncation, alignment, and gradient text', async () => {
  const r = run((await extracted('1:2')).output);
  assert.match(r.html, /@font-face\{font-family:'f0';src:local\('SFProText-Bold'\),local\('SFPro-Bold'\);font-style:normal\}\n@font-face\{font-family:'f1';src:local\('PingFangSC-Regular'\);font-style:normal\}\n@font-face\{font-family:'f2';src:local\('Kanit-Light'\);font-style:normal\}\n@font-face\{font-family:'f3';src:local\('Kanit-Regular'\);font-style:normal\}<\/style>/);
  assert.deepEqual(r.fonts.map(f => [f.postScriptName, f.source, f.metrics, f.face]),
    [['SFProText-Bold', 'segment', true, 'f0'], ['PingFangSC-Regular', 'segment', false, 'f1'], ['Kanit-Light', 'segment', true, 'f2'], ['Kanit-Regular', 'file', true, 'f3']]);
  const g = run((await extracted('1:3')).output);
  assert.match(g.html, /@font-face\{font-family:'f0';src:local\('O\\'Font-Medium'\);font-weight:500;font-style:normal\}/);
  assert.match(g.html, /@font-face\{font-family:'f2';src:local\('Kanit-Light'\);font-weight:300;font-style:normal\}/);
  assert.deepEqual(g.fonts.map(f => [f.family, f.source]), [["O'Font", 'guess'], ['Missing Sans', 'guess'], ['Kanit', 'segment']]);
  assert.match(tag(g.html, '4:25'), /^<div class="n t nw" data-node="4:25" data-name="\u540d&quot;&lt;&amp;"/);
  assert.match(style(g.html, '4:25'), /font-family:'f0','O\\'Font',system-ui,sans-serif;font-size:10px;font-weight:500;font-style:normal;line-height:12px;letter-spacing:0\.5px;color:#000000;text-transform:uppercase;font-variant-ligatures:none$/);
  assert.match(style(g.html, '4:26'), /display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;text-overflow:ellipsis;/);
  assert.match(style(g.html, '4:27'), /text-align:center;display:flex;flex-direction:column;justify-content:center;.*background:linear-gradient\(90deg,#FF0000 0%,#0000FF 100%\);-webkit-background-clip:text;background-clip:text;color:transparent$/);
  // Escape </style> and newlines in CSS family names; U+2028 becomes a newline and counts as multiline. Preserve decoration color/style and delegate image-filled text to Figma.
  const { output } = await extracted('1:3'), up = find(output.root, '4:25'), [seg] = up.segments;
  Object.assign(seg, { fontName: { family: 'A</style>\nB', style: 'Medium' }, characters: 'Up\u2028per', textDecoration: 'UNDERLINE',
    textDecorationColor: { value: { type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1 } }, textDecorationStyle: 'WAVY' });
  up.characters = 'Up\u2028per';
  const t = run(output);
  assert.match(t.html, /src:local\('A\\3c \/style>B-Medium'\)/);
  assert.match(t.html, /font-family:'f0','A\\3c \/style&gt;\\a B',system-ui/);
  assert.equal(t.html.split('</style>').length, 2);
  assert.match(t.html, />Up\nper<\/div>/);
  assert.match(style(t.html, '4:25'), /line-height:normal;.*text-decoration-color:#FF0000;text-decoration-style:wavy/);
  seg.textDecorationColor = { value: 'AUTO' };
  assert.doesNotMatch(style(run(output).html, '4:25'), /text-decoration-color/, 'Real-device AUTO uses { value: "AUTO" }');
  seg.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, { type: 'IMAGE', scaleMode: 'FILL', imageHash: 'h1' }];
  assert.deepEqual(kinds(run(output), '4:25'), ['needs-island:paint-image', 'line-height-normal', 'text-paint', 'paint-unsupported:IMAGE']);
});

test('Opaque-gradient ALPHA masks avoid BAKE, multiple fills composite alpha, shadows target content, and isolation/smoothing/behind-node shadows record approximations', async () => {
  const { output } = await extracted('1:3'), circle = find(output.root, '4:2');
  circle.fills = [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] }];
  let g = run(output);
  assert.deepEqual([g.needsIsland.includes('4:1'), kinds(g, '4:2')], [false, []]);
  assert.match(decodeURIComponent(g.html.match(/data-mask="4:2"[^>]*mask-image:url\(&quot;data:image\/svg\+xml,([^&]+)&quot;/)[1]), /<g fill-opacity="1">/);
  circle.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }];
  assert.equal(run(output).needsIsland.includes('4:1'), false, 'An opaque lower fill composites to alpha 1');
  circle.fills[1].type = 'IMAGE';
  assert.equal(run(output).needsIsland.includes('4:1'), false);
  circle.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }, { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }];
  assert.match(decodeURIComponent(run(output).html.match(/data-mask="4:2"[^>]*mask-image:url\(&quot;data:image\/svg\+xml,([^&]+)&quot;/)[1]), /<g fill-opacity="0\.75">/);

  // Empty unfilled/unstroked nodes do not cast shadows; unfilled groups with children use content shape; behind-node box shadows require approximation.
  const shadow = { type: 'DROP_SHADOW', visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: true };
  Object.assign(find(output.root, '4:14'), { fills: [], effects: [shadow] });
  Object.assign(find(output.root, '4:1'), { effects: [shadow] });
  find(output.root, '4:24').effects[0].showShadowBehindNode = true;
  g = run(output);
  assert.doesNotMatch(style(g.html, '4:14'), /shadow/);
  assert.match(style(g.html, '4:1'), /filter:drop-shadow\(0px 2px 2px rgba\(0,0,0,0\.25\)\)$/);
  assert.ok(kinds(g, '4:24').includes('shadow-behind'));
  // Backdrop-dependent nodes inside translucent groups can sample only group contents in CSS; smooth corners fall back to circular arcs.
  find(output.root, '4:8').blendMode = 'MULTIPLY';
  find(output.root, '4:5').cornerSmoothing = 0.6;
  g = run(output);
  assert.deepEqual([kinds(g, '4:8'), kinds(g, '4:5')], [['isolation:opacity'], ['corner-smoothing']]);
});

// ── overrides ────────────────────────────────────────────────────────────
test('overrides support style replacement/deletion, basis checks, missing/skip/unrendered nodes, missing SVG islands, and applied values on background-blur layers', async () => {
  const { output } = await extracted('1:2'), note = '\u6d4b\u8bd5';
  const overrides = {
    '2:4': { style: { transform: 'translate(1px,2px)', 'border-radius': '', filter: 'blur(1px)' }, basis: { transform: 'translate(0px,0px)', filter: '' }, note },
    '2:1': { style: { width: '9px' }, basis: { width: '11px' }, note },
    '9:9': { style: { width: '1px' }, note },
    '3:3': { skip: true, note },
    '3:4': { style: { width: '1px' }, note },
    '3:10': { style: { width: '1px' }, note },
    '2:6': { style: { width: '1px' }, note },
    '2:12': { bake: 'ref', note },
    '2:8': { bake: 'svg', note },
    '3:8': { style: { transform: 'translate(1px,1px)' }, note }
  };
  const r = run(output, { overrides });
  assert.equal(style(r.html, '2:4'), 'transform:translate(1px,2px);width:20px;height:20px;background:url("fac-asset:' + output.images.h1.bytes.sha256 + '") center/cover no-repeat;filter:blur(1px)');
  assert.match(style(r.html, '2:1'), /width:10px/, 'A mismatched basis rejects the entire override');
  assert.equal(tag(r.html, '3:5'), undefined);
  assert.equal(r.stats.skipped, 1);
  assert.match(r.html, /data-node="3:8" data-layer="backdrop" style="transform:translate\(1px,1px\);/);
  assert.deepEqual(r.overrides.applied, ['2:4', '2:8', '3:3', '3:8', '2:12']);
  assert.deepEqual(r.overrides.stale, [
    { node: '2:1', kind: 'changed', reason: 'width' }, { node: '9:9', kind: 'missing' }, { node: '3:4', kind: 'invalid', reason: 'not-emitted' },
    { node: '3:10', kind: 'invalid', reason: 'not-emitted' }, { node: '2:6', kind: 'invalid', reason: 'not-emitted' }]);
  assert.deepEqual([r.needsIsland, kinds(r, '2:8')], [['2:8'], ['needs-island:override']]);
  assert.equal(run(output, { overrides }).html, r.html, 'Repeated application is unchanged');
});

// -- Reference-crop baking ------------------------------------------------
// ref containers are .n elements after #canvas, using only translate and CSS-pixel size (integers at scale 1) with a placeholder img.
const refTag = (id, name, key, [x0, y0, x1, y1], k = 1) => `<div class="n" data-node="${id}" data-name="${name}" data-bake="ref" style="transform:translate(${x0 / k}px,${y0 / k}px);`
  + `width:${(x1 - x0) / k}px;height:${(y1 - y0) / k}px"><img src="fac-asset:${key}" alt="" style="width:100%;height:100%"></div>`;

test('bake:"ref" replaces subtrees with deterministic preorder placeholders after #canvas, reports epsilon-aware rectangles/share/bakedOver, and avoids ancestor transforms/opacity', async () => {
  const { output } = await extracted('1:3'), note = '\u73bb\u7483';
  find(output.root, '4:13').renderBounds = [74.99999999999, 45.00000000000023, 40, 20];
  const overrides = { '4:15': { bake: 'ref', note }, '4:6': { bake: 'ref', note }, '4:13': { bake: 'ref', note }, '4:8': { bake: 'ref', note } };
  const r = run(output, { overrides });
  assert.deepEqual(r.refs.map(x => [x.node, x.key, x.rect, x.share, x.bakedOver]), [
    ['4:6', 'ref0', [65, 20, 95, 50], 0.0352, ['4:7', '4:12']],
    ['4:8', 'ref1', [90, 2, 118, 30], 0.0306, ['4:9']],
    ['4:13', 'ref2', [75, 45, 115, 65], 0.0313, ['4:7', '4:19', '4:20']],
    ['4:15', 'ref3', [120, 45, 150, 75], 0.0352, ['4:7', '4:21']]], 'Preorder; floating noise adds no row/column; bakedOver lists outermost covered nodes, excluding ancestors, own subtree, and other refs');
  const tail = [['4:6', '\u6ea2\u51fa', [65, 20, 95, 50]], ['4:8', '\u7ec4\u5185\u7167\u7247', [90, 2, 118, 30]], ['4:13', '\u5bf9\u89d2\u6e10\u53d8', [75, 45, 115, 65]], ['4:15', '\u865a\u7ebf\u6846', [120, 45, 150, 75]]]
    .map(([id, name, rect], i) => refTag(id, name, 'ref' + i, rect)).join('');
  assert.ok(r.html.endsWith(`</div>${tail}</body></html>\n`), 'Final body children appear after #canvas');
  for (const id of ['4:6', '4:8', '4:13', '4:15', '4:14']) assert.equal(r.html.split(`data-node="${id}"`).length - 1, id === '4:14' ? 0 : 1, `${id} subtree is not generated`);
  assert.deepEqual([r.needsIsland.includes('4:15'), r.overrides.applied, r.overrides.stale, r.violations], [false, ['4:6', '4:8', '4:13', '4:15'], [], []]);
  assert.equal(run(structuredClone(output), { overrides }).html, r.html);
  // Replace placeholders using the same mechanism as bitmaps.
  assert.match(embed(r.html, { ref0: 'data:image/png;base64,AA' }).html, /<img src="data:image\/png;base64,AA" alt=""/);
});

test('Invalid refs include roots, missing/null/empty render bounds, and reference-size mismatch; refs inside skipped/island/ref subtrees still render with inside-ref handling', async () => {
  const { output } = await extracted('1:2'), note = 'n', ref = { bake: 'ref', note };
  find(output.root, '2:4').renderBounds = [170, 0, 20, 20];
  find(output.root, '2:15').renderBounds = [150, 150, 20, 20];
  const overrides = { '1:2': ref, '3:10': ref, '2:4': ref, '2:15': ref, '2:13': { skip: true, note }, '2:14': ref, '2:6': ref, '3:3': ref, '3:4': ref, '3:5': { skip: true, note },
    '3:1': ref, '3:2': { style: { width: '1px' }, note }, '2:8': ref, '2:10': { bake: 'svg', note } };
  const r = run(output, { overrides });
  assert.deepEqual(r.overrides.stale, [{ node: '1:2', kind: 'invalid', reason: 'root' }, { node: '3:10', kind: 'invalid', reason: 'no-render-bounds' },
    { node: '2:4', kind: 'invalid', reason: 'no-render-bounds' }, { node: '3:5', kind: 'invalid', reason: 'inside-ref' }, { node: '3:2', kind: 'invalid', reason: 'inside-ref' },
    { node: '2:10', kind: 'invalid', reason: 'inside-ref' }]);
  assert.deepEqual(r.refs.map(x => [x.node, x.rect]), [['2:6', [45, 0, 55, 10]], ['2:14', [60, 0, 70, 10]], ['2:8', [0, 30, 60, 50]], ['2:15', [150, 150, 160, 160]],
    ['3:1', [0, 60, 20, 80]], ['3:3', [30, 60, 80, 70]], ['3:4', [30, 60, 40, 70]]], 'Refs inside island 2:5, skipped 2:13, and ref 3:3 still render; clip out-of-bounds rectangles to the reference');
  assert.ok(tag(r.html, '2:4'), 'Invalid overrides do not apply and nodes generate normally');
  assert.deepEqual(r.needsIsland, [], 'SVG overrides inside ref subtrees do not enter needsIsland');
  // Reference/tree size mismatch invalidates all ref coordinates; differences within 1 px from fractional origins are allowed. Offline data may lack renderBounds.
  const off = structuredClone(output);
  off.reference.width = 161;
  assert.equal(run(off, { overrides }).refs.length, 7);
  off.reference.width = 162;
  const bad = run(off, { overrides });
  assert.deepEqual([bad.refs, bad.overrides.stale.filter(x => x.reason === 'reference-size').map(x => x.node)], [[], ['2:4', '2:15', '2:14', '2:6', '3:3', '3:4', '3:1', '2:8']]);
  walk(off.root, n => { delete n.renderBounds; });
  off.reference.width = 160;
  assert.deepEqual(run(off, { overrides: { '3:1': ref } }).overrides.stale, [{ node: '3:1', kind: 'invalid', reason: 'no-render-bounds' }]);
});

test('Ref rectangles round half pixels outward, clamp negative coordinates, reject zero width at the edge, handle scale 2 and reference dimensions, and ignore root effects/frozen nodes', async () => {
  const { output } = await extracted('1:2'), note = 'n', ref = { bake: 'ref', note };
  find(output.root, '2:4').renderBounds = [-2.5, -1.5, 5, 14];
  find(output.root, '2:15').renderBounds = [10.5, 110.5, 20, 20];
  find(output.root, '2:1').renderBounds = [160, 5, 8, 8];
  output.root.effects = [{ type: 'LAYER_BLUR', visible: true, radius: 4 }];
  const overrides = { '2:4': ref, '2:15': ref, '2:1': ref, '1:2': { style: { opacity: '0.5' }, note } };
  const r = run(output, { overrides });
  assert.deepEqual([r.refs.map(x => [x.node, x.rect, x.share]), r.overrides.stale], [[['2:4', [0, 0, 3, 13], 0.0015], ['2:15', [10, 110, 31, 131], 0.0172]],
    [{ node: '2:1', kind: 'invalid', reason: 'no-render-bounds' }]]);
  assert.match(r.html, /<div id="canvas"[^>]*style="[^"]*filter:blur\(2px\)[^"]*;opacity:0\.5"/);
  assert.ok(r.html.endsWith(`</div>${refTag('2:4', '\u7167\u7247', 'ref0', [0, 0, 3, 13])}${refTag('2:15', '\u9875\u811a', 'ref1', [10, 110, 31, 131])}</body></html>\n`),
    'Refs outside #canvas avoid root blur and override opacity');
  // At scale 2, rectangles use reference pixels while placement and size convert back to CSS pixels.
  const two = structuredClone(output);
  Object.assign(two, { scale: 2 });
  Object.assign(two.reference, { width: 320, height: 320 });
  const d = run(two, { overrides });
  assert.deepEqual(d.refs.map(x => [x.node, x.rect, x.share]), [['2:4', [0, 0, 5, 25], 0.0012], ['2:15', [21, 221, 61, 261], 0.0156]]);
  assert.ok(d.html.endsWith(`${refTag('2:4', '\u7167\u7247', 'ref0', [0, 0, 5, 25], 2)}${refTag('2:15', '\u9875\u811a', 'ref1', [21, 221, 61, 261], 2)}</body></html>\n`));
  // Missing reference width or mismatched height makes every ref report reference-size.
  for (const change of [ref => { delete ref.width; }, ref => { ref.height = 162; }]) {
    const off = structuredClone(output);
    change(off.reference);
    assert.deepEqual(run(off, { overrides }).overrides.stale.map(x => x.reason), ['reference-size', 'reference-size', 'reference-size']);
  }
  // bakedOver lists only nodes otherwise rendered as DOM: frozen node 2:10 inside ref 2:8 also disappears when skipped.
  const nest = (await extracted('1:2')).output;
  find(nest.root, '2:10').renderBounds = [35, 30, 10, 10];
  const over = o => run(nest, { overrides: o }).refs.map(x => [x.node, x.bakedOver]);
  assert.deepEqual(over({ '2:9': ref }), [['2:9', ['2:10']]]);
  assert.deepEqual(over({ '2:8': ref, '2:9': ref }), [['2:8', []], ['2:9', []]]);
  assert.deepEqual(over({ '2:9': ref, '2:10': { skip: true, note } }), [['2:9', []]]);
  // Ref subtrees replace content with reference pixels: once all blended descendants of group 3:3 are baked, it is no longer vetoed as an island.
  const isl = (await extracted('1:2')).output;
  isl.islands['3:3'] = 's0';
  isl.svgs.s0 = '<svg width="50" height="10"/>';
  assert.deepEqual(kinds(run(isl), '3:3'), ['island-vetoed']);
  const kept = run(isl, { overrides: { '3:4': ref, '3:5': ref, '3:6': ref } });
  assert.deepEqual([kinds(kept, '3:3'), kept.refs.length], [[], 3]);
  assert.match(kept.html, /data-node="3:3"[^>]*><svg width="50" height="10"\/><\/div>/);
});

// -- Explicit islands, font requests, and bitmap placeholders ---------------
test('Explicit SVG text inlines when supplied, otherwise records island-unavailable and generates DOM; fontRequests deduplicates/sorts, and embed/dataUri replace assets', async () => {
  const { output, bytes } = await extracted('1:3', { islands: ['4:24'] });
  assert.equal(output.islands['4:24'], 'b0');
  assert.equal(output.svgs.b0.type, 'svg');
  const text = Buffer.from(bytes[output.svgs.b0.sha256]).toString('utf8');
  assert.match(run(output, { svgs: { b0: text } }).html, /data-node="4:24" data-name="\u6295\u5f71" style="transform:translate\(70px,85px\);width:20px;height:20px"><svg data-node="4:24"\/><\/div>/);
  const missing = run(output);
  assert.deepEqual(kinds(missing, '4:24'), ['island-unavailable']);
  assert.match(style(missing.html, '4:24'), /box-shadow/);

  const reqs = fontRequests((await extracted('1:2')).output);
  assert.deepEqual(reqs.map(q => q.key), ['["Kanit-Light","Kanit","Light"]', '["PingFangSC-Regular","PingFang SC","Regular"]', '["SFProText-Bold","SF Pro Text","Bold"]', '[null,"Kanit","Regular"]']);
  assert.deepEqual(reqs[3], { key: '[null,"Kanit","Regular"]', family: 'Kanit', style: 'Regular' });

  const html = run(output, { svgs: { b0: text } }).html, uris = Object.fromEntries(Object.entries(bytes).map(([k, b]) => [k, dataUri('png', b)]));
  const done = embed(html, uris);
  assert.deepEqual(done.missing, []);
  assert.doesNotMatch(done.html, /fac-asset:/);
  assert.match(done.html, /url\(&quot;data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+&quot;\)/);
  assert.deepEqual(embed('<img src="fac-asset:ref0"><i style="background:url(&quot;fac-asset:abc&quot;)">fac-asset:abc fac-asset:zzz</i>', { abc: 'data:x' }),
    { html: '<img src="fac-asset:ref0"><i style="background:url(&quot;data:x&quot;)">fac-asset:abc fac-asset:zzz</i>', missing: ['ref0'] }, 'Matching text is neither replaced nor counted missing');
  // Placeholder-like frame titles/data-name, text, and font names are not replaced; escaping prevents them from producing style/src attributes.
  const named = (await extracted('1:2')).output, seg = find(named.root, '2:15').segments[0];
  named.root.name = 'url("fac-asset:zzz")';
  Object.assign(seg, { characters: 'url("fac-asset:zzz")', fontPostScriptName: 'x src="fac-asset:zzz"' });
  const raw = run(named).html, real = Object.fromEntries(Object.values(named.images).map(i => [i.bytes.sha256, 'data:x']));
  const kept = embed(raw, real);
  assert.deepEqual([kept.missing, raw.split('fac-asset:zzz').length - 1, kept.html.split('fac-asset:zzz').length - 1], [[], 4, 4]);
  assert.deepEqual(['jpg', 'svg', 'webp'].map(t => dataUri(t, new Uint8Array([1, 2, 3]))), ['data:image/jpeg;base64,AQID', 'data:image/svg+xml;base64,AQID', 'data:image/webp;base64,AQID']);
});
