/**
 * [INPUT]: Uses node:child_process spawn/execFile, node:fs, node:os, node:path, node:util and local Chrome or Chromium.
 * [OUTPUT]: FLAGS, findChrome(env) -> executable path, chromeVersion(file) -> version text or CHROME_VERSION_TIMEOUT after 10 s,
 *           launch({ executable, timeout }) -> { version, pid, profile, page(), close() };
 *           page() -> { browser, open(url, width, height, dsf?), shot(clip?), evaluate(expression), cdp(method, params?), close() }.
 * [POS]: Minimal dependency-free CDP rendering layer. command launches it for check/zoom; doctor uses it for diagnostics. Uses Node built-ins only.
 *        Uses --remote-debugging-pipe exclusively: Chrome exits when SIGKILL closes its parent's pipe, unlike port mode, which can leave orphans.
 *        Registers SIGINT/SIGTERM/SIGHUP and exit cleanup before profile creation through browser shutdown; termination or process.exit kills Chrome and removes profiles. Normal close and synchronous exit cleanup retry whole-directory removal while subprocesses finish writing. Only SIGKILL can leave fac-chrome-* directories.
 *        Errors: CHROME_NOT_FOUND during lookup, CHROME_LAUNCH_FAILED during startup, CHROME_PROTOCOL for non-CDP pipe messages,
 *        CHROME_EXITED for unexpected exit (rejecting pending and later commands), and RENDER_TIMEOUT for command/event deadlines.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/** @param {string} message @param {string} code */
const fail = (message, code) => Object.assign(Error(message), { code });

// The first four flags affect pixels: headless, --disable-gpu for hardware-independent software rasterization matching the ui2html 0/60 baseline, sRGB, and hidden scrollbars.
// Remaining flags ensure quiet, repeatable runs without network access, first-run dialogs or keychain access.
export const FLAGS = ['--headless', '--disable-gpu', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--use-mock-keychain',
  '--password-store=basic', '--disable-features=PaintHolding,Translate,OptimizationHints,MediaRouter', '--no-startup-window'];

// -- Discovery ----------------------------------------------------------
// Search environment override, default macOS application paths, then PATH. An invalid override fails immediately; fallback would defeat version pinning.
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** @param {string} file */
const runnable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };

export function findChrome(env = process.env) {
  const pinned = env.FIGMA_AGENT_CONTROL_CHROME;
  if (pinned) {
    if (runnable(pinned)) return pinned;
    throw fail(`FIGMA_AGENT_CONTROL_CHROME points to a file that does not exist or is not executable: ${pinned}`, 'CHROME_NOT_FOUND');
  }
  const found = [MAC_CHROME, ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(dir => ['google-chrome', 'chromium'].map(name => path.join(dir, name)))].find(runnable);
  if (!found) throw fail('Chrome not found: install Google Chrome, or set the FIGMA_AGENT_CONTROL_CHROME environment variable to the executable', 'CHROME_NOT_FOUND');
  return found;
}

// doctor calls this each time. A non-exiting executable can delay at most 10 s before CHROME_VERSION_TIMEOUT. Observed --version calls exceed 3 s when Chrome is already running, while rendering still starts normally,
// so timeout means only that version lookup failed, not that Chrome is unusable.
/** @param {string} file */
export async function chromeVersion(file) {
  try { return (await promisify(execFile)(file, ['--version'], { timeout: 10000 })).stdout.trim(); }
  catch (error) { throw error.killed ? fail(`${file} --version did not return within 10 s`, 'CHROME_VERSION_TIMEOUT') : error; }
}

// -- Cleanup on abnormal exit -------------------------------------------
// close() runs only on normal completion or finally. On signals (Ctrl-C or an agent timeout's SIGTERM), process.exit or uncaught errors,
// synchronously terminate every Chrome started here and remove its profile. After handling a signal, remove this handler and resend the signal to preserve normal process termination;
// if another handler exists, let it decide whether to continue. SIGKILL cannot be caught: Chrome exits when the pipe closes, leaving profile cleanup to the system temporary-directory policy.
/** @typedef {{ proc: import('node:child_process').ChildProcess, profile: string }} Live */
const live = /** @type {Set<Live>} */ (new Set()), SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);
const PROFILE_RETRIES = 3;
let listening = false;
/** @param {string} profile */
function removeProfileSync(profile) {
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: PROFILE_RETRIES }); return; }
    catch (error) {
      // rmSync retries rmdir without enumerating again; a late-created child requires a fresh recursive scan.
      if (error.code !== 'ENOTEMPTY' || attempt === PROFILE_RETRIES) throw error;
    }
  }
}
function reap() {
  for (const b of live) { b.proc.kill('SIGKILL'); removeProfileSync(b.profile); }
  live.clear(); listen(false);
}
/** @param {NodeJS.Signals} signal */
function onSignal(signal) { reap(); if (!process.listenerCount(signal)) process.kill(process.pid, signal); }
// Idempotent: if profile creation or spawn throws synchronously, handlers are registered but live is empty; the next launch must not register duplicates.
/** @param {boolean} on */
function listen(on) {
  if (listening === on) return;
  listening = on;
  for (const signal of SIGNALS) process[on ? 'on' : 'off'](signal, onSignal);
  process[on ? 'on' : 'off']('exit', reap);
}
/** @param {Live} b */
const unwatch = b => { if (live.delete(b) && !live.size) listen(false); };

