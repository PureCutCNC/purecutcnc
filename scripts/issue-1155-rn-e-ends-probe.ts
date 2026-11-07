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
 * #1155 rn-e: what a rotary operation leaves at its target's own ends.
 *
 * Usage:
 *   npx tsx scripts/issue-1155-rn-e-ends-probe.ts [project.camj [ops...]]
 *
 * With no argument it builds the handoff's fixtures in code:
 *  - the Hex 0.75..1.25 (across flats 1.5) over the bar, ball rough + finish,
 *    measured against the analytic Hex at both of its ends;
 *  - the Turn 1.25..3.75 (the Hex's end face) with the flat rough at leave 0 and
 *    0.02, reporting each layer's first cut and the material left on the Hex
 *    face below the flats.
 *
 * The ridge is measured with the cutter's own body (`src/test/rotaryWallFootSweep.ts`):
 * one radial profile per degree, the profile starting at the blank the operation
 * sees, swept by every cutter pose, and the first along position at which the
 * material comes down to the target's surface read off it.
 */

import { readFileSync } from 'node:fs'

import type { BarStock, Operation, Project, Tool } from '../src/types/project'
import { defaultTool, newProject, roundStock } from '../src/types/project'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { isBarStock } from '../src/types/barStock'
import { barMaxRadius } from '../src/types/barStock'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import type { NormalizedTool, ToolpathMove } from '../src/engine/toolpaths/types'
import { defaultOperationForTarget } from '../src/store/helpers/operationDefaults'
import { planRotarySolid } from '../src/store/helpers/rotarySolids'
import type { SelectionState } from '../src/store/types'
import { minRenderHeight } from '../src/engine/csg'
import { blankProfile, cutterPosesByAngle, sweepProfile } from '../src/test/rotaryWallFootSweep'

const EMPTY_SELECTION = {
  mode: 'feature', selectedFeatureId: null, selectedFeatureIds: [], selectedTabIds: [],
  selectedClampIds: [], selectedNode: null, hoveredFeatureId: null, sketchEditTool: null,
  activeControl: null, groupFolderId: null,
} as unknown as SelectionState

const BAR_DIAMETER = 2
const BAR_LENGTH = 4
const HEX_START = 0.75
const HEX_LENGTH = 0.5
const HEX_ACROSS_FLATS = 1.5
const HEX_SIDES = 6
const HEX_END = HEX_START + HEX_LENGTH
const TURN_DIAMETER = 1
const FLAT_TOOL_ID = 'flat-025'
const BALL_TOOL_ID = 'ball-025'
const BALL_TOOL_ID_8 = 'ball-0125'

function boltTools(): Tool[] {
  return [
    {
      ...defaultTool('inch', 1), id: FLAT_TOOL_ID, name: '1/4" Endmill', type: 'flat_endmill',
      diameter: 0.25, defaultStepover: 0.32, defaultStepdown: 0.125,
    },
    {
      ...defaultTool('inch', 1), id: BALL_TOOL_ID, name: '1/4" Ball Endmill', type: 'ball_endmill',
      diameter: 0.25, defaultStepover: 0.16, defaultStepdown: 0.075,
    },
    {
      ...defaultTool('inch', 1), id: BALL_TOOL_ID_8, name: '1/8" Ball Endmill', type: 'ball_endmill',
      diameter: 0.125, defaultStepover: 0.16, defaultStepdown: 0.03,
    },
  ] as Tool[]
}

function boltProject(name: string): Project {
  const base = newProject(name, 'inch')
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 2
  base.stock = roundStock(BAR_DIAMETER, BAR_LENGTH, 'x')
  base.tools = boltTools()
  base.setups.push({
    ...base.setups[0], id: 'around', name: 'Around', kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  base.activeSetupId = 'around'
  return base
}

function boltFixture(turnStart: number): { project: Project; turnId: string; hexId: string } {
  const base = boltProject('rn-e ends probe')
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: turnStart, length: 3.75 - turnStart, diameter: TURN_DIAMETER,
  })
  if (!turn.ok) throw new Error(`the Turn must plan: ${turn.reason}`)
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: HEX_SIDES,
    acrossFlats: HEX_ACROSS_FLATS, rotationDeg: 0,
  })
  if (!hex.ok) throw new Error(`the Hex must plan: ${hex.reason}`)
  return { project: hex.project, turnId: turn.created.featureId, hexId: hex.created.featureId }
}

