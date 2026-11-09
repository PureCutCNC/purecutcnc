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
 * #1177 bal-a: the measurements the handoff's tests A, B, C, D, 4b and 4c name,
 * read off the generated program for Frank's bolt file.
 *
 *   npx tsx scripts/issue-1177-bal-probe.ts work/bolt-test-02-x-mm.camj
 *
 * A: every cut pose of the Hex finish (op0196) against the exact ball-over-
 *    hexagon envelope, per corner, entry and exit separately.
 * B: the ball envelope of all of that operation's moves against each facet
 *    plane, across the full facet width.
 * C: the same envelope's minimum (a gouge is negative).
 * D: radial steps inside a cutting pass.
 * 4b/4c: the material the whole rotary sequence leaves, per facet, near the
 *    shoulder and in the wall-foot band at both Hex ends.
 */

import { readFileSync } from 'node:fs'

import { normalizeProject } from '../src/store/helpers/projectFormat'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import type { NormalizedTool, ToolpathMove, ToolpathResult } from '../src/engine/toolpaths/types'
import type { BarStock, Operation, Project } from '../src/types/project'
import { barPivotZ } from '../src/types/barStock'
import { cutterPosesByAngle, sweepProfile, type WallFootProfile } from '../src/test/rotaryWallFootSweep'

const HEX_X0 = 19.05
const HEX_X1 = 31.75
const HEX_APOTHEM = 19.05
const BAR_RADIUS = 25.4
const BALL_RADIUS = 3.175 / 2

function loadProject(path: string): Project {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return normalizeProject(raw as Parameters<typeof normalizeProject>[0])
}

function generate(project: Project, operation: Operation): ToolpathResult {
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope) throw new Error(`${operation.id} produced no toolpath`)
  return envelope.result
}

function toolOf(project: Project, operation: Operation): NormalizedTool {
  const record = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!record) throw new Error(`${operation.id} has no tool`)
  return normalizeToolForProject(record, project)
}

/** Angle from the nearest facet normal, in degrees, `[0, 30]`. */
function facetOffset(angle: number): number {
  const wrapped = ((angle % 60) + 60) % 60
  return Math.min(wrapped, 60 - wrapped)
}

/**
 * The exact ball-over-hexagon envelope by its definition: the smallest tip radius
 * at which a ball of `R` centred at that angle sits `R` clear of the hexagon.
 * Solved by bisection on the point-to-convex-polygon distance, so the facet
 * contact and the vertex transition both come from the geometry and no formula
 * has to be trusted.
 */
const HEX_VERTICES = Array.from({ length: 6 }, (_, k) => {
  const angle = Math.PI / 6 + (k * Math.PI) / 3
  const radius = HEX_APOTHEM / Math.cos(Math.PI / 6)
  return { u: radius * Math.sin(angle), v: radius * Math.cos(angle) }
})

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

function hexagonDistance(px: number, py: number): number {
  let best = Number.POSITIVE_INFINITY
  for (let k = 0; k < 6; k++) {
    const a = HEX_VERTICES[k]
    const b = HEX_VERTICES[(k + 1) % 6]
    const distance = segmentDistance(px, py, a.u, a.v, b.u, b.v)
    if (distance < best) best = distance
  }
  return best
}

function idealBallTip(angle: number, radius = BALL_RADIUS): number {
  const delta = (facetOffset(angle) * Math.PI) / 180
  const sin = Math.sin(delta)
  const cos = Math.cos(delta)
  let low = HEX_APOTHEM
  let high = HEX_APOTHEM + 4 * radius + 4
  for (let step = 0; step < 80; step++) {
    const mid = (low + high) / 2
    if (hexagonDistance(mid * sin, mid * cos) < radius) low = mid
    else high = mid
  }
  return (low + high) / 2 - radius
}

const wrap180 = (angle: number): number => {
  const folded = ((angle % 360) + 360) % 360
  return folded > 180 ? folded - 360 : folded
}

interface CutPoint {
  x: number
  radius: number
  angle: number
  kind: string
}

