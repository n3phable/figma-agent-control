# Agent guide

[Simplified Chinese](zh_cn/agent-guide.md)

## Available commands

`help`, `init`, `result`, `wait`, `connect`, `status`

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
