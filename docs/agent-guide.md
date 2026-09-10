# Agent guide

[Simplified Chinese](zh_cn/agent-guide.md)

## Available commands

`help`, `init`, `result`, `wait`, `connect`, `status`, `inspect`, `preview`, `variables`, `run`, `doctor`, `stop`, `resolve`

Run the CLI in the project working directory and use help for this revision's syntax.

```sh
figma-agent-control help
figma-agent-control init 'https://www.figma.com/design/<fileKey>/<name>?node-id=1-2'
```

## Connect the plugin

```sh
figma-agent-control connect
```

Keep the foreground process running. Import the returned manifest in Figma Desktop, open the bound file and run the development plugin. Use status from another terminal to inspect the connection.

## Read the target

```sh
figma-agent-control inspect
figma-agent-control preview --node 12:34
figma-agent-control variables
```

Use the receipt's job ID to read result or continue waiting with wait.

## Submit a script

```sh
figma-agent-control doctor
figma-agent-control run <script.js> --node 12:34
```

The script is a function body with figma, target and data. The target defines snapshot coverage; the full Plugin API remains available for the current file. Read instruction, executionStarted and the saved result before continuing.

## Stop and recover

`stop` shuts down the local bridge and preserves outstanding evidence. Delivered writes without a result block later writes. Stop the previous plugin, inspect the original target in the current session, then use `resolve <job-id> --inspect <inspect-id> --previous-plugin-stopped`. Resolution records the review without undoing edits or inventing a successful result.
