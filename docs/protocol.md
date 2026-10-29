# Protocol and evidence

[Simplified Chinese](zh_cn/protocol.md)

This document defines the contracts between the CLI, local bridge, plugin iframe (`ui.html`), plugin execution code (`main.js` plus `extract.js`), and host-side HTML export. Keep it aligned with implementation changes. For operating procedures, see the [agent guide](agent-guide.md).

## Components and data flow

```text
CLI --HTTP / CLI credential--> bridge <--HTTP / plugin credential + version-- ui.html
                                 |                                          |
                                 |                                     postMessage
                                 v                                          |
                    .figma-agent-control/                               main.js
                    binding, session, job evidence                          |
                                                                            v
                                                                      Figma document
```

The bridge listens on `127.0.0.1`, using the first available port in `32523`–`32530`. Each project has at most one bridge, enforced by `bridge.lock`, and one active job. The actual port is recorded in `session.json`.

All plugin HTTP traffic goes through the iframe. `/poll` holds an empty request for up to ten seconds and wakes immediately when a job arrives. A held empty response carries `X-Long-Poll`, causing an immediate next request. This network-driven chain avoids panel timer throttling. Initial polling, handshake retries, ordinary heartbeats, completion retries, error recovery, and panel refresh also use a 750 ms timer. Hidden-panel timers may be heavily throttled, so reconnection can be slower than steady-state polling. Results are sent immediately when received from the execution code.

## Project directory

All paths in this table are relative to `.figma-agent-control/`:

| Path | Writer | Contract |
|---|---|---|
| `binding.json` | `init` | Format `2`, file key, scope node, and source URL. Other formats are rejected |
| `session.json` | Bridge | Port, per-start CLI credential, session ID, and PID; mode `0600`; removed on shutdown |
| `bridge.lock` | Bridge/session | Lock owner's PID |
| `runs/<job-id>/` | Bridge/session | Job evidence; directory mode `0700` |
| `recoveries/<id>/` | Session | Archived stale lock and takeover report |
| `diffs/` | `image-diff` | PNG comparison artifacts |
| `frames/` | `frames` | Video contact sheets and optional original-size frames |
| `check/<extract-job-id>/` | HTML commands | Rendered comparison evidence |

A lock is stale only when checking its PID returns `ESRCH`. Takeover first exclusively creates `bridge.lock.takeover`, rereads the lock, and archives it only if unchanged. An empty lock may be between creation and PID write: `connect`, `stop` without a session, and `doctor` treat it as occupied and never delete it. A live PID is occupied even if the operating system reused it; the diagnostic gives a manual inspection path.

`init` adds the evidence directory to the project's `.gitignore`. Keep this local evidence directory separate from delivery artifacts because it contains design data and credentials.

## Global plugin directory

The shared directory is `~/.config/figma-agent-control/`, overridden by `FIGMA_AGENT_CONTROL_HOME`.

| Path | Writer | Contract |
|---|---|---|
| `pairing.json` | `connect` via session | Persistent plugin credential, mode `0600`; exclusive first creation. Corruption gives `PAIRING_INVALID` |
| `plugin/manifest.json` | `connect` | Generated development manifest, `documentAccess: dynamic-page`, `enablePrivatePluginApi: true`, no Figma-assigned plugin ID |
| `plugin/main.js` | `connect` | Concatenation of source `plugin/main.js` and `plugin/extract.js` in `PLUGIN_SCRIPTS` order |
| `plugin/ui.html` | `connect` | Template with candidate ports, plugin credential, and plugin version injected |

The bridge generates plugin contents; `connect` installs only changed files. A fixed candidate port range and shared pairing credential make the generated files identical across projects at the same version. Bindings and project names arrive in authenticated response headers instead of being embedded in the plugin.

Because the manifest has no Figma-assigned ID, private `setPluginData` is unavailable. Namespaced `setSharedPluginData` does not depend on that ID.

## Jobs

### Submission: `POST /job`

The caller must use the CLI role.

| Field | Operations | Constraint |
|---|---|---|
| `operation` | All | `run`, `inspect`, `preview`, `variables`, or `extract` |
| `code` | Run | Nonempty JavaScript function body |
| `libs` | Run | At most 20 `{name, code}` entries, at most 2 MiB UTF-8 combined |
| `targetNodeId` | All | Defaults to the bound node; plugin validates scope membership; extract cannot target a page |
| `snapshotDepth` | Run/inspect | Integer `1`–`31`; explicitly limits snapshot depth |
| `nodes` | Preview | 2–50 unique nodes; first equals the effective target |
| `names` | Preview | 1–50 unique, nonempty names of at most 200 characters; excludes `targetNodeId` and `nodes` |
| `scale` | Preview/extract; run with expect | `0.1`–`4`; extract scale changes the reference image only |
| `islands` | Extract | 1–500 unique additional SVG-export node IDs |
| `data` | Run | JSON, at most 1 MiB UTF-8, passed as `data` |
| `expect` | Run | `changed` or `unchanged` |
| `tolerance` | Run with expect | Nonnegative changed-pixel allowance; default `0` |
| `risk` | Run | `{level:"high", reason}` requires plugin-panel approval |
| `cleanOnFail` | Run | Boolean; maps to CLI `--clean-on-fail` |
| `requestId` | All | Lowercase UUID used as the job ID; the CLI exposes it on `run` |
| `label` | All | Source name for reports; CLI uses the script basename, or `clean <original-id>` |

The CLI resolves a bare `--lib motion` to its bundled file before submission. The bridge and plugin receive ordinary named source strings and do not distinguish built-in libraries from user libraries.

A repeated request ID returns the original job with HTTP `200` and `reused:true`. Binding, operation, source, libraries, target, depth, nodes, scale, data, effective high-risk reason, expectation, tolerance, islands, cleanup, and names must remain identical or submission returns `400`. Omitted cleanup and `false` are equivalent; an omitted target and an explicitly supplied bound node are not. `label` is not compared. This identity check precedes transient rejection conditions, so a repeated request can still retrieve its original job while disconnected or busy.

| New-submission condition | Response |
|---|---|
| Bridge shutting down | `409 BRIDGE_STOPPING` |
| Plugin disconnected | `409 RECONNECTING` |
| Another job active | `409 ACTIVE_JOB` |
| Unknown write result and operation is run | `409 REVIEW_REQUIRED`; built-in reads remain available |

### Run execution order

The plugin follows this order:

1. Verify file key and editing mode.

2. Compile libraries and body into nested function scopes. Earlier libraries are outermost. Syntax failure is `executionStarted:false`.

3. Resolve the target and verify that it belongs to the bound scope. Missing and out-of-scope targets are distinct errors.