function rotaryOperation(
  project: Project,
  featureIds: readonly string[],
  kind: 'rotary_rough' | 'rotary_finish',
  patch: Partial<Operation>,
): Operation {
  return {
    ...defaultOperationForTarget(
      project, kind, kind === 'rotary_rough' ? 'rough' : 'finish',
      { source: 'features', featureIds: [...featureIds] }, project.operations.length + 1,
    ),
    setupId: 'around',
    rotaryPassDirection: 'around',
    ...patch,
  }
}

function generate(project: Project, operation: Operation): ToolpathMove[] {
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope) throw new Error(`${operation.name} does not dispatch to the rotary generator`)
  return envelope.result.moves
}

function toolOf(project: Project, operation: Operation): NormalizedTool {
  const record = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!record) throw new Error(`${operation.name} has no tool`)
  return normalizeToolForProject(record, project)
}

function movesSummary(moves: readonly ToolpathMove[]): { total: number; ring: number; helix: number } {
  let ring = 0
  let helix = 0
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const da = Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))
    const dl = Math.abs(move.to.x - move.from.x) + Math.abs(move.to.y - move.from.y)
    if (da >= 360 || (da > 1e-9 && dl > 1e-9)) helix++
    else if (da > 1e-9) ring++
  }
  return { total: moves.length, ring, helix }
}

/** The Hex's own surface radius at one physical angle, for a flat-up hexagon. */
function hexRadius(angleDeg: number): number {
  const apothem = HEX_ACROSS_FLATS / 2
  const sector = 360 / HEX_SIDES
  // Flat-up: the apothem faces A0, so the radius runs from the apothem to the
  // corner every half sector.
  const local = ((angleDeg % sector) + sector) % sector
  const off = Math.abs(local - sector / 2)
  return apothem / Math.cos((off * Math.PI) / 180)
}

/**
 * The material the operation leaves above the Hex's own surface at one of its
 * ends: for each angle, the along width from the end face to the first position
 * where the swept material is at the Hex surface, and the highest material left
 * inside that band.
 */
function hexEndLeftover(
  moves: readonly ToolpathMove[],
  project: Project,
  operation: Operation,
  end: number,
  direction: 1 | -1,
): { width: number; height: number; worstAngle: number; angles: number } {
  const stock = project.stock as BarStock
  const tool = toolOf(project, operation)
  const tolerance = minRenderHeight(project.meta.units) + (operation.stockToLeaveRadial ?? 0)
  const span = 3 * tool.radius
  const from = direction > 0 ? end - span / 2 : end - span * 2.5
  const to = direction > 0 ? end + span * 2.5 : end + span / 2
  const angles = cutterPosesByAngle(moves, stock, tool)
  let width = 0
  let height = 0
  let worstAngle = 0
  for (const entry of angles) {
    // The blank the op sees: the bar at every position. The Hex is the shape
    // the operation leaves, so material it does not reach stays at the bar.
    const base = blankProfile(stock, from, to, tool, end)
    const swept = sweepProfile(base, entry.poses, tool, entry.angle)
    // The ridge is the band beside the end face that no cut reaches at all: the
    // material there still stands at the blank. Measuring "down to the target"
    // instead would read the ball's own scallop as a ridge everywhere.
    const blank = barMaxRadius(stock)
    const clearedBelow = blank - Math.max(tolerance, 1e-3)
    let edge = end + direction * span * 2
    let highest = 0
    let found = false
    for (let i = 0; i < swept.along.length; i++) {
      const along = swept.along[i]
      if (direction > 0 ? along < end - 1e-12 : along > end + 1e-12) continue
      if (direction > 0 && along > end + span * 2) break
      if (direction < 0 && along < end - span * 2) break
      if (!found && swept.top[i] < clearedBelow) {
        edge = along
        found = true
        continue
      }
      if (!found && swept.top[i] - hexRadius(entry.angle) > highest) highest = swept.top[i] - hexRadius(entry.angle)
    }
    const measured = direction > 0 ? edge - end : end - edge
    if (measured > width + 1e-12) {
      width = measured
      height = highest
      worstAngle = entry.angle
    }
  }
  return { width, height, worstAngle, angles: angles.length }
}

