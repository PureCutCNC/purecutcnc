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
 * The square rough must not start every pass at the blank's corner (#1016
 * C2-F2, Frank's UI test: "the rect rounding does lots of air cutting
 * initially").
 *
 * The old rough set `previousRadius = barMaxRadius` at every angle and emitted
 * the first layers there. On a square that is above the blank on all but the
 * corner passes, so the first cut at a flat was `corner - stepdown` and bit
 * nothing. The fix gives each pass its own `S`, the largest square material
 * radius its cutter footprint can touch, and emits a layer only when
 * `layerRadius < S`. The independent reference here is `barSurfaceRadius` and
 * the analytic box, never the helper the generator calls.
 *
 * Mutations that must fail:
 * - `S` taken at the pass angle only (no footprint): the skipped-layer
 *   assertion fires — a layer is dropped while material within the footprint
 *   still reaches it — and the 40° witness loses its corner cut.
 * - `S = barMaxRadius` everywhere (the old code): the disc-intersection
 *   assertion fails on the flat passes, where a layer is wholly in air.
 * - a footprint delta too small: the helper's window assertion fails, and the
 *   40° witness loses the cut because the corner is outside the window.
 *
 * Run with: npx tsx src/engine/toolpaths/squareRotaryRoughAir.test.ts
 */

import assert from 'node:assert/strict'
import {
  barCentre,
  barInscribedRadius,
  barMaxRadius,
  barPivotZ,
  barSurfaceRadius,
  isSquareStock,
  squareStock,
} from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock, RoundStock } from '../../types/project'
import { generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove } from './types'

