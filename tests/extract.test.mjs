/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs/promises, node:os, node:path, node:vm, node:timers/promises, ./fixtures/html/doc.mjs, ./helpers/harness.mjs, ../src/bridge.mjs, ../src/project.mjs, ../src/session.mjs, ../src/record.mjs, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for extract; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { extractDoc, T } from './fixtures/html/doc.mjs';
import { fakeFigma, pluginSource, harness } from './helpers/harness.mjs';
import { start } from '../src/bridge.mjs';
import { init, root, json } from '../src/project.mjs';
import { pairingToken } from '../src/session.mjs';
import { localResult } from '../src/record.mjs';
import { encodePng, pngSize } from '../src/png.mjs';

const BINDING = { fileKey: 'example', nodeId: '1:2' };
const BINARY = '__figmaAgentControlBinary';
const plain = value => JSON.parse(JSON.stringify(value));
const find = (tree, id) => tree.id === id ? tree : (tree.children || []).map(c => find(c, id)).find(Boolean);
const walk = (tree, fn) => { fn(tree); for (const child of tree.children || []) walk(child, fn); };
// Expected automatic islands (islandRule 2): GLASS, background blur, and three blended subtrees yield to smaller pure-graphics subtrees; fully clipped 3:10 is excluded.
const AUTO = { '2:1': 's0', '2:5': 's1', '2:13': 's1', 'I2:12;4:1': 's2', '2:10': 's3', '3:2': 's4', '3:7': 's5', '3:9': 's6' };

// -- Plugin fixtures ------------------------------------------------------
// Read-only guard (design section 4.6): recursively proxy figma, nodes and Image. Guard writes through set, defineProperty and deleteProperty, except figma.skipInvisibleInstanceChildren
// allow only whitelisted own methods, excluding inherited methods such as array iteration. base64Encode is pure encoding needed for binary return values;
// figma.ui belongs to the plugin's own channel and is unguarded. Ignore calls before arm(), including load-time showUI.
// Write APIs absent from the mock (setPluginData/remove/resize, etc.) return undefined, so optional calls or try blocks could bypass method whitelisting; record violations by name on property access.
const READS = new Set(['exportAsync', 'getStyledTextSegments', 'getMainComponentAsync', 'getNodeByIdAsync', 'getImageByHash', 'getBytesAsync', 'getSizeAsync', 'loadAsync', 'on', 'off', 'base64Encode']);
const WRITES = /^(set|remove|resize|rescale|append|insert|create|scroll|loadAll|commit|flatten|group|ungroup|close)/;
function readOnly(figma, violations) {
  const state = { armed: false }, cache = new WeakMap();
  const deny = what => { if (!state.armed) return; violations.push(what); throw Error('Read-only guard: ' + what); };
  const wrap = value => {
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    if (typeof value.then === 'function') return value.then(wrap);
    if (!cache.has(value)) cache.set(value, new Proxy(value, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (target === figma && key === 'ui') return v;
        if (v === undefined && typeof key === 'string' && WRITES.test(key)) deny('call ' + key);
        if (typeof v !== 'function') return wrap(v);
        if (!Object.hasOwn(target, key)) return v;
        if (state.armed && !READS.has(key)) deny('call ' + String(key));
        return (...args) => wrap(v.apply(target, args));
      },
      set(target, key, v) { if (!(target === figma && key === 'skipInvisibleInstanceChildren')) deny('write ' + String(key)); return Reflect.set(target, key, v); },
      defineProperty(target, key, d) { deny('define ' + String(key)); return Reflect.defineProperty(target, key, d); },
      deleteProperty(target, key) { deny('delete ' + String(key)); return Reflect.deleteProperty(target, key); }
    }));
    return cache.get(value);
  };
  return { figma: wrap(figma), arm: () => { state.armed = true; } };
}

// Run real main.js in a VM, structured-clone responses, and unwrap envelopes. events records approvals, checkpoints, Undo boundaries, and page switches.
function plugin(setup = () => {}, { guard = false } = {}) {
  const doc = extractDoc(), events = [], results = [], violations = [];
  const figma = Object.assign(fakeFigma(doc, { onUi: raw => {
    let message = structuredClone(raw);
    if (message.type === 'serialized-result') message = JSON.parse(message.serialized);
    if (['checkpoint', 'approval-request'].includes(message.type)) events.push(message.type); else results.push(message);
  } }), doc.globals);
  figma.commitUndo = () => events.push('undo');
  figma.setCurrentPageAsync = async page => { events.push('setCurrentPage'); figma.currentPage = page; };
  figma.viewport = { center: { x: 0, y: 0 }, zoom: 1, scrollAndZoomIntoView() {} };
  setup({ doc, figma });
  const shield = guard ? readOnly(figma, violations) : null;
  vm.runInNewContext(pluginSource, { figma: shield?.figma ?? figma, __html__: '', setTimeout: () => 0, clearTimeout() {} });
  shield?.arm();
  let seq = 0;
  const send = async job => {
    const id = `job-${++seq}`;
    await figma.ui.onmessage({ id, channelNonce: 'n' + seq, operation: 'extract', binding: BINDING, ...job });
    return results.find(r => r.id === id);
  };
  return { doc, figma, events, violations, send, guarded: shield?.figma, exported: () => plain(doc.exports) };
}
const svgOf = (r, id) => Buffer.from(r.binaries[r.output.svgs[r.output.islands[id]][BINARY]], 'base64').toString('utf8');
// Document structure without functions or parent links must remain identical across read-only tasks.
const dump = doc => JSON.stringify([...doc.all.values()].map(({ parent, children, ...n }) => ({ ...n, children: children?.map(c => c.id) })));