function cutPoints(result: ToolpathResult, stock: BarStock, spacing = Number.POSITIVE_INFINITY): CutPoint[] {
  const pivot = barPivotZ(stock)
  const points: CutPoint[] = []
  for (const move of result.moves) {
    if (move.from.a === undefined || move.to.a === undefined) continue
    const kind = move.kind
    const fromX = stock.axis === 'x' ? move.from.x : move.from.y
    const toX = stock.axis === 'x' ? move.to.x : move.to.y
    const arc = Math.abs(((move.to.a - move.from.a) * Math.PI) / 180)
      * Math.max(Math.abs(move.from.z - pivot), Math.abs(move.to.z - pivot))
    const travel = Math.hypot(toX - fromX, arc, move.to.z - move.from.z)
    const steps = Math.max(1, Math.min(400, Math.ceil(travel / spacing)))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = stock.axis === 'x'
        ? move.from.x + (move.to.x - move.from.x) * t
        : move.from.y + (move.to.y - move.from.y) * t
      points.push({
        x,
        radius: move.from.z + (move.to.z - move.from.z) * t - pivot,
        angle: wrap180(move.from.a + (move.to.a - move.from.a) * t),
        kind,
      })
    }
  }
  return points
}

/** A: every cut pose of the ball finish against the exact envelope. */
function reportA(result: ToolpathResult, stock: BarStock): void {
  const points = cutPoints(result, stock).filter((point) => point.kind !== 'rapid')
  const bands: Array<{ label: string; from: number; to: number }> = [
    { label: 'X 19.00-19.60', from: 19.0, to: 19.6 },
    { label: 'X 24.00-24.60', from: 24.0, to: 24.6 },
    { label: 'X 27.00-27.60', from: 27.0, to: 27.6 },
    { label: 'X 28.80-28.90', from: 28.8, to: 28.9 },
    { label: 'X 31.20-31.80', from: 31.2, to: 31.8 },
  ]
  console.log('\nA: max tip excess over the exact ball-over-hexagon envelope, 12 corners')
  for (const band of bands) {
    const best = new Array<number>(12).fill(Number.NEGATIVE_INFINITY)
    const low = new Array<number>(12).fill(Number.POSITIVE_INFINITY)
    for (const point of points) {
      if (point.x < band.from || point.x > band.to) continue
      const wrapped = ((point.angle % 360) + 360) % 360
      const offset = facetOffset(point.angle)
      if (offset < 24 || offset > 30) continue
      const facet = Math.floor((wrapped + 30) / 60) % 6
      const u = wrapped - (60 * Math.floor((wrapped + 30) / 60) - 30)
      const index = facet * 2 + (u >= 30 ? 0 : 1)
      const excess = point.radius - idealBallTip(point.angle)
      if (excess > best[index]) best[index] = excess
      if (excess < low[index]) { low[index] = excess; if (excess < -0.2) console.log('   LOW', index, point.kind, 'X', point.x.toFixed(3), 'A', point.angle.toFixed(3), 'r', point.radius.toFixed(3), 'ideal', idealBallTip(point.angle).toFixed(3)) }
    }
    console.log(`  ${band.label}: max ${best.map((value) => Number.isFinite(value) ? value.toFixed(3) : '  .  ').join(' ')}`)
    console.log(`  ${' '.repeat(band.label.length)}  min ${low.map((value) => Number.isFinite(value) ? value.toFixed(3) : '  .  ').join(' ')}`)
  }
}

/** E: envelope of all moves at a point (X, angle); returns the material radius. */
function envelopeRadius(
  moves: readonly CutPoint[],
  x: number,
  angle: number,
  toolRadius: number,
): number {
  let best = Number.POSITIVE_INFINITY
  for (const pose of moves) {
    const offset = x - pose.x
    if (Math.abs(offset) > toolRadius) continue
    const delta = ((angle - pose.angle) * Math.PI) / 180
    const cos = Math.cos(delta)
    if (!(cos > 0)) continue
    const centre = pose.radius + toolRadius
    const discriminant = centre * centre * cos * cos
      - (offset * offset + centre * centre - toolRadius * toolRadius)
    if (discriminant < 0) continue
    const lowest = centre * cos - Math.sqrt(discriminant)
    if (lowest < best) best = lowest
  }
  return best
}

