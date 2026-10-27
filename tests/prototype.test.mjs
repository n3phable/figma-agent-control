/**
 * [INPUT]: tests/helpers/plugin plugin with real main.js and createDoc in a VM; lib/prototype.js source; src/record scriptTrace.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Loads prototype through run libs against a page-targeted mock API: reactions/setReactionsAsync, flow starts, overlays, variant sets, instance main components, and variables. Covers read shorthand/targets/graph, declarative no-op and changed-node actions-only writes, flows, prevalidation, reverse rollback, and issue rules. Real-device readback shapes use float32 values, mirrored action/actions, resetVideoPosition:false on NODE actions, and automatic initial flow starts on first outgoing links.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { plugin } from './helpers/plugin.mjs';
import { scriptTrace } from '../src/record.mjs';

const LIB = fs.readFileSync(new URL('../lib/prototype.js', import.meta.url), 'utf8');
const libs = [{ name: 'prototype.js', code: LIB }];
const PAGE = { fileKey: 'example', nodeId: '1:1' };

// -- Fixtures: mock prototype API -----------------------------------------
// Page 1:1 contains frame 1:2 (block 1:4, inner frame, inst instance), Home, Sheet overlay, Detail in a Section, and Toggle variants State=On/Off; page 2:1 contains Far.
const f32 = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'number' && !Number.isInteger(v) ? Math.fround(v) : v));
function protoPlugin() {
  const f = plugin(), { doc, figma } = f, calls = [], reject = new Set();
  const make = (type, parent, name, extra = {}) => Object.assign(doc.create(type, parent), { name }, extra);
  const home = make('FRAME', doc.page, 'Home'), sheet = make('FRAME', doc.page, 'Sheet', { overlayPositionType: 'CENTER', overlayBackground: { type: 'NONE' }, overlayBackgroundInteraction: 'NONE' });
  const section = make('SECTION', doc.page, 'Flow'), detail = make('FRAME', section, 'Detail');
  const set = make('COMPONENT_SET', doc.page, 'Toggle'), on = make('COMPONENT', set, 'State=On'), off = make('COMPONENT', set, 'State=Off');
  const inner = make('FRAME', doc.frame, 'inner'), inst = make('INSTANCE', doc.frame, 'Toggle', { getMainComponentAsync: async () => on });
  const far = make('FRAME', doc.other, 'Far');
  doc.page.flowStartingPoints = [{ nodeId: '1:2', name: 'Flow 1' }];
  const screenOf = n => { while (n.parent && !['PAGE', 'SECTION'].includes(n.parent.type)) n = n.parent; return n; };
  // Readback mirrors action from actions[0], adds resetVideoPosition:false for NODE actions, and stores numbers as float32.
  const store = list => f32(list.map(r => { const actions = r.actions.map(a => a.type === 'NODE' ? { ...a, resetVideoPosition: a.resetVideoPosition ?? false } : a); return { action: actions[0], actions, trigger: r.trigger }; }));
  const reactive = (n, list = []) => Object.assign(n, { reactions: store(list), async setReactionsAsync(next) {
    calls.push([n.id, JSON.parse(JSON.stringify(next))]);
    if (reject.has(n.id)) throw Error('Reaction at index 0 was invalid');
    const first = !n.reactions.length;
    n.reactions = store(next);
    const screen = screenOf(n);
    if (first && next.length && !doc.page.flowStartingPoints.some(s => s.nodeId === screen.id)) doc.page.flowStartingPoints = [...doc.page.flowStartingPoints, { nodeId: screen.id, name: `Flow ${doc.page.flowStartingPoints.length + 1}` }];
  } });
  const nav = (destinationId, navigation = 'NAVIGATE', transition = null, extra = {}) => ({ type: 'NODE', destinationId, navigation, transition, ...extra });
  reactive(doc.swatch, [
    { trigger: { type: 'ON_CLICK' }, actions: [nav(home.id, 'NAVIGATE', { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.3 }, { resetScrollPosition: true })] },
    { trigger: { type: 'AFTER_TIMEOUT', timeout: 0.8 }, actions: [nav(sheet.id, 'OVERLAY', { type: 'MOVE_IN', direction: 'BOTTOM', matchLayers: false, easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { mass: 1, stiffness: 321.7, damping: 17.9 } }, duration: 0.45 })] },
    { trigger: { type: 'ON_KEY_DOWN', device: 'KEYBOARD', keyCodes: [16, 65] }, actions: [nav(detail.id, 'NAVIGATE', { type: 'DISSOLVE', easing: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 } }, duration: 0.3 })] }
  ]);
  reactive(doc.frame); reactive(doc.text); reactive(inner); reactive(far); reactive(detail);
  reactive(home, [{ trigger: { type: 'MOUSE_ENTER', delay: 0.2 }, actions: [{ type: 'URL', url: 'https://example.com', openInNewTab: true }] }]);
  reactive(sheet, [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CLOSE' }] }]);
  reactive(on, [{ trigger: { type: 'ON_CLICK' }, actions: [nav(off.id, 'CHANGE_TO')] }]); reactive(off); reactive(inst);
  figma.variables = { ...figma.variables, getVariableByIdAsync: async id => id === 'VariableID:1:1' ? { id, name: 'brand', resolvedType: 'COLOR' } : null };
  const run = (code, data, target = PAGE) => f.send({ code, libs, binding: target, ...(data ? { data } : {}) });
  return { ...f, calls, reject, run, home, sheet, section, detail, set, on, off, inner, inst, far, nav };
}

// ── readPrototype ────────────────────────────────────────────────────────
test('readPrototype emits seconds, transition/easing/spring, URL, and close shorthand with flow starts, named targets/frames, overlay settings, and a graph without writes', async () => {
  const f = protoPlugin(), r = await f.run('return readPrototype(target)');
  assert.equal(r.ok, true, r.error);
  const { root, page, flows, nodes, targets, frames, overlays, edges } = r.output;
  assert.deepEqual([root, page, flows], [{ id: '1:1', name: '\u9875\u9762', type: 'PAGE' }, '1:1', [{ nodeId: '1:2', name: 'Flow 1' }]]);
  assert.deepEqual(nodes.map(n => [n.id, n.frame]), [['1:4', '1:2'], [f.home.id, f.home.id], [f.sheet.id, f.sheet.id], [f.on.id, f.set.id]]);
  assert.deepEqual(nodes[0].reactions, [
    { on: 'click', do: [{ navigate: f.home.id, transition: 'smart-animate 0.3 ease-out', resetScroll: true }] },
    { on: 'after 0.8', do: [{ overlay: f.sheet.id, transition: 'move-in bottom 0.45 spring(1,321.7,17.9)' }] },
    { on: 'key KEYBOARD 16,65', do: [{ navigate: f.detail.id, transition: 'dissolve 0.3 cubic(0.2,0,0,1)' }] }
  ]);
  assert.deepEqual([nodes[1].reactions, nodes[2].reactions, nodes[3].reactions],
    [[{ on: 'mouse-enter 0.2', do: [{ url: 'https://example.com', newTab: true }] }], [{ on: 'click', do: ['close'] }], [{ on: 'click', do: [{ 'change-to': f.off.id }] }]]);
  assert.deepEqual(targets[f.detail.id], { name: 'Detail', frame: f.detail.id }, 'A frame inside a Section is top-level');
  assert.deepEqual(targets[f.off.id], { name: 'State=Off', frame: f.set.id });
  assert.deepEqual([frames['1:2'], frames[f.set.id]], ['\u753b\u677f', 'Toggle']);
  assert.deepEqual(overlays, { [f.sheet.id]: { overlayPositionType: 'CENTER', overlayBackground: { type: 'NONE' }, overlayBackgroundInteraction: 'NONE' } });
  assert.deepEqual(edges[1], { from: '1:4', fromFrame: '1:2', on: 'after 0.8', nav: 'overlay', to: f.sheet.id, toFrame: f.sheet.id });
  assert.deepEqual(f.calls, []);
});

// ── applyPrototype ───────────────────────────────────────────────────────
test('applyPrototype makes no writes for identical input, writes only changed nodes using actions, clears with [], and reads back the result', async () => {
  const f = protoPlugin();
  const same = await f.run('return applyPrototype(await readPrototype(target))');
  assert.equal(same.ok, true, same.error);
  assert.deepEqual([same.output.changes, f.calls], [{ nodes: 0, flows: 0, flowsAdded: [] }, []]);

  const spec = (await f.run('return readPrototype(target)')).output;
  spec.nodes[0].reactions[0].do[0].transition = 'push left 0.25 gentle match';
  spec.nodes[1].reactions = [];
  const r = await f.run('return applyPrototype(data)', spec);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.output.changes, { nodes: 2, flows: 0, flowsAdded: [] });
  assert.deepEqual(f.calls.map(([id]) => id), ['1:4', f.home.id]);
  const [[, written], [, cleared]] = f.calls;
  assert.deepEqual(written[0], { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: f.home.id, navigation: 'NAVIGATE',
    transition: { type: 'PUSH', direction: 'LEFT', matchLayers: true, easing: { type: 'GENTLE' }, duration: 0.25 }, resetScrollPosition: true }] });
  assert.ok(written.every(reaction => !('action' in reaction)), 'Write only actions');
  assert.deepEqual(written[1].trigger, { type: 'AFTER_TIMEOUT', timeout: 0.8 });
  assert.deepEqual(cleared, []);
  assert.equal(r.output.prototype.nodes[0].reactions[0].do[0].transition, 'push left 0.25 gentle match', 'Read back after writing');
});

test('Explicit flows replace all starts after writing links, including automatically added starts; omitted flows remain unchanged and report automatic additions', async () => {
  const f = protoPlugin(), click = to => ({ on: 'click', do: [{ navigate: to }] });
  const auto = await f.run('return applyPrototype(data)', { nodes: [{ id: f.inner.id, reactions: [] }, { id: f.detail.id, reactions: [click(f.home.id)] }] });
  assert.equal(auto.ok, true, auto.error);
  assert.deepEqual(auto.output.changes.flowsAdded, [{ nodeId: f.detail.id, name: 'Flow 2' }]);
  const f2 = protoPlugin();
  const declared = await f2.run('return applyPrototype(data)', { flows: [{ nodeId: f2.home.id, name: '\u767b\u5f55' }], nodes: [{ id: f2.detail.id, reactions: [click(f2.home.id)] }] });
  assert.equal(declared.ok, true, declared.error);
  assert.deepEqual([declared.output.changes.flows, JSON.parse(JSON.stringify(f2.doc.page.flowStartingPoints))], [1, [{ nodeId: f2.home.id, name: '\u767b\u5f55' }]]);
  assert.deepEqual(declared.output.prototype.flows, [{ nodeId: f2.home.id, name: '\u767b\u5f55' }]);
});

test('applyPrototype validates all input and write-related checks before writing, so invalid later changes also prevent earlier valid changes', async () => {
  const valid = f => ({ id: f.inner.id, reactions: [{ on: 'press', do: ['back'] }] });
  for (const [bad, message] of [
    [f => ({ id: '1:4', reactions: [{ on: 'tap', do: ['back'] }] }), /reaction 1: Unknown trigger: "tap"/],
    [f => ({ id: '1:4', reactions: [{ on: 'click', do: [{ navigate: f.home.id, transition: 'fade 0.3 ease-out' }] }] }), /Unknown transition: "fade 0\.3 ease-out"/],
    [f => ({ id: '1:4', reactions: [{ on: 'click', do: [{ navigate: f.home.id, transition: 'dissolve 0.3 spring(0.3)' }] }] }), /Unknown easing: spring\(0\.3\)/],
    [f => ({ id: '1:4', reactions: [{ on: 'click', do: [{ navigate: f.home.id, delay: 1 }] }] }), /Unknown action key delay/],
    [f => ({ id: f.section.id, reactions: [] }), /is a SECTION and cannot have prototype reactions/],
    [f => ({ id: f.set.id, reactions: [] }), /is a COMPONENT_SET and cannot have prototype reactions/],
    [f => ({ id: '9:9', reactions: [] }), /Node not found: 9:9/],
    [f => ({ id: f.inner.id, reactions: [] }), /inner \(.*\) is listed twice in the spec/],
    [f => ({ id: f.home.id, reactions: [{ on: 'click', do: [{ navigate: f.inner.id }] }] }), /Pre-write check found 1 error\(s\); nothing was written: Home \(.*\): navigate target inner \(.*\) is not a top-level frame/],
    [f => ({ id: f.home.id, reactions: [{ on: 'click', do: [{ navigate: f.far.id }] }] }), /is on another page/],
    [f => ({ id: f.home.id, reactions: [{ on: 'click', do: [{ navigate: '9:9' }] }] }), /target 9:9 was deleted or does not exist/],
    [f => ({ id: f.home.id, reactions: [{ on: 'click', do: [{ navigate: f.home.id }] }] }), /navigates to its own frame/],
    [f => ({ id: '1:4', reactions: [{ on: 'click', do: [{ 'scroll-to': f.home.id }] }] }), /scroll-to target Home \(.*\) is not inside its own frame \u753b\u677f \(1:2\)/],
    [f => ({ id: f.inst.id, reactions: [{ on: 'click', do: [{ 'change-to': f.home.id }] }] }), /change-to target Home \(.*\) is not a variant in component set Toggle \(.*\)/],
    [f => ({ id: '1:4', reactions: [{ on: 'click', do: [{ overlay: f.sheet.id, position: [10, 20] }] }] }), /overlay position is CENTER: only MANUAL accepts position/],
    [f => ({ id: '1:4', reactions: [{ on: 'click', do: [{ type: 'SET_VARIABLE', variableId: 'VariableID:1:1', variableValue: { type: 'BOOLEAN', resolvedType: 'BOOLEAN', value: true } }] }] }), /sets a BOOLEAN value on COLOR variable brand/]
  ]) {
    const f = protoPlugin(), r = await f.run('return applyPrototype(data)', { nodes: [valid(f), bad(f)] });
    assert.equal(r.ok, false, String(message));
    assert.match(r.error, message);
    assert.deepEqual(f.calls, [], String(message));
  }
  const f = protoPlugin(), spec = (await f.run('return readPrototype(target)')).output;
  spec.overlays[f.sheet.id].overlayBackgroundInteraction = 'CLOSE_ON_CLICK_OUTSIDE';
  spec.nodes[0].reactions = [];
  const overlay = await f.run('return applyPrototype(data)', spec);
  assert.match(overlay.error, /Sheet \(.*\): overlayBackgroundInteraction is read-only in the plugin API, so applyPrototype does not write overlay settings: change it in the Figma Prototype panel/);
  assert.match((await f.run('return applyPrototype(data)', { flows: [{ nodeId: f.home.id }], nodes: [] })).error, /flows must be \[\{ nodeId, name \}\] with a non-empty name/);
  assert.match((await f.run('return applyPrototype(data)', { flows: [{ nodeId: f.inner.id, name: 'x' }], nodes: [] })).error, /Flow starting point "x": inner \(.*\) is not a top-level frame on this page/);
  assert.deepEqual(f.calls, []);
});

test('Rejected prototype writes restore original values in reverse order and restore automatic flow starts; errors identify the node, known combinations, rollback count, and caller trace', async () => {
  const f = protoPlugin(), before = (await f.run('return readPrototype(target)')).output;
  f.reject.add(f.home.id);
  const spec = { nodes: [{ id: f.detail.id, reactions: [{ on: 'click', do: [{ navigate: f.home.id }] }] }, { id: f.home.id, reactions: [{ on: 'drag', do: [{ navigate: f.detail.id }] }] }] };
  const code = 'return applyPrototype(data)', r = await f.run(code, spec);
  assert.equal(r.ok, false);
  assert.match(r.error, /^Error: Figma rejected the write to Home \(.*\): Reaction at index 0 was invalid \(known rejected combinations: drag only accepts a smart-animate transition.*\); rolled back 1 earlier write\(s\)$/);
  assert.deepEqual(f.calls.map(([id, list]) => [id, list.length]), [[f.detail.id, 1], [f.home.id, 1], [f.detail.id, 0]]);
  const after = (await f.run('return readPrototype(target)')).output;
  assert.deepEqual([after.nodes, after.flows], [before.nodes, before.flows], 'Restore Detail to empty and remove its automatically added flow start');
  const trace = scriptTrace({ code, libs, label: 'demo.js' }, r.stack, true);
  assert.equal(trace[0].file, 'prototype.js');
  assert.ok(trace.some(frame => frame.file === 'demo.js' && frame.line === 1), JSON.stringify(trace));
});

// ── prototypeIssues ──────────────────────────────────────────────────────
test('prototypeIssues checks Smart Animate name/path mismatches and page-only unreachable/dead-end frames', async () => {
  const f = protoPlugin(), { doc } = f;
  const card = Object.assign(doc.create('FRAME', f.home), { name: 'card' });
  Object.assign(doc.create('RECTANGLE', card), { name: 'bg' });
  f.doc.page.flowStartingPoints = [];
  const r = await f.run('return readPrototype(target)');
  assert.equal(r.ok, true, r.error);
  const byRule = Object.fromEntries(r.output.issues.map(i => [i.rule, i]));
  assert.deepEqual(Object.keys(byRule).sort(), ['dead-end', 'smart-animate-unmatched', 'unreachable']);
  assert.match(byRule['smart-animate-unmatched'].message, /^\u8272\u5757 \(1:4\) uses Smart Animate from \u753b\u677f \(1:2\) to Home \(.*\), but only 0 of 4 layers match by name and layer path; the rest only fade: \u6807\u9898, \u8272\u5757, inner, Toggle$/);
  assert.equal(byRule['smart-animate-unmatched'].level, 'warning');
  assert.match(byRule.unreachable.message, /^4 frame\(s\) cannot be reached in presentation: the page has no flow starting point: \u753b\u677f, Home, Sheet, Detail$/);
  assert.match(byRule['dead-end'].message, /^1 frame\(s\) have no way out .*: Detail; ignore this for end screens$/);
  doc.page.flowStartingPoints = [{ nodeId: '1:2', name: 'Flow 1' }];
  for (const name of ['\u6807\u9898', '\u8272\u5757', 'inner']) Object.assign(doc.create('RECTANGLE', f.home), { name });
  const again = await f.run('return readPrototype(target)');
  assert.deepEqual(again.output.issues.map(i => i.rule), ['dead-end'], 'All frames are reachable from the start; 3 of the frame\'s 4 layers match in Home');
  const frameOnly = await f.run('return readPrototype(target)', undefined, { fileKey: 'example', nodeId: '1:2' });
  assert.deepEqual(frameOnly.output.issues.map(i => i.rule), [], 'Frame targets skip reachability and dead-end checks');
});