/** Each rough layer's first cutting along position, from the moves. */
function layerFirstCuts(moves: readonly ToolpathMove[], stock: BarStock, pivot: number): Map<number, number> {
  const firsts = new Map<number, number>()
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const along = stock.axis === 'x' ? move.to.x : move.to.y
    const z = move.to.z
    const key = Math.round((z - pivot) * 1e4) / 1e4
    const current = firsts.get(key)
    if (current === undefined || along < current) firsts.set(key, along)
  }
  return new Map([...firsts.entries()].filter(([key]) => key > 0).sort((a, b) => b[0] - a[0]))
}

function reportHexEnds(project: Project, operation: Operation, label: string): void {
  const stock = project.stock as BarStock
  const started = performance.now()
  const moves = generate(project, operation)
  const ms = performance.now() - started
  const summary = movesSummary(moves)
  const near = hexEndLeftover(moves, project, operation, HEX_START, 1)
  const far = hexEndLeftover(moves, project, operation, HEX_END, -1)
  console.log(`${label}: ${summary.total} moves (${summary.ring} ring, ${summary.helix} helix), ${ms.toFixed(0)} ms`)
  console.log(`  near end ${HEX_START}: ridge ${near.width.toFixed(5)} in wide, `
    + `worst ${near.height.toFixed(5)} in above the Hex at A${near.worstAngle}° (${near.angles} angles)`)
  console.log(`  far end ${HEX_END}: ridge ${far.width.toFixed(5)} in wide, `
    + `worst ${far.height.toFixed(5)} in above the Hex at A${far.worstAngle}° (${far.angles} angles)`)
  void stock
}

function reportTurnFace(project: Project, operation: Operation, label: string): void {
  const stock = project.stock as BarStock
  const started = performance.now()
  const moves = generate(project, operation)
  const ms = performance.now() - started
  if (process.env.RN_E_DEBUG) {
    const shown = moves.filter((m) => m.kind !== 'rapid' && m.to.x <= 1.6 && m.to.x >= 1.2 && m.to.z - 1 <= 0.56).slice(0, 24)
    for (const m of shown) {
      console.log(`   dbg ${m.kind} ${m.from.x.toFixed(5)}->${m.to.x.toFixed(5)} z ${(m.from.z - 1).toFixed(5)}->${(m.to.z - 1).toFixed(5)} a ${(m.from.a ?? 0).toFixed(2)}->${(m.to.a ?? 0).toFixed(2)}`)
    }
  }
  const summary = movesSummary(moves)
  const pivot = stock.profile.start.y + BAR_DIAMETER / 2
  const layers = layerFirstCuts(moves, stock, pivot)
  console.log(`${label}: ${summary.total} moves (${summary.ring} ring, ${summary.helix} helix), ${ms.toFixed(0)} ms`)
  console.log(`  layer first cuts: ${[...layers.entries()].slice(0, 8).map(([z, x]) => `${z.toFixed(3)}@${x.toFixed(5)}`).join(' ')}`)
  // The material left on the Hex's face below its flats: the profile swept from
  // the Turn's own surface, read from the face outwards.
  const tool = toolOf(project, operation)
  const tolerance = minRenderHeight(project.meta.units)
  const leave = operation.stockToLeaveRadial ?? 0
  const level = TURN_DIAMETER / 2 + leave
  const from = HEX_END - 0.5
  const to = HEX_END + 0.5
  const angles = cutterPosesByAngle(moves, stock, tool)
  let worst = 0
  let worstAngle = 0
  let edgeMax = 0
  for (const entry of angles) {
    const base = blankProfile(stock, from, to, tool, HEX_END + leave)
    for (let i = 0; i < base.along.length; i++) {
      const along = base.along[i]
      if (along < HEX_END) base.top[i] = hexRadius(entry.angle)
      else base.top[i] = barMaxRadius(stock)
    }
    const swept = sweepProfile(base, entry.poses, tool, entry.angle)
    // From the leave boundary outwards: the first position at or below the level.
    let edge = HEX_END + leave + 2 * tool.radius
    let cleared = false
    let highest = 0
    for (let i = 0; i < swept.along.length; i++) {
      const along = swept.along[i]
      if (along < HEX_END + leave - 1e-12) continue
      if (along > HEX_END + leave + 2 * tool.radius) break
      if (!cleared && swept.top[i] <= level + tolerance) {
        edge = along
        cleared = true
      }
      if (!cleared && swept.top[i] > highest) highest = swept.top[i]
    }
    const ledge = edge - (HEX_END + leave)
    if (ledge > edgeMax) edgeMax = ledge
    if (highest - level > worst) {
      worst = highest - level
      worstAngle = entry.angle
    }
  }
  console.log(`  ledge past the face ${edgeMax.toFixed(5)} in; highest leftover above the Turn level `
    + `${worst.toFixed(5)} in at A${worstAngle}°`)
}

