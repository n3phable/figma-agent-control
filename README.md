# Figma Agent Control

[English](README.md) | [Simplified Chinese](README_ZH.md)

Local workspace, execution and evidence modules for Figma automation.

## Capabilities

- Bind a workspace to a Figma file and node scope.
- Coordinate local pairing, bridge locks and plugin leases.
- Read durable results, compare snapshots and summarize job outcomes.
- Use the CLI to initialize bindings and read or wait for saved jobs.
- Relay authenticated plugin tasks and retain unacknowledged results.
- Inspect bound nodes, export previews and read local variables in the plugin.
- Start the authenticated local bridge and inspect connection status.
- Submit built-in reads and persist immutable job results.
- Execute trusted scripts with approval, checkpoints and Undo boundaries.
- Submit scripts with run options and diagnose the connection.

## Install from source

Node.js 22+

```sh
npm link
figma-agent-control help
```

`help`, `init`, `result`, `wait`, `connect`, `status`, `inspect`, `preview`, `variables`, `run`, `doctor`

[Agent guide](docs/agent-guide.md) · [Protocol](docs/protocol.md) · [Architecture](docs/architecture.md) · [MIT](LICENSE)
