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
 * #1155 rn-d: the ledge a rotary around operation leaves at the foot of a
 * neighbour's wall, per angle, with the wall-foot ring and without it.
 *
 * Usage:
 *   npx tsx scripts/issue-1155-rn-d-ledge-probe.ts [project.camj [ops...]]
 *
 * With no argument it builds the handoff's partial-overlap fixture in code (the
 * Hex 0.75..1.25 over a Ø1 Turn 1.2..3.75 on a Ø2 in bar) and measures the flat
 * finish, the flat rough at 0.02 and at zero leave, and a ball finish. With a
 * file it measures that file's Turn operations, whose band starts beside the
 * Hex's far face.
 *
 * The measurement is `src/test/rotaryWallFootSweep.ts`, the same sweep the
 * committed test runs: one radial material profile per degree of A, cut by the
 * real cutter body at every emitted pose, and the leftover beside the wall read
 * off that profile. The ball finish is measured on the material the flat rough
 * leaves, because that is the job it runs in.
 */

import { readFileSync } from 'node:fs'

import type { BarStock, Operation, Project, Tool } from '../src/types/project'
import { defaultTool, newProject, roundStock } from '../src/types/project'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { isBarStock } from '../src/types/barStock'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import type { NormalizedTool, ToolpathMove } from '../src/engine/toolpaths/types'
import { defaultOperationForTarget } from '../src/store/helpers/operationDefaults'
import { planRotarySolid } from '../src/store/helpers/rotarySolids'
import type { SelectionState } from '../src/store/types'
import { minRenderHeight } from '../src/engine/csg'
import {
  blankProfile, cutterPosesByAngle, leftoverLevel, sweepProfile, wallFootLeftover, wallFootWindow,
} from '../src/test/rotaryWallFootSweep'
import type { WallFootProfile } from '../src/test/rotaryWallFootSweep'

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
const HEX_END = HEX_START + HEX_LENGTH
const TURN_START = 1.2
const TURN_LENGTH = 2.55
const TURN_DIAMETER = 1
const TURN_END = TURN_START + TURN_LENGTH
const FLAT_TOOL_ID = 'flat-025'
const BALL_TOOL_ID = 'ball-025'

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

function boltFixture(): { project: Project; turnId: string; hexId: string } {
  const base = boltProject('rn-d ledge probe')
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: TURN_DIAMETER,
  })
  if (!turn.ok) throw new Error(`the Turn must plan: ${turn.reason}`)
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: 6,
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

interface LedgerReport {
  readonly ledge: number
  readonly edgeGap: number
  readonly worstAngle: number
  readonly angles: number
}

/**
 * The leftover beside the wall over every angle of one operation. `previous` is
 * the material an earlier operation left, omitted for the first operation in the
 * job.
 */
function measure(
  project: Project,
  operation: Operation,
  previous: WallFootProfile | null,
): { report: LedgerReport; profile: WallFootProfile } {
  const stock = project.stock as BarStock
  const tool = toolOf(project, operation)
  const tolerance = minRenderHeight(project.meta.units)
  const leave = operation.stockToLeaveRadial ?? 0
  const moves = generate(project, operation)
  const window = wallFootWindow(HEX_END, tool, 1)
  const angles = cutterPosesByAngle(moves, stock, tool)
  let ledge = Number.NEGATIVE_INFINITY
  let edgeGap = Number.NEGATIVE_INFINITY
  let worstAngle = 0
  let profile: WallFootProfile | null = null
  for (const entry of angles) {
    const base = previous === null
      ? blankProfile(stock, window.from, window.to, tool, HEX_END + leave)
      : { along: previous.along, top: [...previous.top] }
    const swept = sweepProfile(base, entry.poses, tool)
    const leftover = wallFootLeftover(swept, HEX_END, 1, leftoverLevel(swept), leave, tolerance)
    if (leftover.ledge > ledge) {
      ledge = leftover.ledge
      worstAngle = entry.angle
    }
    if (leftover.edge - HEX_END > edgeGap) edgeGap = leftover.edge - HEX_END
    profile ??= swept
  }
  return {
    report: { ledge, edgeGap, worstAngle, angles: angles.length },
    profile: profile ?? blankProfile(stock, window.from, window.to, tool),
  }
}

function reportOperation(
  label: string,
  project: Project,
  operation: Operation,
  previous: WallFootProfile | null,
): WallFootProfile {
  const started = performance.now()
  const moves = generate(project, operation)
  const ms = performance.now() - started
  const tool = toolOf(project, operation)
  const summary = movesSummary(moves)
  const { report, profile } = measure(project, operation, previous)
  const leave = operation.stockToLeaveRadial ?? 0
  console.log(`${label}: ${summary.total} moves (${summary.ring} ring, ${summary.helix} helix), `
    + `${ms.toFixed(0)} ms; Ø${tool.diameter} ${tool.type}, leave ${leave}`)
  console.log(`  ledge max ${Number.isFinite(report.ledge) ? report.ledge.toFixed(5) : 'none'} in over `
    + `${report.angles} angles (worst A${report.worstAngle}°); edge past the face max `
    + `${report.edgeGap.toFixed(5)} in against the ${leave.toFixed(3)} leave`)
  return profile
}

function fromFixture(): void {
  const { project, turnId } = boltFixture()
  const finish = rotaryOperation(project, [turnId], 'rotary_finish', {
    name: 'flat finish (turn)', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: 0,
  })
  const rough = rotaryOperation(project, [turnId], 'rotary_rough', {
    name: 'flat rough (turn) leave 0.02', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
    stockToLeaveRadial: 0.02,
  })
  const roughZero = rotaryOperation(project, [turnId], 'rotary_rough', {
    name: 'flat rough (turn) leave 0', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
    stockToLeaveRadial: 0,
  })
  const ball = rotaryOperation(project, [turnId], 'rotary_finish', {
    name: 'ball finish (turn) leave 0', toolRef: BALL_TOOL_ID, stepover: 0.32, stepdown: 0.125,
    stockToLeaveRadial: 0,
  })
  reportOperation(finish.name, project, finish, null)
  const roughProfile = reportOperation(rough.name, project, rough, null)
  reportOperation(roughZero.name, project, roughZero, null)
  reportOperation(ball.name, project, ball, roughProfile)
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
    const isTurn = target.source === 'features' && target.featureIds.includes('f0186')
    if (!isTurn) {
      console.log(`${id} ${operation.name}: target `
        + `${target.source === 'features' ? target.featureIds.join('+') : target.source}`
        + ' (not the Turn, so its band has no wall foot to fix)')
      continue
    }
    reportOperation(`${id} ${operation.name}`, project, operation, null)
  }
}

const [projectPath, ...ops] = process.argv.slice(2)
if (projectPath === undefined) fromFixture()
else fromFile(projectPath, ops)
