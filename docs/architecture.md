# Architecture

[Simplified Chinese](zh_cn/architecture.md)

Figma Agent Control lets an agent submit trusted Plugin API scripts from a local CLI to a development plugin in Figma Desktop. Figma must have the bound file open in Design mode; writes require edit access. The agent needs a shell and access to localhost.

Scripts receive the full `figma` object for the current file. The binding defines valid task targets, and the selected target defines snapshot and visual-check coverage. The system coordinates trusted automation and persists its evidence.

The [protocol](protocol.md) defines fields, files, and exit codes. The [agent guide](agent-guide.md) explains operation and recovery. Module maps link to the owning source without source-line references that drift as comments change.

## Processes and trust boundaries

```text
Agent --shell--> CLI (one process per command)
                  |
                  | HTTP on 127.0.0.1, CLI credential
                  v
               Bridge (foreground connect process) --> project evidence
                  ^
                  | HTTP on localhost, plugin credential + source version
                  |
Figma Desktop: ui.html (iframe relay)
                  |
                  | postMessage, per-job channel nonce
                  v
               main.js + extract.js --> Figma document
```

| Component | Responsibility | Boundary |
|---|---|---|
| CLI | Parse inputs, submit jobs, read local evidence, run host-side analysis | Does not communicate directly with the plugin |
| Bridge | Validate, serialize, persist, and recover jobs | Does not access the Figma document |
| Iframe | Network relay, connection/approval/status UI | Cannot access the document |
| Execution code | Plugin API access, snapshots, scripts, reads, and exports | Sends no HTTP requests; relays through the iframe |

The split follows Figma's plugin environment. The iframe offers the full browser fetch/visibility behavior needed for timeouts and long polling; document execution remains in the plugin runtime. The generated manifest allows only the localhost development port 32523, uses dynamic-page access, and enables private plugin APIs for functionality such as Motion. Motion availability follows the current Figma version and account access.

### Credentials and versions

[bridge.mjs](../src/bridge.mjs) assigns routes to CLI or plugin roles. Each role accepts only its credential. The CLI credential is freshly generated for each bridge startup and stored in the project's mode-0600 session file. The plugin credential is created exclusively once through [session.mjs](../src/session.mjs), stored in the shared pairing file, and injected into the iframe.

Every plugin request also supplies a source version: sixteen SHA-256 hex characters from the concatenated execution script and uninjected UI template. A mismatch produces `PLUGIN_OUTDATED`, preventing an old plugin from interpreting a new protocol. All plugin template bytes, including comments, affect this value. A running plugin may need to be rerun after an update; its footer and `status.pluginVersion` expose the comparison.

The iframe matches each task message against its ID and random nonce before accepting an acknowledgement or result.

### Local storage

[project.mjs](../src/project.mjs) defines two storage roots:

- `<project>/.figma-agent-control/`: binding, current session, lock, durable jobs, recovery records, and derived comparison evidence. The current working directory is the project; no parent search occurs.

- `~/.config/figma-agent-control/`, or `FIGMA_AGENT_CONTROL_HOME`: shared pairing credential and generated development-plugin files.

`connect` is the assembly point: obtain pairing, start bridge, install generated contents. The bridge itself returns those contents rather than writing global plugin files. Installation only changes different files to avoid needless Figma hot reload. Failure during installation closes the bridge.

## Module structure

The host dependency graph is acyclic. Detailed inventories live in [src/AGENTS.md](../src/AGENTS.md), [src/html/AGENTS.md](../src/html/AGENTS.md), [plugin/AGENTS.md](../plugin/AGENTS.md), and [lib/AGENTS.md](../lib/AGENTS.md).

