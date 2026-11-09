# scripts/

> Parent: [repository map](../AGENTS.md)

Release tooling uses only Node.js built-ins. It inspects repository files and the
npm package without starting a bridge or touching a Figma document.

- `check-release.mjs`: checks English source text, obvious credential/path leaks,
  package metadata, required distribution files, and optional version-tag agreement.
  Simplified Chinese is allowed only in `README_ZH.md` and `docs/zh_cn/*.md`;
  sensitive-data checks still apply to these translations.

Keep checks deterministic and diagnostics free of the potentially sensitive value.
Review source history, asset provenance and package contents alongside these
automated checks.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