// -- Launch -------------------------------------------------------------
// Pipe protocol writes to child fd3 and reads fd4, with each JSON message terminated by \0. CDP has no built-in deadline,
// so bound every command and event wait by timeout, reporting RENDER_TIMEOUT instead of hanging forever.
// Pending commands/event waits: CDP result and event shapes vary by method, so pass them to callers as any.
/** @typedef {{ resolve(value: any): void, reject(error: Error): void, method: string, sessionId?: string, timer?: NodeJS.Timeout }} Entry */
/** @param {{ executable?: string, timeout?: number }} [options] */
export async function launch({ executable = findChrome(), timeout = 30000 } = {}) {
  // Register signal handlers before profile creation and spawn. A signal before registration would immediately terminate the process and leave the new profile or starting Chrome unowned;
  // signals arriving afterward run only once this synchronous block ends, when live already contains the browser.
  listen(true);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-chrome-'));
  const proc = spawn(executable, [...FLAGS, `--user-data-dir=${profile}`, '--remote-debugging-pipe'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  // fd3 writes to Chrome and fd4 reads from it; spawn types do not distinguish the directions of stdio entries 4 and 5.
  const toChrome = /** @type {import('node:stream').Writable} */ (proc.stdio[3]), fromChrome = /** @type {import('node:stream').Readable} */ (proc.stdio[4]);
  const self = { proc, profile };
  live.add(self);
  const exited = new Promise(resolve => { proc.once('exit', code => resolve(code)); proc.once('error', (/** @type {NodeJS.ErrnoException} */ error) => resolve(error.code)); });
  let seq = 0, gone = /** @type {Error | null} */ (null), broken = /** @type {Error | null} */ (null);
  const pending = /** @type {Map<number, Entry>} */ (new Map()), waiters = /** @type {Set<Entry>} */ (new Set());
  /** @param {Entry} entry @param {'resolve' | 'reject'} method @param {any} value */
  const settle = (entry, method, value) => { clearTimeout(entry.timer); entry[method](value); };
  exited.then(code => {
    gone = broken ?? fail(`Chrome exited (${code})`, 'CHROME_EXITED');
    for (const entry of [...pending.values(), ...waiters]) settle(entry, 'reject', gone);
    pending.clear(); waiters.clear();
  });
  // The write end can emit EPIPE after Chrome exits. exited owns error reporting; this handler only prevents an unhandled error from terminating the host.
  toChrome.on('error', () => {}); fromChrome.on('error', () => {});
  // Split incoming bytes at \0, joining Buffers before decoding because chunks may bisect multibyte characters. If the peer sends non-JSON, such as a non-Chrome executable,
  // terminate it and let exited reject pending commands with CHROME_PROTOCOL; never let callback exceptions terminate the host process.
  /** @type {Buffer[]} */
  let parts = [];
  fromChrome.on('data', (/** @type {Buffer} */ chunk) => {
    let start = 0, end;
    while (!broken && (end = chunk.indexOf(0, start)) >= 0) {
      parts.push(chunk.subarray(start, end));
      let message;
      try { message = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { broken = fail('Chrome pipe returned an unparsable message; process killed', 'CHROME_PROTOCOL'); proc.kill('SIGKILL'); return; }
      receive(message); parts = []; start = end + 1;
    }
    if (!broken && start < chunk.length) parts.push(chunk.subarray(start));
  });
  /** @param {{ id?: number, method?: string, sessionId?: string, error?: { message: string }, result?: unknown, params?: unknown }} message */
  function receive(message) {
    const entry = message.id && pending.get(message.id);
    if (entry) { pending.delete(/** @type {number} */ (message.id)); settle(entry, message.error ? 'reject' : 'resolve', message.error ? Error(`${entry.method}: ${message.error.message}`) : message.result); return; }
    for (const w of waiters) if (w.method === message.method && w.sessionId === message.sessionId) { waiters.delete(w); settle(w, 'resolve', message.params); return; }
  }
  /** @param {Entry} entry @param {string} label @param {() => void} drop */
  const limit = (entry, label, drop) => { entry.timer = setTimeout(() => { drop(); entry.reject(fail(`Chrome did not complete ${label} within ${timeout / 1000} s`, 'RENDER_TIMEOUT')); }, timeout); return entry; };
  /** @param {string} method @param {object} [params] @param {string} [sessionId] @returns {Promise<any>} */
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (gone) return reject(gone);
    const id = ++seq;
    pending.set(id, limit({ resolve, reject, method }, method, () => pending.delete(id)));
    toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  // Event waits are cancellable and consume events in registration order. Leaving abandoned waiters registered would steal the next event of that name.
  /** @param {string} method @param {string} sessionId */
  const once = (method, sessionId) => {
    /** @type {Entry | undefined} */
    let w;
    const promise = /** @type {Promise<any> & { cancel(): void }} */ (new Promise((resolve, reject) => {
      if (gone) return reject(gone);
      w = limit({ resolve, reject, method, sessionId }, method, () => waiters.delete(/** @type {Entry} */ (w)));
      waiters.add(w);
    }));
    promise.cancel = () => { if (w && waiters.delete(w)) clearTimeout(w.timer); };
    return promise;
  };

  // Shared cleanup for failed startup and normal close: request graceful shutdown, then force termination after 5 s because a hung renderer may ignore Browser.close.
  async function close() {
    send('Browser.close').catch(() => {});
    const kill = setTimeout(() => proc.kill('SIGKILL'), 5000);
    await exited; clearTimeout(kill);
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: PROFILE_RETRIES });
    unwatch(self);
  }

  /** @type {string} */
  let version;
  try {
    version = (await Promise.race([send('Browser.getVersion'), exited.then(code => { throw Error(`process exited immediately after start (${code})`); })])).product;
  } catch (error) {
    await close();
    throw fail(`Chrome failed to launch (${executable}): ${error.message}`, 'CHROME_LAUNCH_FAILED');
  }

  // Each page gets an independent browser context/window; background tabs in the same window may never produce frames or invoke requestAnimationFrame.
  async function page() {
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    /** @param {string} method @param {object} [params] */
    const s = (method, params) => send(method, params, sessionId);
    await s('Page.enable');
    // Use transparent default backgrounds so transparent canvases screenshot as alpha 0, matching Figma export semantics.
    await s('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    /** @param {string} expression */
    const evaluate = async expression => {
      const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw Error(`Page script error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    /** @type {{ width: number, height: number } | undefined} */
    let size;
    return {
      // cdp sends raw commands on this page's session with the same timeout, enabling checks such as actual font lookup unavailable to page scripts.
      browser: { version, args: FLAGS }, evaluate, cdp: s,
      // Viewport dimensions are CSS screenshot size; output pixels multiply by dsf (default 1, zoom up to 4). CDP accepts only integer dimensions, so callers choose rounding
      // (check uses reference-image dimensions). Do not round silently here, which would mismatch requested and actual screenshots.
      /** @param {string} url @param {number} width @param {number} height @param {number} [dsf] */
      async open(url, width, height, dsf = 1) {
        if (![width, height].every(v => Number.isInteger(v) && v > 0)) throw Error(`Viewport size must be positive integers: ${width}x${height}`);
        if (!(Number.isFinite(dsf) && dsf > 0 && dsf <= 4)) throw Error(`dsf must be a number in (0, 4]: ${dsf}`);
        size = { width, height };
        await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false, screenWidth: width, screenHeight: height });
        const loaded = once('Page.loadEventFired', sessionId);
        loaded.catch(() => {});
        try {
          const nav = await s('Page.navigate', { url });
          if (nav.errorText) throw Error(`Page failed to load: ${nav.errorText} (${url})`);
        } catch (error) { loaded.cancel(); throw error; }
        await loaded;
        // After fonts are ready, wait two animation frames for decoded bitmaps to composite, avoiding fixed delays.
        await evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
      },
      // Without clip, capture the entire viewport; shot follows open, so size is initialized.
      async shot(clip = { x: 0, y: 0, .../** @type {{ width: number, height: number }} */ (size) }) {
        const { data } = await s('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
        return Buffer.from(data, 'base64');
      },
      close: async () => { await send('Target.closeTarget', { targetId }); await send('Target.disposeBrowserContext', { browserContextId }); }
    };
  }
  return { version, pid: proc.pid, profile, page, close };
}
