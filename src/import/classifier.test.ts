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
 * Import classifier tests — nesting, modes, paint intent, ambiguity.
 *
 * Run with: npx tsx src/import/classifier.test.ts
 */

import { classifyImportShapes, inferNestedSolidOperation } from './classifier'
import type { ImportGeometryMode, ImportedShape } from './types'
import { polygonProfile, rectProfile } from '../types/project'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function openLine(name: string, layer: string | null = null): ImportedShape {
  return {
    name,
    sourceType: 'dxf',
    layerName: layer,
    profile: {
      start: { x: 0, y: 0 },
      segments: [{ type: 'line', to: { x: 10, y: 0 } }],
      closed: false,
    },
  }
}

function closedRect(name: string, layer: string | null = null, x = 0, y = 0, w = 10, h = 10): ImportedShape {
  return {
    name,
    sourceType: 'dxf',
    layerName: layer,
    profile: rectProfile(x, y, w, h),
  }
}

function svgClosedRect(name: string, hasFill: boolean, hasStroke: boolean, layer: string | null = null): ImportedShape {
  return {
    name,
    sourceType: 'svg',
    layerName: layer,
    profile: rectProfile(0, 0, 10, 10),
    hasFill,
    hasStroke,
  }
}

// ── Paths mode: closed → Line ─────────────────────────────────────────

function test_paths_closed_to_line(): void {
  const shapes = [closedRect('r1')]
  const { classified, result } = classifyImportShapes(shapes, 'paths', 'dxf')
  assert(classified.length === 1, 'expected one shape')
  assert(classified[0].operation === 'line', 'Paths mode: closed should be Line')
  assert(result.closedLineCount === 1, 'summary: 1 closed line')
  assert(result.addCount === 0, 'summary: 0 add')
}

// ── DXF Auto: nesting-aware solids ────────────────────────────────────

function test_dxf_auto_nests_solids(): void {
  const outer = closedRect('outer', null, 0, 0, 100, 100)
  const inner = closedRect('inner', null, 10, 10, 20, 20)
  const { classified, result } = classifyImportShapes([outer, inner], 'auto', 'dxf')
  assert(classified.length === 2, 'expected 2 shapes')
  // outer (Add, depth 0) before inner (Subtract, depth 1)
  assert(classified[0].operation === 'add', 'outer should be Add')
  assert(classified[0].name === 'outer', 'outer first (source order)')
  assert(classified[1].operation === 'subtract', 'inner should be Subtract')
  assert(classified[1].name === 'inner', 'inner second')
  assert(result.addCount === 1, '1 Add')
  assert(result.subtractCount === 1, '1 Subtract')
}

// ── SVG Auto: stroke-only → Line, filled → solid ──────────────────────

function test_svg_auto_stroke_only_line(): void {
  const shapes = [svgClosedRect('stroke-only', false, true)]
  const { classified, result } = classifyImportShapes(shapes, 'auto', 'svg')
  assert(classified.length === 1, 'expected one shape')
  assert(classified[0].operation === 'line', 'SVG Auto: stroke-only closed should be Line')
  assert(result.closedLineCount === 1, 'summary: 1 closed line')
}

function test_svg_auto_filled_solid(): void {
  const shapes = [svgClosedRect('filled', true, false)]
  const { classified, result } = classifyImportShapes(shapes, 'auto', 'svg')
  assert(classified.length === 1, 'expected one shape')
  assert(classified[0].operation === 'add', 'SVG Auto: filled closed should be Add')
  assert(result.addCount === 1, 'summary: 1 add')
}

function test_svg_auto_fill_and_stroke_solid(): void {
  const shapes = [svgClosedRect('both', true, true)]
  const { classified } = classifyImportShapes(shapes, 'auto', 'svg')
  assert(classified.length === 1, 'expected one shape')
  assert(classified[0].operation === 'add', 'SVG Auto: fill+stroke closed should be Add (solid)')
}

// ── Open always Line ───────────────────────────────────────────────────

