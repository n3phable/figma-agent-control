/**
 * [INPUT]: Imports node:util, ./project.mjs.
 * [OUTPUT]: Exports COMMANDS, parse.
 * [POS]: CLI input boundary: validate command syntax and normalize options into command records.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { parseArgs } from 'node:util';
import { isJobId, isNodeId } from './project.mjs';

const wait = /** @type {const} */ ({ timeout: { type: 'string' }, 'no-wait': { type: 'boolean' }, full: { type: 'boolean' } });
const node = /** @type {const} */ ({ node: { type: 'string' } });
// positionals: [minimum, maximum]; submit: wait for the result by default after submitting a task.
/** @typedef {{ usage: string, positionals: [number, number], submit?: true, options: import('node:util').ParseArgsOptionsConfig }} Command */
/** @type {Record<string, Command>} */
export const COMMANDS = {
  help: { usage: 'help', positionals: [0, 0], options: {} },
  init: { usage: 'init <figma-url>: bind the current directory to a scope node in one file', positionals: [1, 1], options: {} },
  connect: { usage: 'connect: start the local bridge in the foreground (stop with Ctrl-C or stop)', positionals: [0, 0], options: {} },
  stop: { usage: 'stop [--force]: stop only the local bridge process; does not modify the Figma document or affect cloud sync; requires --force while a job is unfinished (queued or running); exit code 2 if still shutting down after about 5 s, confirm later with status', positionals: [0, 0], options: { force: { type: 'boolean' } } },
  status: { usage: 'status: live status of the bridge and plugin', positionals: [0, 0], options: {} },
  doctor: { usage: 'doctor: diagnose binding, session, lock, plugin files and connection; also report Chrome, required only by html commands', positionals: [0, 0], options: {} },
  run: { usage: 'run <script.js> [--node <ID>] [--lib <file.js>]... [--data <file.json>] [--depth <1-31>] [--expect changed|unchanged] [--tolerance <pixels>] [--scale <0.1-4>] [--request-id <uuid>] [--high-risk <reason>] [--clean-on-fail] [--timeout <seconds>] [--no-wait] [--full]',
    positionals: [1, 1], submit: true, options: { ...node, lib: { type: 'string', multiple: true }, data: { type: 'string' }, depth: { type: 'string' }, expect: { type: 'string' }, tolerance: { type: 'string' },
      scale: { type: 'string' }, 'request-id': { type: 'string' }, 'high-risk': { type: 'string' }, 'clean-on-fail': { type: 'boolean' }, ...wait } },
  inspect: { usage: 'inspect [--node <ID>] [--depth <1-31>]: read the node tree (including masks and the ancestor visibility chain)', positionals: [0, 0], submit: true, options: { ...node, depth: { type: 'string' }, ...wait } },
  preview: { usage: 'preview [--node <ID>]... [--scale <0.1-4>]: export PNG; repeat --node for batch export', positionals: [0, 0], submit: true, options: { node: { type: 'string', multiple: true }, scale: { type: 'string' }, ...wait } },
  variables: { usage: 'variables [--node <ID>]: local variable catalog and binding counts within the target', positionals: [0, 0], submit: true, options: { ...node, ...wait } },
  extract: { usage: 'extract [--node <ID>] [--scale <0.1-4>] [--island <ID>]... [--timeout <seconds>] [--no-wait] [--full]: read-only extraction of pixel-replica data (node tree, reference PNG, bitmaps, SVG islands); --island adds islands, exit code 1 if any is skipped',
    positionals: [0, 0], submit: true, options: { ...node, scale: { type: 'string' }, island: { type: 'string', multiple: true }, ...wait } },
  result: { usage: 'result <job-id> [--full]: read local evidence', positionals: [1, 1], options: { full: { type: 'boolean' } } },
  wait: { usage: 'wait <job-id> [--timeout <seconds>] [--full]: wait for the original result without resubmitting', positionals: [1, 1], options: { timeout: { type: 'string' }, full: { type: 'boolean' } } },
  resolve: { usage: 'resolve <original-job-id> --inspect <inspect-job-id> --previous-plugin-stopped: after verification, end the unresolved wait without replaying the script', positionals: [1, 1],
    options: { inspect: { type: 'string' }, 'previous-plugin-stopped': { type: 'boolean' } } },
  'image-diff': { usage: 'image-diff <before.png|preview-job-id> <after.png|preview-job-id> [--threshold <0-255>] [--expect changed|unchanged]', positionals: [2, 2],
    options: { threshold: { type: 'string' }, expect: { type: 'string' } } },
  report: { usage: 'report [--since <ISO-time>]: summary of job durations, gaps and repeated runs (default: last 24 hours; a date alone means UTC midnight)', positionals: [0, 0], options: { since: { type: 'string' } } },
  html: { usage: 'html [--node <ID>]... [--from <extract-job-id>]... --out <dir> [--overrides <file.json>] [--no-check] [--timeout <seconds>] [--budget <seconds>]: export pixel-replica HTML and compare each frame with the extract reference image; handles --from first, then submits one extract per --node frame; 1-50 frames in total; --budget caps the time spent submitting and waiting for extracts (10-600, default 90), and when it runs out exits with code 2 and returns the resume command',
    positionals: [0, 0], options: { node: { type: 'string', multiple: true }, from: { type: 'string', multiple: true }, out: { type: 'string' }, overrides: { type: 'string' },
      'no-check': { type: 'boolean' }, timeout: { type: 'string' }, budget: { type: 'string' } } },
  'html-check': { usage: 'html-check <page.html>... [--node <ID>]... [--zoom <extract-job-id>]: find the extract reference image from the page meta, re-render and compare (does not connect to Figma; run in the project directory that generated the page); '
    + '--node runs shift search and checks on the given nodes (not limited to the top 5); --zoom does a magnified comparison against the result of extract --node <ID> --scale <k>', positionals: [1, 50],
    options: { node: { type: 'string', multiple: true }, zoom: { type: 'string' } } },
};

