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
 * initially"; corrected by C2-F2b for the flat footprint, and made exact for a
 * ball by C2-F2c).
 *
 * The old rough set `previousRadius = barMaxRadius` at every angle and emitted
 * the first layers there. On a square that is above the blank on all but the
 * corner passes, so the first cut at a flat was `corner - stepdown` and bit
 * nothing. C2-F2 gave each pass its own `S` and emitted a layer only when
 * `layerRadius < S`, but took `S` as the largest *radial* distance `r(phi)`
 * over an angular window. That is the wrong geometry: the cutter is a cylinder
 * whose axis is the pass ray, so at a fixed pass angle it occupies a slab
 * `|x| <= rt` across the ray, and what matters is the blank's extent **along
 * the cutter axis** inside that slab, not the radial distance. The old bound
 * overestimated and still emitted layers above the blank: 20 mm square, `A0`,
 * 4 mm flat, 0.1 mm stepdown emitted full passes at `Z = 20.1421` and
 * `20.0421` above the `Z = 20` face — pure air.
 *
 * A flat end mill's `S` is the blank's largest height `Y` inside the slab
 * (C2-F2b). A ball end mill is not a cylinder: its centre is at `tip + rt`, so
 * a blank point `(X, Y)` in the slab is cut iff
 * `Y >= tip + rt - sqrt(rt^2 - X^2)`, and the exact bound is
 * `S_ball = max(Y - rt + sqrt(rt^2 - X^2))` over the square inside the slab
 * (C2-F2c). Codex's reproduction is what this pins: 20 mm square, 4 mm ball,
 * A30, where the cylinder bound started at `Z = 22.642136` while the ball first
 * meets the blank at `Z = 21.856406`.
 *
 * This test's reference is the cutter's own contact model, computed from the
 * frozen rotary frame and the analytic square, never the helper the generator
 * calls: a flat cut at tip radius `R` touches the blank iff the slab
 * `|X| <= rt` above the tip intersects the rotated square cross-section; a ball
 * cut touches iff the ball's disc (centre `tip + rt`) or the shank slab above
 * it meets the blank. The ball bound is also checked against an independent
 * numerical maximisation of the rotated boundary, which contains no closed-form
 * tangency.
 *
 * Mutations that must fail:
 * - the old C2-F2 radial `r(phi)` bound over an angular window: the generated
 *   path cut above the `Z = 20` face (Codex's case) and the slab bound
 *   assertion fail.
 * - a slab half-width of zero: `S` collapses to the ray radius, which is below
 *   the slab maximum at an off-flat angle, so a material layer is skipped (the
 *   skipped-layer and first-cut assertions fail).
 * - vertices only, without the edge crossings at `x = ±rt`: at 30° no rotated
 *   vertex is inside a 2 mm slab, so the helper returns no maximum at all (the
 *   helper contract and the first-cut assertions fail).
 * - a ball using the flat cylinder bound (the old C2-F2b code): it emits air
 *   layers above the ball's contact at A30 (Codex's ball case and the
 *   disc+shank skip check fail).
 * - dropping the ball's interior tangency candidate
 *   (`X* = m rt / sqrt(1 + m^2)`) and using vertices/crossings only: the 30°
 *   maximum is interior to the top edge, so the helper disagrees with the
 *   ball reference and skips material.
 * - flipping the sign of `X*`: the candidate lands on the wrong side of the
 *   edge and returns the crossing value instead of the maximum, so the same
 *   two checks fail.
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
import { toolSpacePoint } from '../rotaryFrame'
import { generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool } from './types'

