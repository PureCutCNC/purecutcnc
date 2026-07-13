/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * SVG paint-intent tests for import classification.
 *
 * Run with: npx tsx src/import/svg.test.ts
 */

import { DOMParser } from 'linkedom'
import { importSvgString } from './svg'
import type { ImportContext, ImportedShape } from './types'

// Polyfill DOMParser for Node.js test runner
if (!globalThis.DOMParser) {
  ;(globalThis as Record<string, unknown>).DOMParser = DOMParser
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg)
}

const ctx: ImportContext = { fileName: 'test.svg', targetUnits: 'mm' }

function parse(text: string): ImportedShape[] {
  return importSvgString(text, ctx).shapes
}

// ── default / inherited fill ─────────────────────────────────────────

function test_default_fill_visible(): void {
  const shapes = parse('<svg><rect width="10" height="10"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === true, 'default fill should be visible (black)')
  assert(shapes[0].hasStroke === false, 'default stroke should be none')
}

function test_inherited_fill_from_group(): void {
  const shapes = parse('<svg><g fill="red"><rect width="10" height="10"/></g></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === true, 'inherited fill should be visible')
}

function test_inherited_stroke_from_group(): void {
  const shapes = parse('<svg><g stroke="blue"><line x1="0" y1="0" x2="10" y2="10"/></g></svg>')
  assert(shapes.length === 1, 'expected one line')
  assert(shapes[0].hasStroke === true, 'inherited stroke should be visible')
}

// ── stroke-only ───────────────────────────────────────────────────────

function test_stroke_only_circle(): void {
  const shapes = parse('<svg><circle cx="5" cy="5" r="3" fill="none" stroke="blue"/></svg>')
  assert(shapes.length === 1, 'expected one circle')
  assert(shapes[0].hasFill === false, 'explicit fill=none should be non-visible')
  assert(shapes[0].hasStroke === true, 'stroke should be visible')
}

function test_stroke_only_path(): void {
  const shapes = parse('<svg><path d="M0,0 L10,10" fill="none" stroke="red"/></svg>')
  assert(shapes.length === 1, 'expected one path')
  assert(shapes[0].hasFill === false, 'path fill=none should be non-visible')
  assert(shapes[0].hasStroke === true, 'path stroke should be visible')
}

// ── fill + stroke ─────────────────────────────────────────────────────

function test_fill_and_stroke_rect(): void {
  const shapes = parse('<svg><rect x="0" y="0" width="10" height="10" fill="green" stroke="black"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === true, 'fill should be visible')
  assert(shapes[0].hasStroke === true, 'stroke should be visible')
}

// ── inline style precedence ───────────────────────────────────────────

function test_inline_style_overrides_attribute(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="blue" style="fill:red"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  // Inline style takes precedence over presentation attribute
  assert(shapes[0].hasFill === true, 'fill from inline style should be visible')
}

function test_inline_style_none_overrides_attribute(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="blue" style="fill:none"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'inline style fill:none should override attribute')
}

function test_inline_style_stroke(): void {
  const shapes = parse('<svg><rect width="10" height="10" stroke="blue" style="stroke:red"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasStroke === true, 'inline style stroke should be visible')
}

// ── transparent / none paint ──────────────────────────────────────────

function test_fill_transparent(): void {
  const shapes = parse('<svg><circle cx="5" cy="5" r="3" fill="transparent"/></svg>')
  assert(shapes.length === 1, 'expected one circle')
  assert(shapes[0].hasFill === false, 'fill=transparent should be non-visible')
}

function test_fill_none_case_insensitive(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="None"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'fill=None should be non-visible')
}

// ── open geometry intent ──────────────────────────────────────────────

function test_open_polyline_has_stroke(): void {
  const shapes = parse('<svg><polyline points="0,0 10,10 20,0" fill="none" stroke="red"/></svg>')
  assert(shapes.length === 1, 'expected one polyline')
  assert(shapes[0].profile.closed === false, 'polyline should be open')
  assert(shapes[0].hasStroke === true, 'stroke should be visible')
  assert(shapes[0].hasFill === false, 'fill should be none')
}

function test_open_path_has_stroke(): void {
  const shapes = parse('<svg><path d="M0,0 L10,10" fill="none" stroke="blue"/></svg>')
  assert(shapes.length === 1, 'expected one path')
  assert(shapes[0].profile.closed === false, 'open path should not be closed')
  assert(shapes[0].hasStroke === true, 'stroke should be visible')
}

// ── closed geometry with fill becomes closed profile ───────────────────

function test_closed_filled_path_is_closed(): void {
  const shapes = parse('<svg><path d="M0,0 L10,0 L10,10 L0,10 Z" fill="green"/></svg>')
  assert(shapes.length === 1, 'expected one path')
  assert(shapes[0].profile.closed === true, 'filled closed path should be closed')
  assert(shapes[0].hasFill === true, 'fill should be visible')
}

// ── opacity: ancestor zero ─────────────────────────────────────────────

function test_ancestor_opacity_zero_hides_fill(): void {
  const shapes = parse('<svg><g opacity="0"><rect width="10" height="10" fill="red"/></g></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'ancestor opacity:0 should hide fill')
  assert(shapes[0].hasStroke === false, 'ancestor opacity:0 should hide stroke')
}

function test_ancestor_opacity_zero_nested(): void {
  const shapes = parse('<svg><g opacity="0"><g><rect width="10" height="10" fill="red" stroke="blue"/></g></g></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'nested ancestor opacity:0 should hide fill')
  assert(shapes[0].hasStroke === false, 'nested ancestor opacity:0 should hide stroke')
}

// ── opacity: child zero ────────────────────────────────────────────────

function test_child_opacity_zero(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="red" opacity="0"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'child opacity:0 should hide fill')
}

// ── fill-opacity zero ──────────────────────────────────────────────────

function test_fill_opacity_zero_attribute(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="red" fill-opacity="0"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'fill-opacity:0 should hide fill')
}

function test_fill_opacity_zero_inline_style(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="red" style="fill-opacity:0"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'inline style fill-opacity:0 should hide fill')
}

// ── stroke-opacity zero ────────────────────────────────────────────────

function test_stroke_opacity_zero(): void {
  const shapes = parse('<svg><circle cx="5" cy="5" r="3" fill="none" stroke="blue" stroke-opacity="0"/></svg>')
  assert(shapes.length === 1, 'expected one circle')
  assert(shapes[0].hasStroke === false, 'stroke-opacity:0 should hide stroke')
  assert(shapes[0].hasFill === false, 'fill was already none')
}

// ── inherited fill-opacity / stroke-opacity ────────────────────────────

function test_inherited_fill_opacity_from_group(): void {
  const shapes = parse('<svg><g fill-opacity="0"><rect width="10" height="10" fill="red"/></g></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'inherited fill-opacity:0 should hide fill')
}

function test_inherited_stroke_opacity_from_group(): void {
  const shapes = parse('<svg><g stroke-opacity="0"><line x1="0" y1="0" x2="10" y2="10" stroke="blue"/></g></svg>')
  assert(shapes.length === 1, 'expected one line')
  assert(shapes[0].hasStroke === false, 'inherited stroke-opacity:0 should hide stroke')
}

function test_child_overrides_inherited_fill_opacity(): void {
  const shapes = parse('<svg><g fill-opacity="0"><rect width="10" height="10" fill="red" fill-opacity="1"/></g></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === true, 'child fill-opacity:1 should override inherited 0')
}

// ── rgba/hsla alpha zero ───────────────────────────────────────────────

function test_rgba_comma_alpha_zero(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="rgba(255, 0, 0, 0)"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'rgba with alpha 0 should be invisible')
}

function test_rgba_modern_alpha_zero(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="rgba(255 0 0 / 0)"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'rgba modern syntax with alpha 0 should be invisible')
}

function test_hsla_comma_alpha_zero(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="hsla(0, 100%, 50%, 0)"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'hsla with alpha 0 should be invisible')
}

