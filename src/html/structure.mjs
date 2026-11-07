/**
 * [INPUT]: Uses ./css.mjs VECTORS; types come from ./extract-contract.js LandedExtractOutput/ExtractNode and ./generate.mjs OverrideEntry.
 * [OUTPUT]: structure(output, ctx, dom) -> { untracked, missing, textMismatch }, plus Structure.
 * [POS]: Pure html structure validation comparing page and extracted tree. Consumes layout.collect's data-node/textContent scan without browser access. check blocks clean for any nonempty category: untracked indicates manual page edits; missing/textMismatch indicate lost generated content.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { VECTORS } from './css.mjs';
/** @import { LandedExtractOutput, ExtractNode } from './extract-contract.js' */
/** @import { OverrideEntry } from './generate.mjs' */
/** @typedef {{ untracked: string[], missing: string[], textMismatch: { node: string, figma: string, html: string }[] }} Structure */

/** @param {string} s */
const norm = s => s.replace(/\s+/g, ' ').trim();
/** @param {string} s */
const clip = s => s.length > 80 ? s.slice(0, 77) + '...' : s;

// untracked: IDs present in the page but absent from the extract tree.
// missing: extract nodes without any page data-node element. Exempt entire omitted subtrees: skip, unpainted nodes (renderBounds null unless a mask; absent bounds do not exempt),
// and masks whose wrappers use data-mask only. Exempt descendants of rendered leaf representations: inlined islands, valid refs after #canvas and vectors whose operands are not generated.
// textMismatch: compare whitespace-normalized textContent with characters or concatenated segments for non-exempt TEXT nodes with page text records; truncate both sides to 80 characters.
// Island/ref roots are SVG .n or data-bake containers without text elements, so skip text comparison there too. text-transform does not change textContent.
/**
 * @param {LandedExtractOutput} output
 * @param {{ overrides: Record<string, OverrideEntry>, refs: ReadonlyArray<{ node: string }>, inlined: Set<string> }} ctx  refs are those actually painted by the page.
 * @param {{ nodes: string[], texts: Record<string, string> }} dom
 * @returns {Structure}
 */
export function structure(output, { overrides, refs, inlined }, { nodes, texts }) {
  const known = new Set(), present = new Set(nodes), baked = new Set(refs.map(r => r.node)), missing = /** @type {string[]} */ ([]);
  const textMismatch = /** @type {Structure['textMismatch']} */ ([]);
  /** @param {ExtractNode} n */
  const all = n => { known.add(n.id); for (const c of n.children ?? []) all(c); };
  all(output.root);
  /** @param {ExtractNode} n */
  const visit = n => {
    if (overrides[n.id]?.skip || n.isMask || n.renderBounds === null) return;
    if (!present.has(n.id)) missing.push(n.id);
    const leaf = inlined.has(n.id) || baked.has(n.id);
    if (n.type === 'TEXT' && !leaf && Object.hasOwn(texts, n.id)) {
      const figma = n.characters ?? (n.segments ?? []).map(s => s.characters).join(''), html = texts[n.id];
      if (norm(figma) !== norm(html)) textMismatch.push({ node: n.id, figma: clip(figma), html: clip(html) });
    }
    if (!leaf && !VECTORS.has(n.type)) for (const c of n.children ?? []) visit(c);
  };
  visit(output.root);
  return { untracked: nodes.filter(id => !known.has(id)), missing, textMismatch };
}
