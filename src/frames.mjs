/**
 * [INPUT]: Uses ./html/chrome.mjs launch for video decoding, frame capture and contact sheets; ./png.mjs diffPng; ./record.mjs localResult; and ./project.mjs root/hash/isJobId.
 * [OUTPUT]: frames(cwd, source, { atSeconds, frameCount, compareSource, dump }, invocationDir, chromeOptions) -> summary with contact-sheet paths, sample times, comparison pixel counts, and optional individual PNG paths.
 * [POS]: Converts run-exported MP4/WebM into timestamped PNG contact sheets that agents can inspect. --dump also saves full-size frames for quantitative checks; --compare compares both videos at identical sample times.
 *        Waits for loadeddata and the first presented-frame callback before sampling; subsequent seeks wait for seeked and a presented frame, unless Chrome's settled time is unchanged and the ready frame can be reused.
 *        Serializes each canvas before the next seek so dumps and contact sheets consume the captured pixels.
 *        Shares diffPng's change definition with image-diff and run --expect; byte-identical videos trigger a possible stale-export hint. Sample indices prevent rounded-millisecond filename collisions. Runs offline without bridge access and uses only html/chrome, like doctor.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launch } from './html/chrome.mjs';
import { diffPng } from './png.mjs';
import { localResult } from './record.mjs';
import { root, hash, isJobId } from './project.mjs';

const DEFAULT_COUNT = 8, SHEET_WIDTH = 1600, MIN_CELL = 160, LABEL = 22, GAP = 8;

// Resolve paths relative to invocation cwd; task IDs locate exactly one returned video in project evidence, using bridge file descriptors with type mp4 or webm.
/** @param {string} cwd @param {string} value @param {string} invocationDir */
async function source(cwd, value, invocationDir) {
  if (!isJobId(value)) return path.resolve(invocationDir, value);
  const record = await localResult(cwd, value);
  if (record.job.operation !== 'run' || record.result?.ok !== true) throw Error(`Job ${value} must be a successfully completed run`);
  /** @type {string[]} */
  const videos = [];
  /** @param {unknown} v */
  const walk = v => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const file = /** @type {{ file?: unknown, type?: unknown }} */ (v);
      if (typeof file.file === 'string' && (file.type === 'mp4' || file.type === 'webm')) videos.push(path.join(record.evidence, file.file));
      else Object.values(v).forEach(walk);
    }
  };
  walk(record.result.output);
  if (videos.length !== 1) throw Error(videos.length ? `Job ${value} returned ${videos.length} video(s); pass a file path directly: ${videos.join(', ')}` : `Job ${value} has no MP4 or WebM in its return value`);
  return videos[0];
}

// Page script: omit MIME type so Chrome detects the container; keep elements on window.__fac for later capture and contact-sheet assembly.
// loadeddata can precede a drawable first frame for detached videos; register both readiness signals before loading.
/** @param {string[]} videos base64 */
const LOAD = videos => `(async () => {
  window.__fac = { videos: [], frames: [] };
  for (const b64 of ${JSON.stringify(videos)}) {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
    const loaded = new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error('Cannot decode the video (' + ((v.error && v.error.message) || 'unknown reason') + '): only MP4 (H.264, depending on the Chrome build) and WebM are supported; for GIF or decode failures, export as WEBM instead')); });
    const presented = new Promise(ok => v.requestVideoFrameCallback(ok));
    v.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    await Promise.all([loaded, presented]);
    window.__fac.videos.push(v);
  }
  return window.__fac.videos.map(v => ({ width: v.videoWidth, height: v.videoHeight, duration: v.duration }));
})()`;
/** @param {number[]} times */
const CAPTURE = times => `(async () => {
  const out = [];
  for (const v of window.__fac.videos) {
    const frames = [], pngs = [];
    for (const t of ${JSON.stringify(times)}) {
      if (v.currentTime !== t) {
        const previous = v.currentTime;
        let callback;
        const sought = new Promise(ok => { v.onseeked = ok; });
        const presented = new Promise(ok => { callback = v.requestVideoFrameCallback(ok); });
        v.currentTime = t; await sought;
        // Chrome can settle very close times at the same position without presenting another frame.
        if (v.currentTime !== previous) await presented;
        else v.cancelVideoFrameCallback(callback);
      }
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
      // Materialize this frame's pixels before another seek changes the video.
      pngs.push(c.toDataURL('image/png').split(',')[1]);
      frames.push(c);
    }
    window.__fac.frames.push(frames);
    out.push(pngs);
  }
  return out;
})()`;
// Contact sheet: one cell per time, source above comparison when present, label above both. Up to 4 cells per row (6 with comparison), total width capped at SHEET_WIDTH; scale frames proportionally by width.
// Enlarge videos narrower than MIN_CELL using nearest-neighbor sampling so labels fit without blurring pixels.
/** @param {string[]} labels */
const SHEET = labels => `(() => {
  const labels = ${JSON.stringify(labels)}, sets = window.__fac.frames, n = labels.length, cols = Math.min(n, sets.length > 1 ? 6 : 4), rows = Math.ceil(n / cols);
  const maxW = Math.max(...sets.map(s => s[0].width)), cellW = Math.min(Math.max(maxW, ${MIN_CELL}), Math.floor((${SHEET_WIDTH} - ${GAP} * (cols - 1)) / cols));
  const heights = sets.map(s => Math.round(s[0].height * cellW / s[0].width)), cellH = ${LABEL} + heights.reduce((a, h) => a + h, 0) + 4 * (sets.length - 1);
  const c = document.createElement('canvas'); c.width = cols * cellW + (cols - 1) * ${GAP}; c.height = rows * cellH + (rows - 1) * ${GAP};
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.font = '13px sans-serif'; g.textBaseline = 'middle'; g.imageSmoothingEnabled = cellW <= maxW;
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * (cellW + ${GAP}); let y = Math.floor(i / cols) * (cellH + ${GAP});
    g.fillStyle = '#111'; g.fillText(labels[i], x + 2, y + ${LABEL} / 2); y += ${LABEL};
    sets.forEach((frames, k) => { g.drawImage(frames[i], x, y, cellW, heights[k]); g.strokeStyle = '#bbb'; g.strokeRect(x + 0.5, y + 0.5, cellW - 1, heights[k] - 1); y += heights[k] + 4; });
  }
  return c.toDataURL('image/png').split(',')[1];
})()`;

