/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs, node:os, node:path, node:child_process, node:url, ../src/html/chrome.mjs, ../src/html/check.mjs, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for html render; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findChrome, launch } from '../src/html/chrome.mjs';
import { check, raster, writeEvidence } from '../src/html/check.mjs';
import { decodePng, encodePng } from '../src/png.mjs';

let chrome = null, reason = '';
try { chrome = findChrome(); } catch (error) { reason = `${error.code}: ${error.message}`; }
// Without Chrome, every dependent case below is skipped with the discovery error as its reason.
const needs = { skip: chrome ? false : reason };
const exited = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
const profiles = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('fac-chrome-')).length;

// Fixture pages position nested .n elements with transforms like the generator; the background-free canvas should remain transparent in empty areas.
const page = (body, { width = 200, height = 120 } = {}) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0} #canvas{position:relative;width:${width}px;height:${height}px;overflow:hidden} .n{position:absolute;left:0;top:0;transform-origin:0 0}
</style></head><body><div id="canvas" data-node="1:1" data-name="\u5e27">${body}</div></body></html>`;
const blocks = blueY => page(`<div class="n" data-node="1:2" data-name="\u7ea2\u5757" style="transform:translate(20px,20px);width:60px;height:40px;background:#e53935"></div>
<div class="n" data-node="1:3" data-name="\u84dd\u5757" style="transform:translate(110px,${blueY}px);width:60px;height:60px;background:#1e88e5"></div>
<div class="n" data-node="1:4" data-name="\u6587\u5b57" style="transform:translate(20px,80px);font:16px sans-serif;color:#222">Hello</div>`);

test('findChrome rejects an invalid environment override without fallback and preserves a valid executable path', () => {
  assert.throws(() => findChrome({ FIGMA_AGENT_CONTROL_CHROME: '/nonexistent', PATH: process.env.PATH }), error => error.code === 'CHROME_NOT_FOUND' && /nonexistent/.test(error.message));
  assert.throws(() => findChrome({ FIGMA_AGENT_CONTROL_CHROME: os.tmpdir() }), { code: 'CHROME_NOT_FOUND' }, 'A directory is not an executable file');
  assert.equal(findChrome({ FIGMA_AGENT_CONTROL_CHROME: process.execPath }), process.execPath);
});

test('Immediate process exit reports CHROME_LAUNCH_FAILED and removes its temporary profile', async () => {
  const before = profiles();
  // Node rejects Chrome startup flags and immediately exits nonzero.
  await assert.rejects(launch({ executable: process.execPath }), error => error.code === 'CHROME_LAUNCH_FAILED' && error.message.includes(process.execPath));
  assert.equal(profiles(), before);
});

test('Non-CDP pipe messages terminate the child with CHROME_LAUNCH_FAILED without crashing the host or leaving a profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-html-render-')), fake = path.join(dir, 'fake-chrome'), before = profiles();
  // Write one non-JSON message then suspend; exec makes the suspended process itself the termination target, leaving no orphan.
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "garbage\\000" >&4\nexec sleep 30\n', { mode: 0o755 });
  try { await assert.rejects(launch({ executable: fake }), error => error.code === 'CHROME_LAUNCH_FAILED' && /unparsable/.test(error.message)); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(profiles(), before);
});

test('raster respects paint order, rounds partially covered pixels outward, and clips to the canvas', () => {
  const owner = raster([0, 0, 0, 4, 3, 1, 1.5, 0.5, 1, 1, 2, -5, 2, 100, 9], 4, 3);
  assert.deepEqual([...owner], [0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2]);
  assert.deepEqual([...raster([], 2, 1)], [-1, -1]);
});

test('Refs prevent clean verdicts, report per-rectangle differences and union bakedShare, while failures still apply', async () => {
  // Stub page with a fixed screenshot and no data-node elements: a 10x10 white reference differs at (1,1) and (6,6).
  const W = 10, white = () => new Uint8Array(W * W * 4).fill(255), shot = white();
  for (const [x, y] of [[1, 1], [6, 6]]) shot.set([0, 0, 0, 255], (y * W + x) * 4);
  const fake = png => ({ browser: { version: 'fake' }, open: async () => {}, shot: async () => png, evaluate: async () => ({ ids: [], names: [], rects: [] }) });
  const input = { url: 'about:blank', reference: encodePng(W, W, white()), expected: { width: W, height: W } };
  assert.equal((await check(fake(encodePng(W, W, white())), input)).report.verdict, 'clean');
  const refs = [{ node: '1:2', rect: [0, 0, 4, 4], share: 0.16 }, { node: '1:3', rect: [2, 2, 8, 8], share: 0.36 }];
  const { report } = await check(fake(encodePng(W, W, shot)), { ...input, refs });
  assert.deepEqual([report.verdict, report.mismatched, report.bakedShare], ['pass-with-findings', 2, 0.48], 'Union area is 16 + 36 - 4 = 48 pixels');
  assert.deepEqual(report.refs, [{ node: '1:2', rect: [0, 0, 4, 4], share: 0.16, px: 1 }, { node: '1:3', rect: [2, 2, 8, 8], share: 0.36, px: 1 }]);
  const plain = (await check(fake(encodePng(W, W, shot)), input)).report;
  assert.deepEqual([plain.verdict, plain.refs, plain.bakedShare], ['clean', undefined, undefined], 'The same differences without refs are clean and omit both ref fields');
  const dark = new Uint8Array(W * W * 4).fill(0);
  assert.equal((await check(fake(encodePng(W, W, dark)), { ...input, refs })).report.verdict, 'fail');

  // Rectangles are half-open and exclude antialiasing. A black/gray/white reference differs by a brighter gray antialiasing pixel at (4,2) and a black mismatch at (8,8).
  const stripe = () => { const img = new Uint8Array(W * W * 4); for (let i = 0; i < W * W; i++) { const x = i % W, v = x < 4 ? 0 : x === 4 ? 128 : 255; img.set([v, v, v, 255], i * 4); } return img; };
  const edge = stripe();
  edge.set([230, 230, 230, 255], (2 * W + 4) * 4);
  edge.set([0, 0, 0, 255], (8 * W + 8) * 4);
  const rects = [[3, 0, 6, 4], [6, 6, 8, 9], [6, 6, 9, 8], [8, 8, 9, 9]].map((rect, i) => ({ node: `1:${i}`, rect }));
  const half = (await check(fake(encodePng(W, W, edge)), { ...input, reference: encodePng(W, W, stripe()), refs: rects })).report;
  assert.deepEqual([half.mismatched, half.aa, half.refs.map(x => x.px), half.bakedShare], [1, 1, [0, 0, 0, 1], 0.21], '(8,8) lies only in the final rectangle');
});

describe('Rendering and checking (requires Chrome)', () => {
  let browser, tab, dir, url, reference;
  before(async () => {
    if (!chrome) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-html-render-'));
    url = (name, html) => { const file = path.join(dir, name); fs.writeFileSync(file, html); return pathToFileURL(file).href; };
    browser = await launch({ executable: chrome });
    tab = await browser.page();
    await tab.open(url('a.html', blocks(30)), 200, 120);
    reference = await tab.shot();
  });
  after(async () => {
    if (!chrome) return;
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(exited(browser.pid) && !fs.existsSync(browser.profile), 'The suite-owned Chrome exited and its profile was removed');
  });

  test('Self-comparison is zero without structural blocks; solid-color probes match and empty canvas remains transparent', needs, async () => {
    const { report } = await check(tab, { url: url('self.html', blocks(30)), reference, expected: { width: 200, height: 120 } });
    assert.deepEqual([report.verdict, report.mismatched, report.diffRatio, report.blocks, report.nodes], ['clean', 0, 0, [], []]);
    assert.match(report.browser.version, /Chrome\//);
    assert.ok(report.browser.args.includes('--disable-gpu') && /^[a-f0-9]{12}$/.test(report.checker));
    const img = decodePng(reference), px = (x, y) => [...img.data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 4)];
    const near = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 40);
    assert.ok(near(px(50, 40), [229, 57, 53, 255]), `Red block ${px(50, 40)}`);
    assert.ok(near(px(140, 60), [30, 136, 229, 255]), `Blue block ${px(140, 60)}`);
    assert.equal(px(190, 5)[3], 0, 'Transparent background');
  });

  test('Moving the blue block down 6 px yields two 60x6 difference bands, attributes the new position to the node and vacated area to the frame, and writes evidence', needs, async () => {
    const { report, images } = await check(tab, { url: url('moved.html', blocks(36)), reference, expected: { width: 200, height: 120 } });
    assert.equal(report.mismatched, 720);
    assert.equal(report.verdict, 'fail', '720/24000 = 3%');
    assert.deepEqual(report.nodes.map(n => [n.node, n.px]).sort(), [['1:1', 360], ['1:3', 360]]);
    assert.equal(report.nodes.find(n => n.node === '1:3').area, 3600);
    const lower = report.blocks.find(b => b.y >= 80);
    // A block encloses the union of hot cells; all its differences come from the blue block.
    assert.deepEqual(lower.nodes, [{ node: '1:3', name: '\u84dd\u5757', px: lower.diffPx, share: 1 }]);
    assert.equal(lower.bboxPx, lower.diffPx, 'share divides by differing pixels inside the bounding box; hot cells fill that box here');
    assert.equal(report.blocks.find(b => b.y < 80).nodes[0].node, '1:1', 'HTML sees only the node currently painting a position; Figma-side attribution covers vacated areas');

    const evidence = path.join(dir, 'evidence');
    await writeEvidence(evidence, report, images);
    assert.equal(JSON.parse(fs.readFileSync(path.join(evidence, 'check.json'), 'utf8')).mismatched, 720);
    assert.deepEqual([decodePng(fs.readFileSync(path.join(evidence, 'render.png'))).width, decodePng(fs.readFileSync(path.join(evidence, 'diff.png'))).height], [200, 120]);
  });

  test('Repeated elements with one node ID merge counts, while portions outside clipping ancestors are unattributed', needs, async () => {
    await tab.open(url('empty.html', page('')), 200, 120);
    const empty = await tab.shot();
    const html = page(`<div class="n" data-node="5:1" data-name="\u62c6\u5c42" style="transform:translate(10px,10px);width:20px;height:20px;background:#000"></div>
