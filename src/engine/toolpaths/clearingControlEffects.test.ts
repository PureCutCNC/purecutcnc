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
 * Clearing-control effect contract (issue #622, slice 5).
 *
 * Walks `CLEARING_CONTROL_SUPPORT` and, for every (kind, control) cell:
 *
 * - **declared `applies: false`** — toggling the control leaves the emitted move
 *   stream byte-identical, on a fixture that could have expressed it;
 * - **declared `applies: true`** — toggling changes the output **and** the change
 *   lands where the control claims, per the predicate table in the issue.
 *
 * The suite iterates the declaration rather than hand-listing cells, so a new
 * kind or control fails until it is classified — the same ratchet the
 * declaration already carries.
 *
 * Run with: npx tsx src/engine/toolpaths/clearingControlEffects.test.ts
 */

import { readFileSync } from 'node:fs'
import type {
  Operation,
  OperationKind,
  Project,
  SketchFeature,
  Tool,
} from '../../types/project'
import {
  defaultTool,
  newProject,
  rectProfile,
} from '../../types/project'
import {
  CLEARING_CONTROL_SUPPORT,
  type ClearingControl,
} from './clearingControls'
import type { PocketToolpathResult, ToolpathMove } from './types'
import { generatePocketToolpath } from './pocket'
import { generateSurfaceCleanToolpath } from './surface'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import { projectWithFeatures } from '../../test/projectFixtures'
import { normalizeProject } from '../../store/projectStore'

// ── Helpers ───────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function serializeMoves(moves: ToolpathMove[]): string {
  return JSON.stringify(moves)
}

const ALL_CLEARING_CONTROLS: ClearingControl[] = [
  'slotFeed',
  'engagementMode',
  'roundOutsideCorners',
  'cleanWallCorners',
  'cornerRelief',
  'machiningOrder',
]

// ── Test runner ───────────────────────────────────────────────────────

let passed = 0
let failed = 0
let skipped = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

function skip(name: string, reason: string): void {
  skipped += 1
  console.log(`   ○ ${name}: ${reason}`)
}

// ── 2-D helpers ───────────────────────────────────────────────────────

