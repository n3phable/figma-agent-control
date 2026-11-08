# src/html/

> L2 | Parent: [src](../AGENTS.md)

This subsystem turns a landed extract into self-contained static HTML, renders it in Chrome, compares it with Figma, attributes differences to nodes, and offers recorded overrides. The command layer owns orchestration; generation is pure and checking owns verdicts.

```text
plugin extract -> runs/<id>/result.json + files/
  -> extracts: submit / wait / read
  -> page: fonts + SVGs -> generate/css -> images + reference crops -> embed
  -> page file with provenance metadata
  -> Chrome -> check: match + attribution + diagnostics -> evidence
  -> summary: html.json + stdout + exit code + resume instruction
```

Keep reference and tree from the same extract. Missing islands may trigger one additional extract for a live `--node` frame; an offline `--from` frame requests refresh through its resume instruction. The first result remains the fallback if the second attempt fails.

The generator receives all environment-specific inputs as data. `GENERATOR` hashes css/generate sources. `CHECKER` hashes comparison, diagnostic, rendering, shared CSS, and PNG sources. Comment changes therefore affect fingerprints. Overrides are the sole manual correction input and are fully validated before generation. A hand-edited page produces a regeneration mismatch during html-check.

Dependencies are one-way: command orchestrates extracts/page/overrides/check/summary/chrome; page uses generate/fonts/match; generate uses css only. Check orchestrates match/attrib/shift/layout/structure/suggest/zoom. Shared diagnostics use attrib, and zoom also uses shift/page/match. Suggest recomputes proposals through generate. Host dependencies are client/record/session/png/project, never bridge. The extract contract is type-only.

## Members

- `command.mjs`: html/html-check orchestration, all-input preflight, per-frame isolation, extraction budget/resume behavior, browser lifecycle, and maximum 500 requested islands per frame.
- `summary.mjs`: pure manifest totals, exit codes, whole-batch resume instructions, and progressively reduced stdout within 16 KiB.
- `extract-contract.d.ts`: shared type contract for geometry, text, references, images, islands, and plugin/transit/landed binary representations; no runtime code.
- `extracts.mjs`: sole submission/wait/read path for extracts, injectable HTTP/clock, reconnect retries, and distinction between retryable interruption and deterministic failure.
- `page.mjs`: artifact assembly, font/SVG reads, cached embedded images, reference crops, deterministic filenames, renamed-page cleanup, atomic writes, and metadata/ref reading.
- `overrides.mjs`: validation boundary for frame/node IDs, five allowed entry keys, required notes, safe CSS values, and file fingerprinting.
- `fonts.mjs`: sfnt/TTC/variable-font metrics parser and cached font index. Searches user/system macOS font directories; other platforms lack that discovery path. Supplies data without becoming a generator dependency.
- `generate.mjs`: pure nested-DOM generation, transforms, paint order, root opacity, masks/islands, text metrics, override application/staleness, reference placeholders, and output invariants.
- `css.mjs`: pure single-value CSS/SVG mappings plus shared paint-order and background-dependency decisions. Fixed numeric precision preserves deterministic output.
- `check.mjs`: comparison/diagnostic sequence and sole verdict authority. More than 2% mismatch fails; blocking diagnostics distinguish clean from pass-with-findings. Writes reports and evidence images.
- `chrome.mjs`: minimal CDP pipe client using Node built-ins, software rasterization/sRGB, isolated page contexts, bounded requests, and owned-process/profile cleanup on normal termination/signals.
- `match.mjs`: pixelmatch-derived perceptual comparison, antialias classification, dense-block scanning, translation counts, and crop/upscale/stack helpers. Distinct from strict `png.diffPng` change detection.
- `attrib.mjs`: pure rectangle rasterization and Figma/HTML-side attribution, merged by max contribution to identify missing or displaced content.
- `layout.mjs`: browser geometry/font/structure collection and findings. Box/wrap/content-offset/overflow block clean; ink-offset is informational.
- `shift.mjs`: pure local translation search and conversion to override transforms/bases; fixes require at least fifty original differing pixels and 30% improvement.
- `structure.mjs`: pure data-node/text correspondence checks with explicit exemptions for intentionally omitted or baked subtrees.
- `suggest.mjs`: groups background-dependent approximations, proposes component-level reference crops using generator-derived geometry, and measures crop-edge seams.
- `zoom.mjs`: magnified single-node preflight/render/comparison, neutralizing ancestor effects and reusing translation search at device-pixel precision; focus/zoom do not change the frame verdict.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
