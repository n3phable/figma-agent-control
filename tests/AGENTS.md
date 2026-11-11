# tests/

> L2 | Parent: [project map](../AGENTS.md)

`npm test` runs `node --test --test-concurrency=1 tests/*.test.mjs`. Serial test files avoid competing browser performance workloads. The test suite itself does not require npm runtime packages; `npm run check` and the manual contract sampler require `npm ci`.

Elapsed-time budgets are enabled by default. CI sets `FAC_PERFORMANCE_GATE=1` on Ubuntu/Node.js 22 as the performance baseline and `0` on the other matrix jobs. Every job checks the same functional and pixel results and records timings; the baseline also enforces the existing time limits.

Tests depend on production modules, never the reverse. Plugin tests run the actual concatenated main source and iframe template in `node:vm` against synthetic Figma objects. Bridge tests start the real HTTP service. These tests exercise the local execution and transport contracts.

Isolation is mandatory: use port `0`, or explicitly injected test-owned candidate ports; never take the user's 32523–32530 bridge ports. Set `FIGMA_AGENT_CONTROL_HOME` to a test temporary directory. Do not touch the real shared plugin directory. Clean temporary directories with test hooks/finally. Inject clocks for lease/long-timeout behavior; retain real time only for short scheduling, process, and browser checks. Lock tests stub process probes rather than signaling unrelated processes. Each browser suite closes only Chrome instances it started.

Chrome-dependent tests skip with a reason when unavailable. Some text/font checks also need the named local font. Record skips with their environment requirements. Keep temporary browser profiles isolated between suites.

## Members

- `smoke.test.mjs`: end-to-end run/library/data/visual-check and batch-preview path through the real bridge and VM plugin; verifies result separation from job metadata.
- `args.test.mjs`: command table, option/positional constraints, bundled library labels, frame options, and subprocess JSON/help/errors without a bridge.
- `bridge.test.mjs`: individual HTTP contracts for credentials, versions, inputs, immutable request IDs, submission gates, delivery, completion, limits, and plugin identity probes.
- `bridge-session.test.mjs`: evidence/permissions/binary landing, verification, shutdown races, recovery/resolve, long polling, status, and port/template lifecycle.
- `plugin.test.mjs`: execution order, preflight, approval/checkpoint, final recheck, Undo, snapshots, visual checks, binary serialization, page roots, reads, and target focus.
- `plugin-failure.test.mjs`: creation-event settling, cleanup/protection, deleted-existing warnings, error stacks, and end-to-end mapped failure traces.
- `cancel.test.mjs`: cancellation during preparation/approval/execution, late acknowledgements, nonce isolation, font caching, progress persistence, hidden-panel cancellation, and continuation limits.
- `ui.test.mjs`: iframe request ordering, bridge discovery, result retention, long polling, held-heartbeat cancellation, payload fallback, timeout/error UI, and active/recent task display.
- `project-session.test.mjs`: binding/ID/atomic-write/plugin-install contracts, persistent pairing, startup recovery, locks/takeover, and pure leases without HTTP.
- `record.test.mjs`: change classification, stack mapping, result commit point, summaries/instructions/exits/waiting, and report statistics.
- `clean.test.mjs`: creation evidence shape, cleanup script identity checks, repeated cleanup, pre-submission rejection, and consistent submit/result/wait exits.
- `cli.test.mjs`: real CLI subprocesses against bridge/VM-plugin harness, including requests, binary results, approval, verification, resolution, diagnostics, project switching, image diff, and reporting.
- `extract.test.mjs`: read-only proxy-guarded extraction, geometry/text/islands/limits, bridge landing/recovery, and CLI integration.
- `motion.test.mjs`: MotionSpec read/reconcile/no-op/validation/rollback and trace behavior against synthetic Motion APIs, video-export retries, and pure issue rules.
- `prototype.test.mjs`: PrototypeSpec shorthand, graph/overlay reads, no-op/change-only apply, flow ordering, validation/rollback, and issue checks against synthetic APIs.
- `frames.test.mjs`: source preflight without Chrome; browser sampling/contact-sheet/comparison/dump checks with isolated profiles when available.
- `png.test.mjs`: generated PNG filter/color decoding, malformed data, and encode/decode round trips.
- `html-generate.test.mjs`: deterministic generation, structure, masks, islands, paints/effects/text, overrides, and reference baking using synthetic metrics.
- `html-attrib.test.mjs`: Figma geometry, dual-side ranking, translation search, local coordinate conversion, and fixes without Chrome.
- `html-suggest.test.mjs`: background-effect grouping, suggestion thresholds, generator-consistent crop geometry, and seam measures.
- `html-match.test.mjs`: committed pixelmatch reference pairs plus synthetic threshold/block/crop/shift/upscale/stack cases.
- `html-fonts.test.mjs`: synthetic sfnt/TTC parsing and isolated lookup; local-font-dependent cases may skip.
- `html-summary.test.mjs`: pure 16 KiB stdout reduction, totals, exits, full-batch resume commands, and instructions.
- `html-layout.test.mjs`: pure geometry/font/structure findings plus browser collection when Chrome and required fonts are available.
- `html-render.test.mjs`: Chrome rendering and comparison, paint probes, attribution, size/timeout handling, owned-process cleanup, and correction loops; nonbrowser failure paths remain testable independently.
- `html-zoom.test.mjs`: pure preflight/exclusion cases and browser subtree rendering/fractional translation when Chrome is available.
- `html-cli.test.mjs`: page metadata/naming/assembly/overrides/output cleanup and command preflight/resume/budget/interruption behavior, using browser substitutes except explicit rendering cases.
- `typecheck.mjs`: check entry point requiring the lockfile-pinned local TypeScript; checks host, plugin, motion, and prototype environments separately, never falling back to global tsc.
- `contract-samples.mjs`: optional explicit-path validation of user-supplied extract evidence against the type contract; creates and removes temporary typed samples. No private corpus is required or included in standard checks.
- [helpers/](helpers/AGENTS.md): shared isolated harnesses, synthetic documents, and committed media fixtures.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
