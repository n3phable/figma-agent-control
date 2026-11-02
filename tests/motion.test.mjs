/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs, node:vm, ./helpers/plugin.mjs, ../src/record.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for motion; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { plugin } from './helpers/plugin.mjs';
import { scriptTrace } from '../src/record.mjs';

const LIB = fs.readFileSync(new URL('../lib/motion.js', import.meta.url), 'utf8');
const libs = [{ name: 'motion.js', code: LIB }];
const { motionIssues: issuesInVm } = vm.runInNewContext(`${LIB}\n;({ motionIssues })`);
// VM objects have another realm's prototypes, so deepStrictEqual treats them as different; JSON round-trip into this realm before comparison.
const motionIssues = (...args) => JSON.parse(JSON.stringify(issuesInVm(...args)));

// -- Fixtures: mock Motion API --------------------------------------------
const DEFAULT = { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 } };
const FLOAT = value => ({ type: 'FLOAT', value });
const COLOR = (r, g, b, a = 1) => ({ type: 'COLOR', value: { r, g, b, a } });
const ALIAS = id => ({ type: 'VARIABLE_ALIAS', id });
const binding = (baseValue, keyframes) => ({ id: 'track', baseValue, keyframes: keyframes.map(([timelinePosition, value, easing = DEFAULT], i) => ({ id: `k${i}`, timelinePosition, value, easing })) });
const AVAILABLE = [
  { name: 'motion.preset_name.opacity', styleId: 'Opacity', props: { type: "'fadeIn' | 'fadeOut' // default: 'fadeIn'", amount: 'number // default: 0 (%)', delay: 'number // default: 0 (s)', easing: 'easing // default: { type: "EASE_OUT" }' } },
  { name: 'motion.preset_name.position', styleId: 'Position', props: { type: "'slide_in' | 'slide_out' // default: 'slide_in'", direction: "'left' | 'bottom' // default: 'left'", distance: 'number // default: 200' } }
];
const preset = (id, styleId, offset, duration, props = {}) => ({ type: 'FIGMA', id, styleId: `CodeComponentId:${id}`, name: `motion.preset_name.${styleId.toLowerCase()}`, duration, timelineOffset: offset,
  props: { ...(styleId === 'Opacity' ? { type: 'fadeIn', amount: 0 } : { type: 'slide_in', direction: 'left', distance: 200 }), delay: offset, easing: { type: 'EASE_OUT' }, ...props } });

