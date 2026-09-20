# Architecture

[Simplified Chinese](zh_cn/architecture.md)

Figma Agent Control lets an agent submit trusted Plugin API scripts from a local CLI to a development plugin in Figma Desktop. Figma must have the bound file open in Design mode; writes require edit access. The agent needs a shell and access to localhost.

Scripts receive the full `figma` object for the current file. The binding defines valid task targets, and the selected target defines snapshot and visual-check coverage. The system coordinates trusted automation and persists its evidence.

The [protocol](protocol.md) defines fields, files, and exit codes. The [agent guide](agent-guide.md) explains operation and recovery. Module maps link to the owning source without source-line references that drift as comments change.

## Processes and trust boundaries

| Component | Responsibility | Boundary |
|---|---|---|
| CLI | Parse inputs, submit jobs, read local evidence, run host-side analysis | Does not communicate directly with the plugin |
| Bridge | Validate, serialize, persist, and recover jobs | Does not access the Figma document |
| Iframe | Network relay, connection/approval/status UI | Cannot access the document |
| Execution code | Plugin API access, snapshots, scripts, reads, and exports | Sends no HTTP requests; relays through the iframe |

### Credentials and versions

[bridge.mjs](../src/bridge.mjs) assigns routes to CLI or plugin roles. Each role accepts only its credential. The CLI credential is freshly generated for each bridge startup and stored in the project's mode-0600 session file. The plugin credential is created exclusively once through [session.mjs](../src/session.mjs), stored in the shared pairing file, and injected into the iframe.

The iframe matches each task message against its ID and random nonce before accepting an acknowledgement or result.

### Local storage

[project.mjs](../src/project.mjs) defines two storage roots:

- `<project>/.figma-agent-control/`: binding, current session, lock, durable jobs, recovery records, and derived comparison evidence. The current working directory is the project; no parent search occurs.

- `~/.config/figma-agent-control/`, or `FIGMA_AGENT_CONTROL_HOME`: shared pairing credential and generated development-plugin files.

`connect` is the assembly point: obtain pairing, start bridge, install generated contents. The bridge itself returns those contents rather than writing global plugin files. Installation only changes different files to avoid needless Figma hot reload. Failure during installation closes the bridge.

## Module structure

The host dependency graph is acyclic. Detailed inventories live in [src/AGENTS.md](../src/AGENTS.md), [src/html/AGENTS.md](../src/html/AGENTS.md), [plugin/AGENTS.md](../plugin/AGENTS.md), and lib/AGENTS.md.

`project` has no internal dependencies. `connection` is pure in-memory state with an injectable clock. `png` uses only zlib. Bridge and HTML do not import each other: the bridge/record reference the shared extract type contract only through JSDoc. HTML submits through client and reads records. Shared interruption reasons live in session because both sides need them without a circular dependency.

### Host responsibilities

| Module | Why it owns this work |
|---|---|
| [args](../src/args.mjs) | One command table generates usage and dispatch metadata. Ambiguous duplicate single-value options are rejected before a write target can silently change |
| [client](../src/client.mjs) | One HTTP boundary maps permission denial, connection refusal, and timeout to distinct recovery actions |
| [bridge](../src/bridge.mjs) | One owner enforces active-job, request identity, checkpoint, completion, and unknown-write invariants |
| [connection](../src/connection.mjs) | Lease transitions need no filesystem or HTTP; clock injection makes expiry deterministic in tests |
| [session](../src/session.mjs) | Pairing, lock takeover, and startup repair span process lifetimes and belong outside transient bridge state |
| [record](../src/record.mjs) | All readers share one interpretation of evidence, summary, exit code, and next action; waits never resubmit |
| [doctor](../src/doctor.mjs) | Read-only diagnosis can still explain binding, lock, or installation problems when the bridge is unreachable |
| [report](../src/report.mjs) | Aggregation reads completed evidence without changing sessions or job state |

## Key flows

### Connection

`init` parses a Figma URL and writes binding format 2. `connect` acquires the single-instance lock, repairs interrupted evidence, starts loopback HTTP, writes the current session, and installs the shared plugin. The iframe obtains its file key before probing bridges, then sends its role credential and version. A matching instance takes the lease and receives the binding metadata.

Steady-state polling is held for up to ten seconds and immediately continued by network callbacks. This keeps a hidden panel responsive after connection is established. Initial/retry timers and Figma host calls can still be throttled when the application is invisible or a file is in the background. Active/background leases are 15/90 seconds. A running write cannot be silently handed to another plugin; interrupted reads can be abandoned and resubmitted.

### A run

```text
CLI submits -> bridge validates and persists queued job
            -> delivery persists running before handing off
            -> plugin compiles and verifies target
            -> before snapshot -> optional approval -> durable checkpoint
            -> target revalidation -> before render
            -> Undo boundary -> script -> Undo boundary
            -> after snapshot/render and result serialization
            -> bridge lands files -> atomic result.json
            -> CLI record reader summarizes outcome
```

The original script outcome is separate from evidence availability. A completed script can have an unavailable after snapshot or failed visual expectation. Those are not invitations to replay.

### Waiting and recovery

The CLI waits by observing evidence files and writes the job ID to stderr first. If a terminal or tool ends that waiting process, a later `wait` reads the same evidence. Request IDs identify immutable jobs; repeated submissions with the same ID retrieve the original outcome.

`result.json` is the commit point. A queued job that was never delivered can be recorded as nonexecuted. A delivered run without a result is unknown and blocks future runs. Built-in reads remain available so the user/agent can inspect the target. Resolve requires a current-session direct inspection and an assertion that the previous plugin stopped; it ends the wait without inventing success or undoing anything.

Late results can still land for recovered jobs. Results belonging to another project receive `FOREIGN_JOB` and stay in the iframe until their bridge returns. Diagnostics prioritize that cause so a generic “restart the plugin” instruction does not discard a real result.

### Extraction and HTML

Background-dependent effects need special handling: an SVG export does not include the underlying scene. Automatic island selection avoids them, and the host independently vetoes unsafe inlining unless an override explicitly requests it. Reference baking is different: it crops the complete reference rectangle, freezes the visible content there, and must remain a reported limitation.

## Type checking and tests

Runtime executes `.mjs`/`.js` source directly; JSDoc is checked with lockfile-pinned TypeScript and typings. The source bytes tested in VM are the bytes installed in Figma.

| Environment | Scope |
|---|---|
| [Host tsconfig](https://github.com/n3phable/figma-agent-control/blob/main/tsconfig.json) | Node modules and shared extract contract, without Figma globals |
| [Plugin tsconfig](../plugin/tsconfig.json) | Classic-script main/extract with Figma globals, without Node APIs |

The [extract contract](../src/html/extract-contract.d.ts) distinguishes plugin byte arrays, transport placeholders, and landed files. External JSON and dynamic API field access still require assertions; types alone cannot validate real Figma behavior. The optional `node tests/contract-samples.mjs <runs-directory>` checks explicitly supplied extract evidence against the type contract. It does not require or ship a private corpus.

## Extraction ownership

Read-only extraction runs inside plugin/main.js and shares its document-access helpers.

## Browser comparison layer

The host can render HTML through a Chrome debugging pipe and compare PNG pixels with a supplied reference. Use the comparison module API for this stage.

## HTML modules

- match compares decoded PNG pixels with antialiasing-aware YIQ differences.
- fonts reads local font names and metrics for the rendering pipeline.
- css maps extracted paint, geometry and text properties to CSS without I/O.
