# lib/

> Parent: [module map](../AGENTS.md)

Plugin-side helpers injected through run libraries.

## Members

- `env.d.ts`: Type declarations for injected script values.
- `motion.js`: Read, apply, export and inspect declarative motion specifications.
- `tsconfig.json`: Supporting source or configuration used by this module.

## Contract maintenance

Keep source comments and default documentation in English. Simplified Chinese belongs in README_ZH.md and docs/zh_cn/*.md. Update both languages with their owning feature change.

Read the current source headers before changing behavior. Keep implementation, tests and affected document contracts in the same feature commit. Describe the interfaces provided by the files in this directory.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