function test_open_always_line(): void {
  const shapes = [openLine('open1')]
  for (const mode of ['auto', 'paths', 'solid-regions'] as ImportGeometryMode[]) {
    const { classified, result } = classifyImportShapes(shapes, mode, 'dxf')
    assert(classified[0].operation === 'line', `${mode}: open should be Line`)
    assert(result.openLineCount === 1, `${mode}: summary open line count`)
  }
}

function test_open_ignored_in_solid_mode(): void {
  const shapes = [openLine('open1'), closedRect('closed1')]
  const { classified } = classifyImportShapes(shapes, 'solid-regions', 'dxf')
  assert(classified.length === 2, 'expected 2 shapes')
  assert(classified.find((c) => c.name === 'open1')?.operation === 'line', 'open stays line')
  assert(classified.find((c) => c.name === 'closed1')?.operation === 'add', 'closed becomes add')
}

// ── Disjoint solids (top-level Add) ───────────────────────────────────

function test_disjoint_solids(): void {
  const a = closedRect('a', null, 0, 0, 10, 10)
  const b = closedRect('b', null, 50, 50, 10, 10)
  const { classified, result } = classifyImportShapes([a, b], 'solid-regions', 'dxf')
  assert(classified.length === 2, 'expected 2 shapes')
  assert(classified[0].operation === 'add', 'disjoint a: Add')
  assert(classified[1].operation === 'add', 'disjoint b: Add')
  assert(result.addCount === 2, '2 Adds')
  assert(result.subtractCount === 0, '0 Subtracts')
}

// ── 3-level alternating nesting ───────────────────────────────────────

function test_three_level_nesting(): void {
  const outer = closedRect('outer', null, 0, 0, 100, 100)
  const mid = closedRect('mid', null, 10, 10, 50, 50)
  const inner = closedRect('inner', null, 20, 20, 15, 15)
  const { classified, result } = classifyImportShapes([outer, mid, inner], 'solid-regions', 'dxf')
  assert(classified.length === 3, 'expected 3 shapes')
  assert(classified[0].operation === 'add', 'outer: Add (depth 0)')
  assert(classified[1].operation === 'subtract', 'mid: Subtract (depth 1)')
  assert(classified[2].operation === 'add', 'inner: Add (depth 2)')
  assert(result.addCount === 2, '2 Adds')
  assert(result.subtractCount === 1, '1 Subtract')
  // Source order: outer, mid, inner — parent-before-child preserves this
  assert(classified[0].name === 'outer', 'outer first')
  assert(classified[1].name === 'mid', 'mid second')
  assert(classified[2].name === 'inner', 'inner third')
}

// ── Smallest container ────────────────────────────────────────────────

function test_smallest_container_wins(): void {
  const large = closedRect('large', null, 0, 0, 100, 100)
  const small = closedRect('small', null, 10, 10, 30, 30)
  const tiny = closedRect('tiny', null, 15, 15, 5, 5)
  // tiny is inside both large and small; small is the tightest container
  const { classified } = classifyImportShapes([large, small, tiny], 'solid-regions', 'dxf')
  assert(classified.length === 3, 'expected 3')
  const tinyEntry = classified.find((c) => c.name === 'tiny')
  assert(tinyEntry?.operation === 'add', 'tiny inside small inside large → depth 2 → Add')
  const smallEntry = classified.find((c) => c.name === 'small')
  assert(smallEntry?.operation === 'subtract', 'small inside large → depth 1 → Subtract')
  const largeEntry = classified.find((c) => c.name === 'large')
  assert(largeEntry?.operation === 'add', 'large → depth 0 → Add')
}

// ── Cross-layer nesting ───────────────────────────────────────────────

function test_cross_layer_nesting(): void {
  const outer = closedRect('outer', 'layer-a', 0, 0, 100, 100)
  const inner = closedRect('inner', 'layer-b', 10, 10, 20, 20)
  const { classified } = classifyImportShapes([outer, inner], 'solid-regions', 'dxf')
  assert(classified.length === 2, 'expected 2 shapes')
  assert(classified[0].operation === 'add', 'cross-layer outer: Add')
  assert(classified[1].operation === 'subtract', 'cross-layer inner: Subtract')
}

// ── Touching contours — no parent, top-level Add ──────────────────────

