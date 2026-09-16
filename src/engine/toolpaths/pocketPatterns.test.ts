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
 * The declared pocket-pattern table and, more importantly, the claim it makes
 * (issue #609).
 *
 * The table asserts that every pattern a kind OFFERS is one its generator
 * IMPLEMENTS. That is a claim about emitted motion, not about the table's own
 * fields, so the matrix below runs real generation for every `(kind, offered
 * pattern)` pair on a fixture that pattern should cut and requires a non-empty
 * floor. Three shipped defects (#579, #583, #609) were each exactly this
 * assertion failing, and none of them could be seen from the table alone.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketPatterns.test.ts
 */

import { readFileSync } from 'fs'
import {
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type OperationKind,
  type PocketPattern,
  type Project,
  type SketchFeature,
  type Tool,
} from '../../types/project'
import { normalizeProject } from '../../store/projectStore'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  OPERATION_PATTERN_SUPPORT,
  areaCoverage,
  effectivePocketPattern,
  offeredPocketPatterns,
  takesPocketPattern,
  TROCHOIDAL_RING_STEPOVER,
  type EffectivePocketPattern,
  usesTangentLinks,
} from './pocketPatterns'
import { generatePocketToolpath } from './pocket'
import { generateSurfaceCleanToolpath } from './surface'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import { generateRoughSurfaceToolpath } from './roughSurface'
import type { PocketToolpathResult } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const ALL_KINDS: OperationKind[] = [
  'pocket',
  'v_carve',
  'v_carve_medial',
  'edge_route_inside',
  'edge_route_outside',
  'surface_clean',
  'rough_surface',
  'finish_surface',
  'finish_surface_cleanup',
  'follow_line',
  'drilling',
]

const ALL_PATTERNS: PocketPattern[] = ['offset', 'parallel', 'waterline', 'constant_scallop', 'seeded_offset']

/** An effective pattern that emits motion — anything but the inert `'none'`. */
function cuts(effective: EffectivePocketPattern): boolean {
  if (effective === 'none') return false
  const coverage = areaCoverage(effective)
  // `waterline` and `constant_scallop` are 3D surface-finishing strategies
  // rather than area coverage, so they report no coverage here and are still
  // patterns that cut.
  return effective === 'waterline' || effective === 'constant_scallop'
    || coverage.rings || coverage.rasterSegments
}

// ── The table's own structure ───────────────────────────────────────

function testEveryKindIsClassified(): void {
  console.log('Testing every operation kind is classified by the pattern table...')
  const declared = Object.keys(OPERATION_PATTERN_SUPPORT).sort()
  assert(
    declared.join(',') === [...ALL_KINDS].sort().join(','),
    `pattern table must classify exactly the operation kinds, got ${declared.join(', ')}`,
  )
}

function testOfferedIsAlwaysImplemented(): void {
  console.log('Testing no kind offers a pattern it does not implement...')
  for (const kind of ALL_KINDS) {
    for (const pattern of offeredPocketPatterns(kind)) {
      const effective = effectivePocketPattern(kind, pattern)
      assert(
        cuts(effective),
        `${kind} offers ${pattern}, which resolves to ${effective} and cuts nothing`,
      )
    }
  }
}

function testKindsWithoutAPatternRowResolveToNothing(): void {
  console.log('Testing a kind with no pattern row resolves every pattern to none...')
  for (const kind of ALL_KINDS) {
    if (takesPocketPattern(kind)) continue
    for (const pattern of ALL_PATTERNS) {
      assert(
        effectivePocketPattern(kind, pattern) === 'none',
        `${kind} renders no pattern control, so ${pattern} must resolve to none`,
      )
    }
  }
}

function testCoverageIsSingleValued(): void {
  console.log('Testing an effective pattern never claims two kinds of coverage...')
  const effectives: EffectivePocketPattern[] = [...ALL_PATTERNS, 'none']
  for (const effective of effectives) {
    const coverage = areaCoverage(effective)
    assert(
      !(coverage.rings && coverage.rasterSegments),
      `${effective} claims both rings and a raster`,
    )
    assert(
      !coverage.seedCircles || coverage.rings,
      `${effective} seeds circles without the rings that finish the area`,
    )
  }
}

// ── Fixtures for the generation matrix ──────────────────────────────

function loadFixture(name: string): Project {
  const raw = readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), 'utf8')
  return normalizeProject(JSON.parse(raw) as Project)
}

