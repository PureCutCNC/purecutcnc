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
  | { kind: 'turn'; start: number; length: number; diameter: number }
  | { kind: 'polygon'; start: number; length: number; sides: number; acrossFlats: number }

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

function setUpProject(): Project {
  const project = newProject('around neighbours', 'inch')
  project.meta.projectType = 'rotary'
  project.meta.maxTravelZ = 3
  project.stock = roundStock(BAR_DIAMETER, BAR_LENGTH, 'x', BAR_ORIGIN)
  project.tools = [
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

/** The V-bit's half-width at a height above its tip, capped at its radius. */
function vBitHalfWidthAt(heightAboveTip: number): number {
  return Math.min(VBIT_DIAMETER / 2, heightAboveTip * Math.tan((VBIT_INCLUDED_ANGLE * Math.PI) / 360))
}

function findWarning(result: ToolpathResult, code: string): ToolpathResult['warnings'][number] {
  const warning = result.warnings.find((row) => row.code === code)
  assert.ok(warning, `expected a ${code} warning, got [${result.warnings.map((row) => row.code).join(', ')}]`)
  return warning
}

// ---------------------------------------------------------------------------
// 1. The bolt: the start is trimmed by the width of the V-bit at the Hex's
//    surface, and the end by the same cutter against the uncut bar's shoulder.
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

  // The Hex's Z top is measured from the same Ø0.75 the Thread is cut on, so
  // the neighbour's surface is exactly the guide's: the trim is the V-bit's
  // half-width at the cut's own surface, 0.122 · tan(15°) = 0.0327 in — the
  // 0.033 Frank measured on the part.
  const hexTrim = vBitHalfWidthAt(THREAD_DEPTH)
  assert.ok(Math.abs(hexTrim - 0.0327) < 1e-4, `the fixture's V-bit trims ${hexTrim} in, i.e. the 0.033 in the report`)
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
  assert.equal(startWarning.params?.distance, '0.0327', 'and how far short it stopped')
  assert.equal(startWarning.params?.units, 'inch', 'in the project units')
  assert.equal(
    toolpathWarningText(startWarning),
    'Thread: stopped 0.0327 inch short of Hex at the start so the cutter does not cut into it.',
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
  // material up to the Turn's surface everywhere in the Hex's band. So the
  // check walks the emitted moves, samples the V-bit's own cone up to that
  // surface, and measures how close its body comes to the Hex's end face.
  const frame = aroundFrameForOperation(project, operation)
  assert.ok(frame, 'the operation has an Around frame')
  const unrolled = unrolledProject(project, frame)
  const materials = aroundMaterialBands(project, frame)
  const hexEnd = BAR_START + HEX_START + HEX_LENGTH
  const partSurface = unrolled.stock.thickness - (BAR_DIAMETER - MODEL_DIAMETER) / 2

  const untrimmed = generateFollowLineToolpath(unrolled, operation)
  const gouge = hexEnd - closestCutterApproachToHex(untrimmed.moves, partSurface)
  assert.ok(
    Math.abs(gouge - hexTrim) < 1e-3,
    `without the keep-out the cutter reaches ${gouge} into the Hex — the 0.033 in the report`,
  )

  const trimmed = generateFollowLineToolpath(unrolled, operation, materials)
  assert.ok(
    closestCutterApproachToHex(trimmed.moves, partSurface) >= hexEnd - 1e-9,
    "with the keep-out no part of the cutter body reaches the Hex's end face",
  )
  assert.ok(
    trimmed.moves.some((move) => move.kind === 'cut'),
    'the trimmed path still cuts the thread itself',
  )
}

/**
 * How far the cutter body's closest approach gets to `alongLimit`, measured
 * independently of the trim: every cut and plunge move is sampled along its
 * path, and at each sample the V-bit's profile is walked from its tip up to
 * `partSurface` — the height the neighbouring body's end face occupies.
 */
function closestCutterApproachToHex(
  moves: ToolpathResult['moves'],
  partSurface: number,
): number {
  const pathSamples = 24
  const heightSteps = 16
  let closest = Number.POSITIVE_INFINITY
  for (const move of moves) {
    if (move.kind !== 'cut' && move.kind !== 'plunge') continue
    for (let step = 0; step <= pathSamples; step += 1) {
      const t = step / pathSamples
      const along = move.from.x + (move.to.x - move.from.x) * t
      const tipZ = move.from.z + (move.to.z - move.from.z) * t
      for (let height = 0; height <= heightSteps; height += 1) {
        const aboveTip = Math.max(0, partSurface - tipZ) * (height / heightSteps)
        const halfWidth = Math.min(VBIT_DIAMETER / 2, aboveTip * Math.tan((VBIT_INCLUDED_ANGLE * Math.PI) / 360))
        closest = Math.min(closest, along - halfWidth)
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
  const trim = vBitHalfWidthAt(THREAD_DEPTH)
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

console.log('Around follow-line neighbour keep-out tests passed')