4. Capture the before snapshot, with a 2,000-node budget. Default depth is 32; an undeclared truncation rejects a run. Explicit `snapshotDepth` permits deliberately shallow evidence. Preview, variables, and extract snapshot only the root.

5. For high-risk runs, await panel approval for at most 300 seconds. Rejection or timeout does not execute the script.

6. Send the write-ahead checkpoint to the bridge. It atomically saves `before.json` and fixes its hash. A ten-second acknowledgement timeout prevents execution.

7. Export a before image if `expect` is set. For cleanup, collect IDs already on the target page. For non-page targets, record direct page-root children.

9. Commit an Undo boundary, listen for target-page node changes, enter the script phase, set `executionStarted:true`, evaluate libraries and body, and commit the closing Undo boundary. Boundary failures are reported, not automatically undone. A script failure records created nodes and optionally cleans them after a successful closing boundary.

10. Capture the after snapshot and, if requested, after image. Compare page-root children for successful non-page-target runs. A too-large after snapshot makes the change set unavailable; a failed after export makes visual verification unavailable. Neither changes the script's own outcome.

11. Serialize the result and extract nested binary data. Large plugin messages use the serialized envelope described below.

Trusted scripts receive the full Plugin API for the current file. The binding defines valid targets; the selected target defines snapshot, change-set and visual-check coverage.

### Binary return values

Run output and extract output share a binary channel.

- Byte views such as `Uint8Array`, plus complete PNG/JPEG integer arrays, are recognized anywhere inside nested output. They become `{"__figmaAgentControlBinary": index}` placeholders; returning that reserved key yourself fails the job.

- A run permits at most 200 binaries. Combined base64 length, including before/after visual images, is at most 48 MB. Exceeding this limit fails the run after execution, retains no return value, and saves no output binaries; it must not be replayed.

- The bridge writes `files/output-<n>.<type>`, starting at 1, then replaces placeholders with `{file, bytes, sha256, type, width?, height?, pixels?}`. Paths are relative to the job directory.

- Content detection recognizes PNG, JPEG, GIF, WebP, PDF, SVG, MP4 (`ftyp` at bytes 4–8), and WebM (`1A 45 DF A3` prefix); unknown data uses `bin`. PNGs include dimensions. Run PNGs also have transparency/dominant-color summaries unless a single image exceeds 16 million pixels or the job exceeds 32 million analyzed pixels (`pixels.skipped: "too-large"`). Extract does not compute pixel summaries.

- Invalid placeholders become `{binaryUnavailable:true}` and add `binaryErrors`; other evidence is preserved.

- Binary data is excluded from the iframe's structured-result limit. Base64 strings returned by a script are not excluded and can cause the whole return value to be discarded.

### Preview by name

Names match exact strings among the bound node's children, recursively entering Sections only. Sections themselves can match; frames, groups, components, and instances are not traversed.

All names are resolved after loading the page and before any export. Any missing or ambiguous name fails with `executionStarted:false` and exports nothing. Missing-name errors list up to twenty available names; ambiguous-name errors list the count and up to twenty IDs and locations. Resolved nodes then use the ordinary per-node scope check and export path.

`job.json` records the names. `result.json` records resolved `images[].nodeId`. The bridge checks image count, ordered names, and valid node IDs before accepting the evidence.

### Extract

Extract is a built-in read, not a script. It has no approval, write-ahead checkpoint, or Undo boundary. It loads the target page without changing the page the user is viewing. Every failure has `executionStarted:false`; interrupted extracts can be resubmitted.

It serializes visible nodes only, dropping invisible subtrees. The target cannot be a page or invisible. Automatic SVG islands select maximal graphical subtrees with a vector-like node, no text/path text or visible bitmap, no background-dependent effect, and a painted non-mask root distinct from the target. Background dependencies include GLASS, background blur, and non-normal/non-pass-through blending. Automatic SVG strings are deduplicated.

Explicit `islands` add to automatic exports. Already-exported automatic nodes are reused; other explicit islands use binary SVG without deduplication. Nodes outside the visible target tree, without painting, or failing export are skipped: `islandsSkipped` and `warnings` explain them, `ok` remains true, and the CLI exits `1`.

Target-page changes during extraction add `documentChangedDuringExtract`: the tree, reference, and islands may represent different instants.

| Limit | Value | Remedy |
|---|---|---|
| Visible nodes | 10,000 | Narrow the target |
| Reference, bitmaps, explicit SVG binaries | 200 items, 48 MB base64 combined | Narrow the target or lower scale |
| Structured output | 12 MB estimated UTF-8 upper bound | Narrow the target |

Exceeding a limit fails without partial output. The structured estimate counts non-ASCII code units as three bytes. The output contract is [extract-contract.d.ts](../src/html/extract-contract.d.ts):

| Field | Meaning |
|---|---|
| `schema`, `islandRule` | Schema `1`; automatic-island rule version `2` |
| `root` | Tree with `id`, `name`, `type`, target-space transform `[[a,c,tx],[b,d,ty]]`, dimensions, and clipped target-space `renderBounds` or null. Root transform is identity. Other properties omit defaults; text styles are in `segments` |
| `colorProfile`, `scale` | Document color profile and extraction scale |
| `reference` | PNG of the node's own box via `useAbsoluteBounds`, scaled, preferably sRGB; fallback to document color adds a warning |
| `images` | Image-hash-deduplicated `{bytes, width, height}` entries; missing bytes produce warnings |
| `islands`, `svgs` | Node-to-SVG-key mapping; `s<n>` is an automatic string and `b<n>` an explicit binary |
| `islandsSkipped` | Skipped explicit IDs |
| `stats` | `nodes`, `islands`, `svgs`, `images`, `svgMs`, `componentMs`, `svgSrgb`, `lineHeightMissing`, `postScriptMissing` |
| `warnings` | Nonfatal export, image, color-profile, or consistency problems |

### Result files

Atomic creation of `runs/<job-id>/result.json` is the sole completion commit point. `job.json` is a derived record whose state and finish time are repaired on the next startup if a crash occurs between writes. Readers use `result.json`, not a terminal job state alone. Before snapshots live only in `before.json`.

