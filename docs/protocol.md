# Protocol and evidence

[Simplified Chinese](zh_cn/protocol.md)

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

A lock is stale only when checking its PID returns `ESRCH`. Takeover first exclusively creates `bridge.lock.takeover`, rereads the lock, and archives it only if unchanged. An empty lock may be between creation and PID write: `connect`, `stop` without a session, and `doctor` treat it as occupied and never delete it. A live PID is occupied even if the operating system reused it; the diagnostic gives a manual inspection path.

`init` adds the evidence directory to the project's `.gitignore`. Keep this local evidence directory separate from delivery artifacts because it contains design data and credentials.

## Global plugin directory

The shared directory is `~/.config/figma-agent-control/`, overridden by `FIGMA_AGENT_CONTROL_HOME`.

| Path | Writer | Contract |
|---|---|---|
| `pairing.json` | `connect` via session | Persistent plugin credential, mode `0600`; exclusive first creation. Corruption gives `PAIRING_INVALID` |
| `plugin/manifest.json` | `connect` | Generated development manifest, `documentAccess: dynamic-page`, `enablePrivatePluginApi: true`, no Figma-assigned plugin ID |

Because the manifest has no Figma-assigned ID, private `setPluginData` is unavailable. Namespaced `setSharedPluginData` does not depend on that ID.

## Jobs

### Submission: `POST /job`

The caller must use the CLI role.

| Field | Operations | Constraint |
|---|---|---|
| `code` | Run | Nonempty JavaScript function body |
| `libs` | Run | At most 20 `{name, code}` entries, at most 2 MiB UTF-8 combined |
| `snapshotDepth` | Run/inspect | Integer `1`–`31`; explicitly limits snapshot depth |
| `nodes` | Preview | 2–50 unique nodes; first equals the effective target |
| `names` | Preview | 1–50 unique, nonempty names of at most 200 characters; excludes `targetNodeId` and `nodes` |
| `data` | Run | JSON, at most 1 MiB UTF-8, passed as `data` |
| `expect` | Run | `changed` or `unchanged` |
| `tolerance` | Run with expect | Nonnegative changed-pixel allowance; default `0` |
| `risk` | Run | `{level:"high", reason}` requires plugin-panel approval |
| `requestId` | All | Lowercase UUID used as the job ID; the CLI exposes it on `run` |

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

5. For high-risk runs, await panel approval for at most 300 seconds. Rejection or timeout does not execute the script.

6. Send the write-ahead checkpoint to the bridge. It atomically saves `before.json` and fixes its hash. A ten-second acknowledgement timeout prevents execution.

7. Export a before image if `expect` is set. For cleanup, collect IDs already on the target page. For non-page targets, record direct page-root children.

9. Commit an Undo boundary, listen for target-page node changes, enter the script phase, set `executionStarted:true`, evaluate libraries and body, and commit the closing Undo boundary. Boundary failures are reported, not automatically undone. A script failure records created nodes and optionally cleans them after a successful closing boundary.

10. Capture the after snapshot and, if requested, after image. Compare page-root children for successful non-page-target runs. A too-large after snapshot makes the change set unavailable; a failed after export makes visual verification unavailable. Neither changes the script's own outcome.

Trusted scripts receive the full Plugin API for the current file. The binding defines valid targets; the selected target defines snapshot, change-set and visual-check coverage.

### Binary return values

- Byte views such as `Uint8Array`, plus complete PNG/JPEG integer arrays, are recognized anywhere inside nested output. They become `{"__figmaAgentControlBinary": index}` placeholders; returning that reserved key yourself fails the job.

- A run permits at most 200 binaries. Combined base64 length, including before/after visual images, is at most 48 MB. Exceeding this limit fails the run after execution, retains no return value, and saves no output binaries; it must not be replayed.

- The bridge writes `files/output-<n>.<type>`, starting at 1, then replaces placeholders with `{file, bytes, sha256, type, width?, height?, pixels?}`. Paths are relative to the job directory.

- Invalid placeholders become `{binaryUnavailable:true}` and add `binaryErrors`; other evidence is preserved.

- Binary data is excluded from the iframe's structured-result limit. Base64 strings returned by a script are not excluded and can cause the whole return value to be discarded.

### Result files

Atomic creation of `runs/<job-id>/result.json` is the sole completion commit point. `job.json` is a derived record whose state and finish time are repaired on the next startup if a crash occurs between writes. Readers use `result.json`, not a terminal job state alone. Before snapshots live only in `before.json`.