const BALL: NormalizedTool = {
  id: 'ball', name: '2 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 2, radius: 1, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}
const FLAT: NormalizedTool = { ...BALL, id: 'flat', name: '2 mm flat end mill', type: 'flat_endmill' }
/** Codex's cutter: the 4 mm flat of the reproduced air-cut case. */
const FLAT_4MM: NormalizedTool = { ...FLAT, id: 'flat-4', name: '4 mm flat end mill', diameter: 4, radius: 2 }
/** The same 4 mm cutter as a ball: the second half of the reproduction (C2-F2c). */
const BALL_4MM: NormalizedTool = { ...BALL, id: 'ball-4', name: '4 mm ball nose', diameter: 4, radius: 2 }

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

/**
 * An **asymmetric** closed prism inside the blank: offset across the bar, a
 * bottom and a top that are not equidistant from the pivot, and a top face that
 * slopes along the bar. The reference must hold for a real off-centre model,
 * not only for a coaxial cylinder.
 */
function prismMesh(stock: BarStock): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const side = stock.thickness
  const along0 = 0.60 * side
  const along1 = 1.40 * side
  const across0 = -0.30 * side
  const across1 = 0.10 * side
  const bottom = -0.35 * side
  const topLow = -0.05 * side
  const topHigh = 0.20 * side
  const raw = [
    along0, across0, bottom, along1, across0, bottom, along1, across1, bottom, along0, across1, bottom,
    along0, across0, topLow, along1, across0, topHigh, along1, across1, topHigh, along0, across1, topLow,
  ]
  const positions = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 3) {
    const along = raw[i]
    const across = centre + raw[i + 1]
    const up = pivot + raw[i + 2]
    if (stock.axis === 'x') {
      positions[i] = along
      positions[i + 1] = across
    } else {
      positions[i] = across
      positions[i + 1] = along
    }
    positions[i + 2] = up
  }
  const index = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  return { positions, index }
}

/** One program angle reduced into `[0, 360)`, to a stable key. */
function baseAngle(a: number): number {
  return Math.round((((a % 360) + 360) % 360) * 1e6) / 1e6
}

function radius(point: { z: number }, pivot: number): number {
  return point.z - pivot
}

/** A cut point at a layer radius, not one of the travel-height links. */
function usableCut(point: { z: number }, pivot: number, maxRadius: number): boolean {
  return radius(point, pivot) <= maxRadius + 1e-9
}

/** A stock point of the blank's cross-section, in the tool's own frame. */
function toToolFrame(stock: BarStock, across: number, up: number, angleDeg: number): { x: number; y: number } {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const stockPoint = stock.axis === 'x'
    ? { x: 0, y: centre + across, z: pivot + up }
    : { x: centre + across, y: 0, z: pivot + up }
  const tool = toolSpacePoint(stockPoint, angleDeg, stock)
  return stock.axis === 'x'
    ? { x: tool.y - centre, y: tool.z - pivot }
    : { x: tool.x - centre, y: tool.z - pivot }
}

/**
 * The independent vertical-contact reference: the largest tool-space `y` of
 * the square cross-section inside the cutter's `|x| <= rt` slab. It uses the
 * frozen `toolSpacePoint` rotation and the analytic square corners, never the
 * helper under test, and enumerates the convex intersection exactly (vertices
 * inside the slab plus edge crossings of `x = ±rt`).
 */
function referenceTouchHeight(stock: BarStock, angleDeg: number, toolRadius: number): number {
  if (!isSquareStock(stock)) return barInscribedRadius(stock)
  const halfSide = barInscribedRadius(stock)
  const corners: ReadonlyArray<readonly [number, number]> = [
    [-halfSide, -halfSide], [halfSide, -halfSide], [halfSide, halfSide], [-halfSide, halfSide],
  ]
  const rotated = corners.map(([across, up]) => toToolFrame(stock, across, up, angleDeg))
  const reach = Math.abs(toolRadius)
  const tolerance = 1e-12 * Math.max(1, reach, halfSide)
  let best = Number.NEGATIVE_INFINITY
  for (const point of rotated) {
    if (Math.abs(point.x) <= reach + tolerance) best = Math.max(best, point.y)
  }
  for (let i = 0; i < rotated.length; i++) {
    const from = rotated[i]
    const to = rotated[(i + 1) % rotated.length]
    const dx = to.x - from.x
    if (dx === 0) continue
    for (const boundary of [-reach, reach]) {
      const t = (boundary - from.x) / dx
      if (t < -tolerance || t > 1 + tolerance) continue
      const clamped = Math.min(1, Math.max(0, t))
      best = Math.max(best, from.y + clamped * (to.y - from.y))
    }
  }
  return best
}

/**
 * The independent **ball** contact reference (C2-F2c). The cutter with its tip
 * at `(0, t)` is the solid ball `x^2 + (y - (t + rt))^2 <= rt^2` plus the shank
 * slab `|x| <= rt, y >= t + rt`; it touches a blank point `(x, y)` exactly when
 * `t <= g(x, y) = y - rt + sqrt(rt^2 - x^2)`. `g` is concave and its `y`
 * derivative is 1, so it has no stationary point inside the square; the maximum
 * over the square inside the slab is therefore on the boundary. This clips each
 * rotated edge to the slab and maximises the concave `g` on it by ternary
 * search, with no closed-form tangency in it, so a dropped or sign-flipped
 * candidate in the helper is visible here.
 */
