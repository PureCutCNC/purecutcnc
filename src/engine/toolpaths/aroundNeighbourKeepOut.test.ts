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
 * A Follow line on the Around face stops short of a neighbouring section that
 * stands above the surface it is cut on, and says so (issue #1112 slice rt6-e).
 *
 * Frank's bolt: a 30° V-bit Thread starting exactly where a Hex ends, both on
 * the same Ø0.75, cut 0.122 deep. Follow line put the tool centre on the guide
 * from end to end, so the V-bit's flank reached 0.033 into the Hex's end face.
 * The decision is **trim and warn** — a safety rule, not an option.
 *
 * Every case is built through the app's own creation actions (the Turn/Polygon
 * planner and the Thread/Flutes store action) and read back from the generated
 * toolpath, so the numbers are the ones a user's file produces.
 *
 * Mutations checked while writing this file (each re-broken on purpose, the
 * first assertion it broke quoted, then restored from a `cp` backup — never
 * `git checkout`):
 *   1. Ignore the neighbours (`isWall` always false) → the bolt fails first,
 *      "the Hex end face: 3.5, expected 3.53269 ± 0.00025": the cut runs to the
 *      guide's own end again, as it did before the fix.
 *   2. Use the cutter's radius for a V-bit instead of its width at the
 *      neighbour's surface → "the Hex end face: 3.5627, expected 3.53269":
 *      the bolt trims 0.0625 in instead of 0.0327 in.
 *   3. Drop the trim warning → "the start of the band is warned about": the
 *      trim itself still passes, which is why the warnings are asserted by
 *      their params rather than by counting moves.
 *   4. Treat a `body` as a wall only when it is strictly *above* the guide's
 *      surface → the same 3.5/3.53269 failure, because the Hex's Z top is
 *      level with the thread's surface: exactly the case this slice exists for.
 *
 * Correction round 1 (Codex review of the slice) added the mutations 5–7:
 *   5. Measure a stepped Turn by its single stored Z top again (the pre-fix
 *      `aroundMaterialBands`) → "a stepped Turn is two local surfaces, not one"
 *      and the thread on the small section is deleted with "nothing was cut".
 *   6. Make every equal-height `body` a wall again (`isWall` ignoring whether
 *      it supports the guide) → "a line on the Hex's own surface is cut, not
 *      deleted": no cut move survives.
 *   7. Drop the captured material read set from the cache stamp → "moving the
 *      larger neighbour must invalidate the cached path": `cacheInputsValid`
 *      keeps the stale endpoint, because the footprint narrowing cannot see a
 *      neighbour outside the guide's world-XY footprint.
 *
 * Correction round 2 (rt7-a, Frank's retest of rt6-e) added the mutations 8–10:
 *   8. Measure a body by its stored Z top again (the rt6-e
 *      `aroundMaterialBands`) → "the Hex end face: 3.5329, expected 3.5482":
 *      the 0.5625 across-flats radius is 0.087 in below the 0.6495 corner, so
 *      the trim falls back to 0.0327 and the V-bit cut 0.023 in into it.
 *   9. Keep the rt6-e supporting rule for `body` only, as it was → the
 *      circumferential line on the Turn is deleted again with "nothing was cut",
 *      because the Turn's surface is above the line's stored Z top.
 *   10. Make every *overlapping* band supporting instead of the bands that span
 *      the guide's whole along extent → the line crossing the Hex runs through
 *      it: "no cut may run through the Hex band".
 *
 * Run with: npx tsx src/engine/toolpaths/aroundNeighbourKeepOut.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultTool,
  roundStock,
  type Operation,
  type Project,
  type SketchFeature,
  type Tool,
} from '../../types/project'
import { newProject } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { useProjectStore } from '../../store/projectStore'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import type { SelectionState } from '../../store/types'
import { aroundFrameForOperation, aroundMaterialBands, unrolledProject } from '../aroundFrame'
import { computeOperationToolpath } from './generateOperation'
import { generateFollowLineToolpath } from './carving'
import { operationAffectedByChange, operationFootprint } from './toolpathDependencies'
import { cacheInputsValid, captureCacheInputs } from '../../app/toolpathGeneration/cacheInputs'
import type { TurnCannedProfile } from '../../cannedShapes/generators/turnProfile'
import { toolpathWarningText } from '../../i18n/warningText'
import type { ToolpathResult } from './types'

const store = () => useProjectStore.getState()

const EMPTY_SELECTION: SelectionState = {
  mode: 'feature',
  selectedFeatureId: null,
  selectedFeatureIds: [],
  selectedTabIds: [],
  selectedClampIds: [],
  selectedNode: null,
  hoveredFeatureId: null,
  sketchEditTool: null,
  activeControl: null,
  groupFolderId: null,
}

// ---------------------------------------------------------------------------
// The bolt: an inch Ø1 bar, a Hex then a Turn of the same Ø0.75, one Thread
// starting where the Hex ends, and the 30° V-bit that engraves it.
// ---------------------------------------------------------------------------

const BAR_DIAMETER = 1
const BAR_LENGTH = 4
const BAR_ORIGIN = { x: 2, y: 2 }
/** Along positions are absolute stock coordinates: the bar starts at x = 2. */
const BAR_START = BAR_ORIGIN.x
const MODEL_DIAMETER = 0.75
const HEX_START = 1
const HEX_LENGTH = 0.5
const TURN_START = 1.5
const TURN_LENGTH = 1.5
const THREAD_START = 1.5
const THREAD_LENGTH = 1.5
const THREAD_PITCH = 0.2
const THREAD_DEPTH = 0.122
const VBIT_DIAMETER = 0.125
const VBIT_INCLUDED_ANGLE = 30
/** The sheet's zero line (the bar's centreline) and one full wrap. */
const BAR_ZERO = BAR_ORIGIN.y + BAR_DIAMETER / 2
const CIRCUMFERENCE = Math.PI * BAR_DIAMETER

type SolidInput =
  | { kind: 'turn'; start: number; length: number; diameter: number; profile?: TurnCannedProfile }
  | {
    kind: 'polygon'
    start: number
    length: number
    sides: number
    acrossFlats: number
    /** Rotation about the bar's axis in degrees; 0 puts a flat up. */
    rotationDeg?: number
  }

interface CaseSpec {
  tools?: Tool[]
  solids: SolidInput[]
  /** The Thread/Flutes row, or null when the case draws its own line. */
  thread?: { start: number; length: number; depth: number } | null
  /** A hand-drawn Around line, given by its two sheet endpoints. */
  line?: { start: { x: number; y: number }; end: { x: number; y: number }; zTop: number } | null
  toolRef: string
  carveDepth: number
}