// Frame 1:2 is top-level and owns its timeline ID; block 1:4 has motion, instance descendant I1:9;1:4 inherits motion, and component 1:7 has none. Record writes in calls.
function motionPlugin() {
  const f = plugin(), { doc, figma } = f, calls = [], timeline = { id: '1:2', duration: 2 };
  const log = (...entry) => calls.push(JSON.parse(JSON.stringify(entry)));
  let seq = 0;
  const animate = (n, tracks = {}, styles = []) => Object.assign(n, { manualKeyframeTracks: tracks, animationStyles: styles, timelines: [timeline],
    getTopLevelFrame: () => doc.frame,
    applyManualKeyframeTrack(field, track) {
      log('track', n.id, field, track);
      const b = binding(track.baseValue ?? FLOAT(0), track.keyframes.map(k => [k.timelinePosition, k.value, k.easing]));
      if (field.type === 'PROPERTY') n.manualKeyframeTracks[field.name] = b;
      else n.manualKeyframeTracks[field.collection] = { ...n.manualKeyframeTracks[field.collection], [field.index]: field.field ? { [field.field]: b } : b };
    },
    removeManualKeyframeTrack(field) {
      log('untrack', n.id, field);
      if (field.type === 'PROPERTY') delete n.manualKeyframeTracks[field.name]; else delete n.manualKeyframeTracks[field.collection][field.index];
    },
    applyAnimationStyle(styleId, config) {
      log('style', n.id, styleId, config);
      const id = `AnimationPresetId:new-${++seq}`;
      n.animationStyles.push(config.type === 'CUSTOM' ? { type: 'CUSTOM', id, styleId, name: 'enter', timelineOffset: config.timelineOffset }
        : preset(id, styleId, config.timelineOffset, config.duration, config.props));
      return id;
    },
    removeAnimationStyle(id) { log('unstyle', n.id, id); n.animationStyles = n.animationStyles.filter(s => s.id !== id); },
    setTimelineDuration(id, duration) { log('duration', id, duration); timeline.duration = duration; } });
  animate(doc.frame);
  animate(doc.swatch, {
    OPACITY: binding(FLOAT(1), [[0, FLOAT(0)], [0.30000001192092896, FLOAT(1), { type: 'EASE_OUT', easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } }]]),
    TRANSLATION_XY: binding({ type: 'VECTOR', value: { x: 0, y: 0 } }, [[0, { type: 'VECTOR', value: { x: 0, y: 24 } }], [0.3, { type: 'VECTOR', value: { x: 0, y: 0 } }, { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.30000001 } }]]),
    fills: { 0: binding(COLOR(0, 0, 1), [[0, COLOR(1, 0, 0, 0.5)], [0.3, COLOR(0, 0, 1), ALIAS('VariableID:9:1')], [0.4, COLOR(0, 0, 1), ALIAS('VariableID:lib')]]) },
    effects: { 0: { RADIUS: binding(FLOAT(0), [[0, FLOAT(0)], [0.3, FLOAT(8), { type: 'LINEAR' }]]) } }
  }, [preset('p1', 'Opacity', 0.1, 0.30000001), preset('p2', 'Position', 0.1, 0.3, { direction: 'bottom' }),
    { type: 'CUSTOM', id: 'c1', styleId: 'S:enter,', name: 'enter', timelineOffset: 0.2 }]);
  const inner = animate({ id: 'I1:9;1:4', type: 'RECTANGLE', name: '\u5b9e\u4f8b\u5185\u56fe\u5c42', removed: false, parent: doc.frame }, { ROTATION: binding(FLOAT(0), [[0, FLOAT(0)], [1, FLOAT(360)]]) });
  const component = animate({ id: '1:7', type: 'COMPONENT', name: 'Icon/loader', removed: false, parent: doc.frame });
  for (const n of [inner, component]) { doc.frame.children.push(n); doc.all.set(n.id, n); }
  figma.motion = { figmaAnimationStyles: () => AVAILABLE };
  figma.getLocalCustomAnimationStylesAsync = async () => [{ id: 'S:enter,', name: 'enter' }];
  figma.variables = { ...figma.variables, getLocalVariablesAsync: async type => type === 'EASING' ? [{ id: 'VariableID:9:1', name: 'motion/standard' }] : [],
    getVariableByIdAsync: async id => ({ 'VariableID:9:1': { name: 'motion/standard' }, 'VariableID:lib': { name: 'motion/standard' } })[id] ?? null };
  const run = (code, data) => f.send({ code, libs, ...(data ? { data } : {}) });
  return { ...f, calls, timeline, run };
}

// ── readMotion ───────────────────────────────────────────────────────────
test('readMotion groups timelines and emits shorthand: omit default easing/preset props and at-derived delay, use $/@ references, and mark instance descendants inherited', async () => {
  const f = motionPlugin(), r = await f.run('return readMotion(target)');
  assert.equal(r.ok, true, r.error);
  const { timelines, refs } = r.output;
  assert.deepEqual(timelines.map(t => [t.id, t.name, t.duration, t.nodes.map(n => n.id)]), [['1:2', '\u753b\u677f', 2, ['1:4', 'I1:9;1:4']]]);
  const [swatch, inner] = timelines[0].nodes;
  assert.deepEqual(swatch.tracks, {
    OPACITY: { base: 1, keys: [[0, 0], [0.3, 1, 'ease-out']] },
    TRANSLATION_XY: { base: [0, 0], keys: [[0, [0, 24]], [0.3, [0, 0], 'spring(0.3)']] },
    'fills.0': { base: '#0000FF', keys: [[0, '#FF000080'], [0.3, '#0000FF', '$motion/standard'], [0.4, '#0000FF', '$motion/standard#VariableID:lib']] },
    'effects.0.RADIUS': { base: 0, keys: [[0, 0], [0.3, 8, 'linear']] }
  });
  assert.deepEqual(swatch.styles, [
    { id: 'p1', preset: 'Opacity', at: 0.1, dur: 0.3, easing: 'ease-out' },
    { id: 'p2', preset: 'Position', at: 0.1, dur: 0.3, easing: 'ease-out', props: { direction: 'bottom' } },
    { id: 'c1', style: '@enter', at: 0.2 }
  ]);
  assert.deepEqual([inner.inherited, Object.keys(inner.tracks)], [true, ['ROTATION']]);
  assert.deepEqual(refs, { '$motion/standard': 'VariableID:9:1', '$motion/standard#VariableID:lib': 'VariableID:lib', '@enter': 'S:enter,' });
  assert.ok(r.output.issues.some(i => i.rule === 'track-conflict' && i.node === '1:4'), 'Opacity preset and OPACITY track compete for the same property');
  assert.deepEqual(f.calls, []);
});