function referenceBallTouchHeight(
  stock: BarStock,
  angleDeg: number,
  toolRadius: number,
): number {
  if (!isSquareStock(stock)) return barInscribedRadius(stock)
  const halfSide = barInscribedRadius(stock)
  if (!(halfSide > 0)) return 0
  const reach = Math.abs(toolRadius)
  const corners: ReadonlyArray<readonly [number, number]> = [
    [-halfSide, -halfSide], [halfSide, -halfSide], [halfSide, halfSide], [-halfSide, halfSide],
  ]
  const rotated = corners.map(([across, up]) => toToolFrame(stock, across, up, angleDeg))
  const at = (from: { x: number; y: number }, to: { x: number; y: number }, t: number): number => {
    const x = from.x + t * (to.x - from.x)
    const y = from.y + t * (to.y - from.y)
    return y - reach + Math.sqrt(Math.max(0, reach * reach - x * x))
  }
  let best = Number.NEGATIVE_INFINITY
  for (let i = 0; i < rotated.length; i++) {
    const from = rotated[i]
    const to = rotated[(i + 1) % rotated.length]
    const dx = to.x - from.x
    let lo = 0
    let hi = 1
    if (dx === 0) {
      // A vertical edge: either wholly inside the slab or wholly outside it.
      if (Math.abs(from.x) > reach) continue
    } else {
      const a = (-reach - from.x) / dx
      const b = (reach - from.x) / dx
      lo = Math.max(lo, Math.min(a, b))
      hi = Math.min(hi, Math.max(a, b))
      if (lo > hi) continue
    }
    // Concave on the clipped edge, so a ternary search finds its maximum.
    best = Math.max(best, at(from, to, lo), at(from, to, hi))
    let a = lo
    let b = hi
    for (let k = 0; k < 120; k++) {
      const third = (b - a) / 3
      const left = a + third
      const right = b - third
      if (at(from, to, left) < at(from, to, right)) a = left
      else b = right
    }
    best = Math.max(best, at(from, to, (a + b) / 2))
  }
  return best
}

/**
 * The exact contact height for one tool shape at one program angle. The ball
 * reference is numerical, so it is cached per angle and radius instead of
 * being rebuilt for every cut endpoint.
 */
