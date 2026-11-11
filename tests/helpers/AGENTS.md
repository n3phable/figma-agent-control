# tests/helpers/

> L2 | Parent: [tests](../AGENTS.md)

Fixtures serve test files and depend on production source/plugin code. The harness also exposes the CLI entry path for subprocesses. The small run/preview document and the richer extraction document have distinct responsibilities. Real plugin source runs in `node:vm`; real bridges use port `0`; global plugin homes are always temporary.

## Members

- `harness.mjs`: real bridge plus concatenated VM main/UI, small fake document, deterministic polling gates, and CLI helpers that drain in-flight result uploads before returning. Supports hidden document state and manually driven UI ticks. Timers are unref'd so a suspended script does not retain the process; subprocesses inherit an isolated plugin home.
- `doc.mjs`: richer extraction document with two synthetic 160×160 frames. One is the extraction-contract baseline; the other exercises generator masks, rotated groups, islands, gradients/images, and typography. Export parameters and extra globals make contract drift visible.
- `generate.mjs`: runs real extraction on the synthetic document, lands binary descriptors, and supplies deterministic hand-written font metrics to generation. Cached extracts are copied before use, avoiding test mutation leaks.
- `bridge.mjs`: real-service HTTP fixture with injectable clock and restart; fetch acts as CLI/plugin with the corresponding temporary credentials. Does not execute plugin code.
- `plugin.mjs`: VM execution fixture for run/read/focus operations, scripted approval/checkpoint acknowledgements, host-call ordering, and injected long-timeout behavior. Short creation-event delivery delays remain real.
- `match/`: seven deterministic synthetic PNG pairs and expected counts, masks, difference fingerprints, and dense blocks; no screenshots or private design content. Normal tests only read these files.
- `match/generate.mjs`: rebuilds geometry, glyph, gradient, and transparency fixtures using externally installed pixelmatch 7.2.0 for independent pixel expectations, pngjs for PNG round-trip checks, and a separate grid reference for dense blocks. Invocation is documented in its comments; no runtime dependency is added.
- `motion/`: two synthetic 64×32, one-second WebM fixtures with a black block moving different distances on white, used for frame sampling/comparison. No private design content.

`[PROTOCOL]: When changing this file, update this header and check AGENTS.md.`