| Result field | Meaning |
|---|---|
| `ok`, `output` | Execution/read outcome and returned data with landed binary descriptors |
| `changes` | Run change set |
| `pageRoot` | For a successful non-page-target run, changed direct page children: `created`/`deleted` entries `{id,name,type}`, up to 50 each plus omitted counts. Inspect these before/after differences to identify their source |
| `verify` | Requested visual verification when `ok:true` |
| `images` | Preview descriptors `{nodeId,name,file,bytes,sha256,width,height,pixels}` under `images/<index>-<node>.png` |
| `ancestors` | Inspect visibility chain toward the page, up to twenty levels, including opacity, masks, fills, and clipping |
| `error`, `executionStarted`, `recovery` | Failure, whether the script started, and recovery guidance |
| `stack`, `trace` | Raw and mapped script-error locations |
| `targetMissing`, `missingNodeId`, `fileVerified` | Evidence that a missing-node inspect queried the bound file |
| `after` | Partial-write snapshot, retained only after execution started and failed |
| `bindingVerified` | Actually verified file, page, and node |
| `undoBoundaries` | `before`, `after`, and optionally cleanup `clean` boundary outcomes |
| `created`, `cleaned`, `cleanFailed` | Failed-script node tracking and cleanup results |
| `createdAssets` | New surviving collections, variables, and styles; entries `{id,name}` |
| `deletedExisting` | Existing nodes deleted during a run that also performed cleanup |
| `warnings`, `binaryErrors` | Evidence/cleanup limitations and binary transport issues |
| `pluginMs`, `approvalMs`, `finishedAt` | Execution timing excluding approval, approval timing, and landing time |

### Error stacks and traces

Only a value thrown by script compilation/execution with a string stack supplies `stack`, capped at 4,000 characters. Internal validation, snapshot, and serialization errors do not. An unstringifiable thrown value still ends the job with an explanatory error.

Compilation nests libraries and body in `new Function`. With a two-line engine function header and one outer wrapper line, the first segment starts at engine line 4. Segment `k` starts at `4 + sum(previous segment line counts + 1)`. Its local line is the engine line minus that start plus one; columns are unchanged.

`scriptTrace` in [record.mjs](../src/record.mjs) recognizes QuickJS `<input>` and V8 eval frames. It skips `anonymous` wrappers and trusts unnamed frames only during compilation. It skips out-of-segment frames until the first match, then stops at an outer wrapper. At most ten frames are returned as `{file,line,column,source}`; source is trimmed to 200 characters. Built-ins use `lib:<name>`. Mapping failure never prevents result persistence.

Nested `eval` or `new Function` code can produce misleading locations; the raw stack remains authoritative. QuickJS can truncate callers across `await`; host async rejections can have no stack. Bundled async library wrappers preserve their entry stacks where possible. The CLI emits mapped trace or the first 500 raw stack characters.

### Failed-script node tracking

The plugin listens to target-page `nodechange` CREATE/DELETE events during execution and excludes `origin: REMOTE`. Nested creation/deletion is reported at the highest parent. Registration failure adds a warning without preventing execution.

After a script throws and the closing boundary is attempted, event settling waits at least 200 ms, then until 120 ms of quiet, bounded by one second of wall time with 40 ms checks. Throttling can add a timer interval. Surviving created nodes are fetched and descendants of other created nodes removed from the list. Each entry is `{id,name,type,parentId,size}`; `size` counts owned descendants, excluding instance-internal IDs beginning with `I`. Older records may lack the last two fields.

With `cleanOnFail`, cleanup runs only after a successful closing boundary. It protects a node that existed on the target page before execution, or contains such a node. Successful deletions go to `cleaned`; protection/deletion failures go to `cleanFailed` with a reason. At least one deletion causes another Undo boundary, recorded in `undoBoundaries.clean`; a failed cleanup boundary warns that its deletions may merge into the next Undo step.

If cleanup deleted nodes and original target-page nodes disappeared during execution, `deletedExisting` counts the reported top-level deletions and adds a warning. ID-replacing operations such as detach/flatten can make existing content look new. A deliberate Undo of the cleanup step can restore that content; existing script edits are never rolled back automatically.

Creation tracking excludes other pages and failures after the script body completed, such as serialization failure. New components may not emit CREATE events. Local user edits during execution are indistinguishable from script edits. Existing content moved in from another page is not covered by cleanup protection. Evidence/cleanup errors add warnings while preserving the original script error.

Collections, variables, and styles use before/after ID comparisons rather than node events. `createdAssets` only reports them; neither cleanup path deletes them. Each failure-evidence read has a 15-second timeout. Summary node lists cap at fifty entries with omitted counts.

### Deferred cleanup: `clean`

`clean <job-id>` constructs an ordinary run, so checkpoint, Undo, unknown-write review, and normal evidence all apply. There is no special plugin operation.

The original must be a completed failed run with `executionStarted:true` and a `created` list. Its target page comes from `before.json.bindingVerified.pageId`. Invalid or missing evidence is rejected before submission. The candidate set is `created` minus `cleaned` and `cleanFailed`; deliberately protected nodes remain excluded. An empty set returns `{task,instruction}` with exit `0` and no new job.

The cleanup job has the fixed script, label `clean <original-id>`, depth `1`, and data `{task,pageId,nodes}`. It targets the bound node, not the original target. It has no request ID, high-risk flag, or recursive cleanup. Data above 1 MiB, or at least 2,000 candidate children directly under the bound node, is rejected before submission. Other existing children can still make the before snapshot exceed budget.

Per-node checks classify already absent nodes as `gone`; a changed page, name, type, parent, owned descendant count, or missing original parent evidence becomes `skipped`. Remaining nodes are deleted; deletion errors also become skipped. Output is `{task,cleaned,gone,skipped}`, with reasons on skipped entries. The original evidence is not rewritten. Any skipped entry gives exit `1`; repeated cleanup is supported. This check cannot identify every existing layer moved into a new container, so inspect candidates before invoking it.

### Change sets

Before/after snapshots produce `counts.created`, `deleted`, `moved`, `updated`, `bindingOnly`, and `positionOnly`. The last three are mutually exclusive: changed values, bindings only, or layout-induced position changes only.

A move changes parent or falls outside the longest common ordered sibling subsequence. Inserting/deleting a sibling does not mark every other sibling as moved; swapping two siblings marks one. Up to fifty changed/created/deleted/moved nodes are expanded, with `omitted` for the remainder. Position keys are omitted from per-node `keys`.

Explicit depth adds a `limitation`; deeper changes are invisible. Nonempty Motion styles, tracks, and owner-frame timelines are snapshotted when available. An undeclared after-snapshot depth truncation or node-budget overflow makes the change set unavailable. After an execution failure with an oversized after snapshot, both `changes` and the `after` scene can be absent; use inspect.

Only the target subtree is compared. Out-of-target writes through `figma` are not directly observed; direct page-root additions/deletions have the separate `pageRoot` comparison.

### Visual verification

Run `expect` exports the target before and after and compares premultiplied-alpha pixels at channel threshold zero:

```text
changed = !sameSize || changedPixels > tolerance
pass = expect === "changed" ? changed : !changed
```

Evidence files are `images/render-before.png`, `render-after.png`, and `render-diff.png`. A failed visual check leaves `ok:true` because the script succeeded, but exits `1`; it must not be replayed.