```text
bin -> args / client / bridge / session / record / clean / doctor
    -> report / image-diff / frames / html.command / project

bridge -> connection / session / png / record / project
client -> session / project
clean -> record / project
record / args / report / session -> project
image-diff -> png / record / project
frames -> png / record / project / html.chrome
doctor -> client / session / project / html.chrome

html.command -> extracts / page / overrides / summary / check / chrome
html.extracts -> client / record / session / project
html.page -> generate / fonts / match / png / project
html.generate -> css
html.check -> match / attrib / shift / layout / structure / suggest / zoom
```

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
| [clean](../src/clean.mjs) | Existing failure evidence becomes an ordinary run, reusing write guarantees without adding an operation |
| [doctor](../src/doctor.mjs) | Read-only diagnosis can still explain binding, lock, or installation problems when the bridge is unreachable |
| [png](../src/png.mjs), [image-diff](../src/image-diff.mjs), [frames](../src/frames.mjs) | Host analysis is independent of document execution; exported evidence can be inspected offline |
| [report](../src/report.mjs) | Aggregation reads completed evidence without changing sessions or job state |

The bridge keeps a small set of runtime owners: `active` for the one in-flight slot, `unresolved` for unknown writes, `jobs` for current/recovered records, and per-operation promises for delivery/completion/checkpoint/approval writes. Concurrent duplicate requests share the same persistence operation. Checkpoint contents and approval decisions are immutable. Shutdown waits for in-progress persistence before classifying unfinished work.

### Plugin and libraries

Figma loads one main script. Source is split into [main.js](../plugin/main.js) for execution and [extract.js](../plugin/extract.js) for read-only extraction, then concatenated at installation. They share a classic-script global scope. The extract contract is referenced during type checking.

Run scripts are compiled with `new Function`, so plugin globals remain reachable. Keep new top-level plugin names deliberate; scripts should declare their own variables. The `figma` proxy tracks supported async calls and cancellation, while nodes remain original API objects.

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

The original script outcome is separate from evidence availability. A completed script can have an unavailable after snapshot or failed visual expectation. Those are not invitations to replay. Failed scripts expose partial changes and eligible new nodes; optional cleanup is a separate Undo step and cannot restore earlier deletions or edits.

### Waiting and recovery

The CLI waits by observing evidence files and writes the job ID to stderr first. If a terminal or tool ends that waiting process, a later `wait` reads the same evidence. Request IDs identify immutable jobs; repeated submissions with the same ID retrieve the original outcome.

`result.json` is the commit point. A queued job that was never delivered can be recorded as nonexecuted. A delivered run without a result is unknown and blocks future runs. Built-in reads remain available so the user/agent can inspect the target. Resolve requires a current-session direct inspection and an assertion that the previous plugin stopped; it ends the wait without inventing success or undoing anything.

Late results can still land for recovered jobs. Results belonging to another project receive `FOREIGN_JOB` and stay in the iframe until their bridge returns. Diagnostics prioritize that cause so a generic “restart the plugin” instruction does not discard a real result.

### Progress and cancellation

The execution proxy tracks outstanding `figma.*Async` calls and supported namespaces, retaining their call-site stack. Progress carries preparation/approval/script/finish phase, elapsed time, page-local changes, and the oldest pending calls. The bridge maps stack locations to script/library files and persists `progress.json` for a timed-out CLI.

### Extraction and HTML

```text
extract in plugin -> visible tree + reference PNG + images + SVG islands
                  -> bridge lands one coherent result and files
                  -> host page assembly obtains font metrics/assets
                  -> pure generator emits nested DOM + asset placeholders
                  -> embed assets and write page with source fingerprints
                  -> Chrome renders -> matcher/diagnostics -> evidence/manifest
```

The plugin extracts API facts; frequently changing CSS generation rules remain on the host. A saved extract can therefore be regenerated offline with `html --from` without restarting the plugin. Automatic island selection in the plugin is versioned separately. The host decides which SVGs it can safely use and may request one additional extract for unsupported CSS nodes.

Background-dependent effects need special handling: an SVG export does not include the underlying scene. Automatic island selection avoids them, and the host independently vetoes unsafe inlining unless an override explicitly requests it. Reference baking is different: it crops the complete reference rectangle, freezes the visible content there, and must remain a reported limitation.

## HTML generation and diagnostics

Generation is deterministic: [page.mjs](../src/html/page.mjs) reads environment-dependent inputs and passes data to [generate.mjs](../src/html/generate.mjs); [css.mjs](../src/html/css.mjs) maps values without I/O or mutable state. Image placeholders are embedded afterward. The generator fingerprint records source changes.

