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
 * #1177 bal-a: a ball-nose rotary finish reads the **exact sphere drop**, so the
 * Hex's flats are cut to their own surface at every facet corner.
 *
 * The fixture is Frank's bolt in miniature: a D50.8 bar along X, a Hex of
 * across-flats 38.1 over 19.05..31.75 with uncut bar on its chuck side, a Turn of
 * D25.4 from 30.48, and a 1/8 in ball finish on the Hex with stock to leave 0. It
 * is built the way the app builds it (`planRotarySolid` +
 * `defaultOperationForTarget`), so the operation's own numbers -- cell, stepover,
 * sampling -- are a user's.
 *
 * **A** is the handoff's test A: every cut pose's tip against the exact
 * ball-over-hexagon envelope, on all twelve facet corners, entry and exit
 * separately, at four along bands including one within a radius plus a cell of
 * the shoulder wall, and at two sampling phases. Before this slice the same check
 * on `work/bolt-test-02-x-mm.camj` measured 0.207-0.225 mm along the band and
 * 0.585-0.592 mm on the columns a neighbour's reach read exactly; it now measures
 * 0.000. **C** is the same sweep's minimum (no gouge). **D** is the handoff's
 * test D: no radial step inside a cutting pass, which was 0.0542 mm at A = 35.73
 * and 324.27 on every turn -- the conservative read's per-angle lift changing --
 * and is now the operation's first plunge only.
 *
 * The handoff's **B**, **4b** and **4c** are measured on Frank's file by
 * `scripts/issue-1177-bal-probe.ts`, which reports every corner and both ends;
 * that is where those 0.05 mm bounds are asserted, because this fixture's 5.4 mm
 * facets helix at a 0.4 mm stepover and a ball's chord over a facet **corner**
 * leaves the ball's own corner fit there (0.10 mm), while the 25.4 mm bar's ring
 * path leaves 0.000 on the same read. `work/bolt-test-02-x-mm.camj` is gitignored
 * and not committed, so this file pins the checks a synthetic fixture can prove
 * and the probe carries the rest.
 */

import assert from 'node:assert/strict'

import { barPivotZ } from '../../types/barStock'
import type { BarStock, Operation, Project } from '../../types/project'
import { defaultTool, newProject, roundStock } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import type { NormalizedTool, ToolpathResult } from './types'

const HEX_START = 19.05
const HEX_END = 31.75
const HEX_APOTHEM = 19.05
const BALL_ID = 'ball-0125'
const BALL_RADIUS = 1.5875
const RESIDUAL = 0.05
const GOUGE = -0.01
const STEP = 0.01

const EMPTY_SELECTION = {
  mode: 'feature', selectedFeatureId: null, selectedFeatureIds: [], selectedTabIds: [],
  selectedClampIds: [], selectedNode: null, hoveredFeatureId: null, sketchEditTool: null,
  activeControl: null, groupFolderId: null,
} as unknown as never

/** Frank's bolt in miniature, the Hex's facets rotated by `rotationDeg`. */
function boltFixture(rotationDeg = 0): { project: Project; operation: Operation } {
  const base = newProject('1177 ball finish', 'mm')
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 50.8
  base.stock = roundStock(50.8, 101.6, 'x')
  base.tools = [{
    ...defaultTool('mm', 1), id: BALL_ID, name: '1/8" ball nose', type: 'ball_endmill',
    diameter: 2 * BALL_RADIUS, defaultStepover: 0.4, defaultStepdown: 1,
  }]
  base.setups.push({
    ...base.setups[0], id: 'around', name: 'Around', kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  base.activeSetupId = 'around'
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: 30.48, length: 64.77, diameter: 25.4,
  })
  if (!turn.ok) throw new Error(`the Turn must plan: ${turn.reason}`)
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_END - HEX_START, sides: 6,
    acrossFlats: 2 * HEX_APOTHEM, rotationDeg,
  })
  if (!hex.ok) throw new Error(`the Hex must plan: ${hex.reason}`)
  const project = hex.project
  return {
    project,
    operation: {
      ...defaultOperationForTarget(project, 'rotary_finish', 'finish',
        { source: 'features', featureIds: [hex.created.featureId] }, 1),
      setupId: 'around',
      rotaryPassDirection: 'around',
      name: 'Hex finish',
      toolRef: BALL_ID,
      stepover: 0.4,
      stepdown: 1,
      stockToLeaveRadial: 0,
    },
  }
}

function generate(project: Project, operation: Operation): ToolpathResult {
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope) throw new Error('the finish does not dispatch to the rotary generator')
  return envelope.result
}

function toolOf(project: Project, operation: Operation): NormalizedTool {
  const record = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!record) throw new Error('the finish has no tool')
  return normalizeToolForProject(record, project)
}

/**
 * The fixture's facet-normal phase: `run` sets it to the Hex's own rotation, so
 * the corner algebra below is measured against the facets as built.
 */
let phaseDeg = 0

/** The angle from the nearest facet normal, degrees in `[0, 30]`. */
function facetOffset(angle: number): number {
  const wrapped = (((angle - phaseDeg) % 60) + 60) % 60
  return Math.min(wrapped, 60 - wrapped)
}

const wrap180 = (angle: number): number => {
  const folded = ((angle % 360) + 360) % 360
  return folded > 180 ? folded - 360 : folded
}

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

/**
 * The exact ball-over-hexagon envelope by its definition: the smallest tip radius
 * at which a ball of `R` centred at that angle sits `R` clear of the hexagon.
 * Bisection on the point-to-convex-polygon distance, so the facet contact and the
 * vertex transition are both geometry and no formula has to be trusted.
 */
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

interface CutPoint {
  x: number
  radius: number
  angle: number
  kind: string
}