An unavailable check reports `{expect,tolerance,pass:false,error}` without pixel statistics or images. Causes include failed after export, missing or invalid render data, export budget overflow, or a render above 16 million pixels. The error begins `Visual check unavailable: ` and the next step is a preview.

The export sees only the target: outside covering layers, outside instances, and writes to indistinguishable hidden layers are outside this check.

## Unknown write results

Delivery is recorded as `running` atomically before `/poll` returns a job. Therefore a queued job is provably undelivered: shutdown or startup recovery records a failed result with `executionStarted:false`. A delivered job without a result is different:

- Normal bridge shutdown writes `recovery.json` with `unknown-after-disconnect`.

- Recovery after an abnormal exit writes `needs-document-review`.

- At startup, unresolved jobs for the current binding are loaded as recovered. Recovered runs enter `unresolved` and block new runs; reads do not and can be resubmitted.

- A run with valid `resolution.json` is not reloaded. Corrupt resolution records fail startup. An unresolved write for another binding also fails startup; unrelated read jobs are ignored.

- Recovered jobs are never redelivered and cannot receive a new approval or checkpoint. A late completion for a loaded job may still land and clear its unresolved state.

Resolve with `resolve <original-id> --inspect <inspection-id> --previous-plugin-stopped`. The inspection must directly query the original target in the current session, and the previous plugin must actually be stopped. Resolve closes the unresolved wait without claiming an outcome, replaying, or undoing the write.

Completions are idempotent when `result.json` already exists, even if the job is absent from current memory. A job neither loaded nor completed on disk gets `409 FOREIGN_JOB`; no evidence is written and the plugin retains its original result for the right project. This also applies to a run resolved before restart, which is intentionally not reloaded. Its stale plugin must be closed and rerun; the reviewed result remains unknown.

### Progress and cancellation

Scripts and libraries receive a proxy around `figma`. It forwards access and tracks outstanding methods whose names end in `Async`, including the `variables`, `motion`, `teamLibrary`, `clientStorage`, and `annotations` namespaces. Nodes are returned unchanged, so node async methods are not tracked. Successfully loaded fonts are cached by family/style for the plugin session; failures are not cached.

The plugin reports progress one second after receiving a run, then every two seconds when timers can run:

```text
{seq, phase, elapsedMs, changes?, lastChangeAgoMs?, waiting?, waitingCount?}
```

Phases are `prepare`, `approval`, `script`, and `finish`. Only script phase has target-page local change counts and pending calls. `waiting` includes up to three earliest calls with `{call,forMs}`; the oldest includes up to 1,000 stack characters. The iframe sends progress immediately in a URL-encoded heartbeat parameter. The bridge maps that stack to `at`, removes the raw stack, adds `reportedAt` and optional `hidden:true`, stores memory state, and writes `progress.json` once per sequence number. Invalid progress is ignored. Status adds `ageMs`.

A separate `/heartbeat?hold=1` channel holds until cancellation, completion, or roughly ten seconds, and uses `X-Long-Poll` for immediate continuation. This avoids panel timer throttling. The plugin's own progress and failure-cleanup timers can still be throttled.

Cancellation cannot kill the suspended JavaScript continuation or a host call already in flight. Later proxy access throws, but later direct writes through a previously acquired node are not blocked. A warning records this limit. Stop and rerun the plugin to terminate the continuation. Read-only jobs cannot be cancelled; synchronous work must yield before cancellation can be handled.

## Bridge endpoints

| Endpoint | Role | Contract |
|---|---|---|
| `GET /status` | CLI | Binding, connection, active/unresolved jobs, plugin version, latest twenty jobs, optional progress and cancellation request |
| `POST /job` | CLI | Submit a job |
| `GET /result?id=` | CLI | Current-session result; the CLI normally reads evidence from disk |
| `POST /resolve` | CLI | Resolve an unknown write after inspection |
| `POST /cancel` | CLI | `200 {cancelled:"before-delivery"}` or `202 {cancelRequested:true}`; otherwise `409 NOT_ACTIVE` / `NOT_RUN` |
| `POST /shutdown` | CLI | Requires `{force:boolean}`; active queued/running work without force gives `409 ACTIVE_JOB`; otherwise responds `202` before closing |
| `GET /poll` | Plugin | Claim work, or hold an empty response for up to ten seconds |
| `GET /heartbeat` | Plugin | Identity probe, lease renewal, job/progress report, or held cancellation channel |
| `POST /checkpoint` | Plugin | Persist the write-ahead snapshot |
| `POST /approve` | Plugin | Immutable decision for a high-risk run delivered in this session |
| `POST /complete` | Plugin | Idempotent completion, first result wins; does not require the current lease |

Every request supplies `X-Session-Token`. Plugin routes additionally require `X-Plugin-Version`. CLI and plugin credentials are separate and role-specific. Plugin mismatch gives `403 PAIRING_MISMATCH` without echoing credentials; CLI mismatch gives `403`. A version mismatch gives `409 PLUGIN_OUTDATED`.

`pluginIssues` records a last-seen timestamp independently per connection cause. When disconnected, doctor reports causes seen within two minutes in this order: `FOREIGN_JOB`, `PAIRING_MISMATCH`, `NO_FILE_KEY`, `WRONG_FILE`. Only the first is an error with an action; the rest are warnings. Foreign results take priority because restarting the plugin could discard them. Pairing diagnostics require a version header to avoid noise from simple requests or scans.

## Plugin messages

The iframe and execution code use postMessage. Each job has a random `channelNonce`; mismatched IDs or nonces are ignored.

Job messages above 65,536 JavaScript string characters, including snapshots and base64, use a `serialized-result` envelope. The iframe falls back to compact failure evidence when the structured portion exceeds about 16 MB, the bridge returns `413`, or the same completion receives three cumulative `400` responses. Other failures do not reset the rejection count. `409 FOREIGN_JOB` never triggers degradation. The compact result retains execution state, verified binding, script-failure cleanup lists, new assets, warnings, and stack.

While a result is awaiting delivery, the iframe sends `/complete` rather than heartbeats. Request deadlines are 15 seconds for polling, three seconds plus one second per 10 MB of completion payload, and three seconds for other requests.

## Motion

[lib/motion.js](../lib/motion.js) runs inside ordinary `run --lib motion` jobs. It adds no bridge operation, and inherits run checkpoints, Undo boundaries, and change sets. Motion is a Beta/private API surface; the manifest enables private API access, but Figma availability remains external to FAC.

### MotionSpec

