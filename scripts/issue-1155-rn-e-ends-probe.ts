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
 *  - case 1: the Hex 0.75..1.25 (across flats 1.5) over the bar, ball rough +
 *    1/8" ball finish + flat finish, measured against the analytic Hex at both
 *    of its ends;
 *  - case 2: the Turn 1.25..3.75 (starting at the Hex's end face) with the flat
 *    rough and finish at leave 0 and 0.02, reporting the first full ring and the
 *    material left past the leave boundary.
 *
 * The measurement is the one the committed check
 * (`src/engine/toolpaths/rotaryTargetEnds.test.ts`) uses, out of the shared
 * helper `src/test/rotaryWallFootSweep.ts`:
 *
 *  - one radial material profile per whole degree, cut by every cutter pose the
 *    operation emits, so the cutter **body** is swept and not the generator's
 *    sampled heights;
 *  - a ball finish is measured on the material the **rough** left, because a
 *    ball's section cannot remove the overhang above its own band; measuring it
 *    on the untouched bar reported the whole uncharted shell as a ridge at the
 *    end (the review's "0.375 in wide, worst 0.16555 in above the Hex at A4°");
 *  - the **far** end is walked outwards from the end face, not inward from the
 *    window's lower edge, which is why the old probe reported a 0.75 in ridge
 *    there with a height of exactly zero: it broke out of its scan before
 *    reading a single position;
 *  - the ridge is read against the operation's **own interior** (`endRidge`), so
 *    the stepover scallop and the conservative sampler's lift cancel and only
 *    the extra material beside the end is measured.
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
import { barPivotZ } from '../src/types/barStock'
import {
  blankProfile, endRidge, resample, sweepByAngle,
} from '../src/test/rotaryWallFootSweep'
import type { SweptAngle, WallFootProfile } from '../src/test/rotaryWallFootSweep'

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
const HEX_APOTHEM = HEX_ACROSS_FLATS / 2
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

/** The along extent of the moves that actually cut. */
function cuttingSpan(moves: readonly ToolpathMove[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    min = Math.min(min, move.from.x, move.to.x)
    max = Math.max(max, move.from.x, move.to.x)
  }
  return { min, max }
}

/** The first full ring's along position and tip radius, or `null` when there is none. */
function firstRing(moves: readonly ToolpathMove[], stock: BarStock): { along: number; radius: number } | null {
  const pivot = barPivotZ(stock)
  let best: { along: number; radius: number } | null = null
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    if (Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) < 360) continue
    const along = Math.min(move.from.x, move.to.x)
    if (best === null || along < best.along) best = { along, radius: move.to.z - pivot }
  }
  return best
}

// ── case 1: the Hex's own ends ────────────────────────────────────────────

interface HexMaterial {
  readonly label: string
  /** The target's own along start and end, the band the operation is clamped to. */
  readonly start: number
  readonly end: number
  readonly swept: readonly SweptAngle[]
  readonly tool: NormalizedTool
  readonly moves: readonly ToolpathMove[]
  readonly ms: number
}

/**
 * The Hex's three operations on the material each actually runs on: the ball
 * rough on the bar, the 1/8" ball finish on the rough's material (resampled onto
 * the finish's own along grid), the flat finish on the bar.
 */
function hexMaterials(project: Project, hexId: string): HexMaterial[] {
  const stock = project.stock as BarStock
  const window = { from: HEX_START - 0.3, to: HEX_END + 0.3 }
  const rough = rotaryOperation(project, [hexId], 'rotary_rough', {
    name: 'hex ball rough', toolRef: BALL_TOOL_ID, stepover: 0.16, stepdown: 0.075, stockToLeaveRadial: 0.02,
  })
  const fine = rotaryOperation(project, [hexId], 'rotary_finish', {
    name: 'hex 1/8" ball finish', toolRef: BALL_TOOL_ID_8, stepover: 0.16, stepdown: 0.03, stockToLeaveRadial: 0,
  })
  const flat = rotaryOperation(project, [hexId], 'rotary_finish', {
    name: 'hex flat finish', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: 0,
  })
  const materials: HexMaterial[] = []
  // `ms` is the generation alone, the figure the handoff asks for; the sweep is
  // measurement and is not charged to the operation.
  let started = performance.now()
  const roughMoves = generate(project, rough)
  const roughMs = performance.now() - started
  const roughTool = toolOf(project, rough)
  const roughSwept = sweepByAngle(roughMoves, stock, roughTool, window, HEX_START)
  materials.push({ label: 'case 1 hex ball rough (leave 0.02)', start: HEX_START, end: HEX_END, swept: roughSwept, tool: roughTool, moves: roughMoves, ms: roughMs })
  const roughByAngle = new Map(roughSwept.map((entry) => [entry.angle, entry.profile]))
  started = performance.now()
  const fineMoves = generate(project, fine)
  const fineMs = performance.now() - started
  const fineTool = toolOf(project, fine)
  const fineGrid = blankProfile(stock, window.from, window.to, fineTool, HEX_START).along
  const fineSwept = sweepByAngle(fineMoves, stock, fineTool, window, HEX_START, (angle) => {
    const left = roughByAngle.get(angle)
    return left === undefined ? null : resample(left, fineGrid)
  })
  materials.push({ label: 'case 1 hex 1/8" ball finish (on the rough\'s material)', start: HEX_START, end: HEX_END, swept: fineSwept, tool: fineTool, moves: fineMoves, ms: fineMs })
  started = performance.now()
  const flatMoves = generate(project, flat)
  const flatMs = performance.now() - started
  const flatTool = toolOf(project, flat)
  materials.push({
    label: 'case 1 hex flat finish', start: HEX_START, end: HEX_END,
    swept: sweepByAngle(flatMoves, stock, flatTool, window, HEX_START),
    tool: flatTool, moves: flatMoves, ms: flatMs,
  })
  return materials
}