function inchTool(id: string, type: Tool['type'], diameter: number, vBitAngle: number | null = null): Tool {
  return {
    ...defaultTool('inch', 1),
    id,
    name: id,
    type,
    diameter,
    vBitAngle,
    maxCutDepth: 0.5,
  }
}

interface BarSpec {
  diameter: number
  length: number
  origin: { x: number; y: number }
}

const TEST_BAR: BarSpec = { diameter: BAR_DIAMETER, length: BAR_LENGTH, origin: BAR_ORIGIN }

function setUpProject(bar: BarSpec = TEST_BAR, tools?: Tool[]): Project {
  const project = newProject('around neighbours', 'inch')
  project.meta.projectType = 'rotary'
  project.meta.maxTravelZ = 3
  project.stock = roundStock(bar.diameter, bar.length, 'x', bar.origin)
  project.tools = tools ?? [
    inchTool('vbit', 'v_bit', VBIT_DIAMETER, VBIT_INCLUDED_ANGLE),
    inchTool('flat', 'flat_endmill', VBIT_DIAMETER),
  ]
  return project
}

/** One hand-drawn Around line, the way a user would draw it. */
function lineFeature(
  id: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  zTop: number,
  depth: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: {
        start,
        segments: [{ type: 'line', to: end }],
        closed: false,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'line',
    authoringFace: 'around',
    z_top: zTop,
    z_bottom: zTop - depth,
    visible: true,
    locked: false,
  }
}

/**
 * Build one case through the real actions: the solids through `planRotarySolid`,
 * the pattern through `addRotaryPattern`, the Follow line through
 * `addOperation`. Returns the project and the operation the app would generate.
 */
function buildCase(spec: CaseSpec): { project: Project; operation: Operation } {
  store().loadProject(setUpProject())
  assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available on a round bar')

  for (const solid of spec.solids) {
    const planned = planRotarySolid(store().project, EMPTY_SELECTION, solid)
    assert.ok(planned.ok, `the ${solid.kind} must be created (${planned.ok ? '' : planned.reason})`)
    store().loadProject(planned.project)
    // A load resets the workspace face to Top; the pattern is an Around entry.
    assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available after a write')
  }

  let targetId: string
  if (spec.thread) {
    const created = store().addRotaryPattern({
      kind: 'thread',
      start: spec.thread.start,
      length: spec.thread.length,
      pitch: THREAD_PITCH,
      starts: 1,
      depth: spec.thread.depth,
    })
    assert.ok(created.ok, `the Thread must be created (${created.ok ? '' : created.reason})`)
    targetId = created.featureId
  } else {
    const line = spec.line
    assert.ok(line, 'a case draws a Thread or a line')
    const feature = lineFeature('Around line', line.start, line.end, line.zTop, spec.carveDepth)
    const current = store().project
    store().loadProject({
      ...projectWithFeatures(current, [...current.features, feature]),
      featureTree: [...current.featureTree, { type: 'feature' as const, featureId: feature.id }],
    })
    assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available after a write')
    targetId = feature.id
  }

  const operationId = store().addOperation('follow_line', 'finish', { source: 'features', featureIds: [targetId] })
  assert.ok(operationId, 'the Follow line operation must be accepted')
  store().updateOperation(operationId, {
    toolRef: spec.toolRef,
    carveDepth: spec.carveDepth,
    stepdown: spec.carveDepth,
  })
  const project = store().project
  const operation = project.operations.find((row) => row.id === operationId)
  assert.ok(operation, 'the operation is in the project')
  return { project, operation }
}

// ---------------------------------------------------------------------------
// Frank's bolt, rebuilt inline (scripts/issue-1112-rt7-a-bolt.camj, which is a
// probe input only and never a fixture): an inch Ø1.5 bar, a 1.125 in Hex then
// a Ø0.75 Turn, a Thread on each of them, and two circumferential lines drawn
// on the Turn below its surface.
// ---------------------------------------------------------------------------

const BOLT_BAR: BarSpec = { diameter: 1.5, length: 8, origin: { x: 0, y: 0 } }
const BOLT_HEX = { start: 1, length: 0.5, acrossFlats: 1.125 }
const BOLT_TURN = { start: 1.5, length: 6, diameter: 0.75 }
const BOLT_THREADS = [1.5, 4.5]
const BOLT_THREAD_LENGTH = 2
/** The two circumferential lines: along positions, and the full wrap they draw. */
const BOLT_LINES = [6.5, 3.5]
const BOLT_LINE_TOP_Z = 1
const BOLT_VBIT_DIAMETER = 0.25
const BOLT_VBIT_INCLUDED_ANGLE = 30

interface BoltCase {
  project: Project
  operation: Operation
  /** The two circumferential lines, in BOLT_LINES order. */
  lineIds: string[]
}

/** The same feature set and operations as Frank's bolt file, built by actions. */
function buildBoltCase(): BoltCase {
  store().loadProject(setUpProject(BOLT_BAR, [
    inchTool('bolt-vbit', 'v_bit', BOLT_VBIT_DIAMETER, BOLT_VBIT_INCLUDED_ANGLE),
  ]))
  assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available on a round bar')

  const solids: SolidInput[] = [
    { kind: 'polygon', start: BOLT_HEX.start, length: BOLT_HEX.length, sides: 6, acrossFlats: BOLT_HEX.acrossFlats },
    { kind: 'turn', start: BOLT_TURN.start, length: BOLT_TURN.length, diameter: BOLT_TURN.diameter },
    // The second Hex sits inside the Turn's band, as the bolt's copy does.
    { kind: 'polygon', start: 4, length: BOLT_HEX.length, sides: 6, acrossFlats: BOLT_HEX.acrossFlats },
  ]
  for (const solid of solids) {
    const planned = planRotarySolid(store().project, EMPTY_SELECTION, solid)
    assert.ok(planned.ok, `the ${solid.kind} must be created (${planned.ok ? '' : planned.reason})`)
    store().loadProject(planned.project)
    assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available after a write')
  }

  const targetIds: string[] = []
  for (const start of BOLT_THREADS) {
    const created = store().addRotaryPattern({
      kind: 'thread',
      start,
      length: BOLT_THREAD_LENGTH,
      pitch: THREAD_PITCH,
      starts: 1,
      depth: THREAD_DEPTH,
    })
    assert.ok(created.ok, `the Thread at ${start} must be created (${created.ok ? '' : created.reason})`)
    targetIds.push(created.featureId)
  }
  const lineIds: string[] = []
  for (const along of BOLT_LINES) {
    const feature = lineFeature(`Polyline ${along}`, { x: along, y: -1.5 }, { x: along, y: 3 }, BOLT_LINE_TOP_Z, 0)
    const current = store().project
    store().loadProject({
      ...projectWithFeatures(current, [...current.features, feature]),
      featureTree: [...current.featureTree, { type: 'feature' as const, featureId: feature.id }],
    })
    assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available after a write')
    lineIds.push(feature.id)
  }
  targetIds.push(...lineIds)

  const operationId = store().addOperation('follow_line', 'finish', { source: 'features', featureIds: targetIds })
  assert.ok(operationId, 'the Follow line operation must be accepted')
  store().updateOperation(operationId, {
    toolRef: 'bolt-vbit',
    carveDepth: THREAD_DEPTH,
    stepdown: THREAD_DEPTH,
  })
  const project = store().project
  const operation = project.operations.find((row) => row.id === operationId)
  assert.ok(operation, 'the operation is in the project')
  return { project, operation, lineIds }
}