The DOM follows the Figma hierarchy instead of flattening the canvas. This preserves clipping, masks, group opacity, and compositing relationships. Transform-created stacking contexts can isolate blending, so suitable translation-only containers use left/top while the override contract remains transform-based. SVG islands and reference bakes replace their subtrees.

Font discovery parses sfnt tables, TTC collections, and named variable-font instances without runtime packages. It currently searches macOS user/system font directories. Other platforms can run host tests, but missing metrics/fonts can affect browser fidelity. Substitution is measured and reported rather than hidden.

[check.mjs](../src/html/check.mjs) owns sequencing and verdicts, delegating diagnostics:

| Module | Question answered |
|---|---|
| [match](../src/html/match.mjs) | Which pixels differ, excluding expected antialiasing differences, and where do they form dense blocks? |
| [attrib](../src/html/attrib.mjs) | Which node owns each mismatch on the HTML and Figma sides? |
| [shift](../src/html/shift.mjs) | Would a local translation help, and what transform/basis expresses it? |
| [layout](../src/html/layout.mjs) | Did browser geometry, wrapping, overflow, and actual font usage match? |
| [structure](../src/html/structure.mjs) | Are expected nodes and exact text present, with intended baked/omitted subtrees exempted? |
| [suggest](../src/html/suggest.mjs) | Is a background-dependent reference crop justified, and will it introduce seams? |
| [zoom](../src/html/zoom.mjs) | What differs in a magnified isolated node? |

Attribution uses both sides because the HTML side alone cannot assign pixels where content is missing. Both sides share rasterization and paint-order rules. Structural text checks catch mistakes a low-contrast pixel score might miss. Suggested crops are recomputed through the generator so proposal geometry agrees with applied output.

Run verification and HTML comparison deliberately use different definitions. Run's `diffPng` asks whether pixels changed, with zero default channel threshold. HTML comparison asks how two renderers agree, using the pixelmatch-derived YIQ threshold and separate antialiasing classification. Combining them would either miss small edits or overcount normal renderer differences.

The Chrome client uses a debugging pipe rather than an exposed debugging port, fixes software rasterization/sRGB, bounds commands and waits, and cleans only its owned process/profile. Each page has a separate browser context. Unexpected exit/protocol errors reject pending commands. Normal signals trigger cleanup; SIGKILL can still leave a temporary profile.

Overrides are the only supported manual correction channel. Entire files are validated up front, and basis values make stale corrections visible. `html-check` reconstructs context from saved extraction and fingerprints; modified pages or unavailable matching overrides produce explicit warnings. Focus/zoom diagnostics do not alter the overall verdict.

## Type checking and tests

Runtime executes `.mjs`/`.js` source directly; JSDoc is checked with lockfile-pinned TypeScript and typings. The source bytes tested in VM are the bytes installed in Figma.

| Environment | Scope |
|---|---|
| [Host tsconfig](https://github.com/n3phable/figma-agent-control/blob/main/tsconfig.json) | Node modules and shared extract contract, without Figma globals |
| [Plugin tsconfig](../plugin/tsconfig.json) | Classic-script main/extract with Figma globals, without Node APIs |
| [Motion tsconfig](../lib/tsconfig.json) | Motion helper with injected target/data declarations |

The [extract contract](../src/html/extract-contract.d.ts) distinguishes plugin byte arrays, transport placeholders, and landed files. External JSON and dynamic API field access still require assertions; types alone cannot validate real Figma behavior. The optional `node tests/contract-samples.mjs <runs-directory>` checks explicitly supplied extract evidence against the type contract. It does not require or ship a private corpus.

## Shadow mapping

Shadow outlines account for painted fills and outside/center strokes. Spread follows the observed rectangle/ellipse/filled-clipping-frame rules; overflowing content can require a content-shaped shadow and an explicit approximation finding.

## Child paint order

Generation follows extracted child order. Compare reversed Auto Layout stacking with the reference image.
