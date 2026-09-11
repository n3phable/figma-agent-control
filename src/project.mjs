/**
 * [INPUT]: Imports node:fs/promises, node:path, node:os, node:crypto.
 * [OUTPUT]: Exports hash, root, json, writeAtomic, save, pluginHome, installPlugin, isJobId, isNodeId, parseTarget, readBinding, init.
 * [POS]: Foundation for bound workspaces, evidence paths, atomic writes and plugin installation.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const root = cwd => path.join(cwd, '.figma-agent-control');
export async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

// -- Atomic writes ------------------------------------------------------
// Write a temporary file in the same directory, then rename: readers see either the old file or the complete new file.
// exclusive uses link: existing destinations fail with EEXIST without replacement, ensuring one winner in concurrent first-time creation.
// compact is for evidence: indentation can triple large-tree size; readers use jq or json().
export async function writeAtomic(file, text, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, text, { mode: 0o600, flag: 'wx' }); await (exclusive ? fs.link : fs.rename)(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
export async function save(file, value, compact = false) {
  return writeAtomic(file, (compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n');
}

// -- Global plugin ------------------------------------------------------
// The bridge uses one fixed port, so only one project bridge can run at a time. One global plugin and pairing credential are shared; binding metadata arrives in bridge responses.
// Per-project installation would leave duplicate plugin names in Figma. FIGMA_AGENT_CONTROL_HOME is only for tests or location overrides.
export const pluginHome = () => process.env.FIGMA_AGENT_CONTROL_HOME || path.join(os.homedir(), '.config', 'figma-agent-control');
// Write changed content only: development-plugin file changes trigger Figma hot reload, so unchanged content should not interrupt a running plugin.
export async function installPlugin(home, files) {
  const dir = path.join(home, 'plugin');
  let changed = false;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (await fs.readFile(file, 'utf8').catch(() => null) === text) continue;
    await writeAtomic(file, text);
    changed = true;
  }
  return { manifest: path.join(dir, 'manifest.json'), changed };
}

// -- Identifiers --------------------------------------------------------
// Task IDs are requestIds (lowercase UUIDs avoid runs/<id> collisions on case-insensitive file systems); node IDs accept only Figma's full format, including ';' chains for instance descendants.
export const isJobId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const isNodeId = value => typeof value === 'string' && value.length <= 1024 && /^(?:\d+:\d+|I\d+:\d+(?:;\d+:\d+)+)$/.test(value);

// -- Binding ------------------------------------------------------------
// A project directory binds one scope node in one file. The plugin verifies task targets lie inside that scope; run scripts receive the full figma object and are not sandboxed to it.
export function parseTarget(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname) || url.username || url.password || url.port) throw Error('A valid HTTPS Figma link is required');
  const match = url.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9_-]+)(?:\/|$)/);
  const nodeId = url.searchParams.get('node-id')?.replace(/-/g, ':');
  if (!match || !/^\d+:\d+$/.test(nodeId || '')) throw Error('Provide a frame or page link that contains node-id');
  return { format: FORMAT, id: crypto.randomUUID(), sourceUrl: url.href, fileKey: match[1], nodeId, boundAt: new Date().toISOString() };
}

// Legacy figma-local and this tool's former name used .figma-agent/; current evidence uses .figma-agent-control/. The format version also rejects copied legacy evidence.
const FORMAT = 2;
export async function readBinding(cwd) {
  const binding = await json(path.join(root(cwd), 'binding.json'));
  if (binding.format !== FORMAT) throw Object.assign(Error('This project directory uses a legacy format and figma-agent-control does not read old evidence; run figma-agent-control init in a new directory'), { code: 'LEGACY_PROJECT' });
  return binding;
}

export async function init(cwd, url) {
  const binding = parseTarget(url);
  const dir = root(cwd);
  try { await fs.mkdir(dir, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(Error('The current directory already has a binding; the existing binding was kept. Use a new project directory to connect another file.'), { code: 'EEXIST' });
    throw error;
  }
  await save(path.join(dir, 'binding.json'), binding);
  const ignore = path.join(cwd, '.gitignore');
  let current = '';
  try { current = await fs.readFile(ignore, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!current.split(/\r?\n/).includes('.figma-agent-control/')) await fs.appendFile(ignore, `${current && !current.endsWith('\n') ? '\n' : ''}.figma-agent-control/\n`);
  return { binding, next: 'figma-agent-control connect' };
}