/** @param {string} value @param {number} min @param {number} max @param {string} message */
const integer = (value, min, max, message) => {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw Error(message);
  return Number(value);
};
/** @param {string} value */
const nodeId = (value, flag = '--node') => {
  const id = value.replace(/-/g, ':');
  if (!isNodeId(id)) throw Error(`${flag} needs a valid node ID, e.g. 1:2 or I1:2;3:4`);
  return id;
};
/** @param {string} value */
const scale = value => {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || Number(value) < 0.1 || Number(value) > 4) throw Error('--scale must be 0.1-4');
  return Number(value);
};
/** @param {string} value */
const expect = value => {
  if (!['changed', 'unchanged'].includes(value)) throw Error('--expect accepts only changed or unchanged');
  return value;
};

// parseArgs sees only ParseArgsOptionsConfig and a union of all option value types; COMMANDS above defines each option's exact type.
/** @typedef {{ node?: string | string[], lib?: string[], island?: string[], data?: string, depth?: string, expect?: string, tolerance?: string, scale?: string,
 *   'request-id'?: string, 'high-risk'?: string, 'clean-on-fail'?: boolean, timeout?: string, 'no-wait'?: boolean, full?: boolean, force?: boolean, inspect?: string,
 *   'previous-plugin-stopped'?: boolean, threshold?: string, since?: string, from?: string[], out?: string, overrides?: string, 'no-check'?: boolean, budget?: string,
 *   zoom?: string }} Values */
// Normalized options, read by bin according to the command.
/** @typedef {{ targetNodeId?: string, nodes?: string[], snapshotDepth?: number, timeoutSeconds?: number, threshold?: number, expect?: string, tolerance?: number,
 *   scale?: number, requestId?: string, risk?: { level: 'high', reason: string }, cleanOnFail?: true, islands?: string[], libFiles?: string[], dataFile?: string, since?: string,
 *   inspectId?: string, previousPluginStopped?: true, force?: true, full?: true, noWait?: true,
 *   fromIds?: string[], outDir?: string, overridesFile?: string, noCheck?: true, budgetSeconds?: number, zoomId?: string }} Options */