// ── applyMotion ──────────────────────────────────────────────────────────
test('applyMotion makes no writes for identical input, rewrites only changed tracks/styles, deletes omitted tracks, replaces changed presets, and gives new styles no ID', async () => {
  const f = motionPlugin();
  const same = await f.run('return applyMotion(await readMotion(target))');
  assert.equal(same.ok, true, same.error);
  assert.deepEqual([same.output.changes, f.calls], [{ tracksWritten: 0, tracksRemoved: 0, stylesApplied: 0, stylesRemoved: 0, durations: 0 }, []]);

  const spec = (await f.run('return readMotion(target)')).output, tl = spec.timelines[0], swatch = tl.nodes[0];
  delete swatch.tracks['fills.0'];
  swatch.tracks.OPACITY.keys = [[0, 0], [0.25, 1, '$motion/standard']];
  swatch.styles = [swatch.styles[0], { ...swatch.styles[1], props: { direction: 'bottom', distance: 24 } }, { preset: 'Opacity', at: 0.4, dur: 0.2, easing: 'cubic(0.2, 0, 0, 1)' }];
  tl.duration = 1.2;
  const r = await f.run('return applyMotion(data)', spec);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.output.changes, { tracksWritten: 1, tracksRemoved: 1, stylesApplied: 2, stylesRemoved: 2, durations: 1 });
  assert.deepEqual(f.calls.map(c => c.slice(0, 2)), [['untrack', '1:4'], ['track', '1:4'], ['unstyle', '1:4'], ['unstyle', '1:4'], ['style', '1:4'], ['style', '1:4'], ['duration', '1:2']]);
  const [[, , untracked], [, , field, track], [, , p2], [, , c1], [, , , position], [, , opacityId, opacity]] = f.calls;
  assert.deepEqual([untracked, field, p2, c1], [{ type: 'INDEXED_ITEM', collection: 'fills', index: 0 }, { type: 'PROPERTY', name: 'OPACITY' }, 'p2', 'c1']);
  assert.deepEqual(track.keyframes[1], { timelinePosition: 0.25, value: FLOAT(1), easing: ALIAS('VariableID:9:1') });
  assert.deepEqual(position, { duration: 0.3, timelineOffset: 0.1, props: { direction: 'bottom', distance: 24, easing: { type: 'EASE_OUT' } } });
  assert.deepEqual([opacityId, opacity], ['Opacity', { duration: 0.2, timelineOffset: 0.4, props: { easing: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 } } } }]);
  assert.equal(f.timeline.duration, 1.2);
  assert.deepEqual(r.output.motion.timelines[0].nodes[0].styles.map(s => s.preset ?? s.style), ['Opacity', 'Position', 'Opacity'], 'Read back after writing');
});

