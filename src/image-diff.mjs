/**
 * [INPUT]: Uses ./png.mjs diffPng, ./record.mjs localResult and ./project.mjs root/hash/isJobId.
 * [OUTPUT]: imageDiff(cwd, sources, { threshold, expect }, invocationDir).
 * [POS]: Offline comparison of two PNGs (files or single-image preview tasks), writing a difference image. bridge uses the same diffPng for run --expect.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diffPng } from './png.mjs';
import { localResult } from './record.mjs';
import { root, hash, isJobId } from './project.mjs';

// Resolve file paths relative to invocation cwd; look up task IDs in project evidence. Pass images/ files directly for batch exports.
/** @param {string} cwd @param {string} value @param {string} invocationDir */
async function source(cwd, value, invocationDir) {
  if (!isJobId(value)) return path.resolve(invocationDir, value);
  const record = await localResult(cwd, value);
  const images = record.result?.images ?? [];
  if (record.job.operation !== 'preview' || !record.journalComplete || record.result?.ok !== true || images.length !== 1) throw Error('The job must be a completed single-image preview; for batch exports pass image paths under images/');
  return path.join(record.evidence, images[0].file);
}

/** @param {string} cwd @param {string[]} sources @param {{ threshold?: number, expect?: string }} [options] */
export async function imageDiff(cwd, sources, { threshold = 0, expect } = {}, invocationDir = process.cwd()) {
  const [before, after] = await Promise.all(sources.map(value => source(cwd, value, invocationDir)));
  const [a, b] = await Promise.all([fs.readFile(before), fs.readFile(after)]);
  const { image, ...stats } = diffPng(a, b, threshold);
  // Write .figma-agent-control/diffs only inside bound projects; elsewhere use the system temporary directory, leaving arbitrary directories untouched.
  let dir = path.join(os.tmpdir(), 'figma-agent-control-diffs');
  try { await fs.access(path.join(root(cwd), 'binding.json')); dir = path.join(root(cwd), 'diffs'); } catch { /* Not a project directory.*/ }
  const diffImage = path.join(dir, `${hash(a).slice(0, 12)}-${hash(b).slice(0, 12)}-t${threshold}.png`), temp = `${diffImage}.${process.pid}.tmp`;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(temp, image, { mode: 0o600 }); await fs.rename(temp, diffImage);
  const changed = !stats.sameSize || stats.changedPixels > 0;
  return { beforeFile: before, afterFile: after, ...stats, changed, diffImage,
    ...(expect ? { expect, expectation: (expect === 'changed') === changed ? 'passed' : 'failed' } : {}),
    // List the most common causes when change was expected but absent, saving a diagnostic round trip.
    ...(expect === 'changed' && !changed ? { hint: 'The rendering did not change. Check in order: whether the write target is a mask, hidden or transparent layer; whether a child layer or bitmap above covers it (bitmaps often carry their own background, so changing the container color has no effect); whether the new color equals the color beneath; whether the before and after exports are of the same node and the after export was taken after the write' } : {}),
    limitation: 'Compares the overlapping area pixel by pixel (colors with premultiplied alpha); a size difference counts as a change; export padding, scaling and anti-aliasing can cause differences' };
}
