# plugin/

> L2 | Parent: [project map](../AGENTS.md)

The bridge turns these source templates into the files loaded by Figma. The bridge reads them, concatenates `main.js` and `extract.js` in `PLUGIN_SCRIPTS` order, injects iframe configuration, and returns generated files to `connect` for installation in the shared plugin directory.

The iframe is the only network relay; document execution stays in the plugin side. Figma's sandbox fetch is insufficient for the relay's timeout, visibility, and long-poll requirements. The iframe cannot access the document, and the document code sends no network requests. A per-job nonce plus job ID authenticates their postMessage traffic.

The manifest uses `dynamic-page`, enables private plugin APIs, and permits only the candidate localhost development ports. Scripts must use the relevant async APIs. Motion availability remains dependent on Figma's Beta/private API behavior. The manifest has no assigned plugin ID, so use shared namespaced data instead of private plugin data.

Any byte change to main, extract, or the UI template—including comments—changes the plugin version. The bridge hashes the concatenated main script and uninjected UI template, taking sixteen SHA-256 hex characters. Every plugin request must match it. Reconnect and rerun an outdated plugin. Preserve the unique `SESSION_CONFIG` assignment placeholder: injection replaces its first literal occurrence, so do not duplicate that full assignment in a comment or header.

Generated configuration contains ports, credential, and version only. Binding identity comes from response headers. An idle iframe chooses by current file; one holding a result chooses by original binding and retains the result until that bridge returns. Installation skips unchanged files to avoid needless Figma reloads.

## Members

- `main.js`: task dispatch and execution lifecycle for run/inspect/preview/variables, delegating extract. Enforces file/scope checks, compilation, snapshot budgets, approval, checkpoint, final preflight, and Undo boundaries. Tracks progress/cancellation, partial-write nodes/assets, page-root changes, Motion snapshot fields, and distinct variable binding/prototype-reference counts. Cancellation cooperates with the execution proxy; closing the plugin terminates suspended script continuations.
- `extract.js`: read-only visible-tree extraction, target-space geometry, text segments, reference PNG, image bytes, and automatic/explicit SVG islands. Uses main's shared helpers and declares the 12 MB structured-output budget; the 10,000-node and binary limits are independent.
- `ui.html`: iframe relay and status/approval panel. Serializes delivery/completion polling, maintains a network-driven cancellation heartbeat, forwards progress immediately, and preserves or degrades results according to protocol rules. Shows binding, active/recent jobs, and version; target focus is disabled during execution.
- `tsconfig.json`: classic-script checkJs environment for main/extract with Figma globals and ES2022. Both share one runtime global scope. UI inline JavaScript is exercised by tests rather than this type check.

Tests run the real concatenated main source and UI template in `node:vm` against synthetic document/HTTP behavior. Record live Figma acceptance alongside these automated contract results.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
