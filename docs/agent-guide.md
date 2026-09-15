# Agent guide

[Simplified Chinese](zh_cn/agent-guide.md)

Figma Agent Control has one execution primitive: run a trusted Plugin API script against a target node inside a bound scope. `inspect`, `preview`, `variables`, and `extract` are built-in reads. Other commands manage the connection, interpret evidence, or analyze and export results.

## Getting started

Check `command -v figma-agent-control` before using the CLI. If it is unavailable, follow the [source installation instructions](../README.md#install-from-source). Installing a global command or skill is a separate setup action: follow the user's chosen installation scope. An already authorized installation does not need another confirmation. If you have a checkout but no global command, use a shell function:

```sh
fac() { node /path/to/figma-agent-control/bin/figma-agent-control.mjs "$@"; }
```

Replace `figma-agent-control` with `fac` in returned instructions when using that function. Do not put a space-separated command into a shell variable: zsh does not split it into a command and arguments. For argument lists, use arrays and `"${args[@]}"` in bash or zsh.

Use an existing bound project directory if one is already available. Create a separate directory for an unrelated scope:

```sh
mkdir my-design
cd my-design
figma-agent-control init 'https://www.figma.com/design/<fileKey>/<name>?node-id=1-2'
figma-agent-control connect
```

`connect` runs in the foreground; keep that terminal running. Import the returned manifest once in Figma Desktop through **Plugins → Development → Import plugin from manifest**, then run the plugin in the bound file. In another terminal, from the same directory:

```sh
figma-agent-control status
figma-agent-control doctor
```

Start work when `connected` is `true`. The current working directory is the project root; the CLI does not search parent directories.

- The bound node is the default `target`; `--node` must identify a node inside it. A script receives the full `figma` object. Snapshots, change sets and visual checks cover the selected target subtree, including indirect effects such as changes to its main component. Choose a target covering the authorized writes.

- One bridge executes one job at a time. Multiple agents should retrieve data sequentially, then analyze it independently offline.

- Finish with `figma-agent-control stop` for a bridge you started and no longer need. It stops the local bridge. Check document synchronization in Figma. Exit code `2` means shutdown is still finishing; check `status` later.

## Writing scripts

Scripts are JavaScript function bodies. They can use `figma`, `target`, `data`, and functions supplied by `--lib`; use `return` for the result.

```js
// rename.js
const previous = target.name;
target.name = data.name;
return { id: target.id, previous, name: target.name };
```

```sh
printf '%s' '{"name":"Account card"}' | figma-agent-control run rename.js --node 12:34 --data /dev/stdin
```

Use `--data file.json` for parameters. `/dev/stdin` supports a pipe or heredoc without another file; avoid `--data <(...)` in portable shell scripts. Input data is recorded in `job.json`. Batch related changes in one script with an input array instead of submitting one job per node.

### Choosing a target

| Work | Target and snapshot depth |
|---|---|
| A custom read-only script | Use `run --depth 1` to reduce snapshot cost; it still uses the run lifecycle |
| Writes whose common ancestor contains at most 2,000 nodes at full depth | Target that ancestor without `--depth`, so nested changes remain visible |
| Writes across a larger page or Section | Keep the common ancestor as target and set an explicit depth, often `--depth 2` for page → Section → frame |
| A visible change or a visual-preserving refactor | Add `--expect changed` or `--expect unchanged` on the smallest relevant target |

A shallow snapshot trades detail for coverage. Changes below its depth are invisible; moves across that boundary appear as creations or deletions. Do not point `--node` at a small unrelated node to evade the snapshot budget: the before evidence, final recheck, and change set would cover the wrong content.

Avoid `--expect` on a page: it exports the entire target twice. Preview individual frames instead. Prefer updating a frame in place so its ID and links remain stable. For broad edits, read back key dimensions, layout modes, text, and bindings in the same script after Auto Layout has settled.

Store node markers with `setSharedPluginData('figmaagentcontrol', key, value)` and read them with `getSharedPluginData`. Values are strings; serialize objects explicitly. An empty string deletes a value. The namespace, key, and value together must fit within 100 kB. Shared plugin data is visible to other plugins, so do not store credentials. `setPluginData` is unavailable because this development plugin has no Figma-assigned ID.

### Dynamic-page constraints

The manifest uses `documentAccess: "dynamic-page"`. FAC loads the target page before a job; other pages must be loaded explicitly. This avoids loading an entire large file for a persistent plugin.

| Restricted form | Use instead |
|---|---|
| `figma.getNodeById(id)` | `await figma.getNodeByIdAsync(id)` |
| `figma.getStyleById(id)` | `await figma.getStyleByIdAsync(id)` |
| `figma.currentPage = page` | `await figma.setCurrentPageAsync(page)` |
| `getLocalPaintStyles()`, `getLocalTextStyles()`, `getLocalEffectStyles()`, `getLocalGridStyles()`, `getLocalCustomAnimationStyles()` | The corresponding `Async` method |
| `figma.getFileThumbnailNode()` | `await figma.getFileThumbnailNodeAsync()` |
| `variables.getVariableById()` / `getVariableCollectionById()` | Their `Async` forms |
| `variables.getLocalVariables()` / `getLocalVariableCollections()` | Their `Async` forms |
| `variables.createVariable(name, collectionId, type)` | Pass the collection object |
| `node.setBoundVariable(field, variableId)` | Pass the variable object |
| `setExplicitVariableModeForCollection()` / `clearExplicitVariableModeForCollection()` | Pass the collection object as the first argument |
| Reading `instance.mainComponent` | `await instance.getMainComponentAsync()` |
| `component.instances` | `await component.getInstancesAsync()` |
| `style.consumers` | `await style.getStyleConsumersAsync()` |
| Assigning `fillStyleId`, `strokeStyleId`, `effectStyleId`, `gridStyleId`, or `textStyleId` | The corresponding `set*StyleIdAsync(id)` method |
| Assigning deprecated `backgroundStyleId` | `await node.setFillStyleIdAsync(id)` |
| `setRangeTextStyleId()` / `setRangeFillStyleId()` | Their `Async` forms |
| Assigning `vectorNetwork` | `await node.setVectorNetworkAsync(network)` |
| Reading/traversing/exporting another page, or inserting its children | First `await page.loadAsync()` |
| `figma.root.findAll*`, `findOne`, `findWidgetNodesByWidgetId`, or `figma.on('documentchange', ...)` | First `await figma.loadAllPagesAsync()`; prefer page-local traversal and `page.on('nodechange', ...)` when possible |

Do not call restricted synchronous APIs inside `findOne` or `findAll` callbacks. Figma wraps those callbacks, and a thrown error can also trigger its red “Plugin error” notification. Collect candidates synchronously, then await in a loop:

```js
for (const node of target.findAllWithCriteria({ types: ['INSTANCE'] })) {
  if ((await node.getMainComponentAsync())?.name === 'Button') {
    // Work with the matched instance.
  }
}
```

### Figma behavior notes

These notes summarize Figma Desktop behavior observed during development. Read back important properties in the current file before depending on them.

- **Fonts:** load every font returned by `getRangeAllFontNames(0, node.characters.length)` before editing mixed-font text. `fontName` can be `figma.mixed` even when the layer looks uniform. Handle empty text separately.

- **Text ranges:** assigning an entire `characters` or `fills` value can erase range-specific colors and sizes. Read `getStyledTextSegments` and restore the required ranges.

- **Sizing:** call `resize()` before setting Fill/Hug sizing, then read back the final dimensions. Auto-height text also needs a Hug container to avoid clipping.

- **Auto Layout alignment:** use `MIN`/`MAX`, not `START`/`END`. `primaryAxisAlignItems` also accepts `CENTER` and `SPACE_BETWEEN`; the counter axis accepts `CENTER` and, for horizontal frames, `BASELINE`.

- **New nodes:** `figma.create*` attaches nodes to the current page root at `(0, 0)`. Explicitly `appendChild` them into the intended target.

- **Instance swaps:** nested overrides migrate by layer name. Swapping to a differently named internal layer can lose overrides; keep names consistent or restore them after reading back.

- **Groups:** Groups and Frames have different layout and constraint behavior, and `rescale()` on a Group inside an instance can fail. Put responsive illustration behavior into the main component when appropriate.

- **Aspect ratios:** `targetAspectRatio` is read-only; use `lockAspectRatio()`. Read back dimensions and inspect exports to distinguish scaling, cropping, and distortion.

- **Color bindings:** use the paint returned by `setBoundVariableForPaint`. Preserve the intended alpha in the variable value; binding a translucent paint to an opaque variable can change the rendering. Node opacity is separate.

- **Variable code names:** use `variable.setVariableCodeSyntax('WEB' | 'ANDROID' | 'iOS', name)`.

- **JavaScript:** the plugin uses QuickJS. `Intl` is unavailable in the observed runtime; locale formatting may not insert separators. Avoid assigning undeclared variables: run scripts share the plugin's global environment. `String(Object.create(null))` throws; use JSON serialization for such values.

## Reading results

Read `instruction` first, then the evidence needed to choose the next action:

| Field | Meaning |
|---|---|
| `ok`, `error`, `executionStarted` | Outcome and whether the script started |
| `changes` | Observed target-subtree changes; binding-only and position-only changes are counted separately |
| `verify` | Before/after visual check, when requested and the script succeeded |
| `resultFile`, `evidence` | Paths to durable local evidence |

| Exit code | Meaning | Action |
|---|---|---|
| `0` | Success | Continue |
| `1` | Execution or visual-check failure, incomplete cleanup/extraction, or a reviewed but unknown result | Read `instruction`. Only `executionStarted: false` proves that the script did not start |
| `2` | Still pending or needs review | For `waitStatus: timeout`, wait for the same ID. For `needs-review`, follow the review procedure |

### Parsing output

Stdout is one JSON object. A submitting command writes its receipt to stderr before waiting:

```json
{"submitted":"<job-id>","next":"figma-agent-control wait <job-id>"}
```

Keep the streams separate:

```sh
figma-agent-control run page.js --depth 2 > out.json 2> receipt.log
code=$?
jq '.output' out.json
```

If an external tool kills the CLI while it is waiting and stdout is empty, obtain the ID from `receipt.log` and run `wait <job-id>`. `--no-wait` returns the ID on stdout and does not write that receipt.

Results are identified only by job ID: use the summary's `id`, `result <id>`, `wait <id>`, or supply a new lowercase UUID through `run --request-id`. Reusing an ID returns the original job; it does not execute the script again. Do not find the “latest” result by directory timestamps.

The default summary includes `output` only up to 16 KiB, then gives a reading command. The raw `result.json` contains `.output`. With `--full`, the CLI returns a record whose value is `.result.output`; its binary file paths are relative to `.evidence`. Preview summaries include `images[].name` and absolute `images[].file` paths.

### Chaining scripts

Each script has separate evidence and Undo boundaries. Stop on the first nonzero exit; do not continue writing into a partial result:

Store recurring sequences in a project script with parameters. `break` itself returns zero, so save the failing command's status first, or use `set -e` in an appropriate shell script. On exit `2`, stop the sequence and wait for or review that job; do not skip to the next step.

## Visual verification

`--expect changed` checks that the target's exported pixels changed. `--expect unchanged` is useful for token binding and refactoring that should preserve appearance. `--tolerance <pixels>` permits a count of changed pixels.

Choose the smallest relevant target because it is exported twice. Masks, hidden layers and covering bitmaps can hide a property change, so inspect the rendered result as well as the assigned values. The check covers the target's own export. Use `preview` and `image-diff <before> <after> --expect changed|unchanged` to inspect other regions.

### Previews and batch exports

For a larger batch, return bytes directly:

```js
// export.js
const output = [];
for (const section of target.findAllWithCriteria({ types: ['SECTION'] })) {
  for (const node of section.children.filter(n => n.type === 'FRAME')) {
    output.push({ section: section.name, name: node.name, id: node.id,
      png: await node.exportAsync({ format: 'PNG', useAbsoluteBounds: true,
        constraint: { type: 'SCALE', value: data?.scale ?? 0.5 } }) });
  }
}
return output;
```

```sh
figma-agent-control run export.js --depth 1 > out.json 2> receipt.log
```

Read `.output[].png.file` from the raw `result.json`, relative to the evidence directory. Include the node ID in delivery filenames to prevent duplicate or empty names from overwriting files.

Do not base64-encode exports into strings. Byte values nested anywhere in the result use a separate binary channel: at most 200 items and 48 MB of total base64 payload, including visual-check images. Oversized string results can lose the whole return value. Lower scale or split a large batch. `useAbsoluteBounds: true` exports the node's box; ordinary previews can include shadows outside it.

## Troubleshooting

| Signal | Action |
|---|---|
| `SANDBOX_BLOCKED` | Localhost access is blocked by the execution environment; use its authorized permission mechanism |
| `NO_SESSION`, `BRIDGE_DOWN` | Run `doctor`; reconnect if appropriate |
| `RECONNECTING` | Open the bound file and run the plugin; `doctor` gives the specific cause |
| Multiple plugin diagnostic causes | Follow the first error first; warnings provide context |
| `PAIRING_MISMATCH` | Remove an obsolete duplicate plugin and import the manifest reported by `doctor` |
| `WRONG_FILE` | Run the plugin in the bound file |
| `NO_FILE_KEY` | Confirm use of the generated development plugin in Figma Desktop |
| `FOREIGN_JOB` | Reconnect the original project so its pending result can return; do not casually restart the plugin and discard it |
| `PLUGIN_OUTDATED` | Rerun the development plugin after updating the tool |
| `ACTIVE_JOB` | Wait for the existing job ID |
| `REVIEW_REQUIRED` | Stop the previous plugin, inspect the original target, then resolve using that inspect ID |
| Figma “Plugin error” | Inspect the job error; move restricted API calls out of Figma-wrapped callbacks |
| `stop` exits `2` | Check `status` later; follow any recovery instruction for an interrupted job |

For an unknown write result, use:

```sh
figma-agent-control inspect --node <original-target-id>
figma-agent-control resolve <original-job-id> --inspect <inspect-job-id> --previous-plugin-stopped
```

The flag is an assertion that the previous plugin has actually stopped. The inspect must be from the current session and target the original node directly. Resolve ends the unresolved wait; it neither replays nor undoes the original job. Interrupted reads can be resubmitted. Do not clear `runs/` to bypass review.

`report --since <ISO-time>` summarizes job durations, idle gaps, repeated executions, execution failures (`failed`), and visual-check failures (`verifyFailed`). Include a time zone when supplying a time; a date alone means UTC midnight.

## Limits

- Plugin API operations work within the current Figma file. Use a separate binding to work in another file.

- Check cloud synchronization in Figma.

- Store plugin data with namespaced `setSharedPluginData`, which works with the generated development manifest.

Keep `.figma-agent-control/` out of version control. It includes credentials and design evidence. Deliver only the required result artifacts, retain unreviewed evidence, and stop bridges you started when their work is complete.

## Connection scope

The bridge uses port 32523. Keep only one project bridge active on the machine. The globally installed plugin can reconnect after a bridge restart; stop the previous project before connecting another.
