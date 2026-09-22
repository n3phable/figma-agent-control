/**
 * [INPUT]: Imports node:fs, ../project.mjs.
 * [OUTPUT]: Exports invalidOverrides, loadOverrides.
 * [POS]: Validates per-node rendering overrides before generation consumes them.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs';
import { hash, isNodeId } from '../project.mjs';
/** @import { OverrideEntry } from './generate.mjs' */
/** @typedef {Record<string, Record<string, OverrideEntry>>} OverrideGroups  Outer keys are frame node IDs; inner keys are node IDs within that frame. */

// -- Validation ---------------------------------------------------------
// Frame-grouped format: { <frame node ID>: { <node ID>: entry } }. Both key levels require Figma-returned IDs; URL-style 1-2 would silently miss matches.
// Entries accept only style, basis, skip, bake and required note. style/basis map property names to strings; names match -?[a-z][a-z-]*.
// skip is boolean; bake is "svg" or "ref", with "ref" allowing only note alongside it. Values must fit one declaration, excluding ;{}, newlines,
// and constructs that swallow later declarations (backslashes, quotes, comment openers, unbalanced parentheses/brackets). Disallow url( because HTML embeds local resources only.
const KEYS = new Set(['style', 'basis', 'skip', 'bake', 'note']);
const ID = 'must be a node ID (colon form, e.g. 1:2 or I1:2;3:4)';
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @type {Record<string, string>} */
const PAIRS = { ')': '(', ']': '[' };
/** @param {string} v */
const balanced = v => { const open = []; for (const c of v) if (c === '(' || c === '[') open.push(c); else if (c in PAIRS && open.pop() !== PAIRS[c]) return false; return !open.length; };
/** @param {unknown} v */
const badValue = v => typeof v !== 'string' || /[;{}\n\r\\"']|\/\*|url\(/i.test(v) || !balanced(v);

/** Return the first problem with key path and reason, or null. Validate every entry, including frames outside this export. @param {unknown} raw @returns {string | null} */
export function invalidOverrides(raw) {
  if (!isMap(raw)) return 'top level must be an object (frame node ID -> group)';
  for (const [frame, group] of Object.entries(raw)) {
    if (!isNodeId(frame)) return `${JSON.stringify([frame])}: ${ID}`;
    if (!isMap(group)) return `${JSON.stringify([frame])}: group must be an object (node ID -> entry)`;
    for (const [node, e] of Object.entries(group)) {
      /** @param {string[]} keys */
      const at = (...keys) => JSON.stringify([frame, node, ...keys]);
      if (!isNodeId(node)) return `${at()}: ${ID}`;
      if (!isMap(e)) return `${at()}: entry must be an object`;
      const extra = Object.keys(e).find(k => !KEYS.has(k));
      if (extra) return `${at(extra)}: unknown key; only ${[...KEYS].join(', ')} are accepted`;
      if (typeof e.note !== 'string' || !e.note.trim()) return `${at('note')}: required; must be a non-empty string`;
      for (const k of ['style', 'basis']) {
        const map = e[k];
        if (map === undefined) continue;
        if (!isMap(map)) return `${at(k)}: must be an object (property name -> string)`;
        for (const [p, v] of Object.entries(map)) {
          if (!/^-?[a-z][a-z-]*$/.test(p)) return `${at(k, p)}: property name must match -?[a-z][a-z-]*`;
          if (badValue(v)) return `${at(k, p)}: value must be a string without ;{}, newlines, backslashes, quotes, /* or url(, with balanced brackets`;
        }
      }
      if (e.skip !== undefined && typeof e.skip !== 'boolean') return `${at('skip')}: must be a boolean`;
      if (e.bake !== undefined && e.bake !== 'svg' && e.bake !== 'ref') return `${at('bake')}: only "svg" or "ref" is accepted`;
      if (e.bake === 'ref' && ['style', 'basis', 'skip'].some(k => k in e)) return `${at('bake')}: a "ref" entry may only also have note`;
    }
  }
  return null;
}

// -- Reading ------------------------------------------------------------
// Read synchronously for top-level regression callers. sha is the first 12 hex digits of the file-byte SHA-256, stored in page metadata as the overrides fingerprint.
/** @param {string} file Absolute path. @returns {{ groups: OverrideGroups, sha: string }} */
export function loadOverrides(file) {
  let bytes, raw;
  try { bytes = fs.readFileSync(file); raw = JSON.parse(bytes.toString('utf8')); } catch (error) { throw Error(`Cannot read --overrides: ${error.message}`); }
  const bad = invalidOverrides(raw);
  if (bad) throw Error(`Invalid --overrides: ${bad}`);
  return { groups: /** @type {OverrideGroups} */ (raw), sha: hash(bytes).slice(0, 12) };
}