| Function | Return value |
|---|---|
| `readMotion(root = target, {durationRange}?)` | MotionSpec grouped by timeline, with `issues` |
| `applyMotion(spec = data, root = target)` | `{changes,motion}`; counts `tracksWritten`, `tracksRemoved`, `stylesApplied`, `stylesRemoved`, `durations`, then rereads |
| `exportMotion(node = target, settings = {format:'WEBM',quality:'LOW'}, {waitSeconds=60,intervalMs=3000,differentFrom}?)` | `{frame,video,attempts,waitedMs}`; video bytes use normal binary landing |
| `motionIssues(spec, {durationRange=[0.1,0.5],easingTokens=[]}?)` | Issue array; readMotion already includes it |

```json
{
  "timelines":[{"id":"12:34","name":"Card entrance","duration":0.6,"nodes":[
    {"id":"12:35","name":"card","tracks":{"OPACITY":{"base":1,"keys":[[0,0],[0.3,1,"$motion/standard"]]}},
     "styles":[{"id":"AnimationPresetId:12:40","preset":"Position","at":0.08,"dur":0.3,"easing":"spring(0.3)","props":{"direction":"bottom","distance":24}}]},
    {"id":"I12:9;1:4","name":"spinner","inherited":true,"tracks":{"ROTATION":{"base":0,"keys":[[0,0],[1,360]]}}}
  ]}],
  "refs":{"$motion/standard":"VariableID:12:50"},
  "issues":[]
}
```

- A timeline ID belongs to its top-level frame or Section. Durations and key times are seconds. The root's own timeline is included even when empty; other timelines require motion content.

- Track paths include property names (`OPACITY`, `TRANSLATION_X`), `fills.0`, `strokes.1`, `effects.0.RADIUS`, and component property paths such as `fills.0.properties.<property-id>`.

- Values use numbers, booleans, `[x,y]`, `#RRGGBB` / `#RRGGBBAA`, or unchanged `{type,value}` objects for other kinds. Keys are `[seconds,value,easing?]`.

- Easing controls the segment ending at the keyframe. Supported shorthand includes `linear`, standard ease-in/out/back variants, `hold`, `gentle`, `quick`, `bouncy`, `slow`, `cubic(x1,y1,x2,y2)`, `spring(bounce)`, and `$variable-name`. Unknown forms preserve their raw object. The default manual easing `cubic(0.5,0,0.5,1)` is omitted on read.

- Presets use `{id,preset,at,dur,easing?,props?}`. `preset` comes from `figma.motion.figmaAnimationStyles()`. Default props and delay following the timeline offset are omitted. Custom styles use `{id,style:"@name",at}`. New styles omit `id`.

- `refs` maps `$` / `@` notation to exact IDs; apply tries refs before local names. Duplicate variable names get an `#ID` suffix. Instance sublayers are marked `inherited`.

Apply is declarative: supplied `tracks` or `styles` fully reconcile that field for the listed node, deleting extras and changing only differences. Omitted fields/nodes remain untouched. Changed timeline durations are written. Unchanged input causes no writes, including read-only inherited or component entries.

Video export finds the enclosing top-level frame. It retries `Video export failed`; with `differentFrom`, byte-identical exports also retry. The wait is bounded, and other errors fail immediately. Since video export can lag behind document edits, use `differentFrom` for visible changes and inspect the sampled frames. Omit it for edits intended to preserve appearance.

Issues have `{rule,timeline,node?,message}` and do not modify data:

| Rule | Meaning |
|---|---|
| `beyond-timeline` | Keys/presets extend beyond playback/export duration |
| `first-key-easing` | Easing on the first key has no effect |
| `static-track` | Fewer than two keys |
| `track-conflict` | Competing preset/manual property or overlapping same-kind presets |
| `duration-range` | Active motion outside the configured range; holds/static spans split runs; `null` disables |
| `idle-tail` | More than 0.5 s and one-quarter of the timeline remains after motion; skipped for unknown-duration custom styles |
| `raw-easing` | EASING variables exist but a changing segment uses a raw easing; holds/static segments excluded |
| `inconsistent-easing` | Same preset/type uses different easing |
| `irregular-stagger` | At least three same-preset/type/duration nodes have uneven offsets |

### Frames

`frames <video|run-id> [--at <seconds,...>] [--count <2-24>] [--compare <video|run-id>] [--dump]` samples MP4/WebM in Chrome without connecting to Figma.

A file is resolved from the working directory. A job ID must be a successful run containing exactly one landed MP4/WebM; invalid sources fail before launching Chrome. GIF is unsupported. MP4 codec support depends on the Chrome build.

Explicit times are deduplicated and sorted, limited to 24, and must fit the video. Default sampling uses eight times from zero to 0.05 seconds before the end. Each time selects the covering frame. Contact-sheet cells are labeled, with at most four per row, or six during comparison; total width is at most 1,600 px. Narrow frames are enlarged to at least 160 px with nearest-neighbor sampling. A comparison cell stacks source and comparison frames and labels changed pixels.

Output is `{source,compare?,width,height,duration,sheet,frames:[{t,file?,compareFile?,changedPixels?,sameSize?}],changed?,layout?,warning?,limitation}`. File paths appear only with dump. Identical video bytes add a warning. Pixel differences use the same `diffPng` definition as run verification. Outputs go to the bound project's `frames/` or a system temporary directory. Success exits `0`; invalid inputs or decoding failure exit `1`.

## Prototypes

[lib/prototype.js](../lib/prototype.js) runs through `--lib prototype`, using ordinary run evidence and Undo boundaries. Snapshots already include `reactions` and page `flowStartingPoints`.

### PrototypeSpec

| Function | Return value |
|---|---|
| `readPrototype(root = target)` | Reactions in the subtree, page flows, targets, interaction graph, and issues |
| `applyPrototype(spec = data, root = target)` | `{changes,prototype}`, with `changes:{nodes,flows,flowsAdded}` and reread data |
| `prototypeIssues(spec, root = target)` | Async issue array; it reads targets, variants, layers, and variables |

```json
{
  "root":{"id":"12:1","name":"Flows","type":"PAGE"},"page":"12:1",
  "flows":[{"nodeId":"12:10","name":"Sign in"}],
  "nodes":[{"id":"12:12","name":"button","frame":"12:10","reactions":[
    {"on":"click","do":[{"navigate":"12:20","transition":"smart-animate 0.3 ease-out","resetScroll":true}]}
  ]}],
  "targets":{"12:20":{"name":"Home","frame":"12:20"}},
  "frames":{"12:10":"Login","12:20":"Home"},"overlays":{},
  "edges":[{"from":"12:12","fromFrame":"12:10","on":"click","nav":"navigate","to":"12:20","toFrame":"12:20"}],
  "issues":[]
}
```

Nodes contain only those with reactions. Their `frame` is the enclosing top-level frame directly below a page or Section. Instance sublayers can expose inherited reactions; writes create trigger-based overrides.