/** Every pose the program passes through, cut moves only. */
function cutPoints(result: ToolpathResult, stock: BarStock): CutPoint[] {
  const pivot = barPivotZ(stock)
  const points: CutPoint[] = []
  for (const move of result.moves) {
    if (move.from.a === undefined || move.to.a === undefined) continue
    const fromX = stock.axis === 'x' ? move.from.x : move.from.y
    const toX = stock.axis === 'x' ? move.to.x : move.to.y
    for (const t of [0, 1]) {
      points.push({
        x: fromX + (toX - fromX) * t,
        radius: move.from.z + (move.to.z - move.from.z) * t - pivot,
        angle: wrap180(move.from.a + (move.to.a - move.from.a) * t),
        kind: move.kind,
      })
    }
  }
  return points
}

/**
 * **A** and **C**: every cut pose's tip against the exact ball-over-hexagon
 * envelope, on all twelve facet corners, entry and exit separately.
 */
function checkEnvelope(points: readonly CutPoint[], label: string): number {
  let worst = 0
  const bands: Array<{ name: string; from: number; to: number }> = [
    { name: 'chuck end', from: HEX_START, to: HEX_START + 0.6 },
    { name: 'middle', from: 24.6, to: 25.2 },
    { name: 'last turn', from: 27.6, to: 28.2 },
    { name: 'shoulder wall', from: HEX_END - 2.4, to: HEX_END - 1.8 },
  ]
  for (const band of bands) {
    const high = new Array<number>(12).fill(Number.NEGATIVE_INFINITY)
    const low = new Array<number>(12).fill(Number.POSITIVE_INFINITY)
    for (const point of points) {
      if (point.kind === 'rapid') continue
      if (point.x < band.from || point.x > band.to) continue
      const offset = facetOffset(point.angle)
      if (offset < 24 || offset > 30) continue
      // The fixture's own facet-normal phase: the feature is rotated by
      // `-phaseDeg` in the commanded frame, so the corner buckets shift with it.
      const wrapped = ((((point.angle - phaseDeg) % 360) + 360) % 360)
      const facet = Math.floor((wrapped + 30) / 60) % 6
      const u = wrapped - (60 * Math.floor((wrapped + 30) / 60) - 30)
      const index = facet * 2 + (u >= 30 ? 0 : 1)
      const excess = point.radius - idealBallTip(point.angle)
      if (excess > high[index]) high[index] = excess
      if (excess < low[index]) low[index] = excess
    }
    for (let index = 0; index < 12; index++) {
      if (!Number.isFinite(high[index])) continue
      const corner = `facet ${Math.floor(index / 2)} ${index % 2 === 0 ? 'entry' : 'exit'}`
      if (high[index] > worst) worst = high[index]
      assert.ok(high[index] <= RESIDUAL,
        `${label} A (${band.name}) ${corner}: tip ${high[index].toFixed(4)} mm above the envelope`)
      assert.ok(low[index] >= GOUGE,
        `${label} C (${band.name}) ${corner}: tip ${low[index].toFixed(4)} mm below the envelope`)
    }
  }
  return worst
}

/** **D**: no radial step inside a cutting pass. */
function checkRadialSteps(result: ToolpathResult, stock: BarStock, label: string): void {
  const pivot = barPivotZ(stock)
  let previousWasCut = false
  let previous: { x: number; radius: number; angle: number } | null = null
  for (const move of result.moves) {
    if (move.from.a === undefined || move.to.a === undefined) continue
    const point = {
      x: stock.axis === 'x' ? move.to.x : move.to.y,
      radius: move.to.z - pivot,
      angle: move.to.a,
    }
    if (previous !== null && previousWasCut && move.kind !== 'rapid'
      && Math.abs(point.angle - previous.angle) < 1e-6
      && Math.abs(point.x - previous.x) < 2e-3) {
      const step = Math.abs(point.radius - previous.radius)
      assert.ok(step <= STEP,
        `${label} D A${wrap180(point.angle).toFixed(3)} X${point.x.toFixed(3)}: `
        + `a ${step.toFixed(4)} mm radial step inside a cutting pass`)
    }
    previous = point
    previousWasCut = move.kind !== 'rapid'
  }
}

function run(rotationDeg: number): void {
  const { project, operation } = boltFixture(rotationDeg)
  const stock = project.stock as BarStock
  const label = rotationDeg === 0 ? 'phase 0' : `phase ${rotationDeg}`
  // `boltFixture` rotates the Hex by `rotationDeg` in the sketch frame; in the
  // commanded frame the facet normal moves the other way, so the envelope's
  // phase is `-rotationDeg`. That is the sign the earlier round could not
  // settle: with `+rotationDeg` the check reads the envelope half a corner off
  // and reports 0.19 mm of a residual the fixture does not have.
  phaseDeg = -rotationDeg
  const tool = toolOf(project, operation)
  assert.equal(tool.type, 'ball_endmill', 'the Hex finish runs the 1/8 in ball')
  const result = generate(project, operation)
  const worst = checkEnvelope(cutPoints(result, stock), label)
  checkRadialSteps(result, stock, label)
  console.log(`  ${label}: worst A excess ${worst.toFixed(4)} mm over the envelope`)
}

console.log('Testing the #1177 ball finish against the exact ball-over-hexagon envelope...')
run(0)
// The handoff's shifted sampling phase: the start line rotated by half a sample.
// The shift is 0.4465 degrees -- the half-sample value the earlier rounds'
// probe already used for this file -- so rotating the Hex by that much puts
// every pass angle half a sample off the facet-normal grid. That is a real
// re-generation and re-read, not a shifted check angle: A, C and D all run
// again on it.
run(0.4465)
console.log('issue-1177-ballFinish.test.ts: all checks passed')
