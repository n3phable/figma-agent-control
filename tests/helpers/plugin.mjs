/**
 * [INPUT]: tests/helpers/harness createDoc/fakeFigma/pluginSource; node:vm runs the real plugin/main.js.
 * [OUTPUT]: Exports plugin(options) with doc, figma, events, checkpoints, approvals, results, infos, start, and send; also exports the default task BINDING.
 * [POS]: Plugin unit-test fixture shared by plugin.test.mjs, plugin-failure.test.mjs, and clean.test.mjs. Runs real main.js against a mock document and responds to checkpoints/high-risk approvals by scenario. harness.mjs provides the real-bridge end-to-end fixture.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import vm from 'node:vm';
import { createDoc, fakeFigma, pluginSource } from './harness.mjs';

export const BINDING = { fileKey: 'example', nodeId: '1:2' };

// Run real main.js in a VM. Capture postMessage with structuredClone to match the host boundary; unwrap large-result string envelopes before dispatch.
// Respond to checkpoints and high-risk approvals by scenario: true/false acknowledges automatically; wait leaves acknowledgment to the test.
// events records host-call order: show, approval, checkpoint, undo, export, and script markers through figma.mark.
// sandbox replaces globals such as timers and clocks; delay controls mock nodechange delivery in milliseconds.
export function plugin({ checkpoint = true, approval = 'wait', beforeAck, sandbox, delay } = {}) {
  const doc = createDoc({ delay }), events = [], checkpoints = [], approvals = [], results = [], infos = [];
  const reply = message => queueMicrotask(() => figma.ui.onmessage(message));
  const figma = fakeFigma(doc, { onUi: raw => {
    let message = structuredClone(raw);
    if (message.type === 'serialized-result') message = { ...JSON.parse(message.serialized), envelope: true };
    if (message.type === 'checkpoint') {
      checkpoints.push(message); events.push('checkpoint');
      if (checkpoint === 'wait') return;
      beforeAck?.(doc);
      reply({ type: 'checkpoint-ack', id: message.id, channelNonce: message.channelNonce, ok: checkpoint });
    } else if (message.type === 'approval-request') {
      approvals.push(message); events.push('approval');
      if (approval !== 'wait') reply({ type: 'approval-ack', id: message.id, channelNonce: message.channelNonce, approved: approval });
    } else if (message.type === 'target-info') infos.push(message);
    else results.push(message);
  } });
  figma.commitUndo = () => { events.push('undo'); };
  figma.ui.show = () => { events.push('show'); };
  figma.mark = label => { events.push(label); };
  // Replace 10 s / 300 s timeouts with no-ops so tests do not depend on wall time. Millisecond waits for nodechange delivery after failures still run normally.
  vm.runInNewContext(pluginSource, { figma, __html__: '', setTimeout: (fn, ms) => ms < 1000 ? setTimeout(fn, ms) : 0, clearTimeout() {}, ...sandbox });
  let seq = 0;
  const start = job => {
    const id = `job-${++seq}`, channelNonce = `nonce-${seq}`;
    const done = figma.ui.onmessage({ id, channelNonce, operation: 'run', binding: BINDING, ...job }).then(() => results.find(r => r.id === id));
    return { id, channelNonce, done };
  };
  return { doc, figma, events, checkpoints, approvals, results, infos, start, send: job => start(job).done };
}