| Syntax | Forms |
|---|---|
| `on` | `click`, `hover`, `press`, `drag`, `media-end`; `after seconds`, `mouse-enter seconds`, `mouse-leave seconds`, `mouse-up seconds`, `mouse-down seconds`, `media-hit seconds`; `key DEVICE code,code` |
| `do` | `"back"`, `"close"`, `{url,newTab?}`, or one node verb: `navigate`, `swap`, `overlay`, `scroll-to`, `change-to` with target ID |
| Node action options | `transition`, `position:[x,y]`, `resetScroll`, `resetComponents`, `resetVideo` |
| Directionless transition | `dissolve\|smart-animate\|scroll-animate seconds easing` |
| Directional transition | `move-in\|move-out\|push\|slide-in\|slide-out left\|right\|top\|bottom seconds easing [match]` |
| Easing | Standard easing names, `cubic(x1,y1,x2,y2)`, or `spring(mass,stiffness,damping)` |

The library uses seconds for timeout/delay values. Unknown triggers, transitions, and actions preserve raw objects, including variable and conditional actions. Nested conditional node actions still participate in graph checks. Deprecated trigger version keys are not written. Prototype spring objects use mass/stiffness/damping, not Motion bounce or initialVelocity.

Read values are rounded to three decimals; comparison uses four to accommodate float32 storage. `targets` includes names/frame IDs, `missing:true`, or another page's name. `frames`, `targets`, `edges`, and `issues` are informational and ignored on apply. `overlays` reads the target's placement, background, and outside-click behavior; changes are rejected with instructions to use Figma's Prototype panel.

Apply reconciles reactions for listed nodes; an empty array clears them, omitted nodes remain untouched, and duplicate node entries fail. It validates all syntax, node capabilities, read-only overlays, and named flows before writing. Error-level issues relevant to the requested edits reject the whole apply before mutation. Only changed nodes receive `setReactionsAsync`, and writes use `actions` rather than the deprecated singular `action`.

Flows are written last because Figma can add a flow when a top-level frame first gains an outgoing reaction. Explicit `flows` replaces that final set; omission preserves auto-added flows and reports them in `flowsAdded`. On rejection, the library attempts to restore earlier reactions in reverse order and then original flows. Errors explain known invalid combinations and background-window failures; inspect the result of rollback before retrying. Plan restrictions can reject multiple actions, SET_VARIABLE, or CONDITIONAL.

Issues have `{rule,level,node?,message}`:

| Rule | Level | Meaning |
|---|---|---|
| `target-missing` | error | Missing source or destination |
| `target-other-page` | error | Destination is on another page |
| `not-top-level` | error | Navigate/swap/overlay destination is not a top-level FRAME, or navigation targets the source frame |
| `scroll-outside` | error | Scroll destination lies outside the source frame |
| `change-to-not-variant` | error | Destination is outside the source's variant set |
| `overlay-position` | error | Position supplied for a non-Manual overlay |
| `variable-type` | error | Missing variable or incompatible assignment type |
| `flow-invalid` | error | Missing, duplicate, or invalid top-level flow target |
| `smart-animate-unmatched` | warning | Fewer than half the layers match by name and hierarchy path |
| `unreachable` | warning | Participating top-level frame unreachable from flows; page-root reads only |
| `dead-end` | warning | No navigation/overlay/back/close/link exit; page-root reads only; outside-click-close overlays exempt |

## HTML export

`html` generates self-contained HTML from extracts and compares it with the same extracts' reference images. `html-check` rechecks existing pages. Generation and comparison run in the CLI process; only `html --node` submits bridge jobs. Chrome is required for comparison, configurable through `FIGMA_AGENT_CONTROL_CHROME`; `html --no-check` does not need it.

### Processing order

1. Preflight all inputs before writing files: require `--out`, 1–50 total unique frames across `--node` and `--from`, local scale-1 extract jobs for `--from`, a valid overrides file, and at most 500 SVG-bake IDs per frame.

2. Process `--from` frames first, then `--node`, preserving order within each group. A frame error normally affects only that frame.

3. Read an existing extract without waiting, or submit and wait for a new extract. New extracts include requested SVG-bake islands. Each occupies the bridge's single job slot.

5. If generated output needs missing SVG islands, a `--node` frame may get one second extract with those IDs and valid explicit SVG bakes. A `--from` frame is marked `needsExtract` instead. If the second extract fails, times out, exceeds limits, or still misses islands, preserve the first extraction/page basis and record `second-extract-failed` approximations and warnings.

6. Write the page, run the check unless disabled, and record the frame.

7. Rewrite `<out>/html.json` once the batch finishes. If the command is externally terminated, completed pages/evidence may exist without a final manifest.

### Output files

An absent output directory is created with mode `0700`. Pages use `<safe-name>__<node-part>.html`. The safe name replaces `\/:*?"<>|` and control characters, removes leading whitespace/dots and trailing whitespace, and is capped at 120 UTF-8 bytes without splitting code points; empty names become `frame`. Node IDs replace separators with hyphens. If the filename exceeds 200 bytes, its node portion becomes the first twelve hex characters of the node ID's SHA-256.

Before writing, FAC removes old differently named pages for the same node in the output directory's top level. Only regular HTML files with recognizable metadata in the first 16 KiB qualify; symlinks, subdirectories, and unrelated files remain untouched.

Check evidence is under `check/<extract-job-id>/`: `check.json`, successful `render.png` and `diff.png`, and up to ten `block-<n>.png` reference/render/diff crops. Zoom adds `zoom-<node-part>/{figma,html,diff}.png`. Rechecking overwrites the prior check and removes old block images. Ordinary checks do not remove existing zoom directories. A Chrome startup/protocol failure may leave only the frame's manifest record, with no `check.json`.

### Page metadata

```html
<meta name="figma-agent-control" content="extract=<job-id>; node=<frame-id>; scale=<scale>; overrides=<fingerprint>; generator=<fingerprint>">
```

The overrides fingerprint is the first twelve hex characters of the file bytes' SHA-256, or `none`. The generator fingerprint hashes [css.mjs](../src/html/css.mjs) and [generate.mjs](../src/html/generate.mjs). Node metadata identifies renamed pages; extract metadata locates evidence. Overrides metadata permits recovery from the adjacent manifest; generator metadata distinguishes source changes from page edits.

### `html.json`

The manifest describes only the current invocation and is rewritten in full.

| Field | Meaning |
|---|---|
| `schema`, `generator`, `checker` | Schema `1` and source fingerprints |
| `browser` | `{version,launchMs}` if Chrome started |
| `overrides` | `{file,sha}`, or `none` |
| `out` | Absolute output directory |
| `frames` | Ordered frame records |
| `totals` | Frame verdict counts, error/missing-island frame counts, stale-entry count, approximation counts, top-node geometry counts, and font summary |
| `done`, `pending`, `remaining`, `stop` | Resume state |
| `instruction`, `exitCode` | Full next-step instruction and exit code |
| `ms` | Total and font-index timing |