function fromFixture(): void {
  const case1 = boltFixture(1.2)
  const ballRough = rotaryOperation(case1.project, [case1.hexId], 'rotary_rough', {
    name: 'hex ball rough', toolRef: BALL_TOOL_ID, stepover: 0.16, stepdown: 0.075, stockToLeaveRadial: 0.02,
  })
  const ballFinish = rotaryOperation(case1.project, [case1.hexId], 'rotary_finish', {
    name: 'hex ball finish', toolRef: BALL_TOOL_ID_8, stepover: 0.16, stepdown: 0.03, stockToLeaveRadial: 0,
  })
  reportHexEnds(case1.project, ballRough, 'case 1 hex ball rough (leave 0.02)')
  reportHexEnds(case1.project, ballFinish, 'case 1 hex 1/8 ball finish')
  const flatFinishHex = rotaryOperation(case1.project, [case1.hexId], 'rotary_finish', {
    name: 'hex flat finish', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: 0,
  })
  reportHexEnds(case1.project, flatFinishHex, 'case 1 hex flat finish')

  for (const leave of [0, 0.02]) {
    const case2 = boltFixture(HEX_END)
    const turnRough = rotaryOperation(case2.project, [case2.turnId], 'rotary_rough', {
      name: `turn flat rough leave ${leave}`, toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
      stockToLeaveRadial: leave,
    })
    reportTurnFace(case2.project, turnRough, `case 2 turn flat rough (turn 1.25..3.75, leave ${leave})`)
    const turnFinish = rotaryOperation(case2.project, [case2.turnId], 'rotary_finish', {
      name: `turn flat finish leave ${leave}`, toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
      stockToLeaveRadial: leave,
    })
    reportTurnFace(case2.project, turnFinish, `case 2 turn flat finish (leave ${leave})`)
  }
}

function fromFile(path: string, wanted: string[]): void {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const project = normalizeProject(raw as Parameters<typeof normalizeProject>[0])
  if (!isBarStock(project.stock)) throw new Error('the project is not on a bar')
  const ids = wanted.length > 0 ? wanted : project.operations.filter((op) => op.enabled).map((op) => op.id)
  for (const id of ids) {
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`no operation ${id}`)
    if (operation.kind !== 'rotary_rough' && operation.kind !== 'rotary_finish') continue
    const target = operation.target
    const isHex = target.source === 'features' && target.featureIds.includes('f0184')
    if (isHex) reportHexEnds(project, operation, `${id} ${operation.name}`)
    else reportTurnFace(project, operation, `${id} ${operation.name}`)
  }
}

const [projectPath, ...ops] = process.argv.slice(2)
if (projectPath === undefined) fromFixture()
else fromFile(projectPath, ops)
