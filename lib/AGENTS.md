# lib/

> L2 | Parent: [project map](../AGENTS.md)

These helpers run inside Figma's plugin environment through `run --lib <name>`. `src/args.mjs` resolves bare library names; the CLI reads source and the plugin compiler nests each library in its own outer function scope. There are no imports or runtime host dependencies. Library changes do not alter the plugin fingerprint.

Motion/prototype edits remain ordinary runs, inheriting write-ahead evidence, Undo boundaries, and change sets. Libraries provide read/edit/apply specs instead of adding dedicated bridge operations. Host-only work such as decoding video belongs in `src/`.

## Members

- `motion.js`: Beta Motion API boundary; converts tracks, presets, custom styles, and variable aliases to a round-trippable MotionSpec. Apply validates before mutation and records raw inverse operations for attempted rollback. Async entry stacks preserve caller traces. Video export can retry failures or unchanged bytes.
- `prototype.js`: reaction/flow spec reader, declarative writer, and async issue checks. Writes only changed reactions, restores explicit flows after Figma's auto-add behavior, attempts rollback on rejection, and rejects changes to read-only overlay settings.
- `env.d.ts`: type-only declarations for injected `target` and `data`; Figma globals come from plugin typings.
- `tsconfig.json`: isolated classic-script checkJs environment for motion, matching the plugin runtime without sharing main.js globals.
- `tsconfig.prototype.json`: equivalent separate environment for prototype, avoiding false collisions between helper names that occupy separate runtime scopes.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