<div class="n" data-node="5:1" data-name="\u62c6\u5c42" style="transform:translate(100px,10px);width:30px;height:20px;background:#000"></div>
<div class="n" data-node="5:2" data-name="\u88c1\u5207" style="transform:translate(10px,60px);width:40px;height:20px;overflow:hidden">
<div class="n" data-node="5:3" data-name="\u6ea2\u51fa" style="width:80px;height:20px;background:#000"></div></div>`);
    const { report } = await check(tab, { url: url('dup.html', html), reference: empty, expected: { width: 200, height: 120 } });
    assert.deepEqual(report.nodes.map(n => [n.node, n.px, n.area]), [['5:1', 1000, 1000], ['5:3', 800, 800]]);
    assert.equal(report.mismatched, 1800);
  });

  test('Reference sizes differing by more than 1 px are unchecked/REFERENCE_SIZE without rendering; a 1 px difference compares at reference size and marks fractional', needs, async () => {
    const bad = await check(tab, { url: 'about:blank', reference, expected: { width: 203, height: 120 } });
    assert.deepEqual([bad.report.verdict, bad.report.reason, bad.report.reference, bad.images], ['unchecked', 'REFERENCE_SIZE', { width: 200, height: 120 }, undefined]);
    const fractional = await check(tab, { url: url('frac.html', blocks(30)), reference, expected: { width: 201, height: 119 } });
    assert.deepEqual([fractional.report.sizeNote, fractional.report.mismatched, fractional.images.width], ['fractional', 0, 200]);
    // Missing, NaN, or fractional expected dimensions fail explicitly so size checking cannot silently vanish; viewports also require positive integers.
    for (const expected of [{ width: NaN, height: 120 }, { width: 200 }, { width: 200.5, height: 120 }, undefined])
      await assert.rejects(check(tab, { url: 'about:blank', reference, expected }), /Expected size must be positive integers/);
    await assert.rejects(tab.open('about:blank', 10.5, 7.25), /Viewport size must be positive integers/);
  });

  test('A failed navigation permits immediate reopening of the same page without leaving a pending load event', needs, async () => {
    await assert.rejects(tab.open(pathToFileURL(path.join(dir, 'missing.html')).href, 200, 120), /ERR_FILE_NOT_FOUND/);
    const t = performance.now();
    await tab.open(url('after.html', blocks(30)), 200, 120);
    assert.ok(performance.now() - t < 5000, `Reopening took ${Math.round(performance.now() - t)} ms`);
  });

  test('Render timeout yields unchecked/RENDER_TIMEOUT, and closing removes the owned process and profile', needs, async () => {
    const hung = await launch({ executable: chrome, timeout: 1500 });
    try {
      const { report } = await check(await hung.page(), { url: url('hang.html', '<script>for(;;){}</script>'), reference, expected: { width: 200, height: 120 } });
      assert.deepEqual([report.verdict, report.reason], ['unchecked', 'RENDER_TIMEOUT']);
    } finally { await hung.close(); }
    assert.ok(exited(hung.pid), `pid ${hung.pid} exited`);
    assert.equal(fs.existsSync(hung.profile), false);
  });

  test('SIGTERM also terminates owned Chrome and removes its profile while preserving the parent SIGTERM exit', needs, async () => {
    const lib = new URL('../src/html/chrome.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { launch } = await import(${JSON.stringify(lib)});
const b = await launch({ executable: ${JSON.stringify(chrome)} }); console.log(JSON.stringify({ pid: b.pid, profile: b.profile })); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)));
    let info;
    try {
      info = JSON.parse(await new Promise(resolve => child.stdout.once('data', resolve)));
      child.kill('SIGTERM');
      assert.equal(await ended, 'SIGTERM');
      assert.equal(fs.existsSync(info.profile), false);
      // Chrome has received SIGKILL but may briefly remain a zombie until the system reaps it.
      for (let i = 0; i < 100 && !exited(info.pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(exited(info.pid), `pid ${info.pid} exited`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
      if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} fs.rmSync(info.profile, { recursive: true, force: true }); }
    }
  });

  test('A 1440x6000 frame shifted 1 px checks within 1.6 s for decoding, comparison, structural blocks, and attribution, with attribution within 1 s', needs, async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `<div class="n" data-node="2:${i}" data-name="\u884c${i}" style="transform:translate(24px,${i * 20}px);width:1392px;height:20px">