test('applyMotion validates all input before writing, so an invalid later change also prevents earlier valid changes', async () => {
  const valid = { id: '1:4', tracks: { OPACITY: { base: 1, keys: [[0, 0], [1, 1]] } } };
  for (const [bad, message] of [
    [{ id: '1:4', styles: [{ preset: 'Bounce', at: 0, dur: 0.3 }] }, /No preset named Bounce;/],
    [{ id: '1:4', tracks: { OPACITY: { keys: [[0, 0], [1, 1, 'fast']] } } }, /Unrecognized easing: fast/],
    [{ id: '1:4', tracks: { OPACITY: { keys: [[0, 0], [1, 1, '$motion/none']] } } }, /EASING variable \$motion\/none not found/],
    [{ id: '1:4', tracks: { 'fills.x': { keys: [[0, '#FFFFFF']] } } }, /Unrecognized track: fills\.x/],
    [{ id: '1:4', tracks: { OPACITY: { keys: [[-1, 0]] } } }, /with seconds >= 0/],
    [{ id: '1:4', styles: [{ style: '@exit' }] }, /Custom animation style @exit not found/],
    [{ id: 'I1:9;1:4', inherited: true, tracks: { ROTATION: { base: 0, keys: [[0, 0], [1, 180]] } } }, /is inside an instance; its motion is inherited from the matching layer in the main component, and Figma does not allow editing it in the instance/],
    [{ id: '1:7', tracks: { ROTATION: { keys: [[0, 0], [1, -360]] } } }, /^Error: Icon\/loader \(1:7\) is a component itself, and Figma does not allow plugins to write motion to it: write to its child layers/],
    [{ id: '9:9', tracks: {} }, /Node does not exist or does not support motion: 9:9/]
  ]) {
    const f = motionPlugin(), r = await f.run('return applyMotion(data)', { timelines: [{ id: '1:2', nodes: [valid, bad] }] });
    assert.equal(r.ok, false, String(message));
    assert.match(r.error, message);
    assert.deepEqual(f.calls, [], String(message));
  }
  const f = motionPlugin(), r = await f.run('return applyMotion(data)', { timelines: [{ id: '1:2', duration: 0, nodes: [] }] });
  assert.match(r.error, /duration must be > 0/);
});

test('A rejected applyMotion write rolls back earlier writes in reverse order, reports the node and rollback count, and traces from library frames to the caller', async () => {
  const f = motionPlugin(), strip = spec => spec.timelines.map(t => ({ ...t, nodes: t.nodes.map(n => ({ ...n, styles: n.styles?.map(({ id, ...s }) => JSON.stringify(s)).sort() })) }));
  const spec = (await f.run('return readMotion(target)')).output, before = strip(JSON.parse(JSON.stringify(spec))), swatch = spec.timelines[0].nodes[0];
  delete swatch.tracks['fills.0'];
  swatch.tracks.OPACITY.keys = [[0, 0], [0.25, 1]];
  swatch.styles[1] = { ...swatch.styles[1], props: { direction: 'bottom', distance: 24 } };
  spec.timelines[0].nodes.push({ id: '1:2', tracks: { ROTATION: { keys: [[0, 0], [1, 90]] } } });
  spec.timelines[0].duration = 1;
  f.doc.frame.applyManualKeyframeTrack = () => { throw Error('Cannot write animations to product components via the plugin API'); };
  const code = 'return applyMotion(data)', r = await f.run(code, spec);
  assert.equal(r.ok, false);
  assert.match(r.error, /^Error: Figma rejected the write to \u753b\u677f \(1:2\): Cannot write animations to product components via the plugin API \(plugins cannot write motion to components, component sets themselves, or layers inside instances: write to the child layers of the component or to the instance itself\); rolled back 4 earlier change\(s\)$/);
  // Undo the four earlier steps in reverse order: remove fills.0, write OPACITY, delete p2, apply new p2. Duration remains unchanged.
  assert.deepEqual(f.calls.map(c => c[0]), ['untrack', 'track', 'unstyle', 'style', 'unstyle', 'style', 'track', 'track']);
  assert.equal(f.timeline.duration, 2);
  assert.deepEqual(strip((await f.run('return readMotion(target)')).output), before);
  const trace = scriptTrace({ code, libs, label: 'demo.js' }, r.stack, true);
  assert.equal(trace[0].file, 'motion.js');
  assert.ok(trace.some(frame => frame.file === 'demo.js' && frame.line === 1), JSON.stringify(trace));
});

