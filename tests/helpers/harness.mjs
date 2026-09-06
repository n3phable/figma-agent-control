/**
 * [INPUT]: Imports node:fs/promises, node:os, node:path, node:vm, node:crypto, node:child_process, node:util, node:url, node:timers/promises, ../../src/project.mjs, ../../src/session.mjs, ../../src/png.mjs.
 * [OUTPUT]: Exports cliFile, pluginSource, createDoc, fakeFigma, harness, writeScript.
 * [POS]: Isolated test fixtures shared by the surrounding contract and integration suites.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { init, installPlugin } from '../../src/project.mjs';
import { pairingToken } from '../../src/session.mjs';
import { encodePng } from '../../src/png.mjs';

const exec = promisify(execFile);
export const cliFile = fileURLToPath(new URL('../../bin/figma-agent-control.mjs', import.meta.url));
export const pluginSource = await fs.readFile(new URL('../../plugin/main.js', import.meta.url), 'utf8');

// -- Mock document --------------------------------------------------------
// Page 1:1 contains bound frame 1:2, text 1:3 and swatch 1:4. exportAsync renders the current node fill so tests observe actual visual changes.
// so --expect observes actual visual changes.
export function createDoc() {
  const node = (id, type, name, extra = {}) => ({ id, type, name, removed: false, visible: true, ...extra });
  const page = node('1:1', 'PAGE', '\u9875\u9762', { children: [], loadAsync: async () => {} });
  const frame = node('1:2', 'FRAME', '\u753b\u677f', { width: 100, height: 50, fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1 } }], children: [] });
  const text = node('1:3', 'TEXT', '\u6807\u9898', { characters: '\u539f\u6587', width: 40, height: 20 });
  const swatch = node('1:4', 'RECTANGLE', '\u8272\u5757', { width: 10, height: 10, fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0, g: 0, b: 1 } }] });
  page.children.push(frame); frame.parent = page;
  frame.children.push(text, swatch); text.parent = frame; swatch.parent = frame;
  const all = new Map([page, frame, text, swatch].map(n => [n.id, n]));
  const pixel = n => { const c = n.fills?.[0]?.color ?? { r: 0.5, g: 0.5, b: 0.5 }; return [c.r, c.g, c.b].map(v => Math.round(v * 255)).concat(255); };
  for (const n of all.values()) if (n.type !== 'PAGE') n.exportAsync = async options => {
    const scale = options?.constraint?.value ?? 1, w = Math.max(1, Math.round(2 * scale)), h = Math.max(1, Math.round(2 * scale));
    return encodePng(w, h, new Uint8Array(Array.from({ length: w * h }, () => pixel(n)).flat()));
  };
  return { page, frame, text, swatch, all };
}

export function fakeFigma(doc, { fileKey = 'example', onUi = () => {} } = {}) {
  const figma = {
    fileKey, mode: 'default', editorType: 'figma', currentPage: doc.page,
    showUI() {}, commitUndo() {}, base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    getNodeByIdAsync: async id => { const n = doc.all.get(id); return n && !n.removed ? n : null; },
    setCurrentPageAsync: async page => { figma.currentPage = page; },
    variables: {
      getLocalVariableCollectionsAsync: async () => [{ id: 'C:1', name: '\u989c\u8272', modes: [{ modeId: 'M:1', name: '\u9ed8\u8ba4' }], defaultModeId: 'M:1' }],
      getLocalVariablesAsync: async () => [{ id: 'VariableID:1:1', name: 'brand', variableCollectionId: 'C:1', resolvedType: 'COLOR', valuesByMode: { 'M:1': { r: 0, g: 0, b: 1, a: 1 } }, scopes: ['ALL_FILLS'] }]
    },
    ui: { show() {}, hide() {}, postMessage: message => onUi(message) }
  };
  return figma;
}

// -- End-to-end fixture ---------------------------------------------------
// Real bridge on a random port with real main.js and ui.html in VMs. Replace UI setInterval with manual tick;
// drive(promise) pumps polling until the promise settles.
export async function harness(t, { url = 'https://www.figma.com/design/example/Test?node-id=1-2', fileKey = 'example' } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-agent-control-test-'));
  await init(cwd, url);
  // Follow connect: global pairing credentials, bridge startup, then plugin installation. Use a test-owned temporary global plugin directory;
  // CLI subprocesses read it through FIGMA_AGENT_CONTROL_HOME without touching the real installation. Short holds still exercise long-poll waiting, wakeup, and renewal without waiting 10 s.
  const home = path.join(cwd, 'plugin-home');
  const bridge = await start(cwd, 0, { pollHoldMs: 50, pluginToken: await pairingToken(home) });
  let closed = false;
  t.after(async () => { if (!closed) await bridge.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  await installPlugin(home, bridge.plugin);
  const { 'ui.html': html, 'main.js': main } = bridge.plugin;
  const doc = createDoc(), pending = new Set(), errors = [];
  const track = promise => { const work = Promise.resolve(promise).catch(error => errors.push(error)).finally(() => pending.delete(work)); pending.add(work); };
  const window = {}, elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false }); return elements.get(id); };
  const figma = fakeFigma(doc, { fileKey, onUi: message => track(window.onmessage({ data: { pluginMessage: structuredClone(message) } })) });
  const parent = { postMessage: message => track(figma.ui.onmessage(structuredClone(message.pluginMessage))) };
  // Gate continuous long-poll delivery: pause() blocks new plugin requests and drains in-flight ones, leaving tasks queued. drive releases the gate automatically.
  // requests records each plugin request path and JSON body in send order, avoiding panel-refresh timing dependencies in retry assertions.
  const gate = { open: true, inflight: new Set(), waiters: [] }, requests = [];
  const gatedFetch = async (...args) => {
    while (!gate.open) await new Promise(resolve => gate.waiters.push(resolve));
    requests.push({ path: new URL(args[0]).pathname, body: args[1]?.body === undefined ? undefined : JSON.parse(args[1].body) });
    const request = fetch(...args);
    gate.inflight.add(request);
    try { return await request; } finally { gate.inflight.delete(request); }
  };
  const pause = async () => { gate.open = false; await Promise.allSettled([...gate.inflight]); };
  const resume = () => { gate.open = true; for (const wake of gate.waiters.splice(0)) wake(); };
  let tick;
  vm.runInNewContext(main, { figma, __html__: html, setTimeout, clearTimeout });
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], { window, parent, crypto, fetch: gatedFetch, AbortSignal, TextEncoder,
    document: { visibilityState: 'visible', addEventListener() {}, getElementById: element }, setInterval: callback => { tick = callback; } });
  const settle = async () => { while (pending.size) await Promise.all([...pending]); };
  const drive = async promise => {
    resume();
    let done = false; const result = promise.finally(() => { done = true; });
    while (!done) { await tick(); await settle(); await delay(10); }
    return result;
  };
  const cli = async (...args) => {
    try { const { stdout } = await exec(process.execPath, [cliFile, ...args], { cwd, env: { ...process.env, FIGMA_AGENT_CONTROL_HOME: home } }); return { code: 0, json: JSON.parse(stdout) }; }
    catch (error) { return { code: error.code, json: JSON.parse(error.stdout || 'null'), stderr: error.stderr }; }
  };
  await tick(); await settle();
  return { cwd, home, bridge, figma, doc, element, errors, requests, tick, settle, drive, cli, html, main, pause, resume,
    // Run CLI while pumping the plugin, suitable for submissions that wait for a result by default.
    run: (...args) => drive(cli(...args)),
    close: async () => { closed = true; await bridge.close(); } };
}

export async function writeScript(cwd, name, code) {
  const file = path.join(cwd, name);
  await fs.writeFile(file, code);
  return file;
}
