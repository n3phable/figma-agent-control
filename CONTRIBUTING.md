# Contributing

Use Node.js 22 or later. Install development dependencies with `npm ci` and run:

```sh
npm run check
npm test
npm run check:release
```

Tests run serially to keep browser performance measurements consistent. Use
isolated temporary directories, random local ports, synthetic Figma documents
and a test-specific `FIGMA_AGENT_CONTROL_HOME`. Clean up owned processes and
files after each test. Browser tests require Chrome; font tests report skips
when their named font is unavailable.

CI checks the same functional and pixel results on Linux/macOS with Node.js
22/24. Ubuntu/Node.js 22 enforces the elapsed-time budgets; the other jobs set
`FAC_PERFORMANCE_GATE=0` and record timings. Local `npm test` enforces the budgets
by default.

Work on a focused feature or fix branch. Each change includes its implementation,
regression coverage and affected English and Simplified Chinese documentation.
Keep commits reviewable and describe the observable result in the pull request.
Limit formatting and refactoring to the work being changed.

Keep source comments, test titles, diagnostics and default documentation in
English. `README_ZH.md` and `docs/zh_cn/` hold the Simplified Chinese translations;
update both languages together. Use Unicode escapes for multilingual test
fixtures whose exact bytes or glyphs matter.

Read the relevant `AGENTS.md` map and update affected file contracts when
responsibilities, interfaces or behavior change. Follow the
[protocol](docs/protocol.md) for evidence and recovery: an unknown write requires
inspection and resolution before another write.

Plugin versions and HTML checker/generator fingerprints derive from source
bytes. Regenerate them through the implementation, review changed artifacts,
and run the relevant rendering, protocol or contract checks.

Keep design evidence, pairing state and personal configuration in local working
directories. Commit synthetic fixtures under `tests/helpers/` with reproducible
creation instructions. Use [SECURITY.md](SECURITY.md) for vulnerability reports.

By submitting a contribution, you agree that it can be distributed under this
repository's MIT license. Preserve applicable third-party notices.