/** @param {string} file @param {Buffer} bytes Write a temporary file then rename, preventing readers from seeing a partial PNG. */
async function save(file, bytes) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, bytes, { mode: 0o600 }); await fs.rename(temp, file);
}

/** @param {string} cwd @param {string} sourceValue @param {{ atSeconds?: number[], frameCount?: number, compareSource?: string, dump?: boolean }} [options] @param {{ timeout?: number }} [chromeOptions] */
export async function frames(cwd, sourceValue, { atSeconds, frameCount = DEFAULT_COUNT, compareSource, dump = false } = {}, invocationDir = process.cwd(), chromeOptions = {}) {
  const files = [await source(cwd, sourceValue, invocationDir), ...(compareSource !== undefined ? [await source(cwd, compareSource, invocationDir)] : [])];
  const bytes = await Promise.all(files.map(file => fs.readFile(file)));
  const browser = await launch(chromeOptions);
  try {
    const page = await browser.page();
    await page.open('about:blank', 100, 100);
    /** @type {{ width: number, height: number, duration: number }[]} */
    const meta = await page.evaluate(LOAD(bytes.map(b => b.toString('base64'))));
    const duration = Math.min(...meta.map(m => m.duration));
    // Default to uniform sampling, placing the final frame 0.05 s before the end to avoid seeking beyond duration.
    const last = Math.max(0, duration - 0.05);
    const times = atSeconds ?? Array.from({ length: frameCount }, (_, i) => Math.round(i * last / (frameCount - 1) * 1000) / 1000);
    const late = times.filter(t => t > duration);
    if (late.length) throw Error(`--at exceeds the video duration of ${Math.round(duration * 1000) / 1000} s: ${late.join(', ')}`);
    /** @type {string[][]} */
    const shots = await page.evaluate(CAPTURE(times));
    const diffs = shots.length > 1 ? times.map((_, i) => diffPng(Buffer.from(shots[0][i], 'base64'), Buffer.from(shots[1][i], 'base64'))) : null;
    const labels = times.map((t, i) => `${t.toFixed(2)} s` + (diffs ? `  Δ ${diffs[i].changedPixels} px` : ''));
    const sheetBytes = Buffer.from(await page.evaluate(SHEET(labels)), 'base64');
    // Write .figma-agent-control/frames only inside bound projects; otherwise use the system temporary directory, like image-diff.
    let dir = path.join(os.tmpdir(), 'figma-agent-control-frames');
    try { await fs.access(path.join(root(cwd), 'binding.json')); dir = path.join(root(cwd), 'frames'); } catch { /* Not a project directory.*/ }
    const sheet = path.join(dir, `${bytes.map(b => hash(b).slice(0, 12)).join('-')}-${hash(times.join(',')).slice(0, 8)}.png`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await save(sheet, sheetBytes);
    // --dump: sample indices prevent collisions when precise times round to the same millisecond; comparison frames add -compare.
    const dumped = dump ? sheet.slice(0, -'.png'.length) : null;
    /** @param {number} i */
    const frameFile = (i, compare = false) => `${String(i + 1).padStart(2, '0')}-${times[i].toFixed(3)}s${compare ? '-compare' : ''}.png`;
    if (dumped) {
      await fs.mkdir(dumped, { recursive: true, mode: 0o700 });
      await Promise.all(shots.flatMap((set, k) => set.map((b64, i) => save(path.join(dumped, frameFile(i, k > 0)), Buffer.from(b64, 'base64')))));
    }
    return { source: files[0], ...(files[1] ? { compare: files[1] } : {}), width: meta[0].width, height: meta[0].height, duration: Math.round(duration * 1000) / 1000, sheet,
      frames: times.map((t, i) => ({ t, ...(dumped ? { file: path.join(dumped, frameFile(i)), ...(files[1] ? { compareFile: path.join(dumped, frameFile(i, true)) } : {}) } : {}),
        ...(diffs ? { changedPixels: diffs[i].changedPixels, sameSize: diffs[i].sameSize } : {}) })),
      ...(diffs ? { changed: diffs.some(d => !d.sameSize || d.changedPixels > 0), layout: 'Each cell shows the source on top and the comparison below; the delta in each label is the number of changed pixels at that time' } : {}),
      // Figma video export can lag edits, returning the previous video immediately after a change. Byte-identical videos often indicate this; report it explicitly.
      ...(bytes[1]?.equals(bytes[0]) ? { warning: 'The two videos are byte-identical: if the motion was changed in between, the post-change export may still be the old one (Figma video export lags behind edits, observed up to several minutes); use differentFrom of exportMotion to wait until the export reflects the change, then compare' } : {}),
      limitation: 'Each time takes the frame covering it, so precision is limited by the export frame rate; at most 24 times per call, split denser sampling across several --at calls; frames in the contact sheet are scaled down to fit the width, for original size use --dump or --at with a single time' };
  } finally { await browser.close(); }
}