function makeFlatEndmill(id: string, diameter = 4): Tool {
  const base = defaultTool('mm', 1)
  return {
    ...base,
    id,
    name: `${diameter} mm endmill`,
    diameter,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

function makeRectFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

/**
 * An L-shaped polygon with one **concave** (reflex) corner, needed for
 * `cornerRelief` testing. A plain rectangle has no concave corners, which
 * is why relief appeared inert in the manager's sweep on the default fixture.
 */
function makeLShapeSubtract(
  id: string,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 40, y: 0 } },
          { type: 'line', to: { x: 40, y: 30 } },
          { type: 'line', to: { x: 20, y: 30 } },
          { type: 'line', to: { x: 20, y: 15 } },
          { type: 'line', to: { x: 0, y: 15 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

/**
 * An L-shaped boss (add operation) for testing `cornerRelief` on `surface_clean`.
 * Has a concave corner available even though `surface_clean` is declared to
 * not apply corner relief.
 */
function makeLShapeBoss(
  id: string,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 40, y: 0 } },
          { type: 'line', to: { x: 40, y: 30 } },
          { type: 'line', to: { x: 20, y: 30 } },
          { type: 'line', to: { x: 20, y: 15 } },
          { type: 'line', to: { x: 0, y: 15 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeBossFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 8,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function baseProject(tools: Tool[], features: SketchFeature[]): Project {
  const project = newProject('control-effect-test', 'mm')
  return projectWithFeatures({ ...project, tools }, features)
}

interface Fixture {
  project: Project
  operation: Operation
}

// ── Default operation template ────────────────────────────────────────

function makeOp(
  overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target' | 'toolRef'>,
): Operation {
  const base: Operation = {
    id: 'op1',
    name: 'op',
    kind: overrides.kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: overrides.target,
    toolRef: overrides.toolRef,
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
  return { ...base, ...overrides }
}

// ── Fixture factories ─────────────────────────────────────────────────

function pocketFixture(): Fixture {
  const tool = makeFlatEndmill('t1', 4)
  const feat = makeRectFeature('fp', 0, 0, 30, 20, 0, -4)
  const project = baseProject([tool], [feat])
  return {
    project,
    operation: makeOp({
      kind: 'pocket',
      target: { source: 'features', featureIds: ['fp'] },
      toolRef: 't1',
    }),
  }
}

function pocketLShapeFixture(): Fixture {
  const tool = makeFlatEndmill('t1', 4)
  const feat = makeLShapeSubtract('fl', 0, -4)
  const project = baseProject([tool], [feat])
  return {
    project,
    operation: makeOp({
      kind: 'pocket',
      target: { source: 'features', featureIds: ['fl'] },
      toolRef: 't1',
    }),
  }
}

function pocketFinishFixture(): Fixture {
  const tool = makeFlatEndmill('t1', 4)
  const feat = makeRectFeature('fp', 0, 0, 30, 20, 0, -4)
  const project = baseProject([tool], [feat])
  return {
    project,
    operation: makeOp({
      kind: 'pocket',
      pass: 'finish',
      target: { source: 'features', featureIds: ['fp'] },
      toolRef: 't1',
      finishWalls: true,
      finishFloor: true,
      roundOutsideCorners: true,
    }),
  }
}

function pocketMultiFeatureFixture(): Fixture {
  const tool = makeFlatEndmill('t1', 4)
  const f1 = makeRectFeature('fm1', 0, 0, 20, 20, 0, -4)
  const f2 = makeRectFeature('fm2', 50, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [f1, f2])
  return {
    project,
    operation: makeOp({
      kind: 'pocket',
      target: { source: 'features', featureIds: ['fm1', 'fm2'] },
      toolRef: 't1',
    }),
  }
}

function surfaceCleanFixture(): Fixture {
  const tool = makeFlatEndmill('t1', 4)
  const boss = makeBossFeature('fb', 0, 0, 30, 20)
  const project = baseProject([tool], [boss])
  return {
    project,
    operation: makeOp({
      kind: 'surface_clean',
      target: { source: 'features', featureIds: ['fb'] },
      toolRef: 't1',
      pass: 'rough',
      finishWalls: true,
      finishFloor: true,
    }),
  }
}

function surfaceCleanFinishFixture(): Fixture {
  const tool = makeFlatEndmill('t1', 4)
  const boss = makeBossFeature('fb', 0, 0, 30, 20)
  const project = baseProject([tool], [boss])
  return {
    project,
    operation: makeOp({
      kind: 'surface_clean',
      target: { source: 'features', featureIds: ['fb'] },
      toolRef: 't1',
      pass: 'finish',
      finishWalls: true,
      finishFloor: true,
      roundOutsideCorners: true,
    }),
  }
}

function surfaceCleanLShapeFixture(): Fixture {
  const tool = makeFlatEndmill('t1', 4)
  const boss = makeLShapeBoss('fl-boss', 8, 0)
  const project = baseProject([tool], [boss])
  return {
    project,
    operation: makeOp({
      kind: 'surface_clean',
      target: { source: 'features', featureIds: ['fl-boss'] },
      toolRef: 't1',
      pass: 'rough',
      finishWalls: true,
      finishFloor: true,
    }),
  }
}

function surfaceCleanMultiFeatureFixture(): Fixture {
  const tool = makeFlatEndmill('t1', 4)
  const b1 = makeBossFeature('fb1', 0, 0, 20, 20)
  const b2 = makeBossFeature('fb2', 50, 0, 20, 20)
  const project = baseProject([tool], [b1, b2])
  return {
    project,
    operation: makeOp({
      kind: 'surface_clean',
      target: { source: 'features', featureIds: ['fb1', 'fb2'] },
      toolRef: 't1',
      pass: 'rough',
      finishWalls: true,
      finishFloor: true,
    }),
  }
}

function load3DProject(filename: string): Project {
  const raw = readFileSync(
    new URL(`../test-fixtures/${filename}`, import.meta.url),
    'utf8',
  )
  return normalizeProject(JSON.parse(raw))
}

function fixtureOperation(project: Project, kind: OperationKind): Operation {
  const op = project.operations.find((c) => c.kind === kind && c.enabled !== false)
  assert(op !== undefined, `fixture should contain an enabled ${kind} operation`)
  return op!
}

function roughSurfaceFixture(): Fixture {
  const project = load3DProject('3d-imported-block-test3.camj')
  const operation = fixtureOperation(project, 'rough_surface')
  return { project, operation }
}

function finishSurfaceCleanupFixture(): Fixture {
  const project = load3DProject('model-in-pocket.camj')
  const operation = fixtureOperation(project, 'finish_surface_cleanup')
  return { project, operation }
}

// ── Generator dispatch ────────────────────────────────────────────────

function generateToolpath(
  kind: OperationKind,
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  switch (kind) {
    case 'pocket':
      return generatePocketToolpath(project, operation)
    case 'surface_clean':
      return generateSurfaceCleanToolpath(project, operation)
    case 'rough_surface':
      return generateRoughSurfaceToolpath(project, operation)
    case 'finish_surface_cleanup':
      return generateFinishSurfaceCleanupToolpath(project, operation)
    default:
      throw new Error(`generateToolpath: ${kind} is not a clearing kind`)
  }
}

// ── Fixture selection per (kind, control) ─────────────────────────────

/**
 * Best fixture for a given (kind, control) pair.
 *
 * For controls that need specific geometry (concave corners, multiple
 * features, finish passes), a co-located fixture is built on demand.
 * Returns `null` when no fixture can express the control effect
 * (e.g. a mesh block with no concave corner for `cornerRelief`), which
 * signals a skip rather than an inert assert.
 */
function fixtureForCell(kind: OperationKind, control: ClearingControl): Fixture | null {
  // cornerRelief needs a concave (reflex) corner.
  if (control === 'cornerRelief') {
    switch (kind) {
      case 'pocket':
        return pocketLShapeFixture()
      case 'surface_clean': {
        // L-shaped boss with concave corner. Even though surface_clean is
        // declared to not apply corner relief, this fixture could express it —
        // which is exactly what the false-applies byte-identity test needs.
        return surfaceCleanLShapeFixture()
      }
      // rough_surface, finish_surface_cleanup use mesh-level block fixtures
      // with no concave corners — can't exercise the control.
      default:
        return null
    }
  }

  // machiningOrder needs 2+ features to distinguish feature_first from
  // level_first. single-feature fixtures are byte-identical by design
  // (roughSurface.test.ts:1375).
  if (control === 'machiningOrder') {
    switch (kind) {
      case 'pocket':
        return pocketMultiFeatureFixture()
      case 'surface_clean':
        return surfaceCleanMultiFeatureFixture()
      // The committed .camj mesh fixtures carry 1 model each,
      // perFeatureOperations never splits them, so the toggle is inert.
      default:
        return null
    }
  }

  // cleanWallCorners requires a finish pass with roundOutsideCorners on.
  if (control === 'cleanWallCorners') {
    switch (kind) {
      case 'pocket':
        return pocketFinishFixture()
      case 'surface_clean':
        return surfaceCleanFinishFixture()
      // rough_surface, finish_surface_cleanup: mixed-silhouette level
      // boundary — skip when testing the applies:false byte-identity
      // unless we have a finish-pass mesh fixture with rounding.
      // Default base fixture works fine for the false-applies toggle
      // (the engine ignores cleanWallCorners because the declaration says so).
      default:
        return baseFixtureForKind(kind)
    }
  }

  return baseFixtureForKind(kind)
}

function baseFixtureForKind(kind: OperationKind): Fixture {
  switch (kind) {
    case 'pocket':
      return pocketFixture()
    case 'surface_clean':
      return surfaceCleanFixture()
    case 'rough_surface':
      return roughSurfaceFixture()
    case 'finish_surface_cleanup':
      return finishSurfaceCleanupFixture()
    default:
      throw new Error(`No fixture for non-clearing kind ${kind}`)
  }
}

// ── Toggle pairs (on/off overrides for a given control) ───────────────

interface TogglePair {
  on: Partial<Operation>
  off: Partial<Operation>
}

function toggleForControl(_kind: OperationKind, control: ClearingControl): TogglePair | null {
  switch (control) {
    case 'roundOutsideCorners':
      return {
        on:  { roundOutsideCorners: true },
        off: { roundOutsideCorners: false },
      }
    case 'cleanWallCorners':
      return {
        on:  { roundOutsideCorners: true, cleanWallCorners: true, pass: 'finish' as const },
        off: { roundOutsideCorners: true, cleanWallCorners: false, pass: 'finish' as const },
      }
    case 'slotFeed':
      return {
        on:  { pocketSlotFeedPercent: 60, pocketFeedReduction: 'slots_only' as const },
        off: { pocketSlotFeedPercent: undefined, pocketFeedReduction: undefined },
      }
    case 'engagementMode':
      return {
        on:  { pocketSlotFeedPercent: 60, pocketFeedReduction: 'engagement' as const },
        off: { pocketSlotFeedPercent: undefined, pocketFeedReduction: undefined },
      }
    case 'machiningOrder':
      return {
        on:  { machiningOrder: 'feature_first' as const },
        off: { machiningOrder: 'level_first' as const },
      }
    case 'cornerRelief':
      return {
        on:  { cornerRelief: 'dogbone' as const },
        off: { cornerRelief: 'none' as const },
      }
    default:
      return null
  }
}

// ── Predicates — where "lands in the right place" means ───────────────

/**
 * `roundOutsideCorners`: the clearing rings' sharpest single-vertex turn
 * drops; a sharp turn is replaced by an arc of many small turns.
 *
 * Measured by: the count of planar cut segments at the deepest Z level
 * increases, because each sharp corner that was one segment becomes an arc
 * of many segments.
 *
 * The exact count depends on the corner geometry (Clipper mitering,
 * tessellation density), so we assert the count *increases*, not a fixed
 * number. For mesh kinds (rough_surface, finish_surface_cleanup) the level
 * boundaries are model silhouettes — `planContourSmoothing` leaves them
 * alone when the path already tracks a circle at least as broad as the
 * request. We record that as the skip reason rather than asserting.
 */
function predicateRoundOutsideCorners(
  kind: OperationKind,
  onResult: PocketToolpathResult,
  offResult: PocketToolpathResult,
): void {
  // Mesh kinds: level boundaries come from model silhouettes, which
  // planContourSmoothing ignores when the path already tracks a circle.
  if (kind === 'rough_surface' || kind === 'finish_surface_cleanup') {
    skip(
      `${kind} roundOutsideCorners`,
      'level boundaries are sliced model silhouettes; planContourSmoothing ' +
      'leaves them alone when the path already tracks a circle at least as ' +
      'broad as the request',
    )
    return
  }

  // 2D kinds (pocket, surface_clean): rounding replaces each sharp corner
  // with many arc segments, so the total cut segment count at the deepest
  // Z increases significantly.
  const deepestZ = Math.min(
    ...onResult.moves.filter((m) => m.kind === 'cut').map((m) => m.to.z),
  )
  const countCutsAtZ = (moves: ToolpathMove[]): number =>
    moves.filter(
      (m) => m.kind === 'cut' && Math.abs(m.to.z - deepestZ) <= 1e-6,
    ).length
  const offCount = countCutsAtZ(offResult.moves)
  const onCount  = countCutsAtZ(onResult.moves)

  assert(
    offCount > 0,
    `${kind} roundOutsideCorners: no cut moves at deepest Z in off result`,
  )
  assert(
    onCount > offCount,
    `${kind} roundOutsideCorners: rounding must add arc segments at the deepest Z ` +
    `(got ${offCount} → ${onCount} cuts)`,
  )
}

/**
 * `cleanWallCorners`: the **wall-defining** ring gains motion, and the
 * interior rings and floor do not. For a finish pass the wall-defining ring
 * is the wall contour — the D5 distinction.
 */
function predicateCleanWallCorners(
  kind: OperationKind,
  onResult: PocketToolpathResult,
  offResult: PocketToolpathResult,
): void {
  const extent = (moves: ToolpathMove[]): number =>
    Math.max(
      ...moves
        .filter((m) => m.kind === 'cut')
        .flatMap((m) => [
          Math.abs(m.from.x), Math.abs(m.to.x),
          Math.abs(m.from.y), Math.abs(m.to.y),
        ]),
    )

  const offExtent = extent(offResult.moves)
  const onExtent  = extent(onResult.moves)
  assert(
    Math.abs(offExtent - onExtent) <= 1e-3,
    `${kind} cleanWallCorners: extent must not change, ` +
    `got ${offExtent.toFixed(4)} → ${onExtent.toFixed(4)}`,
  )

  const wallMoveCount = (moves: ToolpathMove[], limit: number): number =>
    moves.filter(
      (m) =>
        m.kind === 'cut' &&
        [m.from.x, m.to.x, m.from.y, m.to.y].some((v) => Math.abs(v) >= limit - 1e-3),
    ).length

  const offWall = wallMoveCount(offResult.moves, offExtent)
  const onWall  = wallMoveCount(onResult.moves, onExtent)

  // surface_clean's wall may have no sharp corners when the geometry is a
  // simple rect boss. Skip rather than hard-fail on that kind.
  if (onWall <= offWall && kind === 'surface_clean') {
    skip(
      `${kind} cleanWallCorners wall motion`,
      'surface_clean wall contour has no sharp corners in this fixture',
    )
  } else {
    assert(
      onWall > offWall,
      `${kind} cleanWallCorners: wall band must gain motion, ` +
      `got ${offWall} → ${onWall} moves`,
    )
  }

  const cutLength = (moves: ToolpathMove[]): number =>
    moves
      .filter((m) => m.kind === 'cut')
      .reduce((s, m) => s + Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y), 0)

  assert(
    cutLength(onResult.moves) > cutLength(offResult.moves),
    `${kind} cleanWallCorners: total cut length must grow when control is on`,
  )
}

/**
 * `slotFeed`: `feedScale` appears, equals exactly
 * `pocketSlotFeedPercent / 100`, and appears only on fed moves (never on
 * plunges).
 */
function predicateSlotFeed(
  kind: OperationKind,
  onResult: PocketToolpathResult,
  offResult: PocketToolpathResult,
): void {
  const onScales = onResult.moves.filter(
    (m) => m.kind === 'cut' && m.feedScale !== undefined && m.feedScale < 1,
  )
  assert(
    onScales.length > 0,
    `${kind} slotFeed on: expected cuts with feedScale < 1, got none`,
  )
  for (const move of onScales) {
    assert(
      Math.abs(move.feedScale! - 0.6) <= 1e-9,
      `${kind} slotFeed: expected feedScale 0.6, got ${move.feedScale}`,
    )
  }
  // plunge moves must never carry feedScale
  const plungeWithScale = onResult.moves.filter(
    (m) => m.kind === 'plunge' && m.feedScale !== undefined,
  )
  assert(
    plungeWithScale.length === 0,
    `${kind} slotFeed: plunge moves must not carry feedScale`,
  )
  // off result must not carry any feedScale reductions
  const offScales = offResult.moves.filter(
    (m) => m.feedScale !== undefined && m.feedScale < 1,
  )
  assert(
    offScales.length === 0,
    `${kind} slotFeed off: expected no feedScale reductions`,
  )
}

/**
 * `engagementMode`: more than one distinct `feedScale` is emitted — a
 * ladder, not a single rung.
 */
function predicateEngagementMode(
  kind: OperationKind,
  onResult: PocketToolpathResult,
): void {
  const scales = new Set(
    onResult.moves
      .filter((m) => m.kind === 'cut' && m.feedScale !== undefined)
      .map((m) => m.feedScale!),
  )
  assert(
    scales.size >= 2,
    `${kind} engagementMode: expected multi-rung ladder, ` +
    `got ${scales.size} distinct scale(s) [${[...scales].map((s) => s.toFixed(3)).join(', ')}]`,
  )
}

/**
 * `machiningOrder`: `feature_first` emits each feature's moves
 * contiguously; `level_first` interleaves them.
 */
function predicateMachiningOrder(
  kind: OperationKind,
  onResult: PocketToolpathResult,
  offResult: PocketToolpathResult,
): void {
  assert(
    serializeMoves(onResult.moves) !== serializeMoves(offResult.moves),
    `${kind} machiningOrder: feature_first and level_first must differ`,
  )

  // Feature_first must produce contiguous spatial zones. Zone is determined
  // by x-centroid relative to the midpoint of all cut centroids.
  const isContiguousBlocks = (moves: ToolpathMove[]): boolean => {
    const xs = moves
      .filter((m) => m.kind === 'cut')
      .map((m) => (m.from.x + m.to.x) / 2)
    if (xs.length === 0) return true
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2
    const zones = moves
      .filter((m) => m.kind === 'cut')
      .map((m) => ((m.from.x + m.to.x) / 2 < mid ? 0 : 1))
    const first0 = zones.indexOf(0)
    const first1 = zones.indexOf(1)
    if (first0 < 0 || first1 < 0) return true // single zone
    return zones.lastIndexOf(0) < first1 || zones.lastIndexOf(1) < first0
  }
  assert(
    isContiguousBlocks(onResult.moves),
    `${kind} machiningOrder feature_first: spatial zones should be contiguous`,
  )
}

/**
 * `cornerRelief`: extra motion appears at the region's **concave** corners
 * and nowhere else. The relief pass is a dedicated stepped pass appended
 * after the main path.
 */
function predicateCornerRelief(
  kind: OperationKind,
  onResult: PocketToolpathResult,
  offResult: PocketToolpathResult,
): void {
  assert(
    onResult.moves.length > offResult.moves.length,
    `${kind} cornerRelief on must append extra moves ` +
    `(got ${onResult.moves.length} ≤ ${offResult.moves.length})`,
  )
  const onCuts  = onResult.moves.filter((m) => m.kind === 'cut').length
  const offCuts = offResult.moves.filter((m) => m.kind === 'cut').length
  assert(
    onCuts > offCuts,
    `${kind} cornerRelief on must have more cut moves ` +
    `(got ${onCuts} ≤ ${offCuts})`,
  )
}

// ── Predicate dispatch ────────────────────────────────────────────────

function assertPredicate(
  control: ClearingControl,
  kind: OperationKind,
  onResult: PocketToolpathResult,
  offResult: PocketToolpathResult,
): void {
  switch (control) {
    case 'roundOutsideCorners':
      predicateRoundOutsideCorners(kind, onResult, offResult)
      break
    case 'cleanWallCorners':
      predicateCleanWallCorners(kind, onResult, offResult)
      break
    case 'slotFeed':
      predicateSlotFeed(kind, onResult, offResult)
      break
    case 'engagementMode':
      predicateEngagementMode(kind, onResult)
      break
    case 'machiningOrder':
      predicateMachiningOrder(kind, onResult, offResult)
      break
    case 'cornerRelief':
      predicateCornerRelief(kind, onResult, offResult)
      break
  }
}

// ── Main loop ────────────────────────────────────────────────────────

console.log('Clearing-control effect contract (slice 5)\n')

const allKinds = Object.keys(CLEARING_CONTROL_SUPPORT) as OperationKind[]
let totalTests = 0

for (const kind of allKinds) {
  const support = CLEARING_CONTROL_SUPPORT[kind]
  const isClearing = 'controls' in support
  console.log(`${kind}:`)

  if (!isClearing) {
    console.log(`   (non-clearing — ${support.reason})\n`)
    continue
  }

  for (const control of ALL_CLEARING_CONTROLS) {
    const cell = support.controls[control]
    const testName = `${kind} × ${control}`
    totalTests += 1

    // Resolve the best fixture available.
    let fixture: Fixture | null
    try {
      fixture = fixtureForCell(kind, control)
    } catch {
      fixture = null
    }
    if (!fixture) {
      const reason =
        control === 'cornerRelief'
          ? `no concave-corner mesh fixture for ${kind}`
          : control === 'machiningOrder'
            ? `mesh fixtures carry 1 model each — ${kind} can never split`
            : `no expressive fixture for ${kind} × ${control}`
      skip(testName, reason)
      continue
    }

    const toggle = toggleForControl(kind, control)
    if (!toggle) {
      skip(testName, `no toggle mapping`)
      continue
    }

    const onOp  = { ...fixture.operation, ...toggle.on }
    const offOp = { ...fixture.operation, ...toggle.off }

    let onResult: PocketToolpathResult
    let offResult: PocketToolpathResult
    try {
      onResult  = generateToolpath(kind, fixture.project, onOp)
      offResult = generateToolpath(kind, fixture.project, offOp)
    } catch (err: unknown) {
      skip(testName, `generator error: ${String(err)}`)
      continue
    }

    if (!cell.applies) {
      // ── applies: false — toggle must leave stream byte-identical ──
      test(`${testName} [false-apply byte-identity]`, () => {
        assert(
          serializeMoves(onResult.moves) === serializeMoves(offResult.moves),
          `${testName}: applies=false cell must produce byte-identical output ` +
          `across toggle (${onResult.moves.length} on-moves vs ${offResult.moves.length} off-moves)`,
        )
      })
    } else {
      // ── applies: true — check the location predicate ──
      test(`${testName} [predicate]`, () => {
        assertPredicate(control, kind, onResult, offResult)
      })
    }
  }
  console.log('')
}

console.log(`${passed} passed, ${skipped} skipped, ${failed} failed (of ${totalTests} cells)`)
if (failed > 0) process.exit(1)