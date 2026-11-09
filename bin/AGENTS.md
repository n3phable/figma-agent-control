# bin/

> L2 | Parent: [project map](../AGENTS.md)

The CLI process boundary parses arguments, delegates to `src/`, and writes output. Business rules belong in the host modules. The project root is exactly the current directory. Commands are short-lived except foreground `connect`.

Stdout is one JSON object. Submitting commands write a job-ID receipt to stderr before waiting, then read evidence from disk. Exit codes are `0` success, `1` failure or failed verification, and `2` unfinished. `COMMANDS` supplies usage and submission dispatch; the remaining help text is hand-maintained and must track protocol changes.

`connect` is the assembly point: acquire the shared pairing credential, start the bridge, and install the generated plugin only when contents changed. If installation fails, close the bridge before reporting failure.

## Members

- `figma-agent-control.mjs`: executable entry and command dispatcher; delegates argument parsing, bridge/session/client work, record interpretation, cleanup, diagnostics, image/video analysis, and HTML commands. Cancel requests cancellation before using the same wait path as ordinary waits. Local exception messages are capped at 2,000 characters.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
