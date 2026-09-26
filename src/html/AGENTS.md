# src/html/

> Parent: [module map](../AGENTS.md)

Host HTML and image-comparison modules available in this revision.

## Members

- `attrib.mjs`: Attribute pixel mismatches to design and HTML nodes.
- `check.mjs`: Render a page and compare pixels with a supplied reference.
- `chrome.mjs`: Discover Chrome and drive owned rendering sessions through CDP.
- `command.mjs`: Orchestrate HTML export and rechecking.
- `css.mjs`: Map design paint, geometry and text values to CSS/SVG.
- `extract-contract.d.ts`: Shared type-only extraction contract.
- `extracts.mjs`: Submit, wait for and read extraction evidence.
- `fonts.mjs`: Read local font tables and metrics.
- `generate.mjs`: Generate deterministic nested HTML from extracted design data.
- `layout.mjs`: Collect and compare browser geometry and font usage.
- `match.mjs`: Perceptual pixel comparison and structural-block analysis.
- `overrides.mjs`: Validate recorded per-node HTML corrections.
- `page.mjs`: Assemble self-contained pages and provenance metadata.
- `shift.mjs`: Search small translations and produce local-coordinate corrections.
- `structure.mjs`: Check node/text correspondence.
- `summary.mjs`: Summarize frame outcomes and continuation instructions.

## Contract maintenance

Keep source comments and default documentation in English. Simplified Chinese belongs in README_ZH.md and docs/zh_cn/*.md. Update both languages with their owning feature change.

Read the current source headers before changing behavior. Keep implementation, tests and affected document contracts in the same feature commit. Describe the interfaces provided by the files in this directory.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
