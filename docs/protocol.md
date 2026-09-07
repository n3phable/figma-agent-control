# Protocol and evidence

[Simplified Chinese](zh_cn/protocol.md)

## Workspace binding and storage

`src/project.mjs` parses Figma design/file URLs and stores format-2 bindings under `.figma-agent-control/binding.json`. Atomic writes replace a file only after the new contents are complete. `pluginHome` selects the shared plugin directory; `installPlugin` rewrites only changed files.

## Pairing, locks and leases

`src/session.mjs` owns the shared pairing credential, exclusive project lock and interrupted-job recovery. Only an exited PID permits stale-lock takeover. `src/connection.mjs` owns plugin leases; an active task prevents transfer, and rejected requests do not renew ownership.

## Durable results

`src/record.mjs` reads `result.json` as the completion commit point, compares snapshots and derives summaries and exit codes. Waiting observes evidence without submitting another job. `src/report.mjs` aggregates completed records and keeps execution and visual-verification failures separate.

## Offline CLI

`bin/figma-agent-control.mjs` dispatches the commands declared in `src/args.mjs`. This slice exposes `help`, `init`, `result` and `wait`; argument failures produce JSON and a nonzero exit. `result` and `wait` read local evidence by job ID.

## Plugin transport relay

`plugin/ui.html` serializes polling and completion ticks. It accepts task replies only for the matching ID and channel nonce, retains results while their bridge is unavailable, and distinguishes pairing, version and foreign-job failures.

## Plugin read engine

`plugin/main.js` verifies the bound file and target for read operations. Inspect returns the target and display ancestry; preview exports requested in-scope nodes; variables follows local default-mode aliases and counts target-subtree bindings. `src/png.mjs` handles PNG evidence.

## Local bridge and status

`connect` owns the foreground bridge process and installs the generated development plugin. `src/bridge.mjs` binds port 32523 and separates CLI and plugin credentials; `src/client.mjs` is the CLI HTTP boundary. `status` exposes the session and plugin connection. Keep only one project bridge running on the machine.

## Job delivery and completion

The bridge delivers one job at a time and saves job identity before delivery. Reusing a request ID returns the original task and rejects changed content. The first atomically persisted `result.json` wins. The CLI now submits `inspect`, `preview` and `variables`; receipts identify the job to wait for.
