# Figma Agent Control — local, evidence-backed Figma automation

Node.js >=22 + ES modules + a Figma Desktop development plugin + a loopback HTTP bridge + optional Chrome over CDP pipe + node:test. There are no runtime npm dependencies. JSDoc/checkJs uses the exact development versions in `package-lock.json`.

## Architecture

Each CLI command is a short process, except `connect`, which becomes the foreground bridge process. The bridge owns job state and persists evidence under the working directory's `.figma-agent-control/runs/<job-id>/`. Atomic `result.json` creation is the sole completion commit point; CLI readers use disk evidence, so a terminated CLI can later wait for the same job.

The plugin has an iframe network relay and a document execution side joined only by postMessage. CLI and plugin requests have separate credentials; plugin requests also carry a source fingerprint. The binding defines valid task targets, and the selected target defines evidence coverage. Trusted run scripts have full Plugin API access.

## Directory map

| Directory | Responsibility |
|---|---|
| [bin/](bin/AGENTS.md) | CLI parsing/dispatch/output boundary; `connect` is the assembly point |
| [plugin/](plugin/AGENTS.md) | Development-plugin templates: execution, read-only extraction, and iframe relay |
| [src/](src/AGENTS.md) | Host business logic: bridge, sessions, leases, records, cleanup, diagnostics, images, and video frames |
| [src/html/](src/html/AGENTS.md) | Extract consumption, deterministic static HTML generation, Chrome checks, attribution, and overrides |
| [lib/](lib/AGENTS.md) | Plugin-side motion and prototype helpers injected through `run --lib` |
| [tests/](https://github.com/n3phable/figma-agent-control/blob/main/tests/AGENTS.md) | Automated contracts, end-to-end VM-plugin tests, browser tests, and type-check entry point |
| [tests/helpers/](https://github.com/n3phable/figma-agent-control/blob/main/tests/helpers/AGENTS.md) | Shared synthetic documents, real-bridge/VM-plugin harnesses, and media fixtures |
| `docs/` | English agent guide, protocol, architecture, `zh_cn/` translations, and `brand/` assets |
| `skills/figma-agent-control/` | Distributed operating skill; links to the versioned agent guide |
| `scripts/` | Repository release-readiness checks |
| `.github/` | CI, release automation, and contribution templates |

## Configuration and public documents

- `package.json`: CLI entry, Node requirement, package allowlist, MIT metadata, and `test`, `check`, `check:release` scripts. Runtime imports require no installed packages; development tools are pinned.
- `package-lock.json`: reproducible development dependencies; use `npm ci` before type/release validation.
- `tsconfig.json`: host Node/checkJs environment, separate from plugin globals.
- `plugin/tsconfig.json`: classic-script Figma environment for main and extract.
- `lib/tsconfig.json`, `lib/tsconfig.prototype.json`: separate classic-script environments for each library, with injected target/data declarations.
- `.gitignore`: generated dependencies, packages, and local evidence stay out of version control.
- [README.md](README.md), [README_ZH.md](README_ZH.md): English and Simplified Chinese installation, capabilities, quick start, and trust limits.
- [docs/agent-guide.md](docs/agent-guide.md): practical operating and recovery workflow.
- [docs/protocol.md](docs/protocol.md): requests, execution order, evidence, library specs, HTML artifacts, and exit codes.
- [docs/architecture.md](docs/architecture.md): module boundaries and design decisions.
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup, checks and contribution workflow.
- [SECURITY.md](SECURITY.md), [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [CHANGELOG.md](CHANGELOG.md): disclosure policy, licensing, included material, and changes.

## Working rules

Keep source comments, plugin UI, and documentation/examples outside `README_ZH.md` and `docs/zh_cn/*.md` in English. Simplified Chinese documentation is allowed only in those Markdown files; translate the current public English documentation and maintain reciprocal navigation links. CLI-authored human-readable strings must remain ASCII English, including errors, hints, instructions, warnings, and persisted strings later printed by the CLI. Figma-authored names and content are data and must be preserved unchanged.

Read the relevant module map and source headers before changing behavior. Maintain affected `[INPUT]`, `[OUTPUT]`, and `[POS]` contracts; update module maps when members or interfaces change and update the protocol when external behavior changes. Keep updates focused on the affected contracts and current requirements. Keep dependencies acyclic and follow existing error, output, persistence, and testing conventions.

Run checks proportionate to the change. `npm test` runs test files serially to prevent browser performance checks competing for resources. `npm run check` verifies syntax and the separate type environments. `npm run check:release` verifies English text, obvious sensitive-data patterns, and the npm tarball allowlist. Record observed local, hosted-CI and live Desktop checks separately.

CI checks functional behavior on Linux/macOS with Node.js 22/24. Ubuntu/Node.js 22 is the elapsed-time performance baseline; `FAC_PERFORMANCE_GATE=0` disables only timing assertions in the other CI jobs. Local tests enforce timing budgets by default.

Plugin template bytes affect the plugin version; generator/checker source bytes affect their fingerprints. Even comment-only changes can require new plugin installation/reload or regenerate provenance fingerprints. Generate fingerprints from source bytes and run the corresponding checks.

## Installing the consumer skill

When installing FAC for a user, explain the bundled skill and use the user's selected scope. If scope is not yet specified, offer workspace discovery (usually `<workspace>/.agents/skills/figma-agent-control`) or global discovery (`~/.agents/skills/figma-agent-control`); do not silently choose global visibility. Existing authorization and an explicit destination remain valid.

Use a symlink to this checkout's `skills/figma-agent-control` so updates stay aligned. Use the agent's documented discovery location when different; add a Claude-specific link only if that setup is requested. Check existing paths before replacing anything and verify the final link. The [README](README.md#install-from-source) provides manual commands.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
