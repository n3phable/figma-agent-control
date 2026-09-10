# Figma Agent Control

Run trusted Plugin API scripts through a local bridge and Figma Desktop development plugin, inspect nodes, and retain execution evidence.

[Simplified Chinese](README_ZH.md)



Figma Agent Control (FAC) connects your local CLI to a Figma Desktop development plugin through a localhost bridge.

## What it does

- **Read and edit designs:** inspect node trees, inspect variables, export PNG previews, and execute Plugin API scripts with reusable libraries and JSON input.

## Requirements

- **Node.js 22 or newer.** The runtime has no npm dependencies. Development dependencies are pinned in the lockfile.

- **Figma Desktop**, with the target file open in Design mode and the development plugin running. Editing requires edit access to that file.

- **Local shell and localhost access** for the agent running the CLI.

## Install from source

`npm link` makes the CLI available to your shell.

The bundled [agent skill](skills/figma-agent-control/SKILL.md) gives an agent the operating and recovery rules. Choose where your agent should discover it, then link the skill directory:

```sh
# Run from the cloned repository. Choose one destination.
# Workspace scope:
mkdir -p /path/to/workspace/.agents/skills
ln -s "$PWD/skills/figma-agent-control" /path/to/workspace/.agents/skills/figma-agent-control

# Or global scope:
mkdir -p "$HOME/.agents/skills"
ln -s "$PWD/skills/figma-agent-control" "$HOME/.agents/skills/figma-agent-control"
```

Use your agent's documented skill directory if it differs. A symlink keeps the skill aligned with the checkout; do not overwrite an existing installation without checking it. A new agent session may be needed to discover the skill.

## Quick start

Use a separate working directory for each bound design scope:

```sh
mkdir my-design
cd my-design
figma-agent-control init 'https://www.figma.com/design/<fileKey>/<name>?node-id=1-2'
figma-agent-control connect
```

`connect` stays in the foreground. On first use, import the printed `manifest` path in **Figma → Plugins → Development → Import plugin from manifest**, then run **Figma Agent Control** in the bound file. This plugin installation is shared by projects on the machine.

In a second terminal, in the same working directory:

```sh
figma-agent-control status
figma-agent-control inspect --depth 1
figma-agent-control preview --node 12:34
```

When `status` reports `connected: true`, you can run a script. Replace the sample node IDs with IDs from your file:

```js
// rename.js — a JavaScript function body
const previous = target.name;
target.name = data.name;
return { id: target.id, previous, name: target.name };
```

```sh
printf '%s' '{"name":"Account card"}' > input.json
figma-agent-control run rename.js --node 12:34 --data input.json
figma-agent-control result <job-id>
figma-agent-control stop
```

A submitting command waits by default and returns one JSON object. Its stderr receipt includes the job ID before waiting starts. If waiting expires with exit code `2`, continue with `wait <job-id>` using that same ID.

## Commands

| Commands | Purpose |
|---|---|
| `init`, `connect`, `stop`, `status`, `doctor` | Bind a scope, manage the bridge, and diagnose the connection |
| `run` | Execute a trusted script with `--lib`, `--data`, and optional `--expect changed\|unchanged` |
| `clean` | Recheck and delete eligible nodes left by a failed run, as a separate Undo step |
| `image-diff`, `report` | Compare PNGs or summarize job timings, failures, and repeated executions |

Use `figma-agent-control help` for the exact syntax of the installed version. The [agent guide](docs/agent-guide.md) includes complete script examples and recovery procedures.

## Trust and limitations

**Run trusted scripts.** A script has full Plugin API access to the current file. The binding defines valid task targets, and the selected target defines the recorded subtree. Choose an ancestor that covers every authorized write so the change set and visual check capture the intended work.

The bridge listens on `127.0.0.1`, uses separate CLI and plugin credentials, checks the plugin version, and records a before snapshot before each write. For an unknown write result, inspect the target and resolve the job before another write. Use `--high-risk <reason>` when execution needs confirmation in the plugin panel.

Writes take effect as the script runs. After failure, read `instruction` and `executionStarted`, inspect the partial changes, and use cleanup for eligible newly created nodes. Existing-node changes persist. Keep `.figma-agent-control/` local: it contains design evidence and session credentials.

## Documentation and development

- [Simplified Chinese documentation](docs/zh_cn/README.md): translated guides.

- [Agent guide](docs/agent-guide.md): operating workflow, examples, and recovery.

- [Protocol and evidence](docs/protocol.md): requests, results, files, and exit codes.

- [Architecture](docs/architecture.md): process boundaries, modules, and design decisions.

- Contributing: local checks and contribution workflow.

Licensed under the [MIT License](LICENSE). See third-party notices for included material. Maintained by [n3phable](https://github.com/n3phable).

## Connection scope

The bridge uses port 32523. Keep only one project bridge active on the machine. The globally installed plugin can reconnect after a bridge restart; stop the previous project before connecting another.

## Available command syntax

Run `figma-agent-control help` for the commands in this revision. Core commands are init, connect, stop, status, doctor, run, inspect, preview, variables, result, wait, resolve, image-diff and report. A timeout does not authorize replaying a write.

## Use the source checkout

```sh
npm link
figma-agent-control help
```
