/**
 * [INPUT]: src/frames frames; src/html/chrome findChrome; src/png decodePng; two Figma-exported 64x32, 1 s WebM fixtures with a black block moving 48 px and 24 px.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Frame-sampling tests. Invalid task sources fail before Chrome startup. Chrome-dependent cases cover sample times, contact-sheet geometry/content, file/task equivalence, comparisons and identical-byte warnings, original-size dumps, repeated and backward zero-time samples, high-precision filenames, and out-of-duration times; skip with a reason when unavailable. Chrome profiles live in this suite's temporary directory so other suites can count system-temp profiles independently.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { frames } from '../src/frames.mjs';
import { findChrome } from '../src/html/chrome.mjs';
import { decodePng } from '../src/png.mjs';

const FIXTURE = name => fileURLToPath(new URL(`./helpers/motion/${name}`, import.meta.url));
const SLIDE_48 = FIXTURE('slide-48.webm'), SLIDE_24 = FIXTURE('slide-24.webm');
let chrome = null, reason = '';
try { chrome = findChrome(); } catch (error) { reason = `${error.code}: ${error.message}`; }

// A bound project has binding.json; contact sheets go to .figma-agent-control/frames.
async function project(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'fac-frames-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, '.figma-agent-control', 'runs'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.figma-agent-control', 'binding.json'), '{}');
  return cwd;
}
// Task evidence contains bridge-persisted file descriptors in output, with files copied into files/.
async function evidence(cwd, { operation = 'run', ok = true, output }) {
  const id = randomUUID(), dir = path.join(cwd, '.figma-agent-control', 'runs', id);
  await fs.mkdir(path.join(dir, 'files'), { recursive: true });
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({ id, operation, state: 'done' }));
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ id, ok, output }));
  for (const [i, file] of [SLIDE_48, SLIDE_24].entries()) await fs.copyFile(file, path.join(dir, 'files', `output-${i + 1}.webm`));
  return id;
}
const video = n => ({ file: `files/output-${n}.webm`, bytes: 1, sha256: 'x', type: 'webm' });

test('Task IDs must identify successful runs returning exactly one video; invalid sources fail before Chrome starts', async t => {
  const cwd = await project(t), nowhere = { executable: '/nonexistent-chrome' };
  for (const [job, message] of [
    [{ operation: 'preview', output: { v: video(1) } }, /must be a successfully completed run/],
    [{ ok: false, output: { v: video(1) } }, /must be a successfully completed run/],
    [{ output: { png: { file: 'files/output-1.png', type: 'png' }, bin: { file: 'files/output-2.bin', type: 'bin' } } }, /has no MP4 or WebM in its return value/],
    [{ output: [video(1), { nested: video(2) }] }, /returned 2 video\(s\); pass a file path directly: .*output-1\.webm, .*output-2\.webm/]
  ]) await assert.rejects(frames(cwd, await evidence(cwd, job), {}, cwd, nowhere), message, String(message));
  await assert.rejects(frames(cwd, await evidence(cwd, { output: { v: video(1) } }), { compareSource: randomUUID() }, cwd, nowhere), /ENOENT|Evidence/, 'The comparison task is also resolved before startup');
});

describe('Frame sampling and contact sheets (requires Chrome)', { skip: chrome ? false : reason }, () => {
  let tmp, dir;
  before(() => {
    // Keep profiles in this suite's temporary directory; other suites count fac-chrome-* in the system temporary directory.
    tmp = process.env.TMPDIR; process.env.TMPDIR = dir = mkdtempSync(path.join(os.tmpdir(), 'fac-frames-chrome-'));
  });
  after(() => { if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp; rmSync(dir, { recursive: true, force: true }); });
  const opts = () => ({ executable: chrome });

  test('Sample uniformly through duration minus 0.05 s; use four 160 px cells per row showing matching frames, with identical task/file results', async t => {
    const cwd = await project(t), r = await frames(cwd, SLIDE_48, { frameCount: 4 }, cwd, opts());
    assert.deepEqual([r.width, r.height, r.duration, r.frames.map(f => f.t)], [64, 32, 1.033, [0, 0.328, 0.655, 0.983]]);
    assert.equal(path.dirname(r.sheet), path.join(cwd, '.figma-agent-control', 'frames'));
    // Cell width 160 (2.5x), label height 22 px, gap 8 px: four cells form 664x102. The 16 px block starts left at t=0 and approaches the right edge near the end.
    const sheet = decodePng(await fs.readFile(r.sheet)), dark = (x, y) => sheet.data[(y * sheet.width + x) * 4] < 128;
    assert.deepEqual([sheet.width, sheet.height], [664, 102]);
    assert.deepEqual([dark(10, 62), dark(130, 62), dark(3 * 168 + 10, 62), dark(3 * 168 + 140, 62)], [true, false, false, true]);
    const byId = await frames(cwd, await evidence(cwd, { output: { video: video(1) } }), { frameCount: 4 }, cwd, opts());
    assert.equal(byId.sheet, r.sheet, 'The same video and times produce the same sheet');
  });

  test('--compare samples matching times with diffPng semantics: self-comparison is zero, both videos match at t=0 then diverge, and out-of-duration --at fails', async t => {
    const cwd = await project(t);
    const self = await frames(cwd, SLIDE_48, { atSeconds: [0, 0.5], compareSource: SLIDE_48 }, cwd, opts());
    assert.deepEqual([self.changed, self.frames.map(f => f.changedPixels)], [false, [0, 0]]);
    assert.match(self.warning, /two videos are byte-identical/, 'The updated export may still be the old video');
    const r = await frames(cwd, SLIDE_48, { atSeconds: [0, 0.5, 0.9], compareSource: SLIDE_24 }, cwd, opts());
    assert.equal(r.changed, true);
    assert.equal(r.frames[0].changedPixels, 0);
    assert.ok(r.frames.slice(1).every(f => f.sameSize && f.changedPixels > 0), JSON.stringify(r.frames));
    assert.match(r.layout, /source on top and the comparison below/);
    assert.equal(r.warning, undefined);
    await assert.rejects(frames(cwd, SLIDE_48, { atSeconds: [0, 2] }, cwd, opts()), /--at exceeds the video duration of 1\.033 s: 2/);
  });

  test('--dump saves original-size frames beside the sheet and suffixes comparison frames with -compare, allowing pixel displacement measurement', async t => {
    const cwd = await project(t), r = await frames(cwd, SLIDE_48, { atSeconds: [0, 0.5], compareSource: SLIDE_24, dump: true }, cwd, opts());
    assert.deepEqual(r.frames.map(f => [path.relative(r.sheet.slice(0, -4), f.file), path.basename(f.compareFile)]), [['01-0.000s.png', '01-0.000s-compare.png'], ['02-0.500s.png', '02-0.500s-compare.png']]);
    // Leftmost block column: both start at 0; at 0.5 s the 48 px clip moves about 24 px and the 24 px clip about 12 px.
    const left = async file => { const png = decodePng(await fs.readFile(file)); assert.deepEqual([png.width, png.height], [64, 32]); return Array.from({ length: 64 }, (_, x) => x).find(x => png.data[(16 * 64 + x) * 4] < 128); };
    const [a0, b0, a1, b1] = await Promise.all(r.frames.flatMap(f => [left(f.file), left(f.compareFile)]));
    assert.deepEqual([a0, b0], [0, 0]);
    assert.ok(Math.abs(a1 - 24) <= 2 && Math.abs(b1 - 12) <= 2, JSON.stringify([a1, b1]));
  });

  test('--dump keeps distinct samples even when rounded to the same millisecond, with one returned path per comparison frame', async t => {
    const cwd = await project(t), times = [0.1, 0.1001, 0.1002];
    const r = await frames(cwd, SLIDE_48, { atSeconds: times, compareSource: SLIDE_24, dump: true }, cwd, opts());
    const files = r.frames.flatMap(f => [f.file, f.compareFile]);
    assert.deepEqual(r.frames.map(f => f.t), times);
    assert.equal(new Set(files).size, times.length * 2);
    for (const file of files) {
      const png = decodePng(await fs.readFile(file));
      assert.deepEqual([png.width, png.height], [64, 32]);
    }
    assert.equal((await fs.readdir(path.dirname(files[0]))).filter(n => n.endsWith('.tmp')).length, 0);
  });

  test('Zero-time samples preserve the decoded first frame when repeated or revisited after a later frame', async t => {
    const cwd = await project(t), times = [0, 0, 0.5, 0, 0];
    const r = await frames(cwd, SLIDE_48, { atSeconds: times, dump: true }, cwd, opts());
    const shots = await Promise.all(r.frames.map(async f => decodePng(await fs.readFile(f.file))));
    assert.deepEqual(r.frames.map(f => f.t), times);
    for (const shot of shots) assert.deepEqual([shot.width, shot.height], [64, 32]);
    // The first frame is opaque, with a 16 px black block at the left of its center row.
    const first = shots[0];
    assert.ok(first.data.every((value, i) => i % 4 !== 3 || value === 255), 'The first frame must not be an empty transparent canvas');
    assert.deepEqual(Array.from({ length: 64 }, (_, x) => first.data[(16 * 64 + x) * 4] < 128), Array.from({ length: 64 }, (_, x) => x < 16));
    for (const i of [1, 3, 4]) assert.deepEqual(shots[i].data, first.data, `Sample ${i + 1} must contain the same first-frame pixels`);
    assert.notDeepEqual(shots[2].data, first.data, 'The intervening sample must seek to a later frame');
  });
});