function reportHexEnds(material: HexMaterial, turnStart: number | null): void {
  const summary = movesSummary(material.moves)
  const span = cuttingSpan(material.moves)
  const tolerance = minRenderHeight('inch')
  const length = material.end - material.start
  const interiorOf = (radius: number) => ({ from: 1.5 * radius, to: length - 1.5 * radius })
  const interior = interiorOf(material.tool.radius)
  console.log(`${material.label}: ${summary.total} moves (${summary.ring} ring, ${summary.helix} helix), `
    + `${material.ms.toFixed(0)} ms`)
  console.log(`  cutting along ${span.min.toFixed(5)}..${span.max.toFixed(5)} in (the model is `
    + `${material.start}..${material.end})`)
  for (const [end, direction] of [[material.start, 1], [material.end, -1]] as const) {
    const ridge = endRidge(material.swept, end, direction, 2 * material.tool.radius, interior, tolerance)
    console.log(`  ${direction > 0 ? 'near' : 'far '} end ${end}: ridge ${ridge.width.toFixed(5)} in wide, `
      + `${ridge.height.toFixed(5)} in above the operation's own interior (worst A${ridge.angle}°)`)
  }
  if (turnStart !== null && turnStart < material.end) {
    console.log(`  far neighbour: the Turn's face is at ${turnStart.toFixed(5)} in, but its surface `
      + `(${(TURN_DIAMETER / 2).toFixed(5)} in radius) is below the Hex's apothem `
      + `(${HEX_APOTHEM.toFixed(5)} in), so it is not a wall: the model cuts to ${material.end} in`)
  }
}

// ── case 2: the Turn starting at the Hex's face ───────────────────────────

function reportTurnFace(project: Project, operation: Operation, face: number, leave: number, label = operation.name): void {
  const stock = project.stock as BarStock
  const pivot = barPivotZ(stock)
  const started = performance.now()
  const moves = generate(project, operation)
  const ms = performance.now() - started
  const tool = toolOf(project, operation)
  const summary = movesSummary(moves)
  const level = TURN_DIAMETER / 2 + leave
  const foot = face + leave + tool.radius
  const ring = firstRing(moves, stock)
  // The deepest ring at the foot: the rough has one per layer, the finish one.
  let deepest: number | null = null
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    if (Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) < 360) continue
    if (ring !== null && Math.abs(move.to.x - ring.along) > 0.001) continue
    const radius = move.to.z - pivot
    if (deepest === null || radius < deepest) deepest = radius
  }
  console.log(`${label}: ${summary.total} moves (${summary.ring} ring, ${summary.helix} helix), ${ms.toFixed(0)} ms`)
  console.log(`  first full ring along ${ring === null ? 'none' : ring.along.toFixed(5)} in`
    + `${deepest === null ? '' : `, its deepest ring at z ${deepest.toFixed(5)} in`} (the wall's foot is `
    + `${face.toFixed(5)} + ${leave.toFixed(5)} leave + ${tool.radius.toFixed(5)} radius = ${foot.toFixed(5)} in, `
    + `the surface ${level.toFixed(5)} in)`)
  if (ring !== null) {
    console.log(`  cutter body stands ${(ring.along - tool.radius - face).toFixed(5)} in off the neighbour's `
      + `face ${face.toFixed(5)} in (the leave is ${leave.toFixed(5)} in)`)
  }
  const window = { from: face - 0.5, to: face + 0.5 }
  const swept = sweepByAngle(moves, stock, tool, window, face)
  const tolerance = minRenderHeight('inch')
  const interior = { from: 2 * tool.radius, to: 2 * tool.radius + 0.5 }
  const boundary = face + leave + 0.002
  const ridge = endRidge(swept, boundary, 1, 2 * tool.radius, interior, tolerance)
  console.log(`  leftover past the leave boundary ${boundary.toFixed(5)} in: `
    + `${ridge.height.toFixed(5)} in above the operation's own interior (worst A${ridge.angle}°)`)
}

