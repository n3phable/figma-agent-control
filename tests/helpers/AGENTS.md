# tests/helpers/

> Parent: [module map](../AGENTS.md)

Isolated synthetic document, bridge and media fixtures.

## Members

- `doc.mjs`: Synthetic document used by extraction and generation tests.
- `generate.mjs`: Connect synthetic extraction to generation.
- `harness.mjs`: Real bridge and VM-plugin integration fixture.
- `match/`: Related implementation, fixtures or configuration.

## Contract maintenance

Keep source comments and default documentation in English. Simplified Chinese belongs in README_ZH.md and docs/zh_cn/*.md. Update both languages with their owning feature change.

Read the current source headers before changing behavior. Keep implementation, tests and affected document contracts in the same feature commit. Describe the interfaces provided by the files in this directory.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
