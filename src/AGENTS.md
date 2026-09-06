# src/

> Parent: [module map](../AGENTS.md)

Host-side command, bridge and evidence modules.

## Members

- `args.mjs`: Command definitions and argument validation.
- `bridge.mjs`: Loopback HTTP relay with role credentials, serialized jobs and persistent evidence.
- `client.mjs`: CLI-side HTTP requests and bridge lifecycle calls.
- `connection.mjs`: Plugin instance lease state.
- `png.mjs`: PNG codec and strict pixel-change statistics.
- `project.mjs`: Binding, paths, identifiers and atomic file writes.
- `record.mjs`: Interpret persisted job outcomes and wait without resubmission.
- `report.mjs`: Read-only job timing and outcome aggregation.
- `session.mjs`: Pairing, process locks and restart recovery.

## Contract maintenance

Keep source comments and default documentation in English. Simplified Chinese belongs in README_ZH.md and docs/zh_cn/*.md. Update both languages with their owning feature change.

Read the current source headers before changing behavior. Keep implementation, tests and affected document contracts in the same feature commit. Describe the interfaces provided by the files in this directory.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