/** Every along coordinate the operation moves through. */
function alongExtent(moves: ToolpathResult['moves'], axis: 'x' | 'y' = 'x'): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      const along = axis === 'x' ? point.x : point.y
      min = Math.min(min, along)
      max = Math.max(max, along)
    }
  }
  return { min, max }
}

/** One Clipper integer count: the splitter works on this grid. */
const CLIPPER_STEP = 1 / 10_000

/**
 * The trimmed end sits on the keep-out edge, which the Clipper grid rounds
 * outward by up to a couple of counts — never inward, which is the direction
 * that would leave the cutter in the material.
 */
function assertStopsShortOf(actual: number, expected: number, side: 'start' | 'end', label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= 2.5 * CLIPPER_STEP,
    `${label}: ${actual}, expected ${expected} ± ${2.5 * CLIPPER_STEP}`,
  )
  if (side === 'start') {
    assert.ok(actual >= expected - 1e-9, `${label}: the keep-out rounded inward (${actual} < ${expected})`)
  } else {
    assert.ok(actual <= expected + 1e-9, `${label}: the keep-out rounded inward (${actual} > ${expected})`)
  }
}

/** A V-bit's half-width at a height above its tip, capped at its radius. */
function coneHalfWidth(
  heightAboveTip: number,
  diameter = VBIT_DIAMETER,
  angle = VBIT_INCLUDED_ANGLE,
): number {
  return Math.min(diameter / 2, Math.max(0, heightAboveTip) * Math.tan((angle * Math.PI) / 360))
}

/** The fixture's V-bit, in the two cases that use it. */
function vBitHalfWidthAt(heightAboveTip: number): number {
  return coneHalfWidth(heightAboveTip)
}

/**
 * The radius a regular polygon's corners reach: `flats / 2 / cos(π / sides)`.
 * A Polygon/Hex model's stored Z top is its across-flats radius, but the corners
 * stand this much above the axis and sweep past the cutter as the bar turns
 * (issue #1112 rt7-a correction 1).
 */
function cornerRadius(acrossFlats: number, sides = 6): number {
  return acrossFlats / 2 / Math.cos(Math.PI / sides)
}

function findWarning(result: ToolpathResult, code: string): ToolpathResult['warnings'][number] {
  const warning = result.warnings.find((row) => row.code === code)
  assert.ok(warning, `expected a ${code} warning, got [${result.warnings.map((row) => row.code).join(', ')}]`)
  return warning
}

// ---------------------------------------------------------------------------
// 1. The bolt: the start is trimmed by the width of the V-bit at the Hex's
//    **corner** — the largest radius it presents at any angle (rt7-a) — and the
//    end by the same cutter against the uncut bar's shoulder.
// ---------------------------------------------------------------------------

