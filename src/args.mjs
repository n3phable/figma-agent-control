/**
 * [INPUT]: Imports node:util, ./project.mjs.
 * [OUTPUT]: Exports COMMANDS, parse.
 * [POS]: CLI input boundary: validate command syntax and normalize options into command records.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { parseArgs } from 'node:util';
import { isJobId, isNodeId } from './project.mjs';

const wait = { timeout: { type: 'string' }, 'no-wait': { type: 'boolean' }, full: { type: 'boolean' } };
const node = { node: { type: 'string' } };
// positionals: [minimum, maximum]; submit: wait for the result by default after submitting a task.
export const COMMANDS = {
  help: { usage: 'help', positionals: [0, 0], options: {} },
  init: { usage: 'init <figma-url>: bind the current directory to a scope node in one file', positionals: [1, 1], options: {} },
  result: { usage: 'result <job-id> [--full]: read local evidence', positionals: [1, 1], options: { full: { type: 'boolean' } } },
  wait: { usage: 'wait <job-id> [--timeout <seconds>] [--full]: wait for the original result without resubmitting', positionals: [1, 1], options: { timeout: { type: 'string' }, full: { type: 'boolean' } } }
};

const integer = (value, min, max, message) => {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw Error(message);
  return Number(value);
};
const nodeId = value => {
  const id = value.replace(/-/g, ':');
  if (!isNodeId(id)) throw Error('--node needs a valid node ID, such as 1:2 or I1:2;3:4');
  return id;
};
const scale = value => {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || Number(value) < 0.1 || Number(value) > 4) throw Error('--scale must be 0.1-4');
  return Number(value);
};
const expect = value => {
  if (!['changed', 'unchanged'].includes(value)) throw Error('--expect accepts only changed or unchanged');
  return value;
};

export function parse(argv) {
  const [first = 'help', ...rest] = argv;
  if (first === '--help' || first === '-h' || rest.includes('--help') || rest.includes('-h')) return { command: 'help', positionals: [], options: {} };
  const spec = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : null;
  if (!spec) throw Error(`Unknown command: ${first}; run figma-agent-control help to list commands`);
  let parsed;
  try { parsed = parseArgs({ args: rest, options: spec.options, allowPositionals: true, strict: true, tokens: true }); }
  catch (error) { throw Error(`Invalid arguments (${error.message}); usage: ${spec.usage}`); }
  // parseArgs silently takes the last repeated scalar option; reject duplicates so write targets cannot be ambiguous.
  const given = parsed.tokens.filter(token => token.kind === 'option' && !spec.options[token.name].multiple).map(token => token.name);
  const repeated = given.find((name, i) => given.indexOf(name) !== i);
  if (repeated) throw Error(`Invalid arguments (--${repeated} may be given only once); usage: ${spec.usage}`);
  const { values: v, positionals } = parsed;
  if (positionals.length < spec.positionals[0] || positionals.length > spec.positionals[1]) throw Error('Usage: ' + spec.usage);
  const o = {};
  if (v.node !== undefined) {
    const ids = [].concat(v.node).map(nodeId);
    if (new Set(ids).size !== ids.length || ids.length > 50) throw Error('preview accepts at most 50 nodes without duplicates');
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
  if (v.lib !== undefined) o.libFiles = v.lib;
  if (v.data !== undefined) o.dataFile = v.data;
  // Accept ISO format only: timestamps require Z or a time-zone offset; date-only values mean midnight UTC, never a guessed local time zone.
  if (v.since !== undefined) {
    const [y, m, d] = v.since.slice(0, 10).split('-').map(Number);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v.since) || Number.isNaN(Date.parse(v.since))
      || new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d) throw Error('--since needs an ISO time (the date must exist), e.g. 2026-10-06 or 2026-10-06T08:00:00Z');
    o.since = new Date(v.since).toISOString();
  }
  if (first === 'resolve') {
    if (!isJobId(positionals[0]) || !isJobId(v.inspect) || !v['previous-plugin-stopped']) throw Error('Usage: ' + spec.usage + '; first confirm the previous plugin has stopped and check the current document');
    o.inspectId = v.inspect; o.previousPluginStopped = true;
  }
  for (const key of ['force', 'full']) if (v[key]) o[key] = true;
  if (v['no-wait']) o.noWait = true;
  return { command: first, positionals, options: o };
}