function makeFlatEndmill(id: string, diameter: number): Tool {
  return {
    ...defaultTool('mm', 1),
    id,
    name: `${diameter}mm flat`,
    type: 'flat_endmill',
    diameter,
    defaultStepdown: 2,
    defaultStepover: 0.4,
    maxCutDepth: 25,
  }
}

function makeRectFeature(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  operation: SketchFeature['operation'],
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, width, height),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeFloorOperation(
  overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target' | 'toolRef'>,
): Operation {
  const base: Operation = {
    id: 'op1',
    name: 'op',
    kind: overrides.kind,
    pass: 'finish',
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
    // Walls off, floor on: the matrix is about the FLOOR, and a wall pass would
    // hide an empty floor behind motion the pattern had nothing to do with —
    // which is precisely how #609 stayed invisible.
    finishWalls: false,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
  return { ...base, ...overrides }
}

/**
 * The stepover a row is generated at.
 *
 * The fixtures store a contour stepover, a fraction of the tool diameter. A
 * trochoidal stepover is a fraction of the CHANNEL, and the CAM panel replaces
 * the stored value with `TROCHOIDAL_RING_STEPOVER` the moment the pattern is
 * picked. The matrix generates what a user gets by picking the pattern, so
 * trochoidal rows take the seeded value.
 *
 * It matters on the 3D roughing fixture: at its stored 0.32 the rings are dense
 * enough to exhaust that job's point budget, and the pass refuses. That refusal
 * is asserted on its own in `testTrochoidalBudgetRefusalEmitsNothing`.
 */
function patternStepover(pattern: PocketPattern, stored: number): number {
  return pattern === 'trochoidal' ? TROCHOIDAL_RING_STEPOVER : stored
}

/**
 * One `(kind, pattern)` row: generate on a fixture that pattern should cut.
 *
 * `pass` only means anything to `pocket` and `surface_clean`, which clear a
 * whole band on the rough pass and only the floor on the finish pass. It
 * defaults to the finish floor — the narrower, easier-to-hide half — and
 * `testTrochoidalRowsOrbit` runs both, because #789's report was a ROUGH pass
 * and a floor-only matrix would have stayed green through it.
 */
function generateFloor(
  kind: OperationKind,
  pattern: PocketPattern,
  pass: 'rough' | 'finish' = 'finish',
): PocketToolpathResult {
  if (kind === 'pocket') {
    const project = projectWithFeatures(
      { ...newProject('pattern-matrix-pocket', 'mm'), tools: [makeFlatEndmill('t1', 4)] },
      [makeRectFeature('a', 0, 0, 40, 30, 'subtract')],
    )
    return generatePocketToolpath(project, makeFloorOperation({
      kind,
      target: { source: 'features', featureIds: ['a'] },
      toolRef: 't1',
      pocketPattern: pattern,
      stepover: patternStepover(pattern, 0.4),
      pass,
    }))
  }
  if (kind === 'surface_clean') {
    // surface_clean cleans the stock AROUND a pad, so its target is an add.
    const project = projectWithFeatures(
      { ...newProject('pattern-matrix-surface-clean', 'mm'), tools: [makeFlatEndmill('t1', 4)] },
      [makeRectFeature('a', 10, 10, 30, 25, 'add')],
    )
    return generateSurfaceCleanToolpath(project, makeFloorOperation({
      kind,
      target: { source: 'features', featureIds: ['a'] },
      toolRef: 't1',
      stepdown: 1,
      pocketPattern: pattern,
      stepover: patternStepover(pattern, 0.4),
      pass,
    }))
  }
  if (kind === 'finish_surface') {
    // 3D finishing has no wall/floor split; the whole pass is the surface.
    const project = loadFixture('3d-imported-block-test3.camj')
    const operation = project.operations.find((candidate) => candidate.kind === 'finish_surface')
    assert(operation, 'expected a finish_surface operation in 3d-imported-block-test3.camj')
    return generateFinishSurfaceToolpath(project, { ...operation, pocketPattern: pattern })
  }
  if (kind === 'finish_surface_cleanup') {
    const project = loadFixture('model-in-pocket.camj')
    const operation = project.operations.find((candidate) => candidate.kind === 'finish_surface_cleanup')
    assert(operation, 'expected a finish_surface_cleanup operation in model-in-pocket.camj')
    return generateFinishSurfaceCleanupToolpath(project, {
      ...operation,
      pocketPattern: pattern,
      finishWalls: false,
      finishFloor: true,
    })
  }
  if (kind === 'rough_surface') {
    // Roughing is model-aware with no wall/floor split; the whole pass is the
    // level clearing. The stored op in this fixture keeps every other setting.
    const project = loadFixture('model-in-pocket.camj')
    const operation = project.operations.find((candidate) => candidate.kind === 'rough_surface')
    assert(operation, 'expected a rough_surface operation in model-in-pocket.camj')
    return generateRoughSurfaceToolpath(project, {
      ...operation,
      pocketPattern: pattern,
      stepover: patternStepover(pattern, operation.stepover),
    })
  }
  throw new Error(`no fixture for pattern-taking kind ${kind}`)
}

function testEveryOfferedPairCutsSomething(): void {
  console.log('Testing every offered (kind, pattern) pair emits a non-empty floor...')
  let rows = 0
  for (const kind of ALL_KINDS) {
    for (const pattern of offeredPocketPatterns(kind)) {
      const result = generateFloor(kind, pattern)
      const cutCount = result.moves.filter((move) => move.kind === 'cut').length
      assert(
        cutCount > 0,
        `${kind} offers ${pattern} but generation emitted no cut moves `
        + `(warnings: ${JSON.stringify(result.warnings)})`,
      )
      rows += 1
    }
  }
  assert(rows >= 11, `expected the full offered matrix, only ran ${rows} rows`)
}

/**
 * Every kind that offers trochoidal must actually ORBIT (issue #789).
 *
 * `testEveryOfferedPairCutsSomething` above is a non-emptiness check, and that
 * is precisely the hole #789 fell through: `surface_clean` and `rough_surface`
 * offered trochoidal, traced the ring centrelines as plain contours, emitted
 * plenty of cut moves and no warning. The row was green for six months while
 * the program cut a 50 %-of-diameter contour bite the panel described as a
 * light orbit.
 *
 * So this asserts pattern CHARACTER rather than pattern presence. Two
 * independent signatures, because either alone has a cheap false pass:
 *
 *   - the emitter's own ring-to-ring transition, which only the orbit path
 *     produces (a contour ring links at depth or retracts unmarked), and
 *   - a cut count far above the contour row's, because an orbit walks a
 *     sampled trochoid where a contour walks the guide itself. A generator
 *     that emitted one marked transition and then traced contours would pass
 *     the first check and fail this one.
 *
 * The table cannot state this. `areaCoverage` is exhaustive over the pattern
 * union — it forces every pattern to SAY what it covers — but nothing forces a
 * generator to READ the member it is handed, and a generator that destructures
 * three of four members compiles cleanly. Until that is closable at the type
 * level, this is the guard.
 */
function testTrochoidalRowsOrbit(): void {
  console.log('Testing every kind that offers trochoidal emits orbits, not contours...')
  let rows = 0
  for (const kind of ALL_KINDS) {
    if (!offeredPocketPatterns(kind).includes('trochoidal')) continue
    // Rough clears the band, finish clears only the floor, and both orbit —
    // `isTrochoidalPocket`'s `finishFloor` term says so. 3D roughing has no
    // such split, so its two rows are the same pass and one is enough.
    const passes = kind === 'rough_surface' ? (['rough'] as const) : (['rough', 'finish'] as const)
    for (const pass of passes) {
      const orbit = generateFloor(kind, 'trochoidal', pass)
      const contour = generateFloor(kind, 'offset', pass)
      const orbitCuts = orbit.moves.filter((move) => move.kind === 'cut').length
      const contourCuts = contour.moves.filter((move) => move.kind === 'cut').length
      // Every chain of orbits opens with its own entry; a linked ring (#790)
      // has no retract of its own, so the entry is the marker that always exists.
      const entries = orbit.moves.filter((move) => move.source === 'trochoidal-entry').length

      assert(
        entries > 0,
        `${kind} ${pass} offers trochoidal but emitted no orbit entry — the rings were `
        + `traced as contours, which is issue #789 (warnings: ${JSON.stringify(orbit.warnings)})`,
      )
      assert(
        orbitCuts > contourCuts * 2,
        `${kind} ${pass} trochoidal emitted ${orbitCuts} cuts against ${contourCuts} on offset; an `
        + 'orbit samples far more densely than the guide it rides, so a comparable count means '
        + 'the guide itself was cut',
      )
      rows += 1
    }
  }
  assert(rows === 5, `expected pocket and surface_clean on both passes plus rough_surface, ran ${rows}`)
}

/**
 * A trochoidal pass that exhausts its budget emits nothing.
 *
 * Whether a pass exhausts the budget depends on the job — roughly cut area x
 * number of levels / ring spacing, for every clearing kind alike — not on a
 * stepover threshold. The 3D roughing fixture at 0.3 is simply one job that
 * does — its stored 0.32 did until #790 joined rings at depth, which saved the
 * helical entries that took it past the ceiling (997,711 moves now). What is
 * asserted is the refusal: an empty program carrying the budget warning. The
 * alternative is emitting the rings that did fit, after which the level below
 * descends into channels no orbit has opened.
 */
function testTrochoidalBudgetRefusalEmitsNothing(): void {
  console.log('Testing a trochoidal pass that exhausts its budget emits nothing...')
  const project = loadFixture('model-in-pocket.camj')
  const operation = project.operations.find((candidate) => candidate.kind === 'rough_surface')
  assert(operation, 'expected a rough_surface operation in model-in-pocket.camj')
  const result = generateRoughSurfaceToolpath(project, {
    ...operation,
    pocketPattern: 'trochoidal',
    stepover: 0.3,
  })
  assert(
    result.moves.length === 0,
    `a trochoidal pass that could not emit every ring must emit nothing, got ${result.moves.length} moves`,
  )
  assert(
    result.warnings.some((warning) => warning.code === 'pocketTrochoidalMoveBudget'),
    `expected the budget refusal to be named, got ${JSON.stringify(result.warnings.map((w) => w.code))}`,
  )
}

function testTangentLinkApplicability(): void {
  console.log('Testing tangential S-link applicability per kind and pattern...')
  // Every clearing kind links ring-to-ring on every non-parallel pattern.
  // The parallel raster has no rings to move between, so it is excluded.
  for (const kind of ['pocket', 'surface_clean', 'rough_surface', 'finish_surface_cleanup'] as const) {
    assert(usesTangentLinks(kind, 'offset'), `${kind} offset links ring to ring`)
    assert(usesTangentLinks(kind, 'seeded_offset'), `${kind} seeded links ring to ring`)
    assert(!usesTangentLinks(kind, 'parallel'), `${kind} parallel has no ring-to-ring link`)
  }
  // Kinds with no clearing pattern never link.
  for (const kind of ['drilling', 'v_carve', 'follow_line', 'edge_route_inside'] as const) {
    assert(!usesTangentLinks(kind, 'offset'), `${kind} does not clear with rings`)
  }
}

async function run(): Promise<void> {
  testEveryKindIsClassified()
  testOfferedIsAlwaysImplemented()
  testKindsWithoutAPatternRowResolveToNothing()
  testCoverageIsSingleValued()
  testEveryOfferedPairCutsSomething()
  testTrochoidalRowsOrbit()
  testTrochoidalBudgetRefusalEmitsNothing()
  testTangentLinkApplicability()
  console.log('pocketPatterns.test.ts: all tests passed')
}

void run()
