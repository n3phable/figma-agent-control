/**
 * [INPUT]: Imports node:test, node:assert/strict, ../src/html/css.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for html generate; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearGradient, paintLayer, place, num, svgLinearGradient, bakeReason, maskImage, textBox, segmentStyle } from '../src/html/css.mjs';



// -- Structure and traversal ----------------------------------------------








// -- Styles ---------------------------------------------------------------




test('CSS numeric contracts cover gradient-stop remapping, SVG gradients, CROP conversion, number formatting, and matrices', () => {
  const stops = [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }];
  const g = (m, w, h, opacity) => linearGradient({ gradientTransform: m, gradientStops: stops, opacity }, w, h);
  assert.equal(g([[2, 0, -0.5], [0, 1, 0]], 100, 50), 'linear-gradient(90deg,#FF0000 25%,rgba(0,0,255,0.5) 75%)');
  assert.equal(g([[0.5, 0.5, 0], [-0.5, 0.5, 0.5]], 40, 40, 0.5), 'linear-gradient(135deg,rgba(255,0,0,0.5) 0%,rgba(0,0,255,0.25) 100%)');
  assert.equal(g([[0.5, 0.5, 0], [-0.5, 0.5, 0.5]], 40, 20), 'linear-gradient(153.435deg,#FF0000 0%,rgba(0,0,255,0.5) 100%)');
  assert.equal(g([[0, 0, 0.5], [0, 0, 0]], 10, 10), 'linear-gradient(180deg,#FF0000 0%,rgba(0,0,255,0.5) 100%)', 'Zero gradient preserves original stop positions');
  assert.equal(svgLinearGradient({ gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops }, 20, 10, 'v'),
    '<linearGradient id="v" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0" gradientTransform="matrix(20 0 0 10 0 0)"><stop offset="0" stop-color="#FF0000"/><stop offset="1" stop-color="rgba(0,0,255,0.5)"/></linearGradient>');
  assert.match(svgLinearGradient({ gradientTransform: [[1, 0, 0.25], [0, 1, 0.5]], gradientStops: stops }, 20, 10, 'v'), /gradientTransform="matrix\(20 0 0 10 -5 -5\)"/);
  assert.equal(svgLinearGradient({ gradientTransform: [[0, 0, 0], [0, 0, 0]], gradientStops: stops }, 20, 10, 'v'), '');
  const crop = paintLayer({ type: 'IMAGE', scaleMode: 'CROP', imageHash: 'h', imageTransform: [[1, 0, 0], [0, 0.9386, 0.0589]] }, 20, 20, { url: 'u', width: 4, height: 4 });
  assert.deepEqual(crop, { css: 'url("u") 0px -1.255px/20px 21.308px no-repeat' });
  assert.deepEqual(paintLayer({ type: 'IMAGE', scaleMode: 'TILE', imageHash: 'h' }, 20, 20, { url: 'u', width: 0, height: 0 }), { css: 'url("u") 0 0/auto repeat', approx: 'paint-unsupported', detail: 'TILE' });
  assert.deepEqual([num(-0.0001), num(1.23456), num(2.5000001, 6), num(NaN)], ['0', '1.235', '2.5', 'NaN']);
  assert.equal(place([1, 0, 0, 1, 1.5, -2]), 'translate(1.5px,-2px)');
  assert.equal(place([0, 1, -1, 0, 3, 4]), 'matrix(0,1,-1,0,3,4)');
  // BAKE reasons, EVENODD mask geometry, bottom alignment, and default underline thickness/offset.
  const box = extra => ({ id: '1:1', name: 'n', type: 'RECTANGLE', transform: [[1, 0, 0], [0, 1, 0]], width: 10, height: 10, ...extra });
  const image = extra => ({ type: 'IMAGE', scaleMode: 'FILL', imageHash: 'h', ...extra });
  assert.deepEqual([box({ fills: [image({ rotation: 90 })] }), box({ fills: [image({ filters: { exposure: 0.2 } })] }), box({ effects: [{ type: 'NOISE', visible: true }] }),
    box({ strokes: [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [] }] }), box({ fills: [image({ filters: { exposure: 0 } })] })].map(bakeReason),
  ['image-transform', 'image-filter', 'effect-noise', 'gradient-stroke', null]);
  assert.match(decodeURIComponent(maskImage(box({ fillGeometry: [{ windingRule: 'EVENODD', data: 'M0 0 L1 1' }] }), 0.4)['mask-image']), /<g fill-opacity="0\.4"><path d="M0 0 L1 1" fill-rule="evenodd"\/>/);
  assert.equal(textBox(box({ type: 'TEXT', textAlignVertical: 'BOTTOM' })).style['justify-content'], 'flex-end');
  const u = segmentStyle({ characters: 'x', start: 0, end: 1, fontName: { family: 'F', style: 'Regular' }, fontSize: 10, lineHeight: { unit: 'AUTO' }, fills: [], textDecoration: 'UNDERLINE' },
    { name: 'f0', family: 'F', italic: false }, null, [10, 10]);
  assert.deepEqual([u['text-decoration-thickness'], u['text-underline-offset'], u['text-decoration-skip-ink']], ['1px', '2.5px', 'none']);
});