function test_touching_no_parent(): void {
  // Two rects that share a border — touching but not strictly containing
  const a = closedRect('a', null, 0, 0, 10, 10)
  const b = closedRect('b', null, 10, 0, 10, 10)
  const { classified, result } = classifyImportShapes([a, b], 'solid-regions', 'dxf')
  assert(classified.length === 2, 'expected 2')
  for (const c of classified) {
    assert(c.operation === 'add', `touching ${c.name} should be Add`)
  }
  assert(result.addCount === 2, '2 Adds (touching = no nesting)')
}

// ── Intersecting contours — top-level Add ─────────────────────────────

function test_intersecting_no_parent(): void {
  // Two rects that intersect — not strictly containing
  const a = closedRect('a', null, 0, 0, 15, 15)
  const b = closedRect('b', null, 5, 5, 15, 15)
  const { classified } = classifyImportShapes([a, b], 'solid-regions', 'dxf')
  assert(classified.length === 2, 'expected 2')
  // Both should be Add (no strict containment)
  for (const c of classified) {
    assert(c.operation === 'add', `intersecting ${c.name} should be Add`)
  }
}

// ── Duplicate / equal contours — ambiguity ────────────────────────────

function test_duplicate_warns(): void {
  const a = closedRect('a', null, 0, 0, 10, 10)
  const b = closedRect('b', null, 0, 0, 10, 10)
  const { classified, result } = classifyImportShapes([a, b], 'solid-regions', 'dxf')
  assert(classified.length === 2, 'expected 2')
  assert(result.warnings.length >= 1, 'duplicate should produce warning')
  // Both at top level
  for (const c of classified) {
    assert(c.operation === 'add', 'duplicate should be Add')
  }
}

// ── Stable sibling order ──────────────────────────────────────────────

function test_stable_sibling_order(): void {
  const outer = closedRect('outer', null, 0, 0, 100, 100)
  const a = closedRect('a', null, 5, 5, 10, 10)
  const b = closedRect('b', null, 20, 5, 10, 10)
  const c = closedRect('c', null, 35, 5, 10, 10)
  const { classified } = classifyImportShapes([outer, a, b, c], 'solid-regions', 'dxf')
  // All siblings should be in source order
  const subtracts = classified.filter((x) => x.operation === 'subtract')
  assert(subtracts.length === 3, '3 subtracts')
  assert(subtracts[0].name === 'a', 'a first sibling')
  assert(subtracts[1].name === 'b', 'b second sibling')
  assert(subtracts[2].name === 'c', 'c third sibling')
}

// ── Summary counts ────────────────────────────────────────────────────

function test_summary_counts_mixed(): void {
  // closed-line (disjoint) and inner (strictly nested) should give: 2 Adds, 1 Subtract
  const shapes = [
    openLine('open1'),
    closedRect('closed-line', null, 150, 150, 10, 10),
    closedRect('outer', null, 0, 0, 100, 100),
    closedRect('inner', null, 10, 10, 20, 20),
  ]
  const { result } = classifyImportShapes(shapes, 'solid-regions', 'dxf')
  assert(result.totalImportable === 4, '4 importable')
  assert(result.openLineCount === 1, '1 open line')
  assert(result.closedLineCount === 0, '0 closed lines (solid-regions)')
  assert(result.addCount === 2, '2 Adds (outer + closed-line disjoint)')
  assert(result.subtractCount === 1, '1 Subtract (inner inside outer)')
}

// ── Paths mode with open+closed mix ───────────────────────────────────

function test_paths_mode_all_line(): void {
  const shapes = [openLine('o'), closedRect('c')]
  const { classified, result } = classifyImportShapes(shapes, 'paths', 'dxf')
  assert(result.openLineCount === 1, '1 open line')
  assert(result.closedLineCount === 1, '1 closed line (paths mode)')
  assert(result.addCount === 0, '0 adds')
  for (const c of classified) {
    assert(c.operation === 'line', `Paths: ${c.name} should be Line`)
  }
}

// ── Solid regions mode ────────────────────────────────────────────────