Each frame records:

| Fields | Meaning |
|---|---|
| `node`, `name`, `source` | Node, name, and `from`/`node` source |
| `extract`, `extracts` | Extract used for generation; ordered list when a second extract was attempted |
| `html`, `check`, `size` | Absolute page/report paths and expected dimensions |
| `verdict`, `reason`, `diffRatio`, `top` | Check outcome and diagnostics; block count and top-node geometry counts are summarized |
| `approximations`, `approximationNodes` | Counts and `{node,kind,detail?}` details |
| `needsIsland`, `needsExtract` | Missing islands and existing-extract refresh requirement |
| `glassDefaults` | GLASS bound to library variables but showing all-default parameters; library data may not have loaded |
| `overrides` | Applied nodes and stale entries when an overrides file was supplied |
| `fonts` | Declared names, metrics source, Figma-missing status, and after checking, actual Chrome usage/substitution |
| `warnings`, `violations` | Extraction/generation concerns and generator output-invariant violations |
| `error` | `{code,message}`; a pre-page failure retains only known identity/source/extract fields plus error |
| `ms` | Extract, generation, writing, and check timings |

Errors include `EXTRACT_REJECTED`, deterministic `EXTRACT_FAILED`, and `EXTRACT_INTERRUPTED`; other failures retain their exception codes.

### Overrides

An overrides file groups entries by frame ID, then node ID. Both levels require colon-form IDs (`1:2`, `I1:2;3:4`), not URL-style hyphens. All groups are validated before writing, including groups not exported in this run; inactive groups are neither applied nor marked stale.

```json
{
  "12:34": {
    "12:40":{"style":{"transform":"translate(12px,601px)"},"basis":{"transform":"translate(12px,603px)"},"note":"Move title up 2 px"},
    "12:41":{"bake":"svg","note":"Gradient stroke"},
    "12:42":{"skip":true,"note":"Annotation layer"},
    "12:43":{"bake":"ref","note":"Background-dependent glass search box"}
  }
}
```

Entries accept only `style`, `basis`, `skip`, `bake`, and a required nonempty `note`. Style/basis map CSS property names matching `-?[a-z][a-z-]*` to strings. Values must be single safe declarations: no semicolons/braces, newlines, backslashes, quotes, comment openings, or `url(`, and parentheses/brackets must balance. This prevents swallowing later declarations or introducing external resources. `skip` is Boolean. `bake` is `svg` or `ref`; a ref entry permits only `note` alongside it.

| Key | Effect |
|---|---|
| `style` | Replace generated declarations; empty string removes a property. Position always uses `transform`, including containers emitted with left/top |
| `basis` | Compare original generated declarations before applying; missing properties count as empty strings. Any mismatch skips the entire entry. Omission is unconditional |
| `skip` | Omit node and subtree |
| `bake:"svg"` | Use Figma's SVG for the node, requesting extraction as needed |
| `bake:"ref"` | Omit node/subtree and crop its outward-rounded scaled render bounds from the reference, placing the crop above the canvas; verdict cannot be clean |

Unused entries become `overrides.stale`, with `{node,kind,reason?}`. They count toward `totals.stale` and cause exit `1` when no resume work remains:

| Kind | Meaning |
|---|---|
| `missing` | Node absent from the extracted visible tree |
| `changed` | Basis mismatch; reason lists properties |
| `invalid` | Entry cannot affect output: `root`, `no-render-bounds`, `reference-size`, `inside-ref`, or `not-emitted` |

A reference crop freezes all content visible within the rectangle, including content outside the target subtree. Descendant overrides cannot apply and become `inside-ref`. This limitation must remain visible in diagnostics.

### `check.json`

| Field | Meaning |
|---|---|
| `verdict`, `reason` | Outcome and an unavailable-check reason |
| `expected`, `reference`, `sizeNote` | Expected rounded dimensions and actual reference dimensions. A one-pixel difference uses the reference with `fractional`; larger differences prevent comparison |
| `mismatched`, `aa`, `diffRatio` | Differing pixels excluding antialiasing, antialiasing pixels, and frame-area mismatch ratio |
| `blocks` | Dense mismatch regions `{x,y,w,h,diffPx,bboxPx,nodes,image?}`, with top three node contributors |
| `nodes`, `unattributed` | HTML-side per-node mismatch attribution and unattributed pixels |
| `top` | Top five nodes ranked by max of HTML/Figma contributions, excluding root/ref nodes; includes `px`, `htmlPx`, `figmaPx`, optional gap, shift/fix, flat positioning, geometry, fonts, approximations, and hint |
| `focus` | Requested html-check nodes with the same diagnostic shape as top |
| `fonts`, `cause` | Actual Chrome font usage and substitution. `font-substitution` cause requires affected nodes to own at least half the frame's mismatches |
| `untracked`, `missing`, `textMismatch` | Unknown page data-node IDs, absent expected elements, or `{node,figma,html}` content differences |
| `refs`, `bakedShare` | Ref rectangles, area shares, content covered, mismatch pixels, edge seams, and union area share |
| `suggest`, `clusters`, `hints` | Background-dependent ref suggestions, grouping, withheld-suggestion reasons, replacement entries, and seam warnings |
| `zoom` | Magnified comparison and evidence subdirectory |
| `context` | html-check only: overrides recovery state and byte-exact regeneration status |
| `browser`, `checker`, `ms` | Chrome configuration, checker fingerprint, and timings |

Geometry types are `box`, `wrap`, `content-offset`, `overflow`, and reporting-only `ink-offset`. Verdict rules are:

- `fail`: `diffRatio > 0.02`.

- `pass-with-findings`: ratio passes, but structural blocks, reference crops, substituted fonts, blocking top-node geometry, structure findings, or triggered approximation clusters remain.

- `clean`: none of those conditions. Focus and zoom do not affect the verdict.

- `unchecked`: comparison could not run. `REFERENCE_SIZE` and `RENDER_TIMEOUT` appear in check reports. Chrome discovery/startup failure prevents checks for the run; protocol/exit failure affects the current frame and permits a fresh browser for the next frame. After a render timeout, remaining frames are also unchecked for that invocation.

The HTML matcher uses pixelmatch-style YIQ comparison and antialiasing treatment. Run verification uses strict pixel-change detection. Structure and font checks supplement the HTML mismatch ratio.

### Interruptions and resuming