/** B and C: the ball envelope against each facet plane. */
function reportBC(moves: readonly CutPoint[], toolRadius: number, phaseDeg: number): void {
  const points = moves.filter((point) => point.kind !== 'rapid')
  const halfWidth = HEX_APOTHEM * Math.tan(Math.PI / 6)
  let worst = Number.NEGATIVE_INFINITY
  let worstAt = ''
  let gouge = 0
  let gougeAt = ''
  const rows: string[] = []
  for (const x of [20.3, 24.5, 27.5, 28.85, 29.9, 31.2]) {
    const values: string[] = []
    for (const s of [-halfWidth, -halfWidth * 0.91, -halfWidth * 0.82, -halfWidth * 0.73,
      -halfWidth * 0.64, -halfWidth * 0.5, -halfWidth * 0.25, 0,
      halfWidth * 0.25, halfWidth * 0.5, halfWidth * 0.64, halfWidth * 0.73,
      halfWidth * 0.82, halfWidth * 0.91, halfWidth]) {
      // Facet 0's normal is at A0; `s` is the distance across the flat.
      const angle = (Math.atan2(s, HEX_APOTHEM) * 180) / Math.PI + phaseDeg
      const radius = envelopeRadius(points, x, angle, toolRadius)
      if (!Number.isFinite(radius)) {
        values.push('  .  ')
        continue
      }
      const above = radius * Math.cos((facetOffset(angle) * Math.PI) / 180) - HEX_APOTHEM
      values.push(`${above >= 0 ? '+' : ''}${above.toFixed(3)}`)
      if (above > worst) {
        worst = above
        worstAt = `X${x} s${s.toFixed(1)} A${angle.toFixed(1)}`
      }
      if (above < gouge) {
        gouge = above
        gougeAt = `X${x} s${s.toFixed(1)} A${angle.toFixed(1)}`
      }
    }
    rows.push(`  X${x.toFixed(2)}: ${values.join(' ')}`)
  }
  console.log(`\nB: ball envelope above the facet plane (mm), phase ${phaseDeg}°, s across the flat`)
  for (const row of rows) console.log(row)
  console.log(`  worst +${worst.toFixed(3)} mm at ${worstAt}; C: worst gouge ${gouge.toFixed(3)} mm at ${gougeAt}`)
}

/** D: radial steps inside a cutting pass. */
function reportD(result: ToolpathResult, stock: BarStock): void {
  const pivot = barPivotZ(stock)
  let worst = 0
  let worstAt = ''
  const hits: string[] = []
  let previous: { x: number; radius: number; angle: number } | null = null
  let previousWasCut = false
  for (const move of result.moves) {
    if (move.from.a === undefined || move.to.a === undefined) continue
    const point = {
      x: stock.axis === 'x' ? move.to.x : move.to.y,
      radius: move.to.z - pivot,
      angle: move.to.a,
    }
    const from = {
      x: stock.axis === 'x' ? move.from.x : move.from.y,
      radius: move.from.z - pivot,
      angle: move.from.a,
    }
    if (previous !== null && previousWasCut && move.kind !== 'rapid') {
      const da = Math.abs(point.angle - previous.angle)
      const dx = Math.abs(point.x - previous.x)
      const dr = point.radius - previous.radius
      if (move.kind !== 'rapid' && da < 1e-6 && dx < 2e-3 && Math.abs(dr) > worst) {
        worst = Math.abs(dr)
        worstAt = `A${point.angle.toFixed(3)} X${point.x.toFixed(3)} from ${previous.radius.toFixed(4)} to ${point.radius.toFixed(4)}`
      }
      if (move.kind !== 'rapid' && da < 1e-6 && dx < 2e-3 && Math.abs(dr) > 0.01) {
        hits.push(`A${wrap180(point.angle).toFixed(2)} X${point.x.toFixed(3)} ${dr >= 0 ? '+' : ''}${dr.toFixed(4)}`)
      }
    }
    // A move whose from/to differ only in Z, inside the emitted program.
    if (Math.abs(point.angle - from.angle) < 1e-9 && Math.abs(point.x - from.x) < 1e-9
      && Math.abs(point.radius - from.radius) > 0.01 && move.kind !== 'rapid') {
      hits.push(`move A${wrap180(point.angle).toFixed(2)} X${point.x.toFixed(3)} `
        + `${(point.radius - from.radius).toFixed(4)}`)
    }
    previous = point
    previousWasCut = move.kind !== 'rapid'
  }
  console.log(`\nD: worst pure radial step inside a cutting pass: ${worst.toFixed(4)} mm at ${worstAt}`)
  const unique = [...new Set(hits)].slice(0, 12)
  console.log(`  ${hits.length} steps > 0.01 mm${unique.length > 0 ? `: ${unique.join(' | ')}` : ''}`)
}

function main(): void {
  const [path] = process.argv.slice(2)
  if (!path) throw new Error('usage: npx tsx scripts/issue-1177-bal-probe.ts <project.camj>')
  const project = loadProject(path)
  const stock = project.stock as BarStock
  const ids = ['op0195', 'op0196', 'op0197', 'op0198']
  const results = new Map<string, ToolpathResult>()
  for (const id of ids) {
    const operation = project.operations.find((entry) => entry.id === id)
    if (!operation) {
      console.log(`${id}: absent`)
      continue
    }
    const started = performance.now()
    const result = generate(project, operation)
    results.set(id, result)
    console.log(`${id} ${operation.name}: ${result.moves.length} moves, `
      + `${(performance.now() - started).toFixed(0)} ms, warnings ${result.warnings.length}`)
  }
  const finish = results.get('op0196')
  if (finish === undefined) throw new Error('op0196 is required')
  const ball = toolOf(project, project.operations.find((entry) => entry.id === 'op0196')!)
  console.log(`\nop0196 tool ${ball.type} r ${ball.radius}`)
  reportA(finish, stock)
  // The finish alone and the whole sequence, both against the facet plane.
  reportBC(cutPoints(finish, stock, BALL_RADIUS / 8), ball.radius, 0)
  reportBC(cutPoints(finish, stock, BALL_RADIUS / 8), ball.radius, 0.4465)
  reportD(finish, stock)
  reportSequence(project, results)
}

