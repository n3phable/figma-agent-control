# Architecture

[Simplified Chinese](zh_cn/architecture.md)

## Responsibilities and dependencies

- **Workspace binding and storage:** `src/project.mjs` parses Figma design/file URLs and stores format-2 bindings under `.figma-agent-control/binding.json`. Atomic writes replace a file only after the new contents are complete. `pluginHome` selects the shared plugin directory; `installPlugin` rewrites only changed files.

- **Pairing, locks and leases:** `src/session.mjs` owns the shared pairing credential, exclusive project lock and interrupted-job recovery. Only an exited PID permits stale-lock takeover. `src/connection.mjs` owns plugin leases; an active task prevents transfer, and rejected requests do not renew ownership.

- **Durable results:** `src/record.mjs` reads `result.json` as the completion commit point, compares snapshots and derives summaries and exit codes. Waiting observes evidence without submitting another job. `src/report.mjs` aggregates completed records and keeps execution and visual-verification failures separate.