<div class="n" data-node="3:${i}" data-name="\u8272\u5757${i}" style="transform:translate(0,2px);width:16px;height:16px;background:hsl(${i * 7 % 360},70%,50%)"></div>
<div class="n" data-node="4:${i}" data-name="\u6587\u5b57${i}" style="transform:translate(28px,1px);font:14px sans-serif;white-space:pre">\u7b2c ${i} \u884c Row ${i} · The quick brown fox jumps over the lazy dog</div></div>`).join('');
    const tall = (dy, name) => url(name, page(`<div class="n" data-node="1:9" data-name="\u5185\u5bb9" style="transform:translate(0,${dy}px)">${rows}</div>`, { width: 1440, height: 6000 }));
    await tab.open(tall(0, 'tall-a.html'), 1440, 6000);
    const ref = await tab.shot();
    const { report } = await check(tab, { url: tall(1, 'tall-b.html'), reference: ref, expected: { width: 1440, height: 6000 } });
    const { render, ...rest } = report.ms, total = Object.values(rest).reduce((s, v) => s + v, 0);
    assert.ok(report.mismatched > 10000 && report.nodes.length > 100, `Translation should cause widespread differences: ${report.mismatched} px, ${report.nodes.length} nodes`);
    assert.ok(total <= 1600, `Check stages ${JSON.stringify(report.ms)}`);
    assert.ok(report.ms.attrib <= 1000, `Attribution ${report.ms.attrib} ms`);
  });
});
