# src/

> L2 | Parent: [project map](../AGENTS.md)

Top-level host modules are shared by short CLI processes and the long-lived bridge. Business rules live here; `bin/` dispatches. Static HTML has a separate [module map](html/AGENTS.md).

The CLI uses `client` for HTTP and `record` for disk evidence. The bridge exclusively owns active/unresolved jobs and in-progress persistence. `session` owns cross-process/restart behavior, and `connection` owns in-memory plugin leases. Atomic `result.json` landing is the only completion commit point.

Dependencies remain acyclic. `project` is the bottom layer; `png` uses only zlib, and `connection` has no imports. Session, record, args, and report depend on project. Client depends on session/project. Bridge depends on connection/session/png/record/project. Only doctor and frames use `html/` at runtime, both for Chrome capabilities. Bridge/record refer to the extract contract through types only. HTML depends on client/record/session/png/project, never on bridge. Shared interruption reasons belong in session to preserve this direction.

## Members

- `args.mjs`: single command/usage/options table and parser. Rejects duplicate single-value options, normalizes URL-style node IDs, resolves bundled library names, and supplies trace library labels and the host Options type.
- `bridge.mjs`: loopback HTTP service and host-side enforcement point for credentials, plugin fingerprint, single active job, immutable request IDs, checkpoints, durable completion, unknown-write blocking, progress, and cancellation. Generates plugin files without installing them. Polls hold for ten seconds; default candidate ports are 32523–32530.
- `clean.mjs`: converts a failed run's creation evidence into an ordinary cleanup run. Validates evidence/size limits before submission and rechecks node identity, page, parent, and owned subtree count before deletion; no special bridge operation.
- `client.mjs`: sole CLI HTTP entry, reading session credentials and separating blocked-localhost, unavailable-bridge, and timeout errors. Stop affects only the bridge and interprets persisted execution state before allowing a resubmit.
- `connection.mjs`: pure in-memory plugin lease with injectable clock; active/background expiry is 15/90 seconds. Refuses unsafe instance replacement and returns reason codes rather than throwing.
- `doctor.mjs`: read-only diagnosis from Node/Chrome through binding/session/lock/plugin files to connection/job state. Missing Chrome warns without blocking non-browser readiness; no evidence cleanup.
- `frames.mjs`: resolves a successful single-video run or file, samples MP4/WebM in Chrome, writes labeled contact sheets and optional original-resolution frames, and compares videos using strict pixel changes.
- `image-diff.mjs`: offline comparison of PNG paths or single-image preview IDs using the run verifier's `diffPng`; writes differences to project evidence or a temporary directory.
- `png.mjs`: zero-dependency noninterlaced 8-bit PNG codec and premultiplied-alpha change statistics. HTML uses its codec but a separate perceptual matcher.
- `project.mjs`: foundational paths, hashes, JSON, atomic/exclusive writes, IDs, binding format 2, init, and content-aware global plugin installation. Imports no internal module.
- `record.mjs`: read-only evidence interpretation for summaries, next actions, exits, waits, changes, and script stack mapping. Recognizes cleanup runs by label/data without importing clean. Waiting never resubmits.
- `report.mjs`: read-only job statistics, elapsed/idle time distributions, repeated source executions, and distinct execution/verification failure counts; default interval is 24 hours.
- `session.mjs`: persistent pairing credential, startup repair, recovered jobs, single-instance lock, serialized stale-lock takeover, and shared undelivered/abandoned-read reasons. Does not start HTTP.
- `html/`: generation/checking/command subsystem with its own [map](html/AGENTS.md).

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