{
  const { project, operation } = buildCase({
    solids: [
      { kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: 6, acrossFlats: MODEL_DIAMETER },
      { kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: MODEL_DIAMETER },
    ],
    thread: { start: THREAD_START, length: THREAD_LENGTH, depth: THREAD_DEPTH },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'follow_line generates in an Around setup')
  const { result } = envelope
  assert.ok(result.moves.some((move) => move.kind === 'cut'), 'the thread still cuts its band')

  // The Hex's corners stand `0.375 / cos(30°)` = 0.4330 above the axis while the
  // Thread is cut at 0.375, so the neighbour's corner is 0.0580 above the guide:
  // the trim is the V-bit's half-width at (0.0580 + 0.122) above its tip,
  // 0.1800 · tan(15°) = 0.0482 in. Measuring the stored across-flats radius
  // instead would trim 0.0327 in and leave the corner gouging 0.0155 in (rt7-a).
  const hexTrim = vBitHalfWidthAt(cornerRadius(MODEL_DIAMETER) - MODEL_DIAMETER / 2 + THREAD_DEPTH)
  assert.ok(
    Math.abs(hexTrim - 0.0482) < 1e-4,
    `the fixture's V-bit trims at the Hex corner: ${hexTrim} in`,
  )
  const flatsTrim = vBitHalfWidthAt(THREAD_DEPTH)
  assert.ok(hexTrim > flatsTrim + 0.015, 'the corner trim is meaningfully wider than the flats one')
  const extent = alongExtent(result.moves)
  assertStopsShortOf(extent.min, BAR_START + TURN_START + hexTrim, 'start', 'the Hex end face')

  // The uncut bar past the Turn's end is the second shoulder. At the bar's
  // surface the cone would be 0.0662 wide, so the tool radius caps it.
  const barTrim = VBIT_DIAMETER / 2
  assert.ok(
    Math.max(...result.moves.flatMap((move) => [move.from.z, move.to.z])) > 0,
    'the cut stays above the centreline',
  )
  assertStopsShortOf(extent.max, BAR_START + TURN_START + TURN_LENGTH - barTrim, 'end', 'the uncut bar shoulder')

  const startWarning = result.warnings.find((row) => row.code === 'carveNeighbourTrimmed' && row.params?.sideId === 'start')
  assert.ok(startWarning, 'the start of the band is warned about')
  assert.equal(startWarning.params?.name, 'Thread', 'the warning names the trimmed feature')
  assert.equal(startWarning.params?.neighbour, 'Hex', 'and what it stays clear of')
  assert.equal(startWarning.params?.sideId, 'start', 'and the end it stopped at')
  assert.equal(startWarning.params?.distance, '0.0482', 'and how far short it stopped: the corner half-width it used')
  assert.equal(startWarning.params?.units, 'inch', 'in the project units')
  assert.equal(
    toolpathWarningText(startWarning),
    'Thread: stopped 0.0482 inch short of Hex at the start so the cutter does not cut into it.',
    'the rendered message is the report\'s sentence',
  )

  const endWarning = result.warnings.find((row) => row.code === 'carveNeighbourTrimmed' && row.params?.sideId === 'end')
  assert.ok(endWarning, 'the end of the band is warned about too')
  assert.equal(endWarning.params?.neighbourId, 'bar', 'the shoulder is the uncut bar, carried as a word id')
  assert.equal(
    toolpathWarningText(endWarning),
    `Thread: stopped ${barTrim} inch short of the uncut bar at the end so the cutter does not cut into it.`,
    'the bar is named in the active language, not with an English literal',
  )

  // -- The gouge, and its removal, measured on the cutter body -----------------
  //
  // The instrument is the swept cutter, not the voxel replay: replaying this
  // operation alone starts from the unturned bar, whose surface is one radius
  // above the Turn's, so the shank would "cut" a bar that the rotary work
  // removes first. What the report is about is the part the rotary work leaves:
  // material up to the Hex's **corner** everywhere in its band, because the bar
  // turns and the corner sweeps past every angular position the thread reaches.
  // So the check walks the emitted moves, samples the V-bit's own cone up to
  // that corner height, and measures how close its body comes to the Hex's end
  // face.
  const frame = aroundFrameForOperation(project, operation)
  assert.ok(frame, 'the operation has an Around frame')
  const unrolled = unrolledProject(project, frame)
  const materials = aroundMaterialBands(project, frame)
  const hexEnd = BAR_START + HEX_START + HEX_LENGTH
  const cornerSurface = cornerRadius(MODEL_DIAMETER)
  assert.ok(
    cornerSurface > MODEL_DIAMETER / 2,
    'the Hex corner stands above its across-flats radius, or the case proves nothing',
  )

  const probe = {
    end: hexEnd,
    surface: cornerSurface,
    diameter: VBIT_DIAMETER,
    angle: VBIT_INCLUDED_ANGLE,
  }
  const untrimmed = minCutterClearance(generateFollowLineToolpath(unrolled, operation).moves, probe)
  assert.ok(
    Math.abs(untrimmed.clearance + hexTrim) < 1e-3,
    `without the keep-out the cutter reaches ${-untrimmed.clearance} into the Hex corner, matching the ${hexTrim} trim`,
  )

  const trimmed = generateFollowLineToolpath(unrolled, operation, materials)
  const clearance = minCutterClearance(trimmed.moves, probe)
  assert.ok(
    clearance.clearance >= -1e-9,
    `with the keep-out no part of the cutter body reaches the Hex's end face (${clearance.clearance})`,
  )
  assert.ok(
    trimmed.moves.some((move) => move.kind === 'cut'),
    'the trimmed path still cuts the thread itself',
  )
}

/**
 * The cutter body's closest approach to a neighbouring body's end face,
 * measured independently of the trim: every cut and plunge move is sampled
 * along its path, and at each sample the V-bit's own cone is walked from its
 * tip up to `surface` — the height the neighbour's material reaches — where its
 * furthest reach is compared with the body's `end` face.
 *
 * The clearance is negative when the cutter body is inside the neighbour by
 * that much. `reach` limits the samples to the stretch on the neighbour's side
 * of its face, so a case with several features measures one neighbour at a
 * time.
 */
function minCutterClearance(
  moves: ToolpathResult['moves'],
  options: {
    /** The neighbour's end face along the bar. */
    end: number
    /** The neighbour's largest radius above the axis: how high its material reaches. */
    surface: number
    /** The V-bit's diameter and included angle. */
    diameter: number
    angle: number
    /** Restrict the samples to this much beyond the end face. */
    reach?: number
  },
): { clearance: number; along: number; aboveTip: number } {
  const pathSamples = 64
  const heightSteps = 32
  const reach = options.reach ?? Number.POSITIVE_INFINITY
  const maxHalfWidth = options.diameter / 2
  const slope = Math.tan((options.angle * Math.PI) / 360)
  let closest = { clearance: Number.POSITIVE_INFINITY, along: options.end, aboveTip: 0 }
  for (const move of moves) {
    if (move.kind !== 'cut' && move.kind !== 'plunge') continue
    for (let step = 0; step <= pathSamples; step += 1) {
      const t = step / pathSamples
      const along = move.from.x + (move.to.x - move.from.x) * t
      if (along < options.end || along > options.end + reach) continue
      const tipZ = move.from.z + (move.to.z - move.from.z) * t
      const top = options.surface - tipZ
      if (top <= 0) continue
      for (let height = 0; height <= heightSteps; height += 1) {
        const aboveTip = top * (height / heightSteps)
        const halfWidth = Math.min(maxHalfWidth, aboveTip * slope)
        const clearance = along - halfWidth - options.end
        if (clearance < closest.clearance) closest = { clearance, along, aboveTip }
      }
    }
  }
  return closest
}

// ---------------------------------------------------------------------------
// 2. A flat endmill has no cone: it trims by its radius.
// ---------------------------------------------------------------------------

{
  const { project, operation } = buildCase({
    solids: [
      { kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: 6, acrossFlats: MODEL_DIAMETER },
      { kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: MODEL_DIAMETER },
    ],
    thread: { start: THREAD_START, length: THREAD_LENGTH, depth: THREAD_DEPTH },
    toolRef: 'flat',
    carveDepth: THREAD_DEPTH,
  })
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope)
  const extent = alongExtent(envelope.result.moves)
  assertStopsShortOf(extent.min, BAR_START + TURN_START + VBIT_DIAMETER / 2, 'start', 'a flat cutter by its radius')
  const warning = findWarning(envelope.result, 'carveNeighbourTrimmed')
  assert.equal(warning.params?.distance, '0.0625', 'the warning reports the radius it kept clear')
}

// ---------------------------------------------------------------------------
// 3. Clear space on both sides changes nothing — byte for byte.
// ---------------------------------------------------------------------------