function test_solid_regions_mode(): void {
  const outer = closedRect('outer', null, 0, 0, 100, 100)
  const inner = closedRect('inner', null, 10, 10, 30, 30)
  const { classified } = classifyImportShapes([outer, inner], 'solid-regions', 'dxf')
  assert(classified[0].operation === 'add', 'solid-regions: outer Add')
  assert(classified[1].operation === 'subtract', 'solid-regions: inner Subtract')
}

// ── SVG solid-regions mode ignores paint ──────────────────────────────

function test_svg_solid_regions_ignores_paint(): void {
  const shapes = [svgClosedRect('stroke-only', false, true)]
  const { classified } = classifyImportShapes(shapes, 'solid-regions', 'svg')
  assert(classified[0].operation === 'add', 'explicit solid-regions mode overrides SVG paint')
}

// ── Warning content ────────────────────────────────────────────────────

function test_touching_produces_warning(): void {
  const a = closedRect('a', null, 0, 0, 10, 10)
  const b = closedRect('b', null, 10, 0, 10, 10)
  const { result } = classifyImportShapes([a, b], 'solid-regions', 'dxf')
  assert(result.warnings.length >= 1, 'touching should produce warning')
  assert(result.warnings.some((w) => w.includes('touch or intersect')), 'warning mentions touch/intersect')
  assert(result.warnings.some((w) => w.includes('"a"') && w.includes('"b"')), 'warning names both shapes')
}

function test_intersecting_produces_warning(): void {
  const a = closedRect('a', null, 0, 0, 15, 15)
  const b = closedRect('b', null, 5, 5, 15, 15)
  const { result } = classifyImportShapes([a, b], 'solid-regions', 'dxf')
  assert(result.warnings.length >= 1, 'intersecting should produce warning')
  assert(result.warnings.some((w) => w.includes('touch or intersect')), 'warning mentions intersect')
}

function test_exact_duplicate_warning_content(): void {
  const a = closedRect('a', null, 0, 0, 10, 10)
  const b = closedRect('b', null, 0, 0, 10, 10)
  const { result } = classifyImportShapes([a, b], 'solid-regions', 'dxf')
  assert(result.warnings.length >= 1, 'duplicates should produce warning')
  assert(result.warnings.some((w) => w.includes('identical')), 'warning mentions identical')
  assert(result.warnings.some((w) => w.includes('"a"') && w.includes('"b"')), 'warning names both duplicates')
}

// ── Ambiguous inside larger still top-level ────────────────────────────

function test_ambiguous_inside_larger_is_add(): void {
  // a and b touch each other; both are inside large outer.
  // a and b should both be Add (ambiguous), not nested as Subtract inside outer.
  const large = closedRect('large', null, 0, 0, 100, 100)
  const a = closedRect('a', null, 5, 5, 10, 10)
  const b = closedRect('b', null, 5, 15, 10, 10)
  const { classified, result } = classifyImportShapes([large, a, b], 'solid-regions', 'dxf')
  assert(result.warnings.length >= 1, 'should warn about touching a and b')
  // a and b are ambiguous (touching) → top-level Add
  const aEntry = classified.find((c) => c.name === 'a')
  const bEntry = classified.find((c) => c.name === 'b')
  assert(aEntry?.operation === 'add', 'ambiguous a stays Add even inside large')
  assert(bEntry?.operation === 'add', 'ambiguous b stays Add even inside large')
  // large is still Add
  const largeEntry = classified.find((c) => c.name === 'large')
  assert(largeEntry?.operation === 'add', 'large is Add')
}

// ── Child before parent source order ────────────────────────────────────

function test_child_before_parent_in_source(): void {
  // Child appears in source BEFORE its parent.
  // Output order must still be parent then child.
  const inner = closedRect('inner', null, 10, 10, 20, 20)
  const outer = closedRect('outer', null, 0, 0, 100, 100)
  const { classified } = classifyImportShapes([inner, outer], 'solid-regions', 'dxf')
  assert(classified.length === 2, 'expected 2 shapes')
  assert(classified[0].name === 'outer', 'outer (parent) first in output despite being second in source')
  assert(classified[0].operation === 'add', 'outer is Add')
  assert(classified[1].name === 'inner', 'inner (child) second')
  assert(classified[1].operation === 'subtract', 'inner is Subtract')
  assert(classified[0].sourceIndex === 1, 'outer sourceIndex is 1 (second in source)')
  assert(classified[1].sourceIndex === 0, 'inner sourceIndex is 0 (first in source)')
}