test('Partial-spec rollback restores original variable IDs, track values, and preset parameters without resolving same-name references again', async () => {
  const f = motionPlugin(), { swatch, frame } = f.doc;
  swatch.manualKeyframeTracks = { OPACITY: binding(FLOAT(0.123456789), [[0, FLOAT(0.987654321)], [0.123456789, FLOAT(1), ALIAS('VariableID:lib')]]) };
  swatch.animationStyles = [preset('alias-style', 'Opacity', 0.123456789, 0.345678912, { easing: ALIAS('VariableID:lib'), amount: 0.123456789 })];
  const beforeTrack = structuredClone(swatch.manualKeyframeTracks.OPACITY), beforeStyle = structuredClone(swatch.animationStyles[0]);
  frame.applyManualKeyframeTrack = () => { throw Error('\u62d2\u7edd\u4e0b\u4e00\u8282\u70b9'); };
  const r = await f.run('return applyMotion(data)', {
    refs: { '$motion/standard': 'VariableID:9:1', '$motion/standard#VariableID:lib': 'VariableID:lib' },
    timelines: [{ id: frame.id, nodes: [{ id: swatch.id, tracks: {}, styles: [] }, { id: frame.id, tracks: { OPACITY: { keys: [[0, 0], [1, 1]] } } }] }]
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /rolled back 2 earlier change\(s\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(swatch.manualKeyframeTracks.OPACITY)), beforeTrack);
  const { id: oldId, ...oldStyle } = beforeStyle, { id: newId, ...restoredStyle } = JSON.parse(JSON.stringify(swatch.animationStyles[0]));
  // Figma assigns new instance IDs to reapplied presets; preserve preset configuration and variable identity exactly.
  delete oldStyle.styleId; delete restoredStyle.styleId;
  assert.deepEqual(restoredStyle, oldStyle);
});

// ── exportMotion ─────────────────────────────────────────────────────────
test('exportMotion finds the top-level frame from a child and retries only Video export failed or unchanged differentFrom exports, with immediate other errors and a timeout explanation', async () => {
  const f = motionPlugin(), seen = [];
  let failures = 2;
  f.doc.frame.exportAsync = async settings => { seen.push(settings); if (failures-- > 0) throw Error('Video export failed'); return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]); };
  const ok = await f.run(`return exportMotion(await figma.getNodeByIdAsync('1:4'), undefined, { intervalMs: 1 })`);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual([ok.output.frame, ok.output.attempts, { ...seen[0] }], ['1:2', 3, { format: 'WEBM', quality: 'LOW' }]);
  f.doc.frame.exportAsync = async () => { throw Error('Cannot export node as video'); };
  assert.match((await f.run('return exportMotion(target)')).error, /^Error: Cannot export node as video$/);
  f.doc.frame.exportAsync = async () => { throw Error('Video export failed'); };
  assert.match((await f.run('return exportMotion(target, undefined, { waitSeconds: 0 })')).error, /Figma refused to export video \(Video export failed\) after 1 attempt\(s\).*do not recreate the frame/);
  // differentFrom retries stale export bytes until they differ from the pre-edit video; report a timeout if they never change.
  const stale = [1, 2, 3], fresh = [1, 2, 4];
  let count = 0;
  f.doc.frame.exportAsync = async () => new Uint8Array(++count < 3 ? stale : fresh);
  const waited = await f.run(`return exportMotion(target, undefined, { intervalMs: 1, differentFrom: new Uint8Array(${JSON.stringify(stale)}) })`);
  assert.deepEqual([waited.ok, waited.output.attempts], [true, 3], waited.error);
  f.doc.frame.exportAsync = async () => new Uint8Array(stale);
  assert.match((await f.run(`return exportMotion(target, undefined, { waitSeconds: 0, differentFrom: new Uint8Array(${JSON.stringify(stale)}) })`)).error, /is byte-identical to differentFrom after 1 attempt\(s\)/);
});

// ── motionIssues ─────────────────────────────────────────────────────────
const issues = (nodes, { duration = 1, ...options } = {}) => motionIssues({ timelines: [{ id: '1:2', name: '\u753b\u677f', duration, nodes }] }, options);
const rules = list => list.map(i => i.rule);

test('motionIssues detects timeline overflow, single-keyframe tracks, first-keyframe easing, and property conflicts', () => {
  assert.deepEqual(rules(issues([{ id: 'a', name: 'A', tracks: { OPACITY: { keys: [[0, 0, 'ease-in'], [1.2, 1]] }, ROTATION: { keys: [[0, 90]] } } }], { durationRange: null })),
    ['beyond-timeline', 'first-key-easing', 'static-track']);
  assert.deepEqual(rules(issues([{ id: 'a', styles: [{ preset: 'Opacity', at: 0.9, dur: 0.3 }] }], { durationRange: null })), ['beyond-timeline']);
  const clash = issues([{ id: 'a', tracks: { TRANSLATION_X: { keys: [[0, 0], [0.3, 1]] } }, styles: [{ preset: 'Position', at: 0, dur: 0.3 }, { preset: 'Position', at: 0.2, dur: 0.3 }] }]);
  assert.deepEqual(rules(clash), ['track-conflict', 'track-conflict', 'track-conflict'], 'Both presets conflict with TRANSLATION_X and overlap each other');
  assert.deepEqual(rules(issues([{ id: 'a', styles: [{ preset: 'Position', at: 0, dur: 0.3 }, { preset: 'Position', at: 0.3, dur: 0.3 }] }])), [], 'Adjacent intervals do not overlap');
});