{
  const { project, operation } = buildCase({
    solids: [{ kind: 'turn', start: TURN_START, length: 2, diameter: MODEL_DIAMETER }],
    thread: { start: 2.6, length: 0.5, depth: THREAD_DEPTH },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const frame = aroundFrameForOperation(project, operation)
  assert.ok(frame)
  const unrolled = unrolledProject(project, frame)
  const materials = aroundMaterialBands(project, frame)
  // The Turn the thread rides on is the same surface, and the bar's shoulders
  // are 0.9 in away: nothing is close enough to shorten the guide.
  assert.deepEqual(
    generateFollowLineToolpath(unrolled, operation, materials),
    generateFollowLineToolpath(unrolled, operation),
    'a guide with clear space either side is byte-identical to before',
  )
}

// ---------------------------------------------------------------------------
// 4. A circumferential line inside the keep-out is removed, and says so.
// ---------------------------------------------------------------------------

{
  // A line on the Turn's surface 0.01 in before the Turn's end. The cutter's
  // keep-out reaches half a cutter radius back from the uncut bar's shoulder,
  // so the whole line is inside it.
  const turnEnd = BAR_START + TURN_START + TURN_LENGTH
  const along = turnEnd - 0.01
  const { project, operation } = buildCase({
    solids: [{ kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: MODEL_DIAMETER }],
    thread: null,
    line: {
      start: { x: along, y: BAR_ZERO },
      end: { x: along, y: BAR_ZERO + CIRCUMFERENCE },
      zTop: (BAR_DIAMETER + MODEL_DIAMETER) / 2,
    },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope)
  assert.equal(
    envelope.result.moves.filter((move) => move.kind === 'cut').length,
    0,
    'nothing is cut when the whole line would cut into the shoulder',
  )
  const away = findWarning(envelope.result, 'carveNeighbourTrimmedAway')
  assert.equal(away.params?.name, 'Around line', 'the warning names the line')
  assert.equal(away.params?.neighbourId, 'bar', 'and why: the uncut bar beside the Turn')
  assert.equal(
    toolpathWarningText(away),
    'Around line: nothing was cut — the line would cut into the uncut bar, so it was kept clear of it.',
    'a guide trimmed away entirely says so, and why',
  )
}

// ---------------------------------------------------------------------------
// 5. A Turn of larger diameter is a wall: the guide stops before it.
// ---------------------------------------------------------------------------

{
  const { project, operation } = buildCase({
    solids: [
      { kind: 'turn', start: TURN_START, length: 1, diameter: MODEL_DIAMETER },
      // A larger Turn right after it: the thread's band would run into it.
      { kind: 'turn', start: 2.5, length: 1, diameter: 0.9 },
    ],
    thread: { start: 1.6, length: 0.88, depth: THREAD_DEPTH },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope)
  const largerTurnStart = BAR_START + 2.5
  const surface = (BAR_DIAMETER + 0.9) / 2
  const guideSurface = (BAR_DIAMETER + MODEL_DIAMETER) / 2
  const trim = vBitHalfWidthAt(surface - guideSurface + THREAD_DEPTH)
  const extent = alongExtent(envelope.result.moves)
  assertStopsShortOf(extent.max, largerTurnStart - trim, 'end', 'a larger Turn')
  const warning = findWarning(envelope.result, 'carveNeighbourTrimmed')
  assert.equal(warning.params?.sideId, 'end', 'the trimmed end is named')
  assert.match(String(warning.params?.neighbour), /^Turn/, 'and the Turn that stands above it')
}

// ---------------------------------------------------------------------------
// 6. Uncut bar next to a Turn trims too, and is named as the bar.
// ---------------------------------------------------------------------------

{
  const { project, operation } = buildCase({
    solids: [{ kind: 'turn', start: TURN_START, length: 1, diameter: MODEL_DIAMETER }],
    thread: { start: 1.6, length: 0.88, depth: THREAD_DEPTH },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope)
  const turnEnd = BAR_START + TURN_START + 1
  // The bar's surface is above the Turn's, so the cone would be 0.0662 wide
  // there — the tool radius caps the keep-out at 0.0625.
  const trim = VBIT_DIAMETER / 2
  const extent = alongExtent(envelope.result.moves)
  assertStopsShortOf(extent.max, turnEnd - trim, 'end', 'the uncut bar next to the Turn')
  const warning = findWarning(envelope.result, 'carveNeighbourTrimmed')
  assert.equal(warning.params?.neighbourId, 'bar', 'the bar is what it stays clear of')
  assert.equal(warning.params?.sideId, 'end', 'at the end')
}

// ---------------------------------------------------------------------------
// 7. A line crossing a body in its middle is broken, and says how much.
// ---------------------------------------------------------------------------

{
  // A Hex collar in the middle of the turned band, and a hand-drawn line along
  // the bar on the Turn's surface passing right through it.
  const turnNet = BAR_DIAMETER + MODEL_DIAMETER
  const { project, operation } = buildCase({
    solids: [
      { kind: 'turn', start: TURN_START, length: 2, diameter: MODEL_DIAMETER },
      { kind: 'polygon', start: 2, length: 0.5, sides: 6, acrossFlats: MODEL_DIAMETER },
    ],
    thread: null,
    line: {
      start: { x: BAR_START + 1.6, y: BAR_ZERO + 0.1 },
      end: { x: BAR_START + 3.4, y: BAR_ZERO + 0.1 },
      zTop: turnNet / 2,
    },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope)
  const hexEnd = BAR_START + 2.5
  const hexStart = BAR_START + 2
  // The Hex's corner is the neighbour here too (rt7-a): its flats radius is
  // level with the line's surface, but the corners stand 0.058 in higher.
  const trim = vBitHalfWidthAt(cornerRadius(MODEL_DIAMETER) - MODEL_DIAMETER / 2 + THREAD_DEPTH)
  const before = hexStart - trim
  const after = hexEnd + trim

  // The line survives on both sides of the Hex and nowhere inside its band.
  for (const move of envelope.result.moves) {
    if (move.kind !== 'cut') continue
    const crossed = Math.min(move.from.x, move.to.x) < after && Math.max(move.from.x, move.to.x) > before
    assert.ok(!crossed, `no cut may run through the Hex band (${move.from.x} → ${move.to.x})`)
  }
  const extent = alongExtent(envelope.result.moves)
  assertStopsShortOf(extent.min, BAR_START + 1.6, 'start', 'the line keeps its own start')
  assertStopsShortOf(extent.max, BAR_START + 3.4, 'end', 'and its own end')

  const span = findWarning(envelope.result, 'carveNeighbourTrimmedSpan')
  assert.equal(span.params?.neighbour, 'Hex', 'the middle warning names what it crosses')
  // The distance is the line length actually removed: the Hex's band plus the
  // cutter's half-width on each side, and the couple of Clipper counts the
  // keep-out rounds outward by.
  const removed = Number(span.params?.distance)
  assert.ok(
    Math.abs(removed - (hexEnd - hexStart + 2 * trim)) <= 1e-3,
    `the middle warning reports ${removed}, expected ${hexEnd - hexStart + 2 * trim}`,
  )
}

// ---------------------------------------------------------------------------
// 8. A stepped Turn is not one diameter: only its larger sections are walls.
//    (Correction round 1, finding 2 — the slice measured the whole Turn by its
//    single stored Z top, which is the largest section's.)
// ---------------------------------------------------------------------------

{
  const smallRadius = MODEL_DIAMETER / 2
  const largeRadius = 0.45
  const stepAt = BAR_START + 2.5
  const steppedTurn: TurnCannedProfile = {
    sourceFeatureId: 'drawn outline',
    contours: [{
      closed: false,
      points: [
        { along: BAR_START + 1.5, radius: smallRadius },
        { along: stepAt, radius: smallRadius },
        { along: stepAt, radius: largeRadius },
        { along: BAR_START + 3.5, radius: largeRadius },
      ],
    }],
  }
  const { project, operation } = buildCase({
    solids: [{ kind: 'turn', start: TURN_START, length: 2, diameter: largeRadius * 2, profile: steppedTurn }],
    // Wholly on the Ø0.75 section, more than a cutter radius clear of the step.
    thread: { start: 1.6, length: 0.8, depth: THREAD_DEPTH },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })

  const frame = aroundFrameForOperation(project, operation)
  assert.ok(frame)
  const materials = aroundMaterialBands(project, frame)
  const turnBands = materials.bands.filter((band) => band.kind === 'turn')
  assert.equal(turnBands.length, 2, 'a stepped Turn is two local surfaces, not one')
  assert.ok(Math.abs(turnBands[0]!.surfaceZ - smallRadius) <= 1e-6, `the small section's own surface (${turnBands[0]!.surfaceZ})`)
  assert.ok(Math.abs(turnBands[1]!.surfaceZ - largeRadius) <= 1e-6, `the large section's own surface (${turnBands[1]!.surfaceZ})`)
  assert.ok(Math.abs(turnBands[1]!.alongMin - stepAt) <= 1e-6, 'the split is at the step')

  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope)
  const cuts = envelope.result.moves.filter((move) => move.kind === 'cut')
  assert.ok(cuts.length > 0, 'the thread wholly on the small section is cut, not deleted')
  assert.deepEqual(
    envelope.result.warnings.filter((row) => row.code.startsWith('carveNeighbour')),
    [],
    'its own supporting Turn is not a neighbour and nothing is warned about',
  )
  const extent = alongExtent(cuts)
  assertStopsShortOf(extent.min, BAR_START + 1.6, 'start', 'the guide keeps its own start')
  assertStopsShortOf(extent.max, BAR_START + 2.4, 'end', 'and its own end')

  const unrolled = unrolledProject(project, frame)
  assert.deepEqual(
    generateFollowLineToolpath(unrolled, operation, materials),
    generateFollowLineToolpath(unrolled, operation),
    'a guide clear of every section is byte-identical to before the keep-out',
  )

  // The larger section is still a wall: the same surface line, drawn on past
  // the step, stops clear of it. rt7-a's supporting rule is keyed to a band that
  // spans the guide's whole along extent, so this higher section — which only
  // the line's far end reaches — keeps its trim.
  const crossed = buildCase({
    solids: [{ kind: 'turn', start: TURN_START, length: 2, diameter: largeRadius * 2, profile: steppedTurn }],
    thread: null,
    line: {
      start: { x: BAR_START + 2.2, y: BAR_ZERO },
      end: { x: BAR_START + 2.8, y: BAR_ZERO },
      zTop: (BAR_DIAMETER + MODEL_DIAMETER) / 2,
    },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const crossedEnvelope = computeOperationToolpath(crossed.project, crossed.operation)
  assert.ok(crossedEnvelope)
  const crossedCuts = crossedEnvelope.result.moves.filter((move) => move.kind === 'cut')
  assert.ok(crossedCuts.length > 0, 'the line survives on the small section')
  const stepTrim = vBitHalfWidthAt(largeRadius - smallRadius + THREAD_DEPTH)
  assertStopsShortOf(alongExtent(crossedCuts).max, stepAt - stepTrim, 'end', 'the larger section of the Turn')
  const warning = findWarning(crossedEnvelope.result, 'carveNeighbourTrimmed')
  assert.equal(warning.params?.sideId, 'end', 'the step is the end it stops at')
  assert.match(String(warning.params?.neighbour), /^Turn/, 'and it names that Turn')
}

// ---------------------------------------------------------------------------
// 9. A body the guide is drawn on is its surface, not a neighbour.
//    (Correction round 1, finding 3 — every equal-height body was a wall, so a
//    line on a Hex's own top was deleted with "nothing was cut". Case 1 is the
//    contrast: a guide that starts at the Hex's end is still kept clear of it.)
// ---------------------------------------------------------------------------

{
  const hexStart = BAR_START + 2
  const hexEnd = hexStart + HEX_LENGTH
  const { project, operation } = buildCase({
    solids: [{ kind: 'polygon', start: 2, length: HEX_LENGTH, sides: 6, acrossFlats: MODEL_DIAMETER }],
    thread: null,
    line: {
      start: { x: hexStart + 0.1, y: BAR_ZERO },
      end: { x: hexEnd - 0.1, y: BAR_ZERO },
      zTop: (BAR_DIAMETER + MODEL_DIAMETER) / 2,
    },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope)
  const cuts = envelope.result.moves.filter((move) => move.kind === 'cut')
  assert.ok(cuts.length > 0, "a line on the Hex's own surface is cut, not deleted")
  assert.deepEqual(
    envelope.result.warnings.filter((row) => row.code.startsWith('carveNeighbour')),
    [],
    'the Hex the line is drawn on is not a neighbour',
  )
  const extent = alongExtent(cuts)
  assertStopsShortOf(extent.min, hexStart + 0.1, 'start', 'the line keeps its own start')
  assertStopsShortOf(extent.max, hexEnd - 0.1, 'end', 'and its own end')
}

// ---------------------------------------------------------------------------
// 10. Moving a neighbour across the sheet invalidates the cached path.
//     (Correction round 1, finding 1 — the material bands were read but not
//     stamped, so the old endpoint and warning survived a neighbour edit.)
// ---------------------------------------------------------------------------

{
  // An Around line drawn at an across coordinate the models' side views do not
  // reach (they stand around the zero line, the guide is a whole bar diameter
  // around the sheet), with a larger Turn at its end.
  const guideStart = BAR_START + 1.7
  const guideEnd = BAR_START + 2.45
  const largerTurnStart = BAR_START + 2.5
  const { project, operation } = buildCase({
    solids: [
      { kind: 'turn', start: TURN_START, length: 1, diameter: MODEL_DIAMETER },
      { kind: 'turn', start: 2.5, length: 1, diameter: 0.9 },
    ],
    thread: null,
    line: {
      start: { x: guideStart, y: BAR_ZERO + BAR_DIAMETER },
      end: { x: guideEnd, y: BAR_ZERO + BAR_DIAMETER },
      zTop: (BAR_DIAMETER + MODEL_DIAMETER) / 2,
    },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })

  const before = computeOperationToolpath(project, operation)
  assert.ok(before)
  const beforeEnd = alongExtent(before.result.moves.filter((move) => move.kind === 'cut')).max
  // The larger Turn is the wall: the V-bit's width at its surface, not the
  // radius the uncut bar would give.
  const turnTrim = vBitHalfWidthAt((0.9 - MODEL_DIAMETER) / 2 + THREAD_DEPTH)
  assertStopsShortOf(beforeEnd, largerTurnStart - turnTrim, 'end', 'the larger Turn')

  const inputs = captureCacheInputs(project, operation)
  assert.ok(cacheInputsValid(inputs, operation, project), 'the unchanged project keeps its entry')
  assert.ok(
    cacheInputsValid(inputs, operation, { ...project }),
    'an equal snapshot keeps its entry: the captured material read set compares equal',
  )

  const neighbour = project.features.find((row) => row.name === 'Turn 2')
  assert.ok(neighbour, 'the larger Turn is the second solid')
  // Moving it one inch along the bar exposes the uncut bar at the guide's end.
  const moved: Project = {
    ...project,
    features: project.features.map((row) => row.id === neighbour.id
      ? { ...row, transform: { ...row.transform, e: row.transform.e + 1 } }
      : row),
  }

  // The old narrowing on its own cannot see it: the model's silhouette is its
  // side view around the bar, the guide is measured at its unrolled across
  // coordinate. That gap is why the read set has to be stamped.
  assert.equal(
    operationAffectedByChange(operationFootprint(project, operation), project, moved, new Set([neighbour.id])),
    false,
    'the footprint narrowing alone misses the neighbour',
  )
  assert.ok(
    !cacheInputsValid(inputs, operation, moved),
    'moving the larger neighbour must invalidate the cached path',
  )

  const after = computeOperationToolpath(moved, operation)
  assert.ok(after)
  const afterEnd = alongExtent(after.result.moves.filter((move) => move.kind === 'cut')).max
  assertStopsShortOf(afterEnd, largerTurnStart - VBIT_DIAMETER / 2, 'end', 'the uncut bar the move exposed')
  assert.ok(
    afterEnd < beforeEnd - 1e-3,
    `the endpoint must retreat when the Turn leaves: ${beforeEnd} → ${afterEnd}`,
  )
}

// ---------------------------------------------------------------------------
// 11. Frank's bolt, rebuilt inline: the thread stays clear of the Hex **corner**
//     (rt7-a correction 1), and the circumferential lines on the Turn are cut
//     exactly as they were before the keep-out existed (correction 2).
// ---------------------------------------------------------------------------

{
  const { project, operation, lineIds } = buildBoltCase()
  const frame = aroundFrameForOperation(project, operation)
  assert.ok(frame, 'the operation has an Around frame')
  const unrolled = unrolledProject(project, frame)
  const materials = aroundMaterialBands(project, frame)

  // The Hex's band is 0.5625 in above the axis and its corners reach 0.6495:
  // the band must report the corner, not the stored Z top (rt7-a).
  const hexBands = materials.bands.filter((band) => band.kind === 'body')
  assert.equal(hexBands.length, 2, 'the bolt has two Hex bands')
  const corner = cornerRadius(BOLT_HEX.acrossFlats)
  assert.ok(Math.abs(corner - 0.6495190528) < 1e-9, `the 1.125 in Hex corner is ${corner}`)
  for (const band of hexBands) {
    assert.ok(
      Math.abs(band.surfaceZ - corner) < 1e-9,
      `${band.name}'s keep-out height is its corner ${corner}, not its ${BOLT_HEX.acrossFlats / 2} across-flats radius`,
    )
  }

  // The trim the report complains about: the V-bit at the corner height,
  // (0.6495 − 0.375 + 0.122) · tan(15°) = 0.1062 in, not the 0.0829 the flats
  // radius gave — a 0.023 in gouge.
  const cornerTrim = coneHalfWidth(
    corner - BOLT_TURN.diameter / 2 + THREAD_DEPTH,
    BOLT_VBIT_DIAMETER,
    BOLT_VBIT_INCLUDED_ANGLE,
  )
  assert.ok(Math.abs(cornerTrim - 0.1062) < 1e-4, `the corner half-width is ${cornerTrim} in, not 0.0829`)

  const trimmed = generateFollowLineToolpath(unrolled, operation, materials)
  const untrimmed = generateFollowLineToolpath(unrolled, operation)
  const probe = { diameter: BOLT_VBIT_DIAMETER, angle: BOLT_VBIT_INCLUDED_ANGLE }

  // Every cutting move on a Thread, against the Hex before it. The window is
  // the thread's own two inches beyond the Hex's end face.
  const clears: number[] = []
  for (const band of hexBands) {
    const surface = corner
    const reach = BOLT_THREAD_LENGTH + 0.2
    const gouge = minCutterClearance(untrimmed.moves, { ...probe, end: band.alongMax, surface, reach })
    assert.ok(
      Math.abs(gouge.clearance + cornerTrim) < 2e-3,
      `without the keep-out the cutter reaches ${-gouge.clearance} into ${band.name}'s corner`,
    )
    const clear = minCutterClearance(trimmed.moves, { ...probe, end: band.alongMax, surface, reach })
    assert.ok(clear.clearance >= 0, `the cutter body stays clear of ${band.name} (${clear.clearance})`)
    assert.ok(
      clear.clearance <= 3 * CLIPPER_STEP,
      `${band.name}'s trim is the corner half-width, not a wider fudge (${clear.clearance})`,
    )
    clears.push(clear.clearance)
  }
  console.log(`  the bolt's minimum Hex clearance: ${Math.min(...clears)} in`)
  const warnings = trimmed.warnings
  const startWarnings = warnings.filter((row) => row.code === 'carveNeighbourTrimmed' && row.params?.sideId === 'start')
  assert.equal(startWarnings.length, 2, 'both threads are warned about at their start')
  for (const warning of startWarnings) {
    assert.equal(warning.params?.distance, '0.1062', 'the warning reports the half-width actually used')
  }

  // -- The circumferential lines on the Turn ----------------------------------
  //
  // Their stored Z top (0.25 above the axis) is below the Turn's 0.375 surface.
  // rt6-e read the Turn as a wall and dropped both lines with "nothing was
  // cut"; the Turn spans the guide's own along extent, so it is the surface they
  // are cut on, not a neighbour (rt7-a correction 2).
  for (const along of BOLT_LINES) {
    const cuts = trimmed.moves.filter((move) => move.kind === 'cut'
      && Math.abs(move.from.x - along) < 1e-6
      && Math.abs(move.to.x - along) < 1e-6)
    assert.ok(cuts.length > 0, `the circumferential line at ${along} is cut`)
  }
  const away = warnings.filter((row) => row.code === 'carveNeighbourTrimmedAway')
  assert.deepEqual(away, [], 'neither line is trimmed away: the Turn under it is its surface')
  assert.deepEqual(
    warnings.filter((row) => row.code.startsWith('carveNeighbour') && String(row.params?.name).startsWith('Polyline')),
    [],
    'the lines are not trimmed at all, so they cannot be warned about',
  )

  // Byte-identical to the pre-rt6-e behaviour: with only the two lines as the
  // operation's targets, the keep-out changes nothing, move for move.
  const linesOnly: Operation = {
    ...operation,
    id: 'lines-only',
    target: { source: 'features', featureIds: lineIds },
  }
  assert.deepEqual(
    generateFollowLineToolpath(unrolled, linesOnly, materials),
    generateFollowLineToolpath(unrolled, linesOnly),
    'a line on its own Turn is byte-identical to the path before the keep-out',
  )
}

// ---------------------------------------------------------------------------
// 12. Extending the supporting rule to every kind must not swallow a neighbour
//     that only overlaps the guide: a line on the Turn is cut end to end, but
//     the same line running off onto the bar still stops at the shoulder
//     (rt7-a correction 2).
// ---------------------------------------------------------------------------

{
  const turnNet = BAR_DIAMETER + MODEL_DIAMETER
  const turnEnd = BAR_START + TURN_START + 1
  const solids: SolidInput[] = [{ kind: 'turn', start: TURN_START, length: 1, diameter: MODEL_DIAMETER }]
  const within = buildCase({
    solids,
    thread: null,
    line: {
      start: { x: BAR_START + TURN_START + 0.1, y: BAR_ZERO + 0.1 },
      end: { x: turnEnd - 0.1, y: BAR_ZERO + 0.1 },
      // 0.1 in below the Turn's own surface, the bolt's Polyline 6 shape: under
      // the rt6-e rule the Turn read as a wall and the line was deleted.
      zTop: turnNet / 2 - 0.1,
    },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const withinEnvelope = computeOperationToolpath(within.project, within.operation)
  assert.ok(withinEnvelope)
  const withinCuts = withinEnvelope.result.moves.filter((move) => move.kind === 'cut')
  assert.ok(withinCuts.length > 0, 'a line inside the Turn it is drawn on is cut, not deleted')
  assert.deepEqual(
    withinEnvelope.result.warnings.filter((row) => row.code.startsWith('carveNeighbour')),
    [],
    'its own Turn spans the guide, so it is the surface and not a neighbour',
  )
  const withinExtent = alongExtent(withinCuts)
  assertStopsShortOf(withinExtent.min, BAR_START + TURN_START + 0.1, 'start', 'the line keeps its own start')
  assertStopsShortOf(withinExtent.max, turnEnd - 0.1, 'end', 'and its own end')

  const runsOff = buildCase({
    solids,
    thread: null,
    line: {
      start: { x: BAR_START + TURN_START + 0.1, y: BAR_ZERO + 0.1 },
      end: { x: turnEnd + 0.2, y: BAR_ZERO + 0.1 },
      // On the Turn's surface, running past its end onto the uncut bar: the
      // handoff's own example of a guide crossing onto a higher band.
      zTop: turnNet / 2,
    },
    toolRef: 'vbit',
    carveDepth: THREAD_DEPTH,
  })
  const offEnvelope = computeOperationToolpath(runsOff.project, runsOff.operation)
  assert.ok(offEnvelope)
  const offCuts = offEnvelope.result.moves.filter((move) => move.kind === 'cut')
  assert.ok(offCuts.length > 0, 'the part of the line on the Turn is still cut')
  const offExtent = alongExtent(offCuts)
  assertStopsShortOf(offExtent.min, BAR_START + TURN_START + 0.1, 'start', 'the line keeps its own start on the Turn')
  // The uncut bar past the Turn's end stands above the line, so the guide stops
  // a cutter radius short of the shoulder even though the Turn spans the rest.
  assertStopsShortOf(offExtent.max, turnEnd - VBIT_DIAMETER / 2, 'end', 'the uncut bar the line runs onto')
  const warning = findWarning(offEnvelope.result, 'carveNeighbourTrimmed')
  assert.equal(warning.params?.neighbourId, 'bar', 'the bar it runs onto is the neighbour')
  assert.equal(warning.params?.sideId, 'end', 'at its far end')
}

// ---------------------------------------------------------------------------
// 13. A flat Hex (rotation changes the corner angle) still uses the
//     circumradius: a rotation moves where the corners are, never how far out
//     they reach (rt7-a correction 1).
// ---------------------------------------------------------------------------

{
  const trims: number[] = []
  for (const rotationDeg of [0, 30]) {
    const { project, operation } = buildCase({
      solids: [
        { kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: 6, acrossFlats: MODEL_DIAMETER, rotationDeg },
        { kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: MODEL_DIAMETER },
      ],
      thread: { start: THREAD_START, length: THREAD_LENGTH, depth: THREAD_DEPTH },
      toolRef: 'vbit',
      carveDepth: THREAD_DEPTH,
    })
    const frame = aroundFrameForOperation(project, operation)
    assert.ok(frame)
    const band = aroundMaterialBands(project, frame).bands.find((row) => row.kind === 'body')
    assert.ok(band, 'the Hex is the body band')
    // A corner-up Hex's own stored Z top already is the corner, so the band is
    // the larger of that (a Float32 mesh top) and the parameter's circumradius.
    assert.ok(
      Math.abs(band.surfaceZ - cornerRadius(MODEL_DIAMETER)) < 1e-6,
      `rotation ${rotationDeg}: the band reports the corner ${cornerRadius(MODEL_DIAMETER)}, got ${band.surfaceZ}`,
    )
    const envelope = computeOperationToolpath(project, operation)
    assert.ok(envelope)
    trims.push(alongExtent(envelope.result.moves).min)
  }
  assertStopsShortOf(
    trims[0]!,
    trims[1]!,
    'start',
    'the flat Hex (rotation 0) stops as far short of its corners as the corner-up one (rotation 30)',
  )
}

console.log('Around follow-line neighbour keep-out tests passed')