// ── Self-invalid profile ────────────────────────────────────────────────

function test_self_invalid_is_add(): void {
  // A self-intersecting (bow-tie) polygon — Clipper detects invalid.
  const bowtie: ImportedShape = {
    name: 'bowtie',
    sourceType: 'dxf',
    layerName: null,
    profile: polygonProfile([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    ]),
  }
  const outer = closedRect('outer', null, -5, -5, 25, 25)
  const { classified, result } = classifyImportShapes([bowtie, outer], 'solid-regions', 'dxf')
  assert(result.warnings.length >= 1, 'self-invalid should produce warning')
  assert(result.warnings.some((w) => w.includes('self-intersecting')), 'warning mentions self-intersecting')
  const bt = classified.find((c) => c.name === 'bowtie')
  assert(bt?.operation === 'add', 'self-invalid bowtie is top-level Add')
}

// ── Concave container ───────────────────────────────────────────────────

function test_concave_container(): void {
  // A U-shaped concave outer polygon (cavity opens upward).
  // Inner rect is placed in the main body below the cavity — strictly inside.
  // The edge-intersection check must not falsely flag this as touching.
  const uShape: ImportedShape = {
    name: 'ushape',
    sourceType: 'dxf',
    layerName: null,
    profile: polygonProfile([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 80, y: 100 },
      { x: 80, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: 100 },
      { x: 0, y: 100 },
    ]),
  }
  const inner = closedRect('inner', null, 10, 5, 20, 10)
  const { classified, result } = classifyImportShapes([uShape, inner], 'solid-regions', 'dxf')
  assert(result.warnings.length === 0, 'no warnings for strictly nested concave')
  assert(classified.length === 2, 'expected 2 shapes')
  const uEntry = classified.find((c) => c.name === 'ushape')
  const iEntry = classified.find((c) => c.name === 'inner')
  assert(uEntry?.operation === 'add', 'u-shape is Add')
  assert(iEntry?.operation === 'subtract', 'inner inside u-shape main body is Subtract')
}

// ── Regression: name lookup with non-solid shapes before solids ──────────

function test_name_lookup_with_non_solid_shapes(): void {
  // An open line (non-solid) before two duplicate solid candidates.
  // The warning must name the correct shapes, never undefined.
  const open = openLine('open-line')
  const a = closedRect('duplicate-a', null, 0, 0, 10, 10)
  const b = closedRect('duplicate-b', null, 0, 0, 10, 10)
  const { result } = classifyImportShapes([open, a, b], 'solid-regions', 'dxf')
  assert(result.warnings.length >= 1, 'should warn about duplicates')
  const hasDupWarning = result.warnings.some(
    (w) => w.includes('"duplicate-a"') && w.includes('"duplicate-b"'),
  )
  assert(hasDupWarning, 'warning names correct shapes')
  assert(
    !result.warnings.some((w) => w.includes('undefined')),
    'warning must not contain "undefined"',
  )
}

// ── Regression: touching chain A→B→C all top-level Add ──────────────────

function test_touching_chain_all_add(): void {
  // A touches B (shared edge), B touches C (shared edge).
  // Previously B→C was skipped because B was already ambiguous from
  // A→B, leaving C eligible for nesting. All three must be Add.
  const a = closedRect('a', null, 0, 0, 10, 10)
  const b = closedRect('b', null, 10, 0, 10, 10)
  const c = closedRect('c', null, 20, 0, 10, 10)
  const { classified, result } = classifyImportShapes([a, b, c], 'solid-regions', 'dxf')
  assert(classified.length === 3, 'expected 3 shapes')
  for (const entry of classified) {
    assert(entry.operation === 'add', `${entry.name} should be Add (touching chain)`)
  }
  assert(result.addCount === 3, '3 Adds')
  assert(result.warnings.length >= 1, 'should warn about edge contact')
  const edgeWarning = result.warnings.find((w) => w.includes('touch or intersect'))
  assert(edgeWarning !== undefined, 'should have edge contact warning')
  assert(edgeWarning!.includes('"a"'), 'warning names a')
  assert(edgeWarning!.includes('"b"'), 'warning names b')
  assert(edgeWarning!.includes('"c"'), 'warning names c')
}

