# plugin/

> Parent: [module map](../AGENTS.md)

Figma development-plugin execution and iframe relay templates.

## Members

- `main.js`: Verify task scope and execute document operations with evidence boundaries.
- `tsconfig.json`: Supporting source or configuration used by this module.
- `ui.html`: Relay network requests and plugin messages through an iframe.

## Contract maintenance

Keep source comments and default documentation in English. Simplified Chinese belongs in README_ZH.md and docs/zh_cn/*.md. Update both languages with their owning feature change.

Read the current source headers before changing behavior. Keep implementation, tests and affected document contracts in the same feature commit. Describe the interfaces provided by the files in this directory.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