// ── the two fixtures ──────────────────────────────────────────────────────

function fromFixture(): void {
  const case1 = boltFixture(1.2)
  for (const material of hexMaterials(case1.project, case1.hexId)) {
    reportHexEnds(material, 1.2)
  }
  for (const leave of [0, 0.02]) {
    const case2 = boltFixture(HEX_END)
    for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
      const operation = rotaryOperation(case2.project, [case2.turnId], kind, {
        name: `case 2 turn flat ${kind} (turn ${HEX_END}..3.75, leave ${leave})`,
        toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: leave,
      })
      reportTurnFace(case2.project, operation, HEX_END, leave)
    }
  }
}

// ── a saved project ───────────────────────────────────────────────────────

/** One rotary model feature's along extent, read off its own sheet profile. */
interface FeatureExtent {
  readonly id: string
  readonly kind: string
  readonly min: number
  readonly max: number
}

function featureExtents(project: Project, axis: 'x' | 'y'): FeatureExtent[] {
  const extents: FeatureExtent[] = []
  for (const feature of project.features) {
    const definition = project.featureDefinitions[feature.definitionId]
    if (!definition) continue
    const canned = (definition as { canned?: { kind?: string } }).canned
    if (canned?.kind === undefined) continue
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    const profile = (definition as { profile?: { start?: { x?: number; y?: number }; segments?: Array<{ to?: { x?: number; y?: number } }> } }).profile
    const points = [profile?.start, ...(profile?.segments ?? []).map((segment) => segment.to)]
    for (const point of points) {
      const value = point === undefined ? undefined : point[axis]
      if (value === undefined) continue
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue
    extents.push({ id: feature.id, kind: canned.kind, min, max })
  }
  return extents
}

/**
 * The face a turn operation's band starts against: the **polygon** neighbour's
 * end that stands at or before the cutter's flank. That is the wall this probe
 * is about (a Turn against the Hex); a Turn against another turned feature is
 * not modelled here.
 */
function faceBefore(extents: readonly FeatureExtent[], flank: number): number {
  let face = Number.NEGATIVE_INFINITY
  for (const extent of extents) {
    if (extent.kind !== 'polygon') continue
    for (const end of [extent.min, extent.max]) {
      if (end <= flank + 1e-9 && end > face) face = end
    }
  }
  return Number.isFinite(face) ? face : Number.NaN
}

function fromFile(path: string, wanted: string[]): void {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const project = normalizeProject(raw as Parameters<typeof normalizeProject>[0])
  if (!isBarStock(project.stock)) throw new Error('the project is not on a bar')
  const stock = project.stock
  const axis = stock.axis
  const extents = featureExtents(project, axis)
  const ids = wanted.length > 0 ? wanted : project.operations.filter((op) => op.enabled).map((op) => op.id)
  for (const id of ids) {
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`no operation ${id}`)
    if (operation.kind !== 'rotary_rough' && operation.kind !== 'rotary_finish') continue
    if (operation.target.source !== 'features') continue
    const targetsPolygon = operation.target.featureIds.some((targetId) => {
      const extent = extents.find((candidate) => candidate.id === targetId)
      return extent?.kind === 'polygon'
    })
    const started = performance.now()
    const moves = generate(project, operation)
    const ms = performance.now() - started
    const tool = toolOf(project, operation)
    if (targetsPolygon) {
      const target = extents.find((candidate) => operation.target.source === 'features'
        && operation.target.featureIds.includes(candidate.id) && candidate.kind === 'polygon')
      const start = target?.min ?? HEX_START
      const end = target?.max ?? HEX_END
      const window = { from: start - 0.3, to: end + 0.3 }
      reportHexEnds({
        label: `${id} ${operation.name}`, start, end,
        swept: sweepByAngle(moves, stock, tool, window, start),
        tool, moves, ms,
      }, null)
      continue
    }
    const ring = firstRing(moves, stock)
    const face = ring === null ? Number.NaN : faceBefore(extents, ring.along - tool.radius)
    reportTurnFace(project, operation, face, operation.stockToLeaveRadial ?? 0, `${id} ${operation.name}`)
  }
}

const [projectPath, ...ops] = process.argv.slice(2)
if (projectPath === undefined) fromFixture()
else fromFile(projectPath, ops)