// ── Manual closed-feature default inference ───────────────────────────

function test_manual_nested_operation_inference(): void {
  const existing = [
    { profile: rectProfile(0, 0, 100, 100), operation: 'add' as const },
    { profile: rectProfile(20, 20, 60, 60), operation: 'subtract' as const },
  ]
  assert(
    inferNestedSolidOperation(rectProfile(200, 200, 10, 10), existing) === 'add',
    'outside all solids defaults Add',
  )
  assert(
    inferNestedSolidOperation(rectProfile(5, 5, 10, 10), existing) === 'subtract',
    'inside Add defaults Subtract',
  )
  assert(
    inferNestedSolidOperation(rectProfile(30, 30, 10, 10), existing) === 'add',
    'smallest Subtract container defaults Add',
  )
}

function test_manual_ambiguous_contact_stays_add(): void {
  const outer = { profile: rectProfile(0, 0, 100, 100), operation: 'add' as const }
  assert(
    inferNestedSolidOperation(rectProfile(0, 20, 10, 10), [outer]) === 'add',
    'boundary-touching contour has no strict parent',
  )
  assert(
    inferNestedSolidOperation(rectProfile(0, 0, 100, 100), [outer]) === 'add',
    'duplicate contour has no strict parent',
  )
}

// ── run ───────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

const tests: Array<{ name: string; fn: () => void }> = [
  { name: 'Paths: closed → Line', fn: test_paths_closed_to_line },
  { name: 'DXF Auto: nests solids', fn: test_dxf_auto_nests_solids },
  { name: 'SVG Auto: stroke-only → Line', fn: test_svg_auto_stroke_only_line },
  { name: 'SVG Auto: filled → solid', fn: test_svg_auto_filled_solid },
  { name: 'SVG Auto: fill+stroke → solid', fn: test_svg_auto_fill_and_stroke_solid },
  { name: 'open always Line (all modes)', fn: test_open_always_line },
  { name: 'open ignored in solid mode', fn: test_open_ignored_in_solid_mode },
  { name: 'disjoint solids (top-level Add)', fn: test_disjoint_solids },
  { name: '3-level alternating nesting', fn: test_three_level_nesting },
  { name: 'smallest container wins', fn: test_smallest_container_wins },
  { name: 'cross-layer nesting', fn: test_cross_layer_nesting },
  { name: 'touching: no parent', fn: test_touching_no_parent },
  { name: 'intersecting: no parent', fn: test_intersecting_no_parent },
  { name: 'duplicate: warns', fn: test_duplicate_warns },
  { name: 'stable sibling order', fn: test_stable_sibling_order },
  { name: 'summary counts (mixed)', fn: test_summary_counts_mixed },
  { name: 'Paths mode: all Line', fn: test_paths_mode_all_line },
  { name: 'Solid regions mode', fn: test_solid_regions_mode },
  { name: 'SVG solid-regions ignores paint', fn: test_svg_solid_regions_ignores_paint },
  { name: 'touching produces warning', fn: test_touching_produces_warning },
  { name: 'intersecting produces warning', fn: test_intersecting_produces_warning },
  { name: 'exact duplicate warning content', fn: test_exact_duplicate_warning_content },
  { name: 'ambiguous inside larger is Add', fn: test_ambiguous_inside_larger_is_add },
  { name: 'child before parent in source', fn: test_child_before_parent_in_source },
  { name: 'self-invalid is Add', fn: test_self_invalid_is_add },
  { name: 'concave container', fn: test_concave_container },
  { name: 'name lookup with non-solid shapes before solids', fn: test_name_lookup_with_non_solid_shapes },
  { name: 'touching chain all Add', fn: test_touching_chain_all_add },
  { name: 'manual nested operation inference', fn: test_manual_nested_operation_inference },
  { name: 'manual ambiguous contact stays Add', fn: test_manual_ambiguous_contact_stays_add },
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

console.log(`\nClassifier: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
