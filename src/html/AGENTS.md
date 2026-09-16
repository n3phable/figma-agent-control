# src/html/

> Parent: [module map](../AGENTS.md)

Host HTML and image-comparison modules available in this revision.

## Members

- `check.mjs`: Render a page and compare pixels with a supplied reference.
- `chrome.mjs`: Discover Chrome and drive owned rendering sessions through CDP.
- `extract-contract.d.ts`: Shared type-only extraction contract.
- `match.mjs`: Perceptual pixel comparison and structural-block analysis.

## Contract maintenance

Keep source comments and default documentation in English. Simplified Chinese belongs in README_ZH.md and docs/zh_cn/*.md. Update both languages with their owning feature change.

Read the current source headers before changing behavior. Keep implementation, tests and affected document contracts in the same feature commit. Describe the interfaces provided by the files in this directory.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
