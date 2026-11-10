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
 * **B**, **4b** and **4c** measure the material the cutters leave, from points on
 * every facet plane across its whole width (both corners included): a ray along
 * the facet's normal and every pose of every cut move's tool body, a ball as its
 * sphere plus shank and a flat as its cylinder. B is the finish alone at three
 * stretches of the band; 4b and 4c run Frank's whole rotary sequence (Hex rough
 * and finish, Turn rough and finish) and check X28 to the shoulder face, no
 * cutter behind that face, and the wall-foot band at **both** Hex ends. On
 * 18d908f6 they measure 0.22 (B), 0.26 (4b) and 0.22 / 0.26 at the two ends
 * (4c); the same rays also catch the chord a ball's refinement let dip 0.0145 mm
 * into a vertex. The fixture uses Frank's stepovers (a fraction of the tool
 * diameter: 0.16 for both balls, 0.32 for the flat), so the scallop between
 * helix turns is his file's 0.02 mm.
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

/** Where the Turn starts: the Hex's shoulder face, once the Turn has cut. */
const SHOULDER = 30.48
const ROUGH_BALL_ID = 'ball-025'
const FLAT_ID = 'flat-025'

/** Frank's bolt in miniature, the Hex's facets rotated by `rotationDeg`. */
function boltFixture(rotationDeg = 0): {
  project: Project
  operation: Operation
  /** op0195, op0197, op0198: the Hex rough, the Turn rough and the Turn finish. */
  others: Operation[]
} {
  const base = newProject('1177 ball finish', 'mm')
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 50.8
  base.stock = roundStock(50.8, 101.6, 'x')
  base.tools = [{
    ...defaultTool('mm', 1), id: BALL_ID, name: '1/8" ball nose', type: 'ball_endmill',
    diameter: 2 * BALL_RADIUS, defaultStepover: 0.4, defaultStepdown: 1,
  }, {
    ...defaultTool('mm', 2), id: ROUGH_BALL_ID, name: '1/4" ball nose', type: 'ball_endmill',
    diameter: 6.35, defaultStepover: 1.6, defaultStepdown: 1.905,
  }, {
    ...defaultTool('mm', 3), id: FLAT_ID, name: '1/4" end mill', type: 'flat_endmill',
    diameter: 6.35, defaultStepover: 2, defaultStepdown: 3.175,
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
  const hexTarget = { source: 'features' as const, featureIds: [hex.created.featureId] }
  const turnTarget = { source: 'features' as const, featureIds: [turn.created.featureId] }
  const around = { setupId: 'around', rotaryPassDirection: 'around' as const }
  return {
    project,
    operation: {
      ...defaultOperationForTarget(project, 'rotary_finish', 'finish', hexTarget, 1),
      ...around,
      name: 'Hex finish',
      toolRef: BALL_ID,
      // A fraction of the tool diameter, as Frank's op0196 has it: 0.508 mm.
      stepover: 0.16,
      stepdown: 1,
      stockToLeaveRadial: 0,
    },
    // The rest of Frank's sequence, with his tools, stepdowns and leaves.
    others: [{
      ...defaultOperationForTarget(project, 'rotary_rough', 'rough', hexTarget, 0),
      ...around, name: 'Hex rough', toolRef: ROUGH_BALL_ID, stepover: 0.16, stepdown: 1.905, stockToLeaveRadial: 0.508,
    }, {
      ...defaultOperationForTarget(project, 'rotary_rough', 'rough', turnTarget, 2),
      ...around, name: 'Turn rough', toolRef: FLAT_ID, stepover: 0.32, stepdown: 3.175, stockToLeaveRadial: 0.508,
    }, {
      ...defaultOperationForTarget(project, 'rotary_finish', 'finish', turnTarget, 3),
      ...around, name: 'Turn finish', toolRef: FLAT_ID, stepover: 0.32, stepdown: 3.175, stockToLeaveRadial: 0,
    }],
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

// ── B, 4b, 4c: the material the cutters leave on the facets ────────────────
//
// Independent of the generator: a point on a facet plane, a ray from it along
// the facet's outward normal, and every pose of every cut move's tool body --
// a ball is its sphere plus the shank above its centre, a flat the cylinder
// from its tip outward, both on the radial tool axis at the pose's A. The
// material left at the point is how far up the ray the first body starts; a
// body that reaches below the plane is a gouge.

interface Pose {
  readonly x: number
  readonly angle: number
  readonly tip: number
  readonly radius: number
  readonly ball: boolean
  /** The tool axis's direction in the bar's cross-section. */
  readonly av: number
  readonly aw: number
}

interface PoseIndex {
  readonly cells: Map<number, Pose[]>
  readonly maxRadius: number
}

const POSE_ALONG_BIN = 0.25
const POSE_ANGLE_BIN = 2

const poseKey = (alongBin: number, angleBin: number): number => alongBin * 1000 + angleBin

/** Every pose the cut and plunge moves pass through, no coarser than 0.5 deg and 0.05 mm. */
function posesOf(result: ToolpathResult, stock: BarStock, tool: NormalizedTool, index: PoseIndex): void {
  const pivot = barPivotZ(stock)
  for (const move of result.moves) {
    if (move.kind === 'rapid' || move.from.a === undefined || move.to.a === undefined) continue
    const fromX = stock.axis === 'x' ? move.from.x : move.from.y
    const toX = stock.axis === 'x' ? move.to.x : move.to.y
    const fromTip = move.from.z - pivot
    const toTip = move.to.z - pivot
    const steps = Math.max(1, Math.ceil(Math.abs(move.to.a - move.from.a) / 0.5),
      Math.ceil(Math.abs(toX - fromX) / 0.05), Math.ceil(Math.abs(toTip - fromTip) / 0.05))
    for (let step = 0; step <= steps; step++) {
      const f = step / steps
      const angle = (((move.from.a + (move.to.a - move.from.a) * f) % 360) + 360) % 360
      const pose: Pose = {
        x: fromX + (toX - fromX) * f,
        angle,
        tip: fromTip + (toTip - fromTip) * f,
        radius: tool.radius,
        ball: tool.type === 'ball_endmill',
        av: Math.cos((angle * Math.PI) / 180),
        aw: Math.sin((angle * Math.PI) / 180),
      }
      const key = poseKey(Math.floor(pose.x / POSE_ALONG_BIN), Math.floor(pose.angle / POSE_ANGLE_BIN))
      const cell = index.cells.get(key)
      if (cell) cell.push(pose)
      else index.cells.set(key, [pose])
    }
  }
}

function poseIndex(runs: ReadonlyArray<{ result: ToolpathResult; tool: NormalizedTool }>, stock: BarStock): PoseIndex {
  const index: PoseIndex = { cells: new Map(), maxRadius: Math.max(...runs.map((entry) => entry.tool.radius)) }
  for (const entry of runs) posesOf(entry.result, stock, entry.tool, index)
  return index
}

/** What one facet point has collected so far: material left above it, depth reached below. */
interface RayTally {
  left: number
  gouge: number
}

/** One `h` interval of a body on the ray, folded into the tally. */
function tallyPiece(tally: RayTally, low: number, high: number): void {
  if (!(high > low) || high < -1) return
  if (high >= 0 && Math.max(0, low) < tally.left) tally.left = Math.max(0, low)
  if (low < 0 && Math.min(1, -low) > tally.gouge) tally.gouge = Math.min(1, -low)
}

/**
 * One pose's body on the ray `P + h n`: the sphere (a ball) and the cylinder
 * about the tool axis from `start` outward (a ball's shank above its centre, a
 * flat's whole body from its tip). `dx` is the point's along offset from the
 * pose, `(pv, pw)` and `(nv, nw)` the point and the normal in the cross-section.
 */
function tallyPose(tally: RayTally, pose: Pose, dx: number, pv: number, pw: number, nv: number, nw: number): void {
  const { av, aw } = pose
  const r = pose.radius
  const s0 = pv * av + pw * aw
  const k = nv * av + nw * aw
  const pn = pv * nv + pw * nw
  const start = pose.ball ? pose.tip + r : pose.tip
  if (pose.ball) {
    const qv = pv - start * av
    const qw = pw - start * aw
    const half = qv * nv + qw * nw
    const disc = half * half - (dx * dx + qv * qv + qw * qw - r * r)
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      tallyPiece(tally, -half - sq, -half + sq)
    }
  }
  // The cylinder: perp^2 = (1 - k^2) h^2 + 2 (pn - s0 k) h + (dx^2 + |P|^2 - s0^2) <= r^2.
  const alpha = 1 - k * k
  const beta = 2 * (pn - s0 * k)
  const gamma = dx * dx + pv * pv + pw * pw - s0 * s0 - r * r
  let low: number
  let high: number
  if (alpha < 1e-12) {
    if (gamma > 0) return
    low = Number.NEGATIVE_INFINITY
    high = Number.POSITIVE_INFINITY
  } else {
    const disc = beta * beta - 4 * alpha * gamma
    if (disc < 0) return
    const sq = Math.sqrt(disc)
    low = (-beta - sq) / (2 * alpha)
    high = (-beta + sq) / (2 * alpha)
  }
  if (Math.abs(k) < 1e-12) {
    if (s0 < start) return
  } else if (k > 0) {
    low = Math.max(low, (start - s0) / k)
  } else {
    high = Math.min(high, (start - s0) / k)
  }
  tallyPiece(tally, low, high)
}

/** The material left above one facet point, and how deep the bodies reach below it. */
function leftAt(index: PoseIndex, x: number, pv: number, pw: number, nv: number, nw: number): RayTally {
  const reach = index.maxRadius + 0.5
  const polar = (Math.atan2(pw, pv) * 180) / Math.PI
  const spread = (Math.asin(Math.min(1, reach / Math.max(Math.hypot(pv, pw) - 0.5, reach))) * 180) / Math.PI + POSE_ANGLE_BIN
  const tally: RayTally = { left: Number.POSITIVE_INFINITY, gouge: 0 }
  const bins = Math.ceil(360 / POSE_ANGLE_BIN)
  for (let a = Math.floor((x - reach) / POSE_ALONG_BIN); a <= Math.floor((x + reach) / POSE_ALONG_BIN); a++) {
    for (let b = Math.floor((polar - spread) / POSE_ANGLE_BIN); b <= Math.floor((polar + spread) / POSE_ANGLE_BIN); b++) {
      const cell = index.cells.get(poseKey(a, ((b % bins) + bins) % bins))
      if (!cell) continue
      for (const pose of cell) {
        const dx = x - pose.x
        if (dx > pose.radius || dx < -pose.radius) continue
        tallyPose(tally, pose, dx, pv, pw, nv, nw)
      }
    }
  }
  return tally
}

interface FacetSurvey {
  /** The most material left anywhere, and where. */
  readonly worst: number
  readonly worstAt: string
  /** The deepest any body reaches below a facet. */
  readonly gouge: number
  readonly gougeAt: string
  readonly points: number
}

/**
 * Every facet plane over `[fromX, toX]`, across its whole width (vertex to
 * vertex, both corners included), every 0.05 mm along and 0.2 mm across.
 */
function surveyFacets(index: PoseIndex, fromX: number, toX: number): FacetSurvey {
  const half = HEX_APOTHEM * Math.tan(Math.PI / 6)
  let worst = 0
  let worstAt = ''
  let gouge = 0
  let gougeAt = ''
  let points = 0
  for (let facet = 0; facet < 6; facet++) {
    const normal = ((phaseDeg + 60 * facet) * Math.PI) / 180
    const nv = Math.cos(normal)
    const nw = Math.sin(normal)
    const across = Math.ceil((2 * half) / 0.2)
    for (let ix = 0; ix <= Math.round((toX - fromX) / 0.05); ix++) {
      const x = Math.min(toX, fromX + ix * 0.05)
      for (let iu = 0; iu <= across; iu++) {
        const u = -half + (2 * half * iu) / across
        const pv = HEX_APOTHEM * nv - u * nw
        const pw = HEX_APOTHEM * nw + u * nv
        const at = leftAt(index, x, pv, pw, nv, nw)
        points++
        const where = `facet ${facet} X${x.toFixed(2)} u${u.toFixed(2)}`
        if (at.left > worst) {
          worst = at.left
          worstAt = where
        }
        if (at.gouge > gouge) {
          gouge = at.gouge
          gougeAt = where
        }
      }
    }
  }
  return { worst, worstAt, gouge, gougeAt, points }
}

function checkFacets(index: PoseIndex, fromX: number, toX: number, label: string): FacetSurvey {
  const survey = surveyFacets(index, fromX, toX)
  assert.ok(Number.isFinite(survey.worst), `${label}: every facet point is reached by a cutter`)
  assert.ok(survey.worst <= RESIDUAL,
    `${label}: ${survey.worst.toFixed(4)} mm left above the facet at ${survey.worstAt} (bound ${RESIDUAL})`)
  assert.ok(survey.gouge <= -GOUGE,
    `${label}: a cutter reaches ${survey.gouge.toFixed(4)} mm below the facet at ${survey.gougeAt}`)
  return survey
}

function run(rotationDeg: number): void {
  const { project, operation, others } = boltFixture(rotationDeg)
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

  // **B**: the finish alone leaves no more than 0.05 mm on any facet, across its
  // whole width, corners included, at three stretches of the band (each 1.2 mm,
  // more than two helix pitches long).
  const finishIndex = poseIndex([{ result, tool }], stock)
  for (const from of [21, 24.5, 27.4]) {
    const survey = checkFacets(finishIndex, from, from + 1.2, `${label} B X${from}`)
    console.log(`  ${label} B X${from}..${from + 1.2}: worst ${survey.worst.toFixed(4)} mm at ${survey.worstAt}, `
      + `deepest ${survey.gouge.toFixed(4)} mm, ${survey.points} points`)
  }

  // The full rotary sequence: the Hex rough and finish, then the Turn rough and
  // finish, which cut the Hex down to its shoulder face at X30.48.
  const sequence = [{ result, tool }, ...others.map((other) => ({
    result: generate(project, other),
    tool: toolOf(project, other),
  }))]
  for (const entry of sequence) assert.ok(entry.result.moves.length > 0, `${label}: every operation of the sequence cuts`)
  const all = poseIndex(sequence, stock)

  // **4b**: every facet from X28 to the shoulder face.
  const shoulder = checkFacets(all, 28, SHOULDER - 0.01, `${label} 4b`)
  console.log(`  ${label} 4b X28..shoulder: worst ${shoulder.worst.toFixed(4)} mm at ${shoulder.worstAt}, `
    + `deepest ${shoulder.gouge.toFixed(4)} mm`)
  // No cutter enters the shoulder: just behind the face the Hex is solid from the
  // Turn's radius out to the facets, and no body may reach into it.
  let shoulderHits = 0
  let shoulderChecked = 0
  for (const behind of [0.02, 0.1, 0.25]) {
    for (let angle = 0; angle < 360; angle += 1) {
      const facetDelta = (facetOffset(angle) * Math.PI) / 180
      const outer = HEX_APOTHEM / Math.cos(facetDelta) - 0.02
      for (let radius = 12.7 + 0.05; radius < outer; radius += 0.25) {
        const t = (angle * Math.PI) / 180
        const pv = radius * Math.cos(t)
        const pw = radius * Math.sin(t)
        shoulderChecked++
        // The point is inside a body when a ray through it along any direction
        // has `h = 0` in a body piece; the radial direction is enough.
        const at = leftAt(all, SHOULDER - behind, pv, pw, Math.cos(t), Math.sin(t))
        if (at.left === 0 && at.gouge > 1e-6) shoulderHits++
      }
    }
  }
  assert.equal(shoulderHits, 0, `${label} 4b: no cutter enters the Hex behind its shoulder face (${shoulderChecked} points)`)

  // **4c**: the wall-foot band at **both** Hex ends -- the chuck end against the
  // uncut bar and the shoulder end -- is clean, and the two ends match.
  // One cutter radius plus the finish's own cell (`rotaryOperation`'s rule).
  const band = tool.radius + Math.min(tool.radius / 3, (operation.stepover ?? 0.5) * tool.diameter * 0.5)
  const chuck = checkFacets(all, HEX_START, HEX_START + band, `${label} 4c chuck end`)
  const far = checkFacets(all, SHOULDER - band, SHOULDER - 0.01, `${label} 4c shoulder end`)
  assert.ok(Math.abs(chuck.worst - far.worst) <= 0.02,
    `${label} 4c: the two ends match (${chuck.worst.toFixed(4)} at the chuck, ${far.worst.toFixed(4)} at the shoulder)`)
  console.log(`  ${label} 4c: chuck end ${chuck.worst.toFixed(4)} mm (${chuck.worstAt}), `
    + `shoulder end ${far.worst.toFixed(4)} mm (${far.worstAt}), band ${band.toFixed(4)} mm`)
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
