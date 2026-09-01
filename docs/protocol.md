# Protocol and evidence

[Simplified Chinese](zh_cn/protocol.md)

## Workspace binding and storage

`src/project.mjs` parses Figma design/file URLs and stores format-2 bindings under `.figma-agent-control/binding.json`. Atomic writes replace a file only after the new contents are complete. `pluginHome` selects the shared plugin directory; `installPlugin` rewrites only changed files.