test('motionIssues aggregates overridable duration ranges per timeline, counts raw easing with EASING variables, detects trailing idle time, and checks preset easing/stagger consistency', () => {
  const long = [{ id: 'a', name: 'A', tracks: { OPACITY: { keys: [[0, 0], [0.8, 1]] }, ROTATION: { keys: [[0, 0], [0.05, 1]] } } }];
  const range = issues(long);
  assert.deepEqual([rules(range), range[0].message], [['duration-range'], '\u753b\u677f has 2 animation segment(s) outside the common interaction motion duration of 0.1-0.5 s: OPACITY on A: 0.8 s from 0 s, ROTATION on A: 0.05 s from 0 s']);
  assert.deepEqual([rules(issues(long, { durationRange: [0, 1] })), rules(issues(long, { durationRange: null }))], [[], []]);
  // Measure duration over continuous motion: 0.3 s enter/hold/exit is valid; hold splits intervals; two continuous rotations form one 2 s segment.
  const segments = issues([{ id: 'a', name: 'A', tracks: { OPACITY: { keys: [[0, 0], [0.3, 1], [1.2, 1], [1.5, 0]] }, SCALE: { keys: [[0, 0], [0.3, 1], [0.6, 2, 'hold'], [0.9, 3]] } } },
    { id: 'b', name: 'B', tracks: { ROTATION: { keys: [[0, 0], [1, -360, 'linear'], [2, -720, 'linear']] } } }], { duration: 2 });
  assert.deepEqual([rules(segments), segments[0].message], [['duration-range'], '\u753b\u677f has 1 animation segment(s) outside the common interaction motion duration of 0.1-0.5 s: ROTATION on B: 2 s from 0 s']);

  const tokens = issues([{ id: 'a', tracks: { OPACITY: { keys: [[0, 0], [0.2, 1], [0.4, 0, '$motion/standard']] } }, styles: [{ preset: 'Scale', at: 0, dur: 0.2, easing: '$motion/standard' }] }], { duration: 0.4, easingTokens: ['$motion/standard'] });
  assert.deepEqual([rules(tokens), tokens[0].message], [['raw-easing'], '\u753b\u677f has 1 easing(s) not bound to an EASING variable (linear for constant rotation and similar is a valid choice; decide by intent); the file has: $motion/standard']);
  // Enter/hold/exit: unchanged hold values and step holds have no visible easing and are excluded.
  const held = issues([{ id: 'a', tracks: { OPACITY: { keys: [[0, 0], [0.2, 1, '$motion/ease'], [0.8, 1], [1, 0, '$motion/ease']] }, ROTATION: { keys: [[0, 0], [0.5, 90, 'hold'], [1, 180, '$motion/ease']] } } }], { easingTokens: ['$motion/ease'], durationRange: null });
  assert.deepEqual(rules(held), []);

  assert.deepEqual(rules(issues([{ id: 'a', tracks: { OPACITY: { keys: [[0, 0], [0.4, 1]] } } }], { duration: 2 })), ['idle-tail']);
  assert.deepEqual(rules(issues([{ id: 'a', tracks: { OPACITY: { keys: [[0, 0], [0.4, 1]] } }, styles: [{ style: '@enter', at: 0 }] }], { duration: 2 })), [], 'Unknown custom-style durations are not judged');

  const cards = [0, 0.08, 0.2].map((at, i) => ({ id: `c${i}`, styles: [{ preset: 'Position', at, dur: 0.3, easing: i === 2 ? 'spring(0.3)' : 'ease-out', props: { direction: 'bottom' } }] }));
  const stagger = issues(cards, { duration: 0.5 });
  assert.deepEqual(rules(stagger), ['inconsistent-easing', 'irregular-stagger']);
  assert.match(stagger[1].message, /Position preset staggers 3 nodes at uneven intervals: 0\.08, 0\.12 s/);
  cards[2].styles[0].at = 0.16; cards[2].styles[0].easing = 'ease-out';
  assert.deepEqual(rules(issues(cards, { duration: 0.5 })), [], 'Even staggering and consistent easing');
});
