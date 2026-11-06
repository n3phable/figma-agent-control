/**
 * [INPUT]: Uses ./generate generate/fontRequests/embed/dataUri, ./fonts findFont, ./match crop, ../png decodePng/encodePng,
 *          ../project hash/writeAtomic, node:fs, node:fs/promises and node:path; accepts persisted extract output and its task directory or offline base directory.
 * [OUTPUT]: expectedSize(output), assemble(output, input) -> { html, result, violations, expected }, pageFile(name, node), readMeta(text), readRefs(html), indexPages(dir), writePage(dir, file, node, html, index).
 * [POS]: Defines the single-file HTML artifact: assembly through font metrics, islands, bitmaps, reference crops and embedding; filenames;
 *        atomic persistence and cleanup after renames; and provenance reads. html, html-check and local regression scripts share assembly. All file access stays here so generate remains pure.
 *        readMeta/readRefs depend on generator metadata and ref-container syntax, protected by round-trip tests.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { generate, fontRequests, embed, dataUri } from './generate.mjs';
import { findFont } from './fonts.mjs';
import { crop } from './match.mjs';
import { decodePng, encodePng } from '../png.mjs';
import { hash, writeAtomic } from '../project.mjs';
/** @import { LandedExtractOutput, BinaryFile } from './extract-contract.js' */
/** @import { GenerateResult, OverrideEntry } from './generate.mjs' */

// -- Assembly -----------------------------------------------------------
// Expected dimensions are the rounded root width/height multiplied by reference scale.
/** @param {LandedExtractOutput} output @returns {{ width: number, height: number }} */
export const expectedSize = output => ({ width: Math.round(output.root.width * output.scale), height: Math.round(output.root.height * output.scale) });

// Look up local metrics for each fontRequests key through findFont's process-local index. Read explicit-island file descriptors as UTF-8 SVG for the generator;
// read each bitmap SHA-256 once into a data URI using a cross-frame cache. Crop references to refs rectangles, encode PNG and replace placeholders through the same embed function.
// Resolve descriptors with path.resolve(dir, file): live evidence uses task-relative paths, while offline data may use absolute paths. Read only, without writing files.
// violations combines generator output-invariant violations with placeholders left unresolved after embedding.
/**
 * @param {LandedExtractOutput} output
 * @param {{ dir: string, extract?: string, overrides?: Record<string, OverrideEntry>, overridesHash?: string, cache?: Map<string, string> }} input
 *   Pass extract, overrides and overridesHash unchanged to generate, defaulting to 'none', {} and 'none'.
 * @returns {{ html: string, result: GenerateResult, violations: string[], expected: { width: number, height: number } }}
 */
export function assemble(output, { dir, extract, overrides, overridesHash, cache = new Map() }) {
  /** @param {string} file */
  const read = file => fs.readFileSync(path.resolve(dir, file));
  const fonts = Object.fromEntries(fontRequests(output).map(r => [r.key, findFont(r)])), svgs = /** @type {Record<string, string>} */ ({});
  for (const [k, v] of Object.entries(output.svgs)) if (typeof v !== 'string' && 'file' in v) svgs[k] = read(v.file).toString('utf8');
  const result = generate(output, { fonts, svgs, extract, overrides, overridesHash });
  const used = /** @type {Record<string, string>} */ ({});
  for (const image of Object.values(output.images)) {
    const bytes = image?.bytes;
    if (!bytes || !('sha256' in bytes)) continue;
    if (!cache.has(bytes.sha256)) cache.set(bytes.sha256, dataUri(bytes.type, read(bytes.file)));
    used[bytes.sha256] = /** @type {string} */ (cache.get(bytes.sha256));
  }
  // Nonempty refs prove the reference persisted; unavailable references make generate reject ref entries as reference-size without placing them.
  if (result.refs.length) {
    const ref = decodePng(read(/** @type {BinaryFile} */ (output.reference).file));
    for (const r of result.refs) used[r.key] = dataUri('png', encodePng(r.rect[2] - r.rect[0], r.rect[3] - r.rect[1], crop(ref.data, ref.width, r.rect)));
  }
  const { html, missing } = embed(result.html, used);
  return { html, result, violations: [...result.violations, ...missing.map(k => `fac-asset:${k} not replaced`)], expected: expectedSize(output) };
}