// -- Read-only behavior ---------------------------------------------------
test('Read-only guard observes no writes or unapproved calls, approvals/checkpoints/Undo/page switches; document and global flag are restored and nodechange listeners removed', async () => {
  const other = { id: '5:1', type: 'PAGE', name: '\u7528\u6237\u6b63\u5728\u770b\u7684\u9875' };
  const f = plugin(({ figma }) => { figma.currentPage = other; }, { guard: true });
  const before = dump(f.doc);
  const r = await f.send({ islands: ['2:9'], scale: 2 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(f.violations, []);
  assert.deepEqual(f.events, []);
  assert.equal(f.figma.currentPage, other);
  assert.equal(f.figma.skipInvisibleInstanceChildren, false);
  assert.equal(f.doc.listeners.size, 0);
  assert.equal(dump(f.doc), before);
  assert.equal(r.executionStarted, undefined);
  assert.deepEqual(r.bindingVerified, { fileKey: 'example', pageId: '1:1', nodeId: '1:2' });
  // Prove the guard catches non-whitelisted calls, node/paint writes, and missing write APIs, including optional calls.
  assert.throws(() => f.guarded.setCurrentPageAsync(other), /Read-only guard/);
  const frame = await f.guarded.getNodeByIdAsync('1:2');
  assert.throws(() => { frame.name = '\u6539\u540d'; }, /Read-only guard/);
  assert.throws(() => { frame.fills[0].color.r = 0; }, /Read-only guard/);
  assert.throws(() => frame.setPluginData?.('k', 'v'), /Read-only guard/);
  assert.throws(() => f.guarded.viewport.scrollAndZoomIntoView([frame]), /Read-only guard/);
  assert.throws(() => f.guarded.loadAllPagesAsync?.(), /Read-only guard/);
  assert.deepEqual(f.violations, ['call setCurrentPageAsync', 'write name', 'write r', 'call setPluginData', 'call scrollAndZoomIntoView', 'call loadAllPagesAsync']);
});

test('Hidden layers and their bitmaps are excluded; traversal enables skipInvisibleInstanceChildren and restores it on success or failure', async () => {
  const seen = [];
  const f = plugin(({ doc, figma }) => { doc.all.get('2:9').getStyledTextSegments = () => { seen.push(figma.skipInvisibleInstanceChildren); return []; }; });
  const r = await f.send({});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(seen, [true]);
  assert.equal(find(r.output.root, '2:11'), undefined);
  assert.equal(f.exported().some(e => e.image === 'h2'), false);
  assert.equal(f.figma.skipInvisibleInstanceChildren, false);
  const failing = plugin(({ doc }) => { doc.frame.exportAsync = async () => { throw Error('\u5bfc\u51fa\u5931\u8d25'); }; });
  const failed = await failing.send({});
  assert.equal(failed.ok, false);
  assert.equal(failed.executionStarted, false);
  assert.equal(failing.figma.skipInvisibleInstanceChildren, false);
  assert.equal(failing.doc.listeners.size, 0);
  // Failed nodechange registration becomes a warning; failed unregistration also must not leave the flag true.
  const deaf = plugin(({ doc }) => { doc.page.on = () => { throw Error('unsupported event'); }; });
  const heard = await deaf.send({});
  assert.equal(heard.ok, true, heard.error);
  assert.match(heard.output.warnings.join('\n'), /nodechange listener unavailable.*unsupported event/);
  assert.equal(deaf.figma.skipInvisibleInstanceChildren, false);
  const stuck = plugin(({ doc }) => { doc.page.off = () => { throw Error('off failed'); }; });
  assert.equal((await stuck.send({})).ok, true);
  assert.equal(stuck.figma.skipInvisibleInstanceChildren, false);
});

// -- Node tree ------------------------------------------------------------
test('Node trees preserve target-space transforms, mask geometry, renderBounds/null, expanded mixed values, text segments, instance provenance, SLOT, and boundVariables', async () => {
  const r = await plugin().send({});
  const { root: tree, schema, islandRule, colorProfile, scale } = r.output;
  assert.deepEqual([schema, islandRule, colorProfile, scale], [1, 2, 'SRGB', 1]);
  assert.deepEqual(tree.transform, T(0, 0));
  assert.equal(tree.fills.length, 1, 'Invisible fills are discarded');
  assert.equal(tree.clipsContent, true);
  assert.deepEqual(find(tree, '2:1').transform, T(15, 5, -1, 0, 0, 1));
  assert.deepEqual(find(tree, '2:1').renderBounds, [5, 5, 10, 10]);
  walk(tree, n => assert.ok('renderBounds' in n, n.id));
  const mask = find(tree, '2:3');
  assert.deepEqual([mask.isMask, mask.maskType, mask.renderBounds], [true, 'ALPHA', null]);
  assert.deepEqual(mask.fillGeometry, [{ windingRule: 'NONZERO', data: 'M0 0 L20 0 L20 20 L0 20 Z' }]);
  assert.equal(find(tree, '3:10').renderBounds, null);
  assert.deepEqual([find(tree, '2:4').cornerRadius, find(tree, '2:4').topLeftRadius, find(tree, '2:4').bottomLeftRadius], ['MIXED', 4, 0]);
  const row = find(tree, '2:8');
  assert.deepEqual([row.strokeWeight, row.strokeTopWeight, row.strokeLeftWeight, row.layoutMode, row.itemSpacing], ['MIXED', 1, 0, 'HORIZONTAL', 4]);
  assert.equal(find(tree, '2:10').layoutSizingHorizontal, 'FIXED');
  const label = find(tree, '2:9');
  assert.equal(label.fills, 'MIXED');
  assert.equal(label.fillGeometry, undefined);
  assert.deepEqual(label.segments.map(s => [s.characters, s.fontName.family, s.lineHeight.unit]), [['Hi ', 'SF Pro Text', 'AUTO'], ['\u4f60\u597d', 'PingFang SC', 'PIXELS']]);
  assert.deepEqual(find(tree, '2:12').component, { id: '9:1', name: 'State=Default', key: 'k1', remote: false, set: 'Button' });
  assert.deepEqual(find(tree, '2:12').componentProperties, { 'Label#1:2': { type: 'TEXT', value: 'OK' } });
  const slot = find(tree, 'I2:12;4:1');
  assert.deepEqual([slot.type, slot.layoutMode, slot.children.map(c => c.id)], ['SLOT', 'HORIZONTAL', ['I2:12;4:1;4:2']]);
  // Omit node-level boundVariables; preserve those inside paints, effects, and segment fills.
  assert.equal(find(tree, '2:1').boundVariables, undefined);
  assert.deepEqual(find(tree, '2:1').fills[0].boundVariables, { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' } });
  assert.equal(find(tree, '3:1').effects[0].boundVariables.radius.type, 'VARIABLE_ALIAS');
  assert.equal(label.segments[0].fills[0].boundVariables.color.id, 'VariableID:1:2');

  // GROUP masks lack fillGeometry. Failed provenance reads become componentError; unsupported full segment fields fall back to basic fields without failing extraction.
  const odd = plugin(({ doc }) => {
    Object.assign(doc.all.get('2:5'), { isMask: true, maskType: 'ALPHA', absoluteRenderBounds: null });
    Object.defineProperty(doc.all.get('2:12'), 'componentProperties', { get() { throw Error('Component set for node has existing errors'); } });
    const text = doc.all.get('2:9'), segments = text.getStyledTextSegments;
    text.getStyledTextSegments = fields => { if (fields.length > 7) throw Error('unknown field'); return segments(fields); };
  });
  const o = await odd.send({});
  assert.equal(o.ok, true, o.error);
  assert.deepEqual([find(o.output.root, '2:5').isMask, find(o.output.root, '2:5').maskType, 'fillGeometry' in find(o.output.root, '2:5')], [true, 'ALPHA', false]);
  assert.deepEqual([find(o.output.root, '2:12').component.id, find(o.output.root, '2:12').componentProperties], ['9:1', undefined]);
  assert.match(find(o.output.root, '2:12').componentError, /existing errors/);
  assert.match(o.output.warnings.join('\n'), /Some text segment fields are unavailable; fell back to base fields: Error: unknown field/);
  assert.deepEqual(find(o.output.root, '2:15').segments.map(s => s.characters), ['A', 'B']);
  // A stroked shape missing strokeGeometry fails the whole frame rather than silently losing geometry; main.js reads it without an in check.
  const bare = await plugin(({ doc }) => { const n = doc.all.get('3:7'); n.strokes = [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0 } }]; delete n.strokeGeometry; }).send({});
  assert.deepEqual([bare.ok, bare.executionStarted], [false, false]);
});

// -- Islands --------------------------------------------------------------
test('Automatic islands select and deduplicate maximal pure-graphics subtrees, descend into backdrop-dependent roots, exclude fully clipped nodes, treat path text as text, and export sRGB SVG_STRING', async () => {
  const f = plugin();
  const r = await f.send({});
  assert.deepEqual(r.output.islands, AUTO);
  assert.deepEqual(Object.keys(r.output.svgs), ['s0', 's1', 's2', 's3', 's4', 's5', 's6']);
  assert.equal(r.output.svgs.s1, '<svg data-shape="icon"/>');
  for (const id of ['3:1', '3:3', '3:4', '3:5', '3:6', '3:8', '3:10']) assert.equal(id in r.output.islands, false, id);
  const svgs = f.exported().filter(e => e.format === 'SVG_STRING');
  assert.deepEqual([...new Set(svgs.map(e => e.id))], Object.keys(AUTO));
  for (const e of svgs) assert.deepEqual([e.svgOutlineText, e.svgSimplifyStroke, e.svgIdAttribute, e.colorProfile], [false, false, false, 'SRGB'], e.id);
  assert.deepEqual(r.output.islandsSkipped, []);
  assert.equal(r.output.stats.svgSrgb, true);
  // The target itself is not an island; continue descending even when it is a pure-graphics subtree.
  assert.deepEqual(Object.keys((await plugin().send({ targetNodeId: '2:5' })).output.islands), ['2:6', '2:7']);
  // Path text counts as text, preventing its group from becoming an island while leaving a neighboring vector eligible.
  const path = await plugin(({ doc }) => { doc.all.get('2:7').type = 'TEXT_PATH'; }).send({});
  assert.deepEqual(['2:5' in path.output.islands, '2:6' in path.output.islands, '2:7' in path.output.islands], [false, true, false]);
});

test('Explicit islands follow automatic ones using binary SVG exports without duplicate automatic exports; hidden, out-of-subtree, and fully clipped nodes enter islandsSkipped', async () => {
  const f = plugin();
  const r = await f.send({ islands: ['2:9', '2:5', '2:11', '3:10', '9:9'] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.output.islands, { ...AUTO, '2:9': 'b0' });
  assert.deepEqual(r.output.svgs.b0, { [BINARY]: 2 }, 'Third binary after the reference image and bitmap');
  assert.equal(svgOf(r, '2:9'), '<svg data-node="2:9"/>');
  assert.deepEqual(f.exported().filter(e => e.id === '2:9').map(e => [e.format, e.colorProfile]), [['SVG', 'SRGB']]);
  assert.equal(f.exported().filter(e => e.id === '2:5').length, 1);
  assert.deepEqual(r.output.islandsSkipped, ['2:11', '3:10', '9:9']);
  assert.ok(r.output.warnings.includes('Island node is not in the visible subtree of the target; skipped: 2:11'));
  assert.ok(r.output.warnings.includes('Island node has no rendered content (fully clipped, a mask, or opacity 0); skipped: 3:10'));
  assert.ok(r.output.warnings.includes('Island node is not in the visible subtree of the target; skipped: 9:9'));
  assert.deepEqual([r.output.stats.islands, r.output.stats.svgs], [9, 8]);

  // If an automatic island export fails and is also explicit, retry through the explicit path; explicit failure also enters islandsSkipped.
  const flaky = plugin(({ doc }) => {
    for (const [id, format] of [['2:5', 'SVG_STRING'], ['2:9', 'SVG']]) {
      const n = doc.all.get(id), original = n.exportAsync;
      n.exportAsync = async options => { if (options.format === format) throw Error('export failed'); return original(options); };
    }
  });
  const g = await flaky.send({ islands: ['2:5', '2:9'] });
  assert.equal(g.ok, true, g.error);
  assert.deepEqual([g.output.islands['2:5'], g.output.islands['2:9'], g.output.islandsSkipped], ['b0', undefined, ['2:9']]);
  assert.ok(g.output.warnings.includes('Island 2:9 export failed: Error: export failed'));
});

test('sRGB fallback occurs only when export fails with the option but succeeds without it; two failures report export failure without changing the global flag, and failed reference export fails the task', async () => {
  const fallback = plugin(({ doc }) => {
    const n = doc.all.get('I2:12;4:1'), original = n.exportAsync;
    n.exportAsync = async options => { if (options.colorProfile) throw Error('colorProfile unsupported'); return original(options); };
  });
  const a = await fallback.send({});
  assert.equal(a.output.stats.svgSrgb, false);
  assert.match(a.output.warnings.join('\n'), /SVG export in sRGB failed.*colorProfile unsupported/);
  assert.deepEqual(a.output.islands, AUTO);
  const after = fallback.exported().filter(e => e.format === 'SVG_STRING' && ['2:10', '3:2', '3:7', '3:9'].includes(e.id));
  assert.ok(after.length === 4 && after.every(e => e.colorProfile === undefined), 'Fallback no longer includes colorProfile');

  const broken = plugin(({ doc }) => { doc.all.get('2:5').exportAsync = async () => { throw Error('may not have any visible layers'); }; });
  const b = await broken.send({});
  assert.equal(b.output.stats.svgSrgb, true);
  assert.ok(b.output.warnings.includes('Island 2:5 export failed: Error: may not have any visible layers'));
  assert.doesNotMatch(b.output.warnings.join('\n'), /sRGB/);
  assert.equal('2:5' in b.output.islands, false);
  assert.ok(broken.exported().filter(e => e.format === 'SVG_STRING').every(e => e.colorProfile === 'SRGB'));

  const reference = plugin(({ doc }) => {
    const original = doc.frame.exportAsync;
    doc.frame.exportAsync = async options => { if (options.format === 'PNG' && options.colorProfile) throw Error('colorProfile unsupported'); return original(options); };
  });
  const c = await reference.send({});
  assert.equal(c.ok, true, c.error);
  assert.match(c.output.warnings.join('\n'), /Reference image export in sRGB failed/);
  assert.equal(c.output.stats.svgSrgb, true);
  const lost = plugin(({ doc }) => {
    const original = doc.frame.exportAsync;
    doc.frame.exportAsync = async options => { if (options.format === 'PNG') throw Error('render failed'); return original(options); };
  });
  const d = await lost.send({});
  assert.deepEqual([d.ok, d.executionStarted], [false, false]);
  assert.match(d.error, /render failed/);
});

test('Reference PNGs use sRGB, node size, and scale; each imageHash is read once and binaries return placeholders', async () => {
  const f = plugin();
  const r = await f.send({ scale: 2 });
  assert.deepEqual(f.exported().find(e => e.format === 'PNG'), { id: '1:2', format: 'PNG', constraint: { type: 'SCALE', value: 2 }, useAbsoluteBounds: true, colorProfile: 'SRGB' });
  assert.deepEqual(f.exported().filter(e => e.image), [{ image: 'h1' }]);
  assert.equal(r.binaries.length, 2);
  assert.deepEqual(r.output.reference, { [BINARY]: 0 });
  assert.deepEqual(r.output.images.h1, { bytes: { [BINARY]: 1 }, width: 1, height: 1 });
  assert.deepEqual(pngSize(Buffer.from(r.binaries[0], 'base64')), { width: 320, height: 320 });
  assert.equal(r.output.scale, 2);
  // Rejected bitmap reads, such as pending downloads, are skipped with warnings like missing handles; the host falls back to DOM.
  const offline = plugin();
  offline.figma.getImageByHash = () => ({ getBytesAsync: async () => { throw Error('Image could not be downloaded'); }, getSizeAsync: async () => ({ width: 1, height: 1 }) });
  const o = await offline.send({});
  assert.equal(o.ok, true, o.error);
  assert.deepEqual([o.output.images, o.binaries.length], [{}, 1]);
  assert.ok(o.output.warnings.includes('Bitmap unavailable: h1: Error: Image could not be downloaded'));
});

// -- Segment metrics, warnings, and statistics -----------------------------
test('Segment lineHeightPx uses PIXELS directly or PERCENT of font size; AUTO and PostScript names use REST overrides, omitting unresolved keys with counts/warnings', async () => {
  const segs = (r, id) => find(r.output.root, id).segments.map(s => [s.lineHeightPx, s.fontPostScriptName]);
  const f = plugin();
  const r = await f.send({});
  // Real JSON_REST_V1-shaped overrides change the font and size without lineHeightPx; AUTO segments cannot reuse the base style's 17.90.
  assert.deepEqual(segs(r, '2:9'), [[undefined, 'SFProText-Bold'], [18, 'PingFangSC-Regular']]);
  assert.deepEqual(segs(r, '2:15'), [[19.434999465942383, 'Kanit-Light'], [undefined, undefined]]);
  assert.deepEqual([r.output.stats.lineHeightMissing, r.output.stats.postScriptMissing], [2, 1]);
  assert.match(r.output.warnings.join('\n'), /2 text segment\(s\) have no lineHeightPx/);
  assert.match(r.output.warnings.join('\n'), /1 text segment\(s\) have no fontPostScriptName/);
  assert.doesNotMatch(r.output.warnings.join('\n'), /do not match the JSON_REST_V1 override table in family, style or size/);
  assert.equal(f.exported().filter(e => e.format === 'JSON_REST_V1').length, 1);

  // Failed REST export still writes PIXELS height but omits AUTO height and font names.
  const failing = plugin(({ doc }) => {
    const original = doc.frame.exportAsync;
    doc.frame.exportAsync = async options => { if (options.format === 'JSON_REST_V1') throw Error('unsupported format'); return original(options); };
  });
  const failed = await failing.send({});
  assert.equal(failed.ok, true, failed.error);
  assert.deepEqual([segs(failed, '2:9'), segs(failed, '2:15')], [[[undefined, undefined], [18, undefined]], [[undefined, undefined], [undefined, undefined]]]);
  assert.deepEqual([failed.output.stats.lineHeightMissing, failed.output.stats.postScriptMissing], [3, 4]);
  assert.match(failed.output.warnings.join('\n'), /JSON_REST_V1 export failed/);

  // Color-only overrides inherit both base values; align the B segment to Light. PERCENT derives from font size without REST.
  const varied = plugin(({ doc }) => {
    const footer = doc.all.get('2:15'), [a, b] = footer.getStyledTextSegments();
    footer.rest.styleOverrideTable = { 3: { fills: [] } };
    footer.getStyledTextSegments = () => [a, { ...b, fontName: { family: 'Kanit', style: 'Light' } }];
    const label = doc.all.get('2:9'), [hi, cjk] = label.getStyledTextSegments();
    label.getStyledTextSegments = () => [hi, { ...cjk, lineHeight: { unit: 'PERCENT', value: 130 } }];
  });
  const v = await varied.send({});
  assert.deepEqual([segs(v, '2:15'), segs(v, '2:9')[1], v.output.stats.lineHeightMissing, v.output.stats.postScriptMissing],
    [[[19.434999465942383, 'Kanit-Light'], [19.434999465942383, 'Kanit-Light']], [15.6, 'PingFangSC-Regular'], 1, 0]);

  // Text-free subtrees do not request REST export.
  const noText = plugin();
  const icons = await noText.send({ targetNodeId: '3:3' });
  assert.equal(icons.ok, true, icons.error);
  assert.equal(noText.exported().some(e => e.format === 'JSON_REST_V1'), false);
  assert.deepEqual([icons.output.stats.lineHeightMissing, icons.output.stats.postScriptMissing], [0, 0]);
});

test('Segment mapping aligns code-point override indexes with UTF-16 start/end offsets, rejects mismatched family/style/size, and guards every metric/font-affecting key', async () => {
  const BOLD = { fontFamily: 'Kanit', fontPostScriptName: 'Kanit-Bold', fontStyle: 'Bold', fontWeight: 700 };
  // Each segment is [characters, line-height unit, size, style], concatenated into text 2:9. Base Kanit Medium 28 has AUTO height 28 * 1.495; style can override fields.
  // Extract only row 2:8 containing 2:9 so statistics cover one text node. Return [lineHeightPx, fontPostScriptName] per segment; last retains output.
  let last;
  const run = async (parts, overrides, table, style = {}) => {
    let text = '';
    const list = parts.map(([characters, unit, fontSize = 28, face = 'Medium']) => ({ characters, start: text.length, end: (text += characters).length,
      fontName: { family: 'Kanit', style: face }, fontSize, lineHeight: unit === 'PIXELS' ? { unit, value: 28 } : { unit } }));
    const base = { fontFamily: 'Kanit', fontStyle: 'Medium', fontPostScriptName: 'Kanit-Medium', fontSize: 28, lineHeightPx: 41.86, ...style };
    const r = await plugin(({ doc }) => Object.assign(doc.all.get('2:9'), { characters: text, getStyledTextSegments: () => list,
      rest: { style: base, characterStyleOverrides: overrides, styleOverrideTable: table } })).send({ targetNodeId: '2:8' });
    last = r.output;
    return find(r.output.root, '2:9').segments.map(s => [s.lineHeightPx, s.fontPostScriptName]);
  };
  // Real-device sample: two emoji followed by AB, with only B at size 48, gives overrides [0,0,0,1]; both segments use PIXELS 28.
  assert.deepEqual(await run([['😀😀A', 'PIXELS'], ['B', 'PIXELS', 48]], [0, 0, 0, 1], { 1: { fontSize: 48 } }), [[28, 'Kanit-Medium'], [28, 'Kanit-Medium']]);
  // The same shape with AUTO cannot match either segment if indexed by code units, so no values resolve.
  assert.deepEqual(await run([['😀😀A', 'AUTO'], ['B', 'AUTO', 48]], [0, 0, 0, 1], { 1: { fontSize: 48 } }), [[41.86, 'Kanit-Medium'], [undefined, 'Kanit-Medium']]);
  // Cover overridden emoji and emoji after an override, with trailing zero entries omitted.
  assert.deepEqual(await run([['A', 'AUTO'], ['😀', 'AUTO', 28, 'Bold'], ['B', 'AUTO']], [0, 1, 0], { 1: BOLD }), [[41.86, 'Kanit-Medium'], [undefined, 'Kanit-Bold'], [41.86, 'Kanit-Medium']]);
  assert.deepEqual(await run([['A', 'AUTO'], ['B', 'AUTO', 28, 'Bold'], ['😀😀', 'AUTO']], [0, 1], { 1: BOLD }), [[41.86, 'Kanit-Medium'], [undefined, 'Kanit-Bold'], [41.86, 'Kanit-Medium']]);
  // Non-emoji U+20000 is one code point; e + U+0301 is two. This is inferred: real-device verification covered emoji only.
  assert.deepEqual(await run([['\u{20000}e\u0301', 'AUTO'], ['X', 'AUTO', 28, 'Bold']], [0, 0, 0, 1], { 1: BOLD }), [[41.86, 'Kanit-Medium'], [undefined, 'Kanit-Bold']]);
  assert.equal(last.warnings.some(w => /do not match the JSON_REST_V1 override table in family, style or size/.test(w)), false);
  // Inconsistent character values within a segment omit both fields.
  assert.deepEqual(await run([['AB', 'AUTO', 28, 'Bold']], [1, 2], { 1: BOLD, 2: { ...BOLD, fontPostScriptName: 'Kanit-Black' } }), [[undefined, undefined]]);

  // A skin-tone emoji is two code points but one grapheme: code-point overrides resolve B to Kanit-Bold; grapheme-indexed [0,0,1] matches neither segment, so omit and warn rather than guess.
  assert.deepEqual(await run([['👍🏽A', 'AUTO'], ['B', 'AUTO', 28, 'Bold']], [0, 0, 0, 1], { 1: BOLD }), [[41.86, 'Kanit-Medium'], [undefined, 'Kanit-Bold']]);
  assert.deepEqual(await run([['👍🏽A', 'AUTO'], ['B', 'AUTO', 28, 'Bold']], [0, 0, 1], { 1: BOLD }), [[undefined, undefined], [undefined, undefined]]);
  assert.deepEqual([last.stats.lineHeightMissing, last.stats.postScriptMissing], [2, 2]);
  assert.ok(last.warnings.includes('2 text segment(s) do not match the JSON_REST_V1 override table in family, style or size (the table may not count by code point); REST values are not used for these segments'));
  // Match a real-device sample where only B changes to size 48: grapheme indexing leaves only the size mismatched, still excluding both segments.
  assert.deepEqual(await run([['👍🏽A', 'AUTO'], ['B', 'AUTO', 48]], [0, 0, 1], { 1: { fontSize: 48 } }), [[undefined, undefined], [undefined, undefined]]);
  // An override family differing from its segment does not match.
  assert.deepEqual(await run([['A', 'AUTO']], [1], { 1: { fontFamily: 'Inter', fontPostScriptName: 'Inter-Medium' } }), [[undefined, undefined]]);
  // PIXELS does not depend on REST: mismatches still preserve line height and omit only the font name.
  assert.deepEqual(await run([['👍🏽A', 'PIXELS'], ['B', 'PIXELS', 28, 'Bold']], [0, 0, 1], { 1: BOLD }), [[28, undefined], [28, undefined]]);
  // An override index referencing a nonexistent entry does not match.
  assert.deepEqual(await run([['A', 'AUTO']], [9], {}), [[undefined, undefined]]);

  // Explicit override keys may equal base values but omit the value being read: height/font keys block inherited height, font keys block inherited names; color-only changes inherit both.
  const keys = [{ lineHeightUnit: 'INTRINSIC_%' }, { italic: false }, { semanticWeight: 'NORMAL' }, { fontFamily: 'Kanit' }, { fontStyle: 'Medium' }, { fontWeight: 500 }, { fills: [] }];
  assert.deepEqual(await run(keys.map(() => ['a', 'AUTO']), keys.map((_, i) => i + 1), Object.fromEntries(keys.map((entry, i) => [i + 1, entry]))),
    [[undefined, 'Kanit-Medium'], [undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], [41.86, 'Kanit-Medium']]);
  // A null REST fontPostScriptName is omitted.
  assert.deepEqual(await run([['A', 'AUTO']], [], {}, { fontPostScriptName: null }), [[41.86, undefined]]);
});

test('nodechange during extraction sets documentChangedDuringExtract; stats include nodes, islands, SVGs, bitmaps, timing, sRGB fallback, and missing text metrics', async () => {
  const f = plugin(({ doc }) => {
    const n = doc.all.get('2:10'), original = n.exportAsync;
    n.exportAsync = async options => { await delay(15); doc.emit(); return original(options); };
    const instance = doc.all.get('2:12'), main = instance.getMainComponentAsync;
    instance.getMainComponentAsync = async () => { await delay(15); return main(); };
  });
  const r = await f.send({});
  assert.equal(r.ok, true, r.error);
  assert.match(r.output.warnings.join('\n'), /^documentChangedDuringExtract: /m);
  const { svgMs, componentMs, ...stats } = r.output.stats;
  assert.deepEqual(stats, { nodes: 27, islands: 8, svgs: 7, images: 1, svgSrgb: true, lineHeightMissing: 2, postScriptMissing: 1 });
  assert.ok(svgMs >= 10 && componentMs >= 10, JSON.stringify(r.output.stats));
  assert.equal(f.doc.listeners.size, 0);
  const quiet = await plugin().send({});
  assert.doesNotMatch(quiet.output.warnings.join('\n'), /documentChangedDuringExtract/);
});

// -- Limits ---------------------------------------------------------------
test('Exceeding 200 binaries, 48 MB including explicit islands, estimated 12 MB UTF-8 structure, or 10000 visible nodes fails with extract-specific guidance; targets cannot be pages or hidden', async () => {
  const many = plugin(({ doc }) => { doc.all.get('2:4').fills = Array.from({ length: 200 }, (_, i) => ({ type: 'IMAGE', visible: true, imageHash: 'h1' + i })); });
  many.figma.getImageByHash = () => ({ getBytesAsync: async () => new Uint8Array(8), getSizeAsync: async () => ({ width: 1, height: 1 }) });
  const count = await many.send({});
  assert.deepEqual([count.ok, count.executionStarted], [false, false]);
  assert.match(count.error, /Reference image, bitmaps and explicit islands exceed 200 items or 48 MB.*--node/);
  assert.equal(many.figma.skipInvisibleInstanceChildren, false);

  const big = plugin(({ doc }) => { doc.all.get('2:9').exportAsync = async () => new Uint8Array(37 * 1024 * 1024); });
  const size = await big.send({ islands: ['2:9'] });
  assert.equal(size.ok, false);
  assert.match(size.error, /exceed 200 items or 48 MB.*--scale/);

  // 4.2 million CJK code units are below 12 million characters but approximately 12.6 MB at the UTF-8 upper bound.
  const text = '\u4e2d'.repeat(2.1e6);
  const cjk = plugin(({ doc }) => {
    const n = doc.all.get('2:9');
    Object.assign(n, { characters: text, getStyledTextSegments: () => [{ characters: text, start: 0, end: text.length, fontSize: 12 }], rest: undefined });
  });
  const utf8 = await cjk.send({});
  assert.equal(utf8.ok, false);
  assert.match(utf8.error, /Extract result exceeds 12 MB \(UTF-8 estimate\): narrow the target with --node/);

  const wide = plugin(({ doc }) => { doc.frame.children.push(...Array.from({ length: 10000 }, (_, i) => ({ id: '8:' + i, type: 'RECTANGLE', name: '\u65b9\u5757', visible: true,
    width: 1, height: 1, absoluteTransform: T(100, 200), absoluteRenderBounds: null, parent: doc.frame }))); });
  const nodes = await wide.send({});
  assert.deepEqual([nodes.ok, nodes.executionStarted], [false, false]);
  assert.match(nodes.error, /Extract exceeds 10000 visible nodes: narrow the target with --node/);
  assert.equal(wide.figma.skipInvisibleInstanceChildren, false);

  const page = await plugin().send({ targetNodeId: '1:1', binding: { fileKey: 'example', nodeId: '1:1' } });
  assert.match(page.error, /not a page/);
  assert.match((await plugin().send({ targetNodeId: '2:11' })).error, /Extract target is not visible/);
});

// -- Bridge layer ---------------------------------------------------------
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function bridge(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-extract-'));
  await init(cwd, 'https://www.figma.com/design/example/Test?node-id=1-2');
  // Inject a fixed connection clock so leases expire only with b.clock, independent of execution speed.
  const b = { cwd, home: path.join(cwd, 'plugin-home'), clock: 0, run: id => path.join(root(cwd), 'runs', id) };
  b.boot = async () => {
    b.pairing = await pairingToken(b.home);
    b.bridge = await start(cwd, 0, { now: () => b.clock, pollHoldMs: 0, pluginToken: b.pairing });
    b.token = (await json(path.join(root(cwd), 'session.json'))).token;
  };
  await b.boot();
  t.after(async () => { await b.bridge.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  const send = async (route, headers, body) => {
    const response = await fetch(`http://127.0.0.1:${b.bridge.port}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  b.cli = (route, body) => send(route, { 'X-Session-Token': b.token }, body);
  b.plugin = (route, body) => send(route, { 'X-Session-Token': b.pairing, 'X-Plugin-Version': b.bridge.version }, body);
  b.poll = (client = 'plugin') => b.plugin(`/poll?client=${client}&file=example`);
  return b;
}
const exists = file => fs.access(file).then(() => true, () => false);

test('Bridge accepts islands only for extract with 1-500 distinct node IDs, permits extract scale, compares islands for requestId, and keeps interrupted extracts from blocking run', { timeout: 10000 }, async t => {
  const b = await bridge(t);
  await b.poll();
  const original = { operation: 'extract', requestId: uuid(1), islands: ['1:3'], scale: 2 };
  assert.equal((await b.cli('/job', original)).status, 202);
  const ids = n => Array.from({ length: n }, (_, i) => `3:${i}`);
  const rejected = { 'empty list': { islands: [] }, '501 entries': { islands: ids(501) }, 'duplicates': { islands: ['1:3', '1:3'] }, 'invalid ID': { islands: ['x'] },
    'not an array': { islands: '1:3' }, 'used with inspect': { operation: 'inspect', islands: ['1:3'] }, 'scale above 4': { scale: 4.01 } };
  for (const [name, body] of Object.entries(rejected)) assert.equal((await b.cli('/job', { operation: 'extract', ...body })).status, 400, name);
  for (const body of [{ islands: ids(500), scale: 4 }, { islands: ['I1:2;3:4'], scale: 0.1 }, {}])
    assert.equal((await b.cli('/job', { operation: 'extract', ...body })).body.code, 'ACTIVE_JOB', JSON.stringify(body).slice(0, 80));
  assert.equal((await b.cli('/job', { ...original, islands: ['1:4'] })).status, 400, 'Same requestId with changed islands');
  assert.deepEqual(await b.cli('/job', original).then(r => [r.status, r.body.reused]), [200, true]);
  const delivered = (await b.poll()).body;
  assert.deepEqual([delivered.id, delivered.islands, delivered.scale], [uuid(1), ['1:3'], 2]);

  // Restart after delivery: recovery guidance treats the task as read-only; it loads as recovered without becoming unresolved or blocking run.
  await b.bridge.close();
  assert.equal((await json(path.join(b.run(uuid(1)), 'recovery.json'))).instruction, 'Read-only job interrupted; the document was not modified; resubmit it');
  await b.boot();
  assert.deepEqual((await b.cli('/status')).body.unresolved, []);
  await b.poll();
  assert.equal((await b.cli('/job', { operation: 'run', code: 'return 1;' })).status, 202);
  const record = await localResult(b.cwd, uuid(1));
  assert.equal(record.instruction, 'Read-only job interrupted; the document was not modified; resubmit it');
  assert.equal(await exists(path.join(b.run(uuid(1)), 'before.json')), false);
});

test('After an extract disconnects and its lease expires, a new instance takes over and marks the task unexecuted, discarding late old results; runs still become unknown', { timeout: 10000 }, async t => {
  const b = await bridge(t);
  await b.poll();
  const { body: { id } } = await b.cli('/job', { operation: 'extract' });
  assert.equal((await b.poll()).body.id, id);
  assert.equal((await b.poll('reopened')).body.code, 'CONNECTION_IN_USE', 'Do not take over a fresh old-instance lease');
  b.clock = 15000;
  const taken = await b.poll('reopened');
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  const failed = await json(path.join(b.run(id), 'result.json'));
  assert.deepEqual([failed.ok, failed.executionStarted], [false, false]);
  assert.match(failed.error, /disconnected while running a read-only job.*the document was not modified; it can be resubmitted/);
  assert.equal((await b.plugin('/complete', { id, ok: true, output: { schema: 1 } })).status, 200);
  assert.deepEqual(await json(path.join(b.run(id), 'result.json')), failed);
  assert.equal((await b.poll('plugin')).body.code, 'RETIRED_CLIENT');

  const write = await b.cli('/job', { operation: 'run', code: 'return 1;' });
  assert.equal(write.status, 202, JSON.stringify(write.body));
  assert.equal((await b.poll('reopened')).body.id, write.body.id);
  b.clock = 30000;
  assert.equal((await b.poll('third')).body.code, 'OPERATION_UNCERTAIN');
  assert.equal(await exists(path.join(b.run(write.body.id), 'result.json')), false);
});

test('Extract binaries persist as files/output-<n> PNG/GIF/SVG/WebP descriptors without pixel summaries, before.json, or change sets', { timeout: 10000 }, async t => {
  const b = await bridge(t);
  await b.poll();
  const { body: { id } } = await b.cli('/job', { operation: 'extract', islands: ['1:3'] });
  await b.poll();
  const png = encodePng(2, 1, new Uint8Array(8).fill(255)), gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), svg = Buffer.from('<svg data-node="1:3"/>');
  const webp = Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8L', 'latin1');
  const output = { schema: 1, reference: { [BINARY]: 0 }, images: { g: { bytes: { [BINARY]: 1 }, width: 1, height: 1 }, w: { bytes: { [BINARY]: 3 }, width: 1, height: 1 } },
    islands: { '1:3': 'b0' }, svgs: { b0: { [BINARY]: 2 } }, islandsSkipped: [] };
  const done = await b.plugin('/complete', { id, ok: true, output, binaries: [png, gif, svg, webp].map(x => Buffer.from(x).toString('base64')),
    bindingVerified: { fileKey: 'example', pageId: '1:1', nodeId: '1:2' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const result = await json(path.join(b.run(id), 'result.json'));
  assert.deepEqual([result.output.reference.file, result.output.reference.type, result.output.reference.width, result.output.reference.pixels], ['files/output-1.png', 'png', 2, undefined]);
  assert.deepEqual([result.output.images.g.bytes.file, result.output.images.g.bytes.type], ['files/output-2.gif', 'gif']);
  assert.deepEqual([result.output.images.w.bytes.file, result.output.images.w.bytes.type], ['files/output-4.webp', 'webp']);
  assert.deepEqual([result.output.svgs.b0.file, result.output.svgs.b0.type], ['files/output-3.svg', 'svg']);
  assert.equal(await fs.readFile(path.join(b.run(id), 'files/output-3.svg'), 'utf8'), '<svg data-node="1:3"/>');
  assert.deepEqual([result.binaryErrors, result.binaries, result.changes, result.before], [undefined, undefined, undefined, undefined]);
  assert.equal(await exists(path.join(b.run(id), 'before.json')), false);
  assert.equal((await json(path.join(b.run(id), 'job.json'))).state, 'done');
});

// -- CLI end to end -------------------------------------------------------
test('CLI extract persists reference/bitmap/explicit-island files with shape/stats summaries; skipped islands keep ok true but exit 1, invalid islands fail before submission, and forced stop gives read-only recovery guidance', { timeout: 20000 }, async t => {
  const h = await harness(t, { doc: extractDoc() });
  const ok = await h.run('extract', '--scale', '2', '--island', '2:9');
  assert.equal(ok.code, 0, JSON.stringify(ok.json).slice(0, 400));
  assert.deepEqual([ok.json.operation, ok.json.ok, ok.json.extract.stats.nodes, ok.json.extract.islandsSkipped, ok.json.output.omitted], ['extract', true, 27, [], true]);
  const result = JSON.parse(await fs.readFile(ok.json.resultFile, 'utf8')), out = result.output;
  assert.deepEqual([out.reference.type, out.reference.width, out.reference.height], ['png', 320, 320]);
  assert.equal((await fs.stat(path.join(ok.json.evidence, out.reference.file))).size, out.reference.bytes);
  assert.equal(out.images.h1.bytes.type, 'png');
  const island = out.svgs[out.islands['2:9']];
  assert.equal(island.type, 'svg');
  assert.equal(await fs.readFile(path.join(ok.json.evidence, island.file), 'utf8'), '<svg data-node="2:9"/>');
  assert.equal(typeof out.svgs[out.islands['2:5']], 'string');
  assert.deepEqual([result.binaryErrors, result.changes], [undefined, undefined]);
  assert.equal(await exists(path.join(ok.json.evidence, 'before.json')), false);

  const skipped = await h.run('extract', '--island', '2:11', '--island', '3-10');
  assert.equal(skipped.code, 1);
  assert.equal(skipped.json.ok, true);
  assert.deepEqual(skipped.json.extract.islandsSkipped, ['2:11', '3:10']);
  assert.ok(skipped.json.extract.warnings.includes('Island node has no rendered content (fully clipped, a mask, or opacity 0); skipped: 3:10'));
  assert.match(skipped.json.instruction, /2 explicit island\(s\) have no result/);
  assert.equal((await h.cli('result', skipped.json.id)).code, 1);

  const runs = await fs.readdir(path.join(root(h.cwd), 'runs'));
  const bad = await h.cli('extract', '--island', 'oops');
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /^--island needs a valid node ID/);
  assert.deepEqual(await fs.readdir(path.join(root(h.cwd), 'runs')), runs);
  assert.deepEqual(h.errors, []);

  // stop --force interrupts an active extract with the same guidance as result: resubmit it as a read-only task.
  const started = Promise.withResolvers();
  h.doc.frame.exportAsync = () => { started.resolve(); return new Promise(() => {}); };
  const hung = await h.cli('extract', '--no-wait');
  await h.tick();
  await started.promise;
  const stopped = await h.cli('stop', '--force');
  assert.equal(stopped.code, 0, JSON.stringify(stopped.json));
  assert.equal(stopped.json.recovery, `Recovery instruction written for running job ${hung.json.id}: Read-only job interrupted; the document was not modified; resubmit it`);
});