/**
 * 4b and 4c: the material the whole rotary sequence leaves, per facet, near the
 * shoulder and in the wall-foot band at both Hex ends.
 */
function reportSequence(project: Project, results: Map<string, ToolpathResult>): void {
  const stock = project.stock as BarStock
  const from = HEX_X0 - 8
  const to = HEX_X1 + 8
  const anchor = HEX_X1
  const operations = ['op0195', 'op0196', 'op0197', 'op0198']
    .map((id) => project.operations.find((entry) => entry.id === id))
    .filter((entry): entry is Operation => entry !== undefined)
  let profiles = new Map<number, WallFootProfile>()
  for (const operation of operations) {
    const result = results.get(operation.id)
    if (!result) continue
    const tool = toolOf(project, operation)
    const poses = cutterPosesByAngle(result.moves, stock, tool, 12)
    if (profiles.size === 0) {
      const along: number[] = []
      const top: number[] = []
      const step = Math.max(tool.radius / 32, 1e-4)
      for (let x = from; x <= to; x += step) {
        along.push(x)
        top.push(BAR_RADIUS)
      }
      profiles = new Map(poses.map((entry) => [entry.angle, { along, top }]))
    }
    for (const entry of poses) {
      const current = profiles.get(entry.angle)
      if (!current) continue
      profiles.set(entry.angle, sweepProfile(current, entry.poses, tool, entry.angle))
    }
  }
  const above = (profile: WallFootProfile, index: number, angle: number): number =>
    profile.top[index] * Math.cos((facetOffset(angle) * Math.PI) / 180) - HEX_APOTHEM
  console.log('\n4b: sequence material above the facet plane, A near every facet normal, mm')
  for (const angle of [0, 10, 20, 28, 60, 120, 180, 240, 300]) {
    const profile = profiles.get(angle)
    if (!profile) continue
    const cells: string[] = []
    for (const x of [28.0, 28.5, 29.0, 30.0, 31.0, 31.5, 31.7]) {
      let index = 0
      let distance = Number.POSITIVE_INFINITY
      for (let i = 0; i < profile.along.length; i++) {
        const candidate = Math.abs(profile.along[i] - x)
        if (candidate < distance) {
          distance = candidate
          index = i
        }
      }
      cells.push(`${x}:${above(profile, index, angle).toFixed(3)}`)
    }
    console.log(`  A${angle}: ${cells.join(' ')}`)
  }
  console.log('\n4b2: sequence material above the facet plane over X 15..23, mm')
  for (const angle of [0, 10, 20, 28]) {
    const profile = profiles.get(angle)
    if (!profile) continue
    const cells: string[] = []
    for (let x = 15; x <= 23.01; x += 0.4) {
      let index = 0
      let distance = Number.POSITIVE_INFINITY
      for (let i = 0; i < profile.along.length; i++) {
        const candidate = Math.abs(profile.along[i] - x)
        if (candidate < distance) {
          distance = candidate
          index = i
        }
      }
      cells.push(`${x.toFixed(1)}:${above(profile, index, angle).toFixed(2)}`)
    }
    console.log(`  A${angle}: ${cells.join(' ')}`)
  }

  console.log('\n4c: sequence material in the wall-foot band at both Hex ends, mm')
  for (const [label, end, direction] of [['chuck X 19.05', HEX_X0, 1], ['shoulder X 31.75', HEX_X1, -1]] as const) {
    for (const angle of [0, 10, 20, 28]) {
      const profile = profiles.get(angle)
      if (!profile) continue
      let worst = Number.NEGATIVE_INFINITY
      for (let i = 0; i < profile.along.length; i++) {
        const distance = (profile.along[i] - end) * direction
        if (distance < 0 || distance > 4) continue
        const value = above(profile, i, angle)
        if (value > worst) worst = value
      }
      console.log(`  ${label} A${angle}: worst ${worst.toFixed(3)} mm`)
    }
  }
}

main()
