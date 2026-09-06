# tests/

> Parent: [module map](../AGENTS.md)

Behavioral tests for the implementation in this revision.

## Members

- `args.test.mjs`: Tests for args behavior in this revision.
- `helpers/`: Isolated synthetic document, bridge and media fixtures.
- `plugin.test.mjs`: Tests for plugin behavior in this revision.
- `project-session.test.mjs`: Tests for project session behavior in this revision.
- `record.test.mjs`: Tests for record behavior in this revision.
- `ui.test.mjs`: Tests for ui behavior in this revision.

## Contract maintenance

Keep source comments and default documentation in English. Simplified Chinese belongs in README_ZH.md and docs/zh_cn/*.md. Update both languages with their owning feature change.

Read the current source headers before changing behavior. Keep implementation, tests and affected document contracts in the same feature commit. Describe the interfaces provided by the files in this directory.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