// -- Filenames ----------------------------------------------------------
// <safe name>__<node part>.html. Replace forbidden/control characters with _, trim whitespace and leading dots, and truncate by code point to at most 120 UTF-8 bytes;
// use frame when empty. The node part matches preview filenames: 129:3229 -> 129-3229, instance chain I1:2;3:4 -> I1-2-3-4.
// Atomic-write temporary names add 41 bytes. Above 200 filename bytes, replace the node part with 12 SHA-256 hex digits to avoid ENAMETOOLONG.
/** @param {string} name @param {string} node @returns {string} */
export function pageFile(name, node) {
  let safe = '', size = 0;
  for (const c of String(name).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^[\s.]+|\s+$/g, '')) {
    if ((size += Buffer.byteLength(c)) > 120) break;
    safe += c;
  }
  const file = `${safe.trimEnd() || 'frame'}__${node.replace(/[^0-9A-Za-z]+/g, '-')}.html`;
  return Buffer.byteLength(file) <= 200 ? file : `${safe.trimEnd() || 'frame'}__${hash(node).slice(0, 12)}.html`;
}

// -- Reading provenance -------------------------------------------------
// Generator metadata uses content="extract=...; node=...; scale=...; overrides=...; generator=...". Node IDs may contain ';', so match minimally through "; scale=".
const META = /<meta name="figma-agent-control" content="extract=([^";]*); node=([^"]+?); scale=([^";]*); overrides=([^";]*); generator=([^";]*)">/;
/** @param {string} text Entire page or leading excerpt. @returns {{ extract: string, node: string, scale: number, overrides: string, generator: string } | null} */
export function readMeta(text) {
  const m = META.exec(text);
  return m && { extract: m[1], node: m[2], scale: Number(m[3]), overrides: m[4], generator: m[5] };
}

// The generator writes one container per ref after #canvas. Translation and size equal the reference rectangle divided by scale, matching reference pixels only at 1x.
// Escaped text and layer names cannot produce these tags; only generator output matches.
const REF = /<div class="n" data-node="([^"]*)" data-name="[^"]*" data-bake="ref" style="transform:translate\((-?[\d.]+)px,(-?[\d.]+)px\);width:([\d.]+)px;height:([\d.]+)px">/g;
/** @param {string} html @returns {{ node: string, rect: [number, number, number, number] }[]} */
export function readRefs(html) {
  return [...html.matchAll(REF)].map(m => {
    const [x, y, w, h] = m.slice(2).map(Number);
    return { node: m[1], rect: [x, y, x + w, y + h] };
  });
}

// -- Persistence --------------------------------------------------------
// Recognize only top-level *.html pages with FAC metadata within the first 16 KiB, grouped by node. Later metadata counts as absent.
// Leave subdirectories, symlinks, non-HTML and metadata-free files untouched. Unreadable files, including deletion after listing, also count as lacking metadata.
/** @param {string} dir @returns {Promise<Map<string, string[]>>} */
export async function indexPages(dir) {
  const index = /** @type {Map<string, string[]>} */ (new Map());
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return index; throw error; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.html')) continue;
    let handle, head;
    try { handle = await fsp.open(path.join(dir, e.name), 'r'); } catch (error) { if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) continue; throw error; }
    try { const { buffer, bytesRead } = await handle.read(Buffer.alloc(16384), 0, 16384, 0); head = buffer.toString('utf8', 0, bytesRead); } finally { await handle.close(); }
    const meta = readMeta(head);
    if (meta) index.set(meta.node, [...index.get(meta.node) ?? [], e.name]);
  }
  return index;
}

// Delete differently named old pages for the same node before atomically writing the target. Deletion must precede writing because, on case-insensitive file systems,
// case-only renames identify the same file; writing first and deleting afterward would erase the new page.
/** @param {string} dir @param {string} file @param {string} node @param {string} html @param {Map<string, string[]>} index @returns {Promise<void>} */
export async function writePage(dir, file, node, html, index) {
  for (const old of index.get(node) ?? []) if (old !== file) await fsp.rm(path.join(dir, old), { force: true });
  index.set(node, [file]);
  await writeAtomic(path.join(dir, file), html);
}
