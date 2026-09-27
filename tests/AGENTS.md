# tests/

> Parent: [module map](../AGENTS.md)

Behavioral tests for the implementation in this revision.

## Members

- `args.test.mjs`: Tests for args behavior in this revision.
- `bridge.test.mjs`: Tests for bridge behavior in this revision.
- `cli.test.mjs`: Tests for cli behavior in this revision.
- `contract-samples.mjs`: Check explicitly provided extraction evidence against its types.
- `extract.test.mjs`: Tests for extract behavior in this revision.
- `helpers/`: Isolated synthetic document, bridge and media fixtures.
- `html-attrib.test.mjs`: Tests for html attrib behavior in this revision.
- `html-cli.test.mjs`: Tests for html cli behavior in this revision.
- `html-fonts.test.mjs`: Tests for html fonts behavior in this revision.
- `html-generate.test.mjs`: Tests for html generate behavior in this revision.
- `html-layout.test.mjs`: Tests for html layout behavior in this revision.
- `html-match.test.mjs`: Tests for html match behavior in this revision.
- `html-render.test.mjs`: Tests for html render behavior in this revision.
- `html-suggest.test.mjs`: Tests for html suggest behavior in this revision.
- `plugin.test.mjs`: Tests for plugin behavior in this revision.
- `png.test.mjs`: Tests for png behavior in this revision.
- `project-session.test.mjs`: Tests for project session behavior in this revision.
- `record.test.mjs`: Tests for record behavior in this revision.
- `smoke.test.mjs`: Tests for smoke behavior in this revision.
- `typecheck.mjs`: Run the local pinned TypeScript checker for available environments.
- `ui.test.mjs`: Tests for ui behavior in this revision.

## Contract maintenance

Keep source comments and default documentation in English. Simplified Chinese belongs in README_ZH.md and docs/zh_cn/*.md. Update both languages with their owning feature change.

Read the current source headers before changing behavior. Keep implementation, tests and affected document contracts in the same feature commit. Describe the interfaces provided by the files in this directory.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
