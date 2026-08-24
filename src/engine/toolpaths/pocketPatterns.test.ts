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

const ALL_PATTERNS: PocketPattern[] = ['offset', 'parallel', 'waterline', 'seeded_offset']

/** An effective pattern that emits motion — anything but the inert `'none'`. */
function cuts(effective: EffectivePocketPattern): boolean {
  if (effective === 'none') return false
  const coverage = areaCoverage(effective)
  // `waterline` is a 3D constant-Z strategy rather than area coverage, so it
  // reports no coverage here and is still a pattern that cuts.
  return effective === 'waterline' || coverage.rings || coverage.rasterSegments
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

/** One `(kind, pattern)` row: generate on a fixture that pattern should cut. */
function generateFloor(kind: OperationKind, pattern: PocketPattern): PocketToolpathResult {
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
    return generateRoughSurfaceToolpath(project, { ...operation, pocketPattern: pattern })
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

function testTangentLinkApplicability(): void {
  console.log('Testing tangential S-link applicability per kind and pattern...')
  // Pocket and surface_clean link ring-to-ring on every non-parallel pattern.
  for (const kind of ['pocket', 'surface_clean'] as const) {
    assert(usesTangentLinks(kind, 'offset'), `${kind} offset links ring to ring`)
    assert(usesTangentLinks(kind, 'seeded_offset'), `${kind} seeded links ring to ring`)
    assert(!usesTangentLinks(kind, 'parallel'), `${kind} parallel has no ring-to-ring link`)
  }
  // Cleanup links the seed path ONLY. Offering the control on any other
  // pattern would be a checkbox the generator ignores — the #609 defect.
  assert(
    usesTangentLinks('finish_surface_cleanup', 'seeded_offset'),
    'cleanup links its seed-circle path',
  )
  for (const pattern of ['offset', 'parallel', 'waterline'] as const) {
    assert(
      !usesTangentLinks('finish_surface_cleanup', pattern),
      `cleanup ${pattern} floor rings are not linked, so the setting is a no-op`,
    )
  }
  // Kinds with no clearing pattern never link.
  for (const kind of ['drilling', 'v_carve', 'follow_line', 'edge_route_inside'] as const) {
    assert(!usesTangentLinks(kind, 'offset'), `${kind} does not clear with rings`)
  }
  // rough_surface joins the clearing set (#618) without S-links: its per-level
  // safeLinkCheck gate is the only link protection it has, and no stored
  // pattern may render the roundLinkCorners checkbox for it.
  for (const pattern of ALL_PATTERNS) {
    assert(
      !usesTangentLinks('rough_surface', pattern),
      `rough_surface ${pattern} must not link — the control stays out of scope for #618`,
    )
  }
}

async function run(): Promise<void> {
  testEveryKindIsClassified()
  testOfferedIsAlwaysImplemented()
  testKindsWithoutAPatternRowResolveToNothing()
  testCoverageIsSingleValued()
  testEveryOfferedPairCutsSomething()
  testTangentLinkApplicability()
  console.log('pocketPatterns.test.ts: all tests passed')
}

void run()