function contactHeight(
  stock: BarStock,
  angleDeg: number,
  tool: NormalizedTool,
  cache: Map<string, number>,
): number {
  if (tool.type !== 'ball_endmill' || !isSquareStock(stock)) {
    return referenceTouchHeight(stock, angleDeg, tool.radius)
  }
  const key = `${baseAngle(angleDeg)}|${tool.radius}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const value = referenceBallTouchHeight(stock, angleDeg, tool.radius)
  cache.set(key, value)
  return value
}

/**
 * True when the solid cutter at `tip` — the ball `x^2 + (y - (tip + rt))^2 <=
 * rt^2` plus the shank slab `|x| <= rt, y >= tip + rt` — contains any point of
 * the blank cross-section at `angleDeg`. This samples the rotated square's
 * interior directly; it never calls the helper, so it is a second, geometric
 * reading of "a skipped layer touches no blank material".
 */
function ballCutterHitsBlank(
  stock: BarStock,
  angleDeg: number,
  toolRadius: number,
  tip: number,
  steps = 64,
): boolean {
  const halfSide = barInscribedRadius(stock)
  const reach = Math.abs(toolRadius)
  const radians = (angleDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const centreY = tip + reach
  for (let i = 0; i <= steps; i++) {
    const u = -halfSide + (2 * halfSide * i) / steps
    for (let j = 0; j <= steps; j++) {
      const v = -halfSide + (2 * halfSide * j) / steps
      const x = u * cos - v * sin
      const y = u * sin + v * cos
      const dx = x
      const dy = y - centreY
      if (dx * dx + dy * dy <= reach * reach) return true
      if (Math.abs(x) <= reach && y >= centreY) return true
    }
  }
  return false
}

// ── 1. The helper's bound, including the round short circuit ───────────
{
  const blank = squareStock(20, 60, 'x')
  const round: RoundStock = roundStock(20, 60, 'x')
  // A0: the slab above the face reaches its full half-side, exactly, and a
  // wide cutter still cannot reach the corner (the old radial bound said
  // 10 / cos(asin(2 / R)) > 10 here, which is the bug).
  approx(squareRotaryTouchRadius(blank, 0, 2), 10, 'flat slab height', 1e-12)
  approx(squareRotaryTouchRadius(blank, 0, 20), 10, 'even a huge cutter sees the flat top', 1e-12)
  // At 45° the corner itself is on the pass ray.
  approx(squareRotaryTouchRadius(blank, 45, 2), barMaxRadius(blank), 'corner pass reaches the corner', 1e-12)
  // At 30° every rotated vertex is outside a 2 mm slab, so the maximum lies on
  // the top edge crossing x = +rt: h / cos 30 + rt tan 30. A vertices-only
  // implementation has nothing to return here.
  const rt = 2
  const edgeMaximum = 10 / Math.cos(Math.PI / 6) + rt * Math.tan(Math.PI / 6)
  approx(squareRotaryTouchRadius(blank, 30, rt), edgeMaximum, 'slab-edge maximum', 1e-12)
  for (const [across, up] of [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const) {
    const x = across * Math.cos(Math.PI / 6) - up * Math.sin(Math.PI / 6)
    assert.ok(Math.abs(x) > rt, 'the 30° maximum is not at a vertex')
  }
  // A zero-width slab is exactly the pass ray, so it is strictly below the
  // slab maximum at 30° — the mutation the generated-path test catches.
  approx(squareRotaryTouchRadius(blank, 30, 0), barSurfaceRadius(blank, 30), 'zero slab is the ray', 1e-12)
  assert.ok(edgeMaximum > barSurfaceRadius(blank, 30) + 1, 'the slab reaches material the ray does not')
  // The helper agrees with the independent frozen-frame reference at every
  // angle, on both sides of zero and across cutter widths.
  for (let angle = -180; angle <= 180; angle += 5) {
    for (const toolRadius of [0.5, 2, 7]) {
      approx(squareRotaryTouchRadius(blank, angle, toolRadius), referenceTouchHeight(blank, angle, toolRadius),
        `helper vs vertical reference at ${angle}° rt=${toolRadius}`, 1e-12)
    }
  }
  // The ball's exact contact is `g`, not the cylinder slab. At A30 the maximum
  // is interior to the top edge at `X* = rt sin 30 = 1`, and
  // `g = (h + rt) / cos 30 - rt = 11.856406`; the slab says 12.701705 and the
  // earlier air passes sat between the two.
  const ballEdgeMaximum = (10 + rt) / Math.cos(Math.PI / 6) - rt
  approx(squareRotaryTouchRadius(blank, 30, rt, 'ball_endmill'), ballEdgeMaximum,
    'ball interior tangency at 30°', 1e-12)
  assert.ok(ballEdgeMaximum < squareRotaryTouchRadius(blank, 30, rt) - 0.8,
    'the ball contacts lower than the flat cylinder slab')
  approx(squareRotaryTouchRadius(blank, 0, rt, 'ball_endmill'), 10, 'ball on a flat face', 1e-12)
  approx(squareRotaryTouchRadius(blank, 45, rt, 'ball_endmill'), barMaxRadius(blank),
    'ball at the corner (the corner is on the pass ray)', 1e-12)
  // The helper agrees with the independent ball reference at every angle and
  // cutter width. The reference has no closed-form tangency, so this is what
  // fails when the candidate is dropped or its sign is flipped.
  for (let angle = -180; angle <= 180; angle += 5) {
    for (const toolRadius of [0.5, 2, 7]) {
      approx(squareRotaryTouchRadius(blank, angle, toolRadius, 'ball_endmill'),
        referenceBallTouchHeight(blank, angle, toolRadius),
        `ball helper vs ball reference at ${angle}° rt=${toolRadius}`, 1e-9)
    }
  }
  // Round bars get the old constant radius, so the layer gate is the old one.
  approx(squareRotaryTouchRadius(round, 0, 2), 10, 'round radius at a flat', 1e-12)
  approx(squareRotaryTouchRadius(round, 37, 2), 10, 'round radius away from a flat', 1e-12)
  assert.throws(() => squareRotaryTouchRadius(blank, Number.NaN, 2), RangeError, 'a non-finite angle is refused')
  assert.throws(() => squareRotaryTouchRadius(blank, 0, Number.NaN), RangeError, 'a non-finite tool radius is refused')
  console.log('square air: the touch bound is the slab maximum over the rotated square, not the ray')
}

// ── 2. Every cut touches the blank; the first cut is one stepdown ──────
//
// Side 12 and 25, flat and ball, both bar axes, mm and inch, on the
// asymmetric prism. The reference is each cutter's contact model: a flat cut
// at tip radius R is above the blank iff R exceeds the slab maximum S, and a
// ball cut is above it iff R exceeds the disc+shank contact g. The first-cut
// assertion measures the shallowest cut at every pass against that contact, so
// a deeper first bite fails it.
{
  const SIDES = [12, 25] as const
  const SCALES = [['mm', 1], ['inch', 0.03937007874015748]] as const
  let cases = 0
  let checked = 0
  let worstSlab = -Infinity
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
          // The height map stores Float32 tips, so a shoulder cut on the
          // blank's own face reads up to a Float32 ulp past the analytic
          // surface (6.6e-9 on the inch fixtures); this is the tangent case,
          // not an air cut.
          const tolerance = 1e-6 * Math.max(1, side * scale)
          const ballCache = new Map<string, number>()
          const contactAt = (angle: number): number => contactHeight(blank, angle, scaledTool, ballCache)
          const params = {
            stepover: 0.8 * scale, stepdown: 1 * scale, sampleSpacing: 1 * scale, stockToLeave: 0,
            alongStart: 0.5 * side * scale, alongEnd: 1.5 * side * scale,
            safeRadius: 0.5 * side * scale, requestedCellSize: 0.2 * scale,
          }
          const mesh = prismMesh(blank)
          const result = generateRotaryRough(`air-${side}-${units}-${axis}-${tool.type}`, mesh, blank, scaledTool, params, {})
          assert.ok(result.moves.length > 0, `${side}/${units}/${axis}/${tool.type} generates motion`)
          const shallowest = new Map<number, number>()
          for (const move of result.moves) {
            if (move.kind !== 'cut') continue
            for (const point of [move.from, move.to]) {
              if (point.a === undefined || !usableCut(point, pivot, maxRadius)) continue
              const r = radius(point, pivot)
              const contact = contactAt(baseAngle(point.a))
              checked++
              worstSlab = Math.max(worstSlab, r - contact)
              assert.ok(r <= contact + tolerance,
                `${side}/${units}/${axis}/${tool.type}: cut at ${point.a}° r=${r} is above the blank `
                + `inside the cutter contact (S=${contact})`)
              // Only cuts below the contact height count as the first bite;
              // the shoulder-refined ends start on the blank's own surface.
              if (r < contact - tolerance) {
                shallowest.set(baseAngle(point.a), Math.max(shallowest.get(baseAngle(point.a)) ?? -Infinity, r))
              }
            }
          }
          assert.ok(shallowest.size > 0, `${side}/${units}/${axis}/${tool.type} cuts`)
          for (const [base, first] of shallowest) {
            const contact = contactAt(base)
            const depth = contact - first
            worstDepth = Math.max(worstDepth, depth)
            if (depth > tolerance) materialCuts++
            assert.ok(depth <= params.stepdown + tolerance,
              `${side}/${units}/${axis}/${tool.type}: the first cut at ${base}° bites ${depth.toFixed(6)} > one stepdown`)
          }
          cases++
        }
      }
    }
  }
  assert.ok(checked > 0, 'the cutter-contact assertion walks real cuts')
  assert.ok(materialCuts > 0, 'some first cuts remove material')
  assert.ok(worstSlab <= 1e-6, `no cut is above the blank contact (worst margin ${worstSlab.toExponential(2)})`)
  assert.ok(worstDepth <= 1 + 1e-6, `the first cut is never deeper than one stepdown (worst ${worstDepth.toFixed(6)})`)
  console.log(`square air: ${cases} asymmetric fixtures, ${checked} endpoints checked, `
    + `worst contact margin ${worstSlab.toExponential(2)}, worst first cut ${worstDepth.toFixed(6)} <= 1`)
}

// ── 3. Codex's reproduction: no A0 pass above the Z20 face ────────────
//
// 20 mm square, A0, 4 mm flat, 0.1 mm stepdown. The old radial bound emitted
// layers at Z = 20.1421 and 20.0421; the slab bound first emits at Z = 19.9421.
// No A0 cut may sit above the face. F5 then removes the shoulder's own ride at
// the face (#1016 C2-F5): the first A0 material point is the real one stepdown
// below it, reached by a straight plunge, so no cut endpoint remains *on* the
// face either.
{
  const blank = squareStock(20, 60, 'x')
  const pivot = barPivotZ(blank)
  const face = pivot + barInscribedRadius(blank)
  const mesh = cylinderMesh(blank, 6, 18, 42)
  const result = generateRotaryRough('codex-air', mesh, blank, FLAT_4MM, {
    stepover: 0.8, stepdown: 0.1, sampleSpacing: 1, stockToLeave: 0,
    alongStart: 18, alongEnd: 42, safeRadius: 5, requestedCellSize: 0.2,
  }, {})
  let aboveFace = 0
  let atFace = 0
  let belowFace = 0
  let shallowestBulk = -Infinity
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      if (point.a === undefined || baseAngle(point.a) !== 0) continue
      const r = radius(point, pivot)
      if (r > barInscribedRadius(blank) + 1e-9) aboveFace++
      if (Math.abs(r - barInscribedRadius(blank)) <= 1e-9) atFace++
      if (r < barInscribedRadius(blank) - 1e-9) {
        belowFace++
        shallowestBulk = Math.max(shallowestBulk, r)
      }
    }
  }
  assert.equal(aboveFace, 0, `no A0 cut is above the Z${face} face (got ${aboveFace})`)
  assert.equal(atFace, 0, 'F5 trims the A0 shoulder ride: no cut endpoint stays on the blank face')
  assert.ok(belowFace > 0, 'the A0 pass still cuts the model below the face')
  assert.ok(shallowestBulk > barInscribedRadius(blank) - 0.1 - 1e-9,
    `the first bulk A0 cut is no deeper than one stepdown (r ${shallowestBulk})`)
  assert.ok(shallowestBulk < barInscribedRadius(blank) - 1e-9, 'the first bulk cut is below the face')
  console.log(`square air: Codex case ${result.moves.length} moves, A0 first bulk cut r=${shallowestBulk.toFixed(6)}, `
    + `${atFace} shoulder endpoints left on the face (F5), ${aboveFace} above it`)
}

// ── 3b. Codex's ball reproduction: the ball's exact contact, not the slab ──
//
// 20 mm square, 12 angular passes (A30 is one), 4 mm ball, 0.1 mm stepdown,
// r6 target along 18..42. The old cylinder bound started A30 at Z = 22.642136;
// the ball first meets the blank at Z = 21.856406. No emitted A30 layer may
// sit above that, and the top one must be within one stepdown of it.
{
  const blank = squareStock(20, 60, 'x')
  const pivot = barPivotZ(blank)
  const maxRadius = barMaxRadius(blank)
  const stepdown = 0.1
  const passes = 12
  // 11.5 passes of spacing lands exactly on 12, so A30 is `k = 1`.
  const stepover = (2 * Math.PI * maxRadius) / (passes - 0.5)
  const mesh = cylinderMesh(blank, 6, 18, 42)
  const result = generateRotaryRough('codex-air-ball', mesh, blank, BALL_4MM, {
    stepover, stepdown, sampleSpacing: 1, stockToLeave: 0,
    alongStart: 18, alongEnd: 42, safeRadius: 5, requestedCellSize: 0.2,
  }, {})
  // The analytic 30° tangency: h / cos 30 + rt (1 / cos 30 - 1).
  const contact = (10 + BALL_4MM.radius) / Math.cos(Math.PI / 6) - BALL_4MM.radius
  approx(referenceBallTouchHeight(blank, 30, BALL_4MM.radius), contact,
    'the ball reference finds the 30° tangency', 1e-9)
  approx(pivot + contact, 21.856406460551018, 'the ball contact at A30 is Z21.856406', 1e-9)
  // Prove the direct disc+shank grid used on skipped layers is not vacuous:
  // half a millimetre below the contact it must see the ball, half a
  // millimetre above it must see air.
  assert.ok(ballCutterHitsBlank(blank, 30, BALL_4MM.radius, contact - 0.5),
    'the disc+shank grid sees a layer 0.5 mm inside the ball contact')
  assert.ok(!ballCutterHitsBlank(blank, 30, BALL_4MM.radius, contact + 0.5),
    'the disc+shank grid sees air 0.5 mm above the ball contact')
  let aboveContact = 0
  let highest = -Infinity
  let checked = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      if (point.a === undefined || baseAngle(point.a) !== 30) continue
      if (!usableCut(point, pivot, maxRadius)) continue
      const r = radius(point, pivot)
      checked++
      highest = Math.max(highest, r)
      if (r > contact + 1e-9) aboveContact++
    }
  }
  assert.ok(checked > 0, 'the A30 ball pass cuts')
  assert.equal(aboveContact, 0,
    `no A30 ball layer is above the ball contact Z${(pivot + contact).toFixed(6)} (got ${aboveContact})`)
  assert.ok(highest <= contact + 1e-9, `the top A30 ball layer is under the contact (r ${highest})`)
  assert.ok(contact - highest <= stepdown + 1e-9,
    `the first A30 ball cut bites ${(contact - highest).toFixed(6)} <= one stepdown`)
  assert.ok(highest < 12.642135623730951,
    'the old cylinder bound\'s Z22.642136 air layer is gone')
  console.log(`square air: Codex ball case ${result.moves.length} moves / `
    + `${result.moves.filter((move) => move.kind === 'cut').length} cuts, A30 top layer `
    + `Z${(pivot + highest).toFixed(6)} <= contact Z${(pivot + contact).toFixed(6)}`)
}

// ── 4. Skipping a layer removes nothing, so the final material is the old one
//
// The generator emits the present layers from the first material layer to the
// final `lowest` layer; the skipped prefix is re-derived here against the
// cutter's contact height. A skipped layer at radius R must have no blank point
// inside the cutter at or above R (`R >= S`), so the old cut there was wholly
// air and removing it cannot change what is left. The final layer is present at
// every pass, which is the old algorithm's final per-angle depth. For a ball the
// disc+shank test below samples the blank cross-section directly, never the
// helper.
{
  let skippedLayers = 0
  let finalLayers = 0
  let discChecks = 0
  for (const side of [12, 25] as const) {
    for (const axis of ['x', 'y'] as const) {
      for (const tool of [FLAT, BALL]) {
        const blank = squareStock(side, 2.5 * side, axis)
        const pivot = barPivotZ(blank)
        const maxRadius = barMaxRadius(blank)
        const tolerance = 1e-9 * side
        const ballCache = new Map<string, number>()
        const params = {
          stepover: 0.8, stepdown: 1, sampleSpacing: 1, stockToLeave: 0,
          alongStart: 0.5 * side, alongEnd: 1.5 * side, safeRadius: 0.5 * side, requestedCellSize: 0.2,
        }
        const mesh = prismMesh(blank)
        const result = generateRotaryRough(`material-${side}-${axis}-${tool.type}`, mesh, blank, tool, params, {})
        const usable = result.moves.filter((move) => move.kind === 'cut'
          && usableCut(move.from, pivot, maxRadius) && usableCut(move.to, pivot, maxRadius))
        assert.ok(usable.length > 0, `${side}/${axis}/${tool.type} cuts`)
        const lowest = Math.min(...usable.flatMap((move) => [radius(move.from, pivot), radius(move.to, pivot)]))
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
        // The global `lowest` tip is reached at the last layer, at the pass
        // where the model is deepest: that is the old rough's per-angle final
        // depth, and it must survive the gate.
        const deepest = usable.reduce((best, move) => {
          const r = Math.min(radius(move.from, pivot), radius(move.to, pivot))
          return r < best.radius ? { radius: r, angle: baseAngle(move.to.a ?? 0) } : best
        }, { radius: Infinity, angle: Number.NaN })
        assert.ok(present.get(deepest.angle)?.has(layers - 1),
          `${side}/${axis}/${tool.type}: the reachable final layer ${layers - 1} is cut at the deepest pass ${deepest.angle}°`)
        for (const [base, set] of present) {
          const indexes = [...set].sort((a, b) => a - b)
          const first = indexes[0]
          for (let i = 1; i < indexes.length; i++) {
            assert.equal(indexes[i], indexes[i - 1] + 1, `${side}/${axis}/${tool.type}: emitted layers are a contiguous suffix at ${base}°`)
          }
          if (indexes[indexes.length - 1] === layers - 1) finalLayers++
          for (let layer = 0; layer < first; layer++) {
            const layerRadius = Math.max(lowest, maxRadius - (layer + 1) * params.stepdown)
            const contact = contactHeight(blank, base, tool, ballCache)
            assert.ok(layerRadius >= contact - tolerance,
              `${side}/${axis}/${tool.type}: skipped layer ${layer} at ${base}° (r ${layerRadius.toFixed(6)}) is still inside `
              + `material out to ${contact.toFixed(6)}`)
            if (tool.type === 'ball_endmill') {
              // The direct disc+shank reading: no point of the blank
              // cross-section may be inside the solid cutter at this tip.
              assert.ok(!ballCutterHitsBlank(blank, base, tool.radius, layerRadius),
                `${side}/${axis}/${tool.type}: skipped layer ${layer} at ${base}° (r ${layerRadius.toFixed(6)}) `
                + 'puts the ball or shank into the blank')
              discChecks++
            }
            skippedLayers++
          }
        }
      }
    }
  }
  assert.ok(skippedLayers > 0, 'the asymmetric fixtures actually skip air layers')
  assert.ok(discChecks > 0, 'the ball disc+shank check walks skipped ball layers')
  assert.ok(finalLayers > 0, 'the reachable final layer survives on passes that cut to the lowest tip')
  console.log(`square air: ${skippedLayers} air layers skipped across ${finalLayers} final-layer passes `
    + `(${discChecks} checked with the ball disc+shank grid); every skipped layer is air`)
}

// ── 5. The side-12 fixture loses moves, with a measured margin ─────────
//
// Before C2-F2 this fixture (12 × 30 blank, r3 target band 8..22, r1 flat,
// stepover 0.8, stepdown 1) generated 2,231 moves, 1,397 of them `cut`; C2-F2's
// pin required at most 2,031 moves and 1,307 cuts. The slab bound (C2-F2b)
// measures 1,959 moves and 1,107 cuts. The pin keeps the pre-F2 regression
// loud; the correction's own regression is Codex's case above.
{
  const blank = squareStock(12, 30, 'x')
  const mesh = cylinderMesh(blank, 3, 8, 22)
  const result = generateRotaryRough('count', mesh, blank, FLAT, {
    stepover: 0.8, stepdown: 1, sampleSpacing: 1, stockToLeave: 0,
    alongStart: 8, alongEnd: 22, safeRadius: 6, requestedCellSize: 0.2,
  }, {})
  const cuts = result.moves.filter((move) => move.kind === 'cut').length
  assert.ok(result.moves.length <= 1959,
    `the side-12 rough drops to the slab-bound count (${result.moves.length} <= 1959)`)
  assert.ok(cuts <= 1107, `the side-12 rough drops to the slab-bound count (${cuts} <= 1107)`)
  console.log(`square air: side-12 fixture ${result.moves.length} moves / ${cuts} cuts, pre-F2 2231 / 1397`)
}

// ── 6. A cut that only the slab reaches is not skipped ────────────────
//
// Nine passes put one at 40°. At that pass the pass ray is 13.054, but the 45°
// corner sits at tool x = 1.232 inside the 2 mm slab and its height there is
// 14.090, so the first layer at 13.3 is material and must be cut. Taking S at
// the ray only (a zero-width slab), or missing the edge crossing, would skip
// it.
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
  const pivot = barPivotZ(blank)
  const atWitness = result.moves.filter((move) => move.kind === 'cut'
    && Math.abs(baseAngle(move.to.a ?? 0) - 40) < 1e-6
    && radius(move.to, pivot) > witnessRadius - 1e-6
    && radius(move.to, pivot) <= maxRadius + 1e-9)
  assert.ok(atWitness.length > 0,
    'the 40° pass cuts its corner layer even though the pass ray is above it')
  assert.ok(atWitness.some((move) => Math.abs(radius(move.to, pivot) - witnessRadius) <= 1e-6),
    'the corner layer cuts at exactly 13.3 where the model is below it')
  console.log(`square air: 40° witness kept ${atWitness.length} corner-layer moves at r=${witnessRadius}`)
}

console.log('engine/toolpaths/squareRotaryRoughAir.test.ts: all assertions passed')