function test_hsla_modern_alpha_zero(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="hsla(0 100% 50% / 0)"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'hsla modern syntax with alpha 0 should be invisible')
}

function test_rgba_alpha_zero_percent(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="rgba(255, 0, 0, 0%)"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'rgba with alpha 0% should be invisible')
}

// ── 8-digit hex alpha zero ─────────────────────────────────────────────

function test_hex8_alpha_zero(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="#ff000000"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, '8-digit hex with alpha 00 should be invisible')
}

function test_hex8_alpha_ff_visible(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="#ff0000ff"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === true, '8-digit hex with alpha ff should be visible')
}

// ── nonzero alpha regression ───────────────────────────────────────────

function test_rgba_nonzero_alpha_visible(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="rgba(255, 0, 0, 0.5)"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === true, 'rgba with alpha 0.5 should still be visible')
}

function test_hsla_nonzero_alpha_visible(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="hsla(0, 100%, 50%, 0.3)"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === true, 'hsla with alpha 0.3 should still be visible')
}

// ── opacity compounding ────────────────────────────────────────────────

function test_opacity_compounding_nonzero(): void {
  // grandparent 0.5 × parent 0.5 = cumulative 0.25 — still > 0, so visible
  const shapes = parse('<svg><g opacity="0.5"><g opacity="0.5"><rect width="10" height="10" fill="red"/></g></g></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === true, 'cumulative opacity 0.25 should still be visible')
}

// ── stroke-only remains visible with fill-opacity:0 ────────────────────

function test_stroke_only_with_fill_opacity_zero(): void {
  const shapes = parse('<svg><rect width="10" height="10" fill="red" fill-opacity="0" stroke="blue"/></svg>')
  assert(shapes.length === 1, 'expected one rect')
  assert(shapes[0].hasFill === false, 'fill-opacity:0 should hide fill')
  assert(shapes[0].hasStroke === true, 'stroke should remain visible')
}

// ── run ───────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

const tests: Array<{ name: string; fn: () => void }> = [
  { name: 'default fill visible', fn: test_default_fill_visible },
  { name: 'inherited fill from group', fn: test_inherited_fill_from_group },
  { name: 'inherited stroke from group', fn: test_inherited_stroke_from_group },
  { name: 'stroke-only circle', fn: test_stroke_only_circle },
  { name: 'stroke-only path', fn: test_stroke_only_path },
  { name: 'fill and stroke rect', fn: test_fill_and_stroke_rect },
  { name: 'inline style overrides attribute', fn: test_inline_style_overrides_attribute },
  { name: 'inline style none overrides attribute', fn: test_inline_style_none_overrides_attribute },
  { name: 'inline style stroke', fn: test_inline_style_stroke },
  { name: 'fill transparent', fn: test_fill_transparent },
  { name: 'fill none case insensitive', fn: test_fill_none_case_insensitive },
  { name: 'open polyline has stroke', fn: test_open_polyline_has_stroke },
  { name: 'open path has stroke', fn: test_open_path_has_stroke },
  { name: 'closed filled path is closed', fn: test_closed_filled_path_is_closed },
  { name: 'ancestor opacity zero hides fill', fn: test_ancestor_opacity_zero_hides_fill },
  { name: 'ancestor opacity zero nested', fn: test_ancestor_opacity_zero_nested },
  { name: 'child opacity zero', fn: test_child_opacity_zero },
  { name: 'fill-opacity zero attribute', fn: test_fill_opacity_zero_attribute },
  { name: 'fill-opacity zero inline style', fn: test_fill_opacity_zero_inline_style },
  { name: 'stroke-opacity zero', fn: test_stroke_opacity_zero },
  { name: 'inherited fill-opacity from group', fn: test_inherited_fill_opacity_from_group },
  { name: 'inherited stroke-opacity from group', fn: test_inherited_stroke_opacity_from_group },
  { name: 'child overrides inherited fill-opacity', fn: test_child_overrides_inherited_fill_opacity },
  { name: 'rgba comma alpha zero', fn: test_rgba_comma_alpha_zero },
  { name: 'rgba modern alpha zero', fn: test_rgba_modern_alpha_zero },
  { name: 'hsla comma alpha zero', fn: test_hsla_comma_alpha_zero },
  { name: 'hsla modern alpha zero', fn: test_hsla_modern_alpha_zero },
  { name: 'rgba alpha zero percent', fn: test_rgba_alpha_zero_percent },
  { name: 'hex8 alpha zero', fn: test_hex8_alpha_zero },
  { name: 'hex8 alpha ff visible', fn: test_hex8_alpha_ff_visible },
  { name: 'rgba nonzero alpha visible', fn: test_rgba_nonzero_alpha_visible },
  { name: 'hsla nonzero alpha visible', fn: test_hsla_nonzero_alpha_visible },
  { name: 'opacity compounding nonzero', fn: test_opacity_compounding_nonzero },
  { name: 'stroke-only with fill-opacity zero', fn: test_stroke_only_with_fill_opacity_zero },
]

for (const t of tests) {
  try {
    t.fn()
    console.log(`${t.name}: PASSED`)
    passed += 1
  } catch (err) {
    console.log(`${t.name}: FAILED — ${err instanceof Error ? err.message : err}`)
    failed += 1
  }
}

console.log(`\nSVG paint intent: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