/** @param {string[]} argv @returns {{ command: string, positionals: string[], options: Options }} */
export function parse(argv) {
  const [first = 'help', ...rest] = argv;
  if (first === '--help' || first === '-h' || rest.includes('--help') || rest.includes('-h')) return { command: 'help', positionals: [], options: {} };
  const spec = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : null;
  if (!spec) throw Error(`Unknown command: ${first}; run figma-agent-control help to list commands`);
  let parsed;
  try { parsed = parseArgs({ args: rest, options: spec.options, allowPositionals: true, strict: true, tokens: true }); }
  catch (error) { throw Error(`Invalid arguments (${error.message}); usage: ${spec.usage}`); }
  // parseArgs silently takes the last repeated scalar option; reject duplicates so write targets cannot be ambiguous.
  const given = parsed.tokens.filter(token => token.kind === 'option' && !spec.options[token.name].multiple).map(token => /** @type {{ name: string }} */ (token).name);
  const repeated = given.find((name, i) => given.indexOf(name) !== i);
  if (repeated) throw Error(`Invalid arguments (--${repeated} may be given only once); usage: ${spec.usage}`);
  const { values, positionals } = parsed, v = /** @type {Values} */ (values);
  if (positionals.length < spec.positionals[0] || positionals.length > spec.positionals[1]) throw Error('Usage: ' + spec.usage);
  /** @type {Options} */
  const o = {};
  if (v.node !== undefined) {
    const ids = /** @type {string[]} */ ([]).concat(v.node).map(id => nodeId(id));
    if (new Set(ids).size !== ids.length || ids.length > 50) throw Error('--node takes at most 50 nodes, without duplicates');
    o.targetNodeId = ids[0];
    if (ids.length > 1) o.nodes = ids;
  }
  if (v.depth !== undefined) o.snapshotDepth = integer(v.depth, 1, 31, '--depth must be an integer 1-31');
  if (v.timeout !== undefined) o.timeoutSeconds = integer(v.timeout, 1, 300, '--timeout must be 1-300 seconds');
  if (v['no-wait'] && (v.full || v.timeout !== undefined)) throw Error('--no-wait cannot be combined with --full or --timeout');
  if (first === 'image-diff') {
    if (v.threshold !== undefined) o.threshold = integer(v.threshold, 0, 255, '--threshold must be an integer 0-255');
    if (v.expect !== undefined) o.expect = expect(v.expect);
  } else if (v.expect !== undefined) o.expect = expect(v.expect);
  if (v.tolerance !== undefined) {
    if (o.expect === undefined) throw Error('--tolerance requires --expect');
    o.tolerance = integer(v.tolerance, 0, 1e8, '--tolerance must be a non-negative integer pixel count');
  }
  if (v.scale !== undefined) {
    if (first === 'run' && o.expect === undefined) throw Error('--scale for run applies only to the before/after renders of --expect');
    o.scale = scale(v.scale);
  }
  if (v['request-id'] !== undefined) { if (!isJobId(v['request-id'])) throw Error('--request-id must be a lowercase UUID'); o.requestId = v['request-id']; }
  if (v['high-risk'] !== undefined) { if (!v['high-risk'].trim()) throw Error('--high-risk requires a risk description'); o.risk = { level: 'high', reason: v['high-risk'] }; }
  if (v.island !== undefined) {
    o.islands = v.island.map(id => nodeId(id, '--island'));
    const repeated = o.islands.find((id, i, all) => all.indexOf(id) !== i);
    if (repeated) throw Error(`--island has a duplicate node: ${repeated}`);
    if (o.islands.length > 500) throw Error('--island takes at most 500 nodes');
  }
  if (v.lib !== undefined) o.libFiles = v.lib;
  if (v.data !== undefined) o.dataFile = v.data;
  // Accept ISO format only: timestamps require Z or a time-zone offset; date-only values mean midnight UTC, never a guessed local time zone.
  if (v.since !== undefined) {
    const [y, m, d] = v.since.slice(0, 10).split('-').map(Number);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v.since) || Number.isNaN(Date.parse(v.since))
      || new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d) throw Error('--since needs an ISO time (the date must exist), e.g. 2026-10-06 or 2026-10-06T08:00:00Z');
    o.since = new Date(v.since).toISOString();
  }
  // html: --node and --from specify 1-50 frames combined; --out is required (an empty string resolves to cwd, which would write pages and remove old pages at the project root).
  if (first === 'html') {
    if (!v.out?.trim()) throw Error('html requires --out <dir>, and it must not be empty');
    o.outDir = v.out;
    const from = v.from ?? [], bad = from.find(id => !isJobId(id)), twice = from.find((id, i) => from.indexOf(id) !== i);
    if (bad !== undefined) throw Error(`--from must be an extract job ID (lowercase UUID): ${bad}`);
    if (twice) throw Error(`--from has a duplicate job: ${twice}`);
    const frames = from.length + (o.nodes?.length ?? (o.targetNodeId ? 1 : 0));
    if (frames < 1 || frames > 50) throw Error(`html needs 1-50 frames (--node and --from combined), got ${frames}`);
    if (from.length) o.fromIds = from;
    if (v.overrides !== undefined) o.overridesFile = v.overrides;
    if (v['no-check']) o.noCheck = true;
    if (v.budget !== undefined) o.budgetSeconds = integer(v.budget, 10, 600, '--budget must be an integer 10-600 seconds');
  }
  if (v.zoom !== undefined) { if (!isJobId(v.zoom)) throw Error(`--zoom must be an extract job ID (lowercase UUID): ${v.zoom}`); o.zoomId = v.zoom; }
  if (first === 'resolve') {
    if (!isJobId(positionals[0]) || !isJobId(v.inspect) || !v['previous-plugin-stopped']) throw Error('Usage: ' + spec.usage + '; first confirm the previous plugin has stopped and check the current document');
    o.inspectId = v.inspect; o.previousPluginStopped = true;
  }
  for (const key of /** @type {const} */ (['force', 'full'])) if (v[key]) o[key] = true;
  if (v['no-wait']) o.noWait = true;
  if (v['clean-on-fail']) o.cleanOnFail = true;
  return { command: first, positionals, options: o };
}