const BALL: NormalizedTool = {
  id: 'ball', name: '2 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 2, radius: 1, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}
const FLAT: NormalizedTool = { ...BALL, id: 'flat', name: '2 mm flat end mill', type: 'flat_endmill' }

function approx(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected}`)
}

/** An open coaxial cylinder, placed along whichever axis the blank uses. */
function cylinderMesh(
  stock: BarStock,
  radius: number,
  alongStart: number,
  alongEnd: number,
  segments = 96,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [alongStart, alongEnd]) {
    for (let i = 0; i < segments; i++) {
      const t = 2 * Math.PI * i / segments
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** One program angle reduced into `[0, 360)`, to a stable key. */
function baseAngle(a: number): number {
  return Math.round((((a % 360) + 360) % 360) * 1e6) / 1e6
}

function radius(move: ToolpathMove, pivot: number): number {
  return move.to.z - pivot
}

/** A cutting move that is not one of the travel-height links. */
function usableCut(move: ToolpathMove, pivot: number, maxRadius: number): boolean {
  return move.kind === 'cut' && radius(move, pivot) <= maxRadius + 1e-9
}

/**
 * The independent touch-radius reference: the largest square surface radius in
 * the cutter's angular footprint, computed with `barSurfaceRadius` and the
 * analytic corner list, not with the helper under test.
 */
function referenceTouchRadius(stock: BarStock, angleDeg: number, layerRadius: number, toolRadius: number): number {
  if (!isSquareStock(stock)) return barInscribedRadius(stock)
  const reach = Math.abs(toolRadius)
  const delta = layerRadius <= reach ? Math.PI / 2 : Math.asin(reach / layerRadius)
  const start = angleDeg - (delta * 180) / Math.PI
  const end = angleDeg + (delta * 180) / Math.PI
  let best = Math.max(barSurfaceRadius(stock, start), barSurfaceRadius(stock, end))
  const first = Math.ceil((start - 45) / 90)
  const last = Math.floor((end - 45) / 90)
  if (last >= first) best = Math.max(best, barMaxRadius(stock))
  return best
}

// ── 1. The helper's bound, including the round short circuit ───────────
{
  const blank = squareStock(20, 60, 'x')
  const round: RoundStock = roundStock(20, 60, 'x')
  // On a flat the window leans towards the nearest corner: half the side at
  // the ray, `halfSide / cos(delta)` at the window edge.
  const flat = squareRotaryTouchRadius(blank, 0, 10, 2)
  approx(flat, 10 / Math.cos(Math.asin(2 / 10)), 'flat touch radius is the window edge', 1e-12)
  assert.ok(flat > barSurfaceRadius(blank, 0), 'the footprint reaches past the ray')
  // The 45° layer is material out to the corner.
  approx(squareRotaryTouchRadius(blank, 45, 10, 2), barMaxRadius(blank), 'a corner in the window is the corner radius', 1e-12)
  // The witness used by the generated-path test below: the pass ray is below
  // the layer, but the corner is inside the footprint.
  const witnessAngle = 40
  const witnessRadius = 13.3
  const witness = squareRotaryTouchRadius(blank, witnessAngle, witnessRadius, 2)
  assert.ok(barSurfaceRadius(blank, witnessAngle) < witnessRadius, 'the pass ray itself is above the material')
  assert.ok(witness > witnessRadius, 'the footprint still reaches the corner')
  assert.ok(witness > barSurfaceRadius(blank, witnessAngle), 'the bound is not the ray radius')
  // Round bars get exactly the old constant radius, so the layer gate is the
  // old one.
  approx(squareRotaryTouchRadius(round, 0, 5, 2), 10, 'round radius at a flat', 1e-12)
  approx(squareRotaryTouchRadius(round, 37, 5, 2), 10, 'round radius away from a flat', 1e-12)
  assert.throws(() => squareRotaryTouchRadius(blank, Number.NaN, 10, 2), RangeError, 'a non-finite angle is refused')
  console.log('square air: the touch radius is the footprint window over the square surface')
}

// ── 2/3. Every cut touches the blank; the first cut is one stepdown ────
//
// Side 12 and 25, flat and ball, both bar axes, mm and inch. The physical
// reference is the analytic box: a cut move at tip radius R and program angle
// a is wholly in air when the disc of radius rt around (R cos a, R sin a) does
// not intersect [-h, h]². The first-cut assertion compares the shallowest cut
// at every pass with `barSurfaceRadius` at that pass, so a deeper first bite
// fails it.
{
  const SIDES = [12, 25] as const
  const SCALES = [['mm', 1], ['inch', 0.03937007874015748]] as const
  let cases = 0
  let checked = 0
  let worstDisc = -Infinity
  let worstDepth = -Infinity
  let materialCuts = 0
  for (const side of SIDES) {
    for (const [units, scale] of SCALES) {
      for (const axis of ['x', 'y'] as const) {
        for (const tool of [FLAT, BALL]) {
          const scaledTool: NormalizedTool = { ...tool, units, radius: tool.radius * scale, diameter: tool.diameter * scale }
          const blank = squareStock(side * scale, 2.5 * side * scale, axis)
          const pivot = barPivotZ(blank)
          const maxRadius = barMaxRadius(blank)
          const halfSide = barInscribedRadius(blank)
          const alongStart = 0.5 * side * scale
          const alongEnd = 1.5 * side * scale
          const params = {
            stepover: 0.8 * scale, stepdown: 1 * scale, sampleSpacing: 1 * scale, stockToLeave: 0,
            alongStart, alongEnd, safeRadius: 0.5 * side * scale, requestedCellSize: 0.2 * scale,
          }
          const mesh = cylinderMesh(blank, 0.25 * side * scale, alongStart, alongEnd)
          const result = generateRotaryRough(`air-${side}-${units}-${axis}-${tool.type}`, mesh, blank, scaledTool, params, {})
          assert.ok(result.moves.length > 0, `${side}/${units}/${axis}/${tool.type} generates motion`)
          const shallowest = new Map<number, number>()
          for (const move of result.moves) {
            if (move.kind !== 'cut') continue
            for (const point of [move.from, move.to]) {
              if (point.a === undefined) continue
              const r = point.z - pivot
              if (r > maxRadius + 1e-9) continue
              checked++
              const theta = point.a * Math.PI / 180
              const x = r * Math.cos(theta)
              const y = r * Math.sin(theta)
              const distance = Math.hypot(Math.max(Math.abs(x) - halfSide, 0), Math.max(Math.abs(y) - halfSide, 0))
              worstDisc = Math.max(worstDisc, distance - scaledTool.radius)
              assert.ok(distance <= scaledTool.radius + 1e-9,
                `${side}/${units}/${axis}/${tool.type}: cut at ${point.a}° r=${r} is wholly outside the blank `
                + `(disc distance ${distance.toFixed(6)} > ${scaledTool.radius})`)
              // Only cuts below the blank's own surface count as the first
              // bite; the shoulder-refined ends start on that surface.
              if (r < barSurfaceRadius(blank, point.a) - 1e-9) {
                shallowest.set(baseAngle(point.a), Math.max(shallowest.get(baseAngle(point.a)) ?? -Infinity, r))
              }
            }
          }
          assert.ok(shallowest.size > 0, `${side}/${units}/${axis}/${tool.type} cuts`)
          for (const [base, first] of shallowest) {
            const depth = barSurfaceRadius(blank, base) - first
            worstDepth = Math.max(worstDepth, depth)
            if (depth > 1e-6) materialCuts++
            assert.ok(depth <= params.stepdown + 1e-6,
              `${side}/${units}/${axis}/${tool.type}: the first cut at ${base}° bites ${depth.toFixed(6)} > one stepdown`)
          }
          cases++
        }
      }
    }
  }
  assert.ok(checked > 0, 'the disc assertion walks real cuts')
  assert.ok(materialCuts > 0, 'some first cuts remove material')
  assert.ok(worstDisc <= 1e-9, `no cut is wholly in air (worst disc margin ${worstDisc.toExponential(2)})`)
  assert.ok(worstDepth <= 1 + 1e-6, `the first cut is never deeper than one stepdown (worst ${worstDepth.toFixed(6)})`)
  console.log(`square air: ${cases} fixtures, ${checked} endpoints checked, worst disc margin ${worstDisc.toExponential(2)}, `
    + `worst first cut ${worstDepth.toFixed(6)} <= 1`)
}

// ── 4. Skipping a layer removes nothing, so the final material is the old one
//
// The generator emits the present layers from the first material layer to the
// final `lowest` layer; the skipped prefix is re-derived here against
// `barSurfaceRadius`. A skipped layer at radius R must have no material at or
// above R in its window (`R >= S`), so the old cut there was wholly air and
// removing it cannot change what is left. The final layer is present at every
// pass, which is the old algorithm's final per-angle depth.
{
  let skippedLayers = 0
  let finalLayers = 0
  for (const side of [12, 25] as const) {
    for (const tool of [FLAT, BALL]) {
      const blank = squareStock(side, 2.5 * side, 'x')
      const pivot = barPivotZ(blank)
      const maxRadius = barMaxRadius(blank)
      const alongStart = 0.5 * side
      const alongEnd = 1.5 * side
      const params = {
        stepover: 0.8, stepdown: 1, sampleSpacing: 1, stockToLeave: 0,
        alongStart, alongEnd, safeRadius: 0.5 * side, requestedCellSize: 0.2,
      }
      const mesh = cylinderMesh(blank, 0.25 * side, alongStart, alongEnd)
      const result = generateRotaryRough(`material-${side}-${tool.type}`, mesh, blank, tool, params, {})
      const usable = result.moves.filter((move) => usableCut(move, pivot, maxRadius))
      assert.ok(usable.length > 0, `${side}/${tool.type} cuts`)
      const lowest = Math.min(...usable.map((move) => radius(move, pivot)))
      const layers = Math.ceil((maxRadius - lowest) / params.stepdown)
      const present = new Map<number, Set<number>>()
      for (const move of result.moves) {
        if (move.kind === 'rapid' || move.to.a === undefined) continue
        const index = Math.floor(move.to.a / 360)
        if (index < 0 || index >= layers) continue
        const set = present.get(baseAngle(move.to.a - index * 360)) ?? new Set<number>()
        set.add(index)
        present.set(baseAngle(move.to.a - index * 360), set)
      }
      assert.equal(present.size, Math.ceil(2 * Math.PI * maxRadius / params.stepover), 'every pass is represented')
      for (const [base, set] of present) {
        const indexes = [...set].sort((a, b) => a - b)
        const first = indexes[0]
        for (let i = 1; i < indexes.length; i++) {
          assert.equal(indexes[i], indexes[i - 1] + 1, `${side}/${tool.type}: emitted layers are a contiguous suffix at ${base}°`)
        }
        assert.equal(indexes[indexes.length - 1], layers - 1, `${side}/${tool.type}: the final layer is cut at ${base}°`)
        finalLayers++
        for (let layer = 0; layer < first; layer++) {
          const layerRadius = Math.max(lowest, maxRadius - (layer + 1) * params.stepdown)
          const touch = referenceTouchRadius(blank, base, layerRadius, tool.radius)
          assert.ok(layerRadius >= touch - 1e-9,
            `${side}/${tool.type}: skipped layer ${layer} at ${base}° (r ${layerRadius.toFixed(6)}) is still inside `
            + `material out to ${touch.toFixed(6)}`)
          skippedLayers++
        }
      }
    }
  }
  assert.ok(skippedLayers > 0, 'the side-12 and side-25 fixtures actually skip air layers')
  assert.ok(finalLayers > 0, 'the final layer is present at every pass')
  console.log(`square air: ${skippedLayers} air layers skipped across ${finalLayers} passes; every final layer remains`)
}

// ── 5. The side-12 fixture loses moves, with a measured margin ─────────
//
// Before the fix this fixture (12 × 30 blank, r3 target band 8..22, r1 flat,
// stepover 0.8, stepdown 1) generated 2,231 moves, 1,397 of them `cut`. The
// baseline is pinned here so a regression that puts the air layers back fails
// loudly; the margin is the smaller of the two measured reductions.
{
  const blank = squareStock(12, 30, 'x')
  const mesh = cylinderMesh(blank, 3, 8, 22)
  const result = generateRotaryRough('count', mesh, blank, FLAT, {
    stepover: 0.8, stepdown: 1, sampleSpacing: 1, stockToLeave: 0,
    alongStart: 8, alongEnd: 22, safeRadius: 6, requestedCellSize: 0.2,
  }, {})
  const cuts = result.moves.filter((move) => move.kind === 'cut').length
  assert.ok(result.moves.length <= 2231 - 200,
    `the side-12 rough drops at least 200 moves (${result.moves.length} <= 2031)`)
  assert.ok(cuts <= 1397 - 90, `the side-12 rough drops at least 90 cut moves (${cuts} <= 1307)`)
  console.log(`square air: side-12 fixture ${result.moves.length} moves / ${cuts} cuts, old 2231 / 1397`)
}

// ── 6. A cut that only the footprint reaches is not skipped ────────────
//
// Nine passes put one at 40°. At that pass the blank surface is 13.054, but
// the 2 mm cutter's footprint reaches the 45° corner (14.142), so the first
// layer at 13.3 is material and must be cut. Taking S at the ray only, or a
// delta narrower than the footprint, would skip it.
{
  const blank = squareStock(20, 60, 'x')
  const maxRadius = barMaxRadius(blank)
  const witnessRadius = 13.3
  const stepdown = maxRadius - witnessRadius
  const passes = 9
  const mesh = cylinderMesh(blank, 6, 18, 42)
  const result = generateRotaryRough('witness', mesh, blank, FLAT, {
    stepover: (2 * Math.PI * maxRadius) / (passes - 0.5), stepdown, sampleSpacing: 1, stockToLeave: 0,
    alongStart: 18, alongEnd: 42, safeRadius: 5, requestedCellSize: 0.2,
  }, {})
  const atWitness = result.moves.filter((move) => move.kind === 'cut'
    && Math.abs(baseAngle(move.to.a ?? 0) - 40) < 1e-6
    && radius(move, barPivotZ(blank)) > witnessRadius - 1e-6
    && radius(move, barPivotZ(blank)) <= maxRadius + 1e-9)
  assert.ok(atWitness.length > 0,
    'the 40° pass cuts its corner layer even though the pass ray is above it')
  assert.ok(atWitness.some((move) => Math.abs(radius(move, barPivotZ(blank)) - witnessRadius) <= 1e-6),
    'the corner layer cuts at exactly 13.3 where the model is below it')
  console.log(`square air: 40° witness kept ${atWitness.length} corner-layer moves at r=${witnessRadius}`)
}

console.log('engine/toolpaths/squareRotaryRoughAir.test.ts: all assertions passed')