| Extract outcome | Handling |
|---|---|
| `409 RECONNECTING` | Retry after 1, 2, and 4 seconds, then stop |
| `409 ACTIVE_JOB` | Stop without preemption; record `stop.active` |
| Other `409`, or bridge access failure | Stop for environment repair; instruction gives that action first |
| Other submission rejection | Record frame `EXTRACT_REJECTED`; continue |
| New extract wait expires | Stop with its ID in `pending`; `WAIT_TIMEOUT` or `BUDGET_EXPIRED` |
| Existing `--from` has no result | Add to pending; continue |
| New extract interrupted | Stop |
| Existing extract interrupted | Record frame error, add its node to remaining, continue |
| Deterministic extraction failure | Record `EXTRACT_FAILED`, do not automatically add to remaining; inspect the limit/error before retrying |

After a stop, later frames become `remaining`; the current frame also does unless its submitted job is pending. Interruption is recognized by the session module's exact nonexecution reasons or recovery/resolution evidence, not by `executionStarted:false`, which also describes deterministic extract failures.

`done` lists reusable extract IDs with written pages. `pending` lists unfinished extracts. `remaining` lists nodes requiring fresh extraction. A second-extract timeout/stop is retained in pending/remaining rather than pretending the first page is complete.

`--timeout` is 1–300 seconds, default 30, per extract wait. `--budget` is 10–600 seconds, default 90, for extract submission/wait only, starting after preflight. Each wait uses the smaller limit, rounded up with at least one second. Once a new extract has been submitted successfully, less than one second remaining prevents another submission. Existing-extract generation/checking is outside that budget.

Resume instructions cover the entire batch and retain overrides, output, no-check, timeout, and budget options. Reusable and pending jobs become `--from`; remaining/missing-page/missing-island/glass-default frames become `--node`, without duplicates. Pending jobs are waited on first. A missing overrides file gets a placeholder only when corrections are appropriate after resume work is complete.

| Exit | `html` | `html-check` |
|---|---|---|
| `0` | No condition below | All pages checked without fail/error |
| `1` | Environment repair required, or no remaining work but errors/fail/unchecked/stale/missing islands/violations | Any error, fail, or unchecked page |
| `2` | Pending/remaining work without an environment-repair stop | Never |

Preflight errors exit `1`. `--no-check` deliberately has no verdict and does not itself fail. `glassDefaults` also does not affect the exit code, but requests fresh extraction in the next command.

### `html-check`

Input is 1–50 pages, with optional repeated `--node` and one `--zoom`. It does not connect to Figma or edit pages. Run it in the project that owns the extract evidence.

Preflight requires readable metadata-bearing pages from scale-1 extracts available in this project. Every focus node must belong to an input frame. A zoom job must be a completed extract at scale greater than 1 and at most 4, with a decodable reference and an unrotated target inside a frame. Any failure stops before checking; Chrome startup failure also stops.

Diagnostic context is regenerated from the original extract. Overrides are recovered through the adjacent manifest only when their fingerprint matches; otherwise diagnostics use no overrides and report `context.overrides: "unavailable"`. A changed page or generator produces `context.exact:false` with a warning. Diagnostics use the regenerated context, while actual page refs are read from the page.

Focus nodes receive translation/geometry/font analysis beyond the top five. Zoom compares the first page containing its target at `1/scale` CSS-pixel precision. Neither affects the frame verdict. Evidence overwrites the ordinary check directory; non-browser per-page exceptions are recorded and the next page continues.

## CLI output

Stdout contains exactly one JSON object. Errors are `{error,code}`, with error text capped at 2,000 characters. Do not merge stderr into JSON output.

Submitting commands wait by default and print a summary; `--full` prints the complete record; `--no-wait` returns the bridge response directly. When waiting begins, stderr receives one JSON line with `{submitted,next,reused?}`. An externally killed CLI can therefore be resumed by ID. HTML writes one receipt per submitted extract. A repeated request waits for its original job and returns that job's outcome.

Summary `output` above 16 KiB UTF-8 is replaced with a reading command. Extract output is always summarized by shape/reading command, with separate `extract:{stats,islandsSkipped,warnings}`; at most fifty skipped IDs and twenty warnings of at most 600 characters are expanded, with omitted counts.

`cancel` requests cancellation then waits as `wait` does. Waiting defaults to thirty seconds, configurable to 1–300 seconds:

| `waitStatus` | Meaning |
|---|---|
| `completed` | Result landed |
| `timeout` | Job may still run; progress and wait/cancel guidance are included when available |
| `needs-review` | Recovery evidence needs the stated review action |
| `resolved` | Reviewed, but the original execution outcome remains unknown |

HTML and html-check stdout summaries fit within 16 KiB of formatted UTF-8 JSON. The complete manifest/reports remain on disk. HTML expands at most ten frames needing attention and three entries each for top/suggestions/hints/refs/stale items; it progressively drops detail, frame lists, then resume lists if necessary, finally pointing to `html.json`. Font tables expand at most ten rows. html-check similarly drops detail, keeps only non-clean pages, and finally drops page lists; detailed focus, context, and warnings remain in per-page reports.

| Exit | General commands |
|---|---|
| `0` | Success |
| `1` | Failure, failed/unavailable visual verification, skipped/rejected cleanup, skipped explicit islands or incomplete extraction binaries, or reviewed-but-unknown outcome |
| `2` | Not complete: timeout or review pending. For stop, accepted shutdown has not released the lock after roughly five seconds; check status later |

HTML-specific codes and frames output are defined above. Network errors remain distinct: `SANDBOX_BLOCKED` is denied localhost access, `BRIDGE_DOWN` is an unresponsive session port, `BRIDGE_TIMEOUT` is a request timeout, and `NO_SESSION` is a missing session file.

`report --since` accepts ISO dates/times; a time requires `Z` or an offset, and a date alone is UTC midnight. `jobs.failed` counts `ok:false`; `jobs.verifyFailed` counts successful executions with failed/unavailable visual checks. They are mutually exclusive.

## Preparation ordering

Target revalidation currently precedes the before-render and later preparation reads. Keep the target unchanged throughout preparation.

## Cancellation boundary

An undelivered run can be marked unexecuted. Once delivered, request cancellation during script execution. Preparation, approval and checkpoint waits retain their timeouts; inspect the returned execution state.

## Motion rollback values

Rollback reconstructs writes from the prior parsed spec. Inspect variable identities and numeric values after an error.

## Frame dump filenames

--dump writes original-size PNGs using rounded sample times such as 0.300s.png. Distinct times rounding to the same millisecond can collide; avoid such pairs in one invocation.

## Discovery probes

Discovery checks bridge identity using heartbeat requests. These requests still follow the normal lease path; recheck connection state after discovery.

## Pending results and port changes

Discovery selects a bridge by the current file. Keep the original project available while a result is pending.