| Result field | Meaning |
|---|---|
| `ok`, `output` | Execution/read outcome and returned data with landed binary descriptors |
| `changes` | Run change set |
| `verify` | Requested visual verification when `ok:true` |
| `images` | Preview descriptors `{nodeId,name,file,bytes,sha256,width,height,pixels}` under `images/<index>-<node>.png` |
| `ancestors` | Inspect visibility chain toward the page, up to twenty levels, including opacity, masks, fills, and clipping |
| `error`, `executionStarted`, `recovery` | Failure, whether the script started, and recovery guidance |
| `targetMissing`, `missingNodeId`, `fileVerified` | Evidence that a missing-node inspect queried the bound file |
| `after` | Partial-write snapshot, retained only after execution started and failed |
| `bindingVerified` | Actually verified file, page, and node |
| `undoBoundaries` | `before`, `after`, and optionally cleanup `clean` boundary outcomes |
| `warnings`, `binaryErrors` | Evidence/cleanup limitations and binary transport issues |
| `pluginMs`, `approvalMs`, `finishedAt` | Execution timing excluding approval, approval timing, and landing time |

### Change sets

Before/after snapshots produce `counts.created`, `deleted`, `moved`, `updated`, `bindingOnly`, and `positionOnly`. The last three are mutually exclusive: changed values, bindings only, or layout-induced position changes only.

A move changes parent or falls outside the longest common ordered sibling subsequence. Inserting/deleting a sibling does not mark every other sibling as moved; swapping two siblings marks one. Up to fifty changed/created/deleted/moved nodes are expanded, with `omitted` for the remainder. Position keys are omitted from per-node `keys`.

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

## Bridge endpoints

| Endpoint | Role | Contract |
|---|---|---|
| `POST /job` | CLI | Submit a job |
| `GET /result?id=` | CLI | Current-session result; the CLI normally reads evidence from disk |
| `POST /resolve` | CLI | Resolve an unknown write after inspection |
| `POST /shutdown` | CLI | Requires `{force:boolean}`; active queued/running work without force gives `409 ACTIVE_JOB`; otherwise responds `202` before closing |
| `GET /poll` | Plugin | Claim work, or hold an empty response for up to ten seconds |
| `POST /checkpoint` | Plugin | Persist the write-ahead snapshot |
| `POST /approve` | Plugin | Immutable decision for a high-risk run delivered in this session |
| `POST /complete` | Plugin | Idempotent completion, first result wins; does not require the current lease |

Every request supplies `X-Session-Token`. Plugin routes additionally require `X-Plugin-Version`. CLI and plugin credentials are separate and role-specific. Plugin mismatch gives `403 PAIRING_MISMATCH` without echoing credentials; CLI mismatch gives `403`. A version mismatch gives `409 PLUGIN_OUTDATED`.

`pluginIssues` records a last-seen timestamp independently per connection cause. When disconnected, doctor reports causes seen within two minutes in this order: `FOREIGN_JOB`, `PAIRING_MISMATCH`, `NO_FILE_KEY`, `WRONG_FILE`. Only the first is an error with an action; the rest are warnings. Foreign results take priority because restarting the plugin could discard them. Pairing diagnostics require a version header to avoid noise from simple requests or scans.

## Plugin messages

The iframe and execution code use postMessage. Each job has a random `channelNonce`; mismatched IDs or nonces are ignored.

While a result is awaiting delivery, the iframe sends `/complete` rather than heartbeats. Request deadlines are 15 seconds for polling, three seconds plus one second per 10 MB of completion payload, and three seconds for other requests.

## CLI output

Stdout contains exactly one JSON object. Errors are `{error,code}`, with error text capped at 2,000 characters. Do not merge stderr into JSON output.

| `waitStatus` | Meaning |
|---|---|
| `completed` | Result landed |
| `needs-review` | Recovery evidence needs the stated review action |
| `resolved` | Reviewed, but the original execution outcome remains unknown |

| Exit | General commands |
|---|---|
| `0` | Success |
| `2` | Not complete: timeout or review pending. For stop, accepted shutdown has not released the lock after roughly five seconds; check status later |

`report --since` accepts ISO dates/times; a time requires `Z` or an offset, and a date alone is UTC midnight. `jobs.failed` counts `ok:false`; `jobs.verifyFailed` counts successful executions with failed/unavailable visual checks. They are mutually exclusive.

## Connection scope

The bridge uses port 32523. Keep only one project bridge active on the machine. The globally installed plugin can reconnect after a bridge restart; stop the previous project before connecting another.

## Preparation ordering

Target revalidation currently precedes the before-render and later preparation reads. Keep the target unchanged throughout preparation.

## Extraction engine

The read-only extractor in plugin/main.js serializes the visible node tree, reference PNG and assets while enforcing extraction budgets. VM cases exercise this execution unit directly.
