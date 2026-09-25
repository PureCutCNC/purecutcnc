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
 * Part-in-hole placement, project side (issue #859, step 5 of #741): which
 * regions of a part count as holes another part may sit in, and a nest that
 * uses one.
 *
 * Run with: npx tsx src/store/nestingHoles.test.ts
 */

import ClipperLib from 'clipper-lib'
import { nest } from '../engine/nesting'
import { NEST_SCALE, ringToPath } from '../engine/nesting/clipperOps'
import { projectWithFeatures } from '../test/projectFixtures'
import {
  defaultStock,
  defaultTool,
  newProject,
  rectProfile,
  type OperationKind,
  type Project,
  type SketchFeature,
  type SketchProfile,
} from '../types/project'
import { createTextFeatureAt } from './helpers/naming'
import { buildNestRequest, nestPlacementMatrix, resolveNestParts } from './helpers/nestPart'
import { defaultOperationForTarget } from './helpers/operationDefaults'
import { normalizeProject, type ProjectFormatInput } from './helpers/projectFormat'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const GAP = 4

function row(id: string, operation: SketchFeature['operation'], profile: SketchProfile, extra: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id, name: id, kind: 'rect', operation, visible: true, locked: false, z_top: 12, z_bottom: 0,
    folderId: null, text: null, stl: null,
    sketch: { origin: { ...profile.start }, orientationAngle: 0, dimensions: [], constraints: [], profile },
    ...extra,
  }
}

/** An 80 mm plate with a 40 mm through hole, cut out by an outside route and the hole by `holeKind`. */
function plateProject(extra: SketchFeature[] = [], holeKind: OperationKind = 'edge_route_inside', holeBottom = 0): Project {
  const base = newProject()
  base.meta = { ...base.meta, units: 'mm' }
  base.stock = defaultStock(300, 200, 12, 'mm')
  const project = projectWithFeatures(base, [
    row('plate', 'add', rectProfile(10, 10, 80, 80)),
    row('hole', 'subtract', rectProfile(30, 30, 40, 40), { z_bottom: holeBottom }),
    ...extra,
  ])
  const tool = { ...defaultTool('mm', 1), id: 'tool', diameter: GAP }
  const withTool = { ...project, tools: [tool] }
  const outside = defaultOperationForTarget(withTool, 'edge_route_outside', 'finish', { source: 'features', featureIds: ['plate'] }, 0)
  const inside = defaultOperationForTarget(withTool, holeKind, 'finish', { source: 'features', featureIds: ['hole'] }, 1)
  const withOperations = {
    ...withTool,
    operations: [{ ...outside, id: 'op-out', toolRef: tool.id }, { ...inside, id: 'op-in', toolRef: tool.id }],
  }
  return normalizeProject(JSON.parse(JSON.stringify(withOperations)) as ProjectFormatInput)
}

function holesOf(project: Project, ids = ['plate']): number[] {
  const resolution = resolveNestParts(project, ids)
  assert(resolution.ok && resolution.parts.length === 1, `one part: ${JSON.stringify(resolution)}`)
  return resolution.parts[0].holes.map((ring) => ClipperLib.Clipper.Area(ringToPath(ring)) / NEST_SCALE ** 2)
}

function testThroughEdgeRoutedHole(): void {
  const areas = holesOf(plateProject())
  assert(areas.length === 1 && Math.abs(areas[0] - 1600) < 1e-6, `the 40 mm hole is found, got ${areas}`)

  const island = row('island', 'add', rectProfile(45, 45, 10, 10))
  const withIsland = holesOf(plateProject([island]), ['plate'])
  assert(
    withIsland.length === 2 && Math.abs(withIsland[0] - 1600) < 1e-6 && Math.abs(withIsland[1] + 100) < 1e-6,
    `an island drawn after the hole stays material, as a clockwise ring: ${withIsland}`,
  )
  console.log('a through, edge-routed hole counts: PASSED')
}

function testTextCounters(): void {
  const base = newProject()
  base.meta = { ...base.meta, units: 'mm' }
  base.stock = defaultStock(300, 200, 12, 'mm')
  const text = createTextFeatureAt(base, { text: 'O', style: 'outline', fontId: 'helvetiker_bold', size: 60, operation: 'add', layout: null }, { x: 20, y: 20 })
  assert(text, 'text feature builds')
  const project = normalizeProject(JSON.parse(JSON.stringify(
    projectWithFeatures(base, [{ ...text, id: 'o', operation: 'add', z_top: 12, z_bottom: 0 }]),
  )) as ProjectFormatInput)
  const areas = holesOf(project, ['o'])
  assert(areas.length === 1 && areas[0] > 300, `the O's counter is a hole, got ${areas}`)
  console.log('text counters count: PASSED')
}

function testHolesThatWouldCutAPart(): void {
  assert(holesOf(plateProject([], 'pocket')).length === 0, 'a pocketed hole is cleared, so not used')
  assert(holesOf(plateProject([], 'v_carve')).length === 0, 'a V-carved hole is not used')
  assert(holesOf(plateProject([], 'edge_route_inside', 4)).length === 0, 'a subtract short of the full depth is not a hole')

  const line: SketchProfile = { start: { x: 35, y: 50 }, segments: [{ type: 'line', to: { x: 65, y: 50 } }], closed: false }
  assert(holesOf(plateProject([row('engrave', 'line', line)])).length === 0, 'an open profile inside the hole drops it')

  const inner = row('inner', 'subtract', rectProfile(40, 40, 20, 20))
  assert(holesOf(plateProject([inner])).length === 0, 'a second routed boundary crossing the hole drops it')

  // A recess over the hole would be pocketed straight across a part inside it.
  const recess = row('recess', 'subtract', rectProfile(20, 20, 60, 60), { z_bottom: 8 })
  assert(holesOf(plateProject([recess])).length === 0, 'a shallow subtract over the hole drops it')
  const outside = row('outside', 'subtract', rectProfile(12, 12, 10, 10), { z_bottom: 8 })
  assert(holesOf(plateProject([outside])).length === 1, 'a shallow subtract elsewhere on the part leaves the hole alone')
  console.log('holes something would machine inside are dropped: PASSED')
}

function testNestPlacesPartsInTheHole(): void {
  // The stock is 1 mm wider than the plate, so the small squares only fit in its hole.
  const project = plateProject([row('small', 'add', rectProfile(150, 150, 10, 10))])
  const sized = { ...project, stock: defaultStock(81, 81, 12, 'mm') }
  const resolution = resolveNestParts(sized, ['plate', 'small'])
  assert(resolution.ok && resolution.parts.length === 2, 'plate and small square are two parts')
  const plateIndex = resolution.parts.findIndex((part) => part.featureIds.includes('plate'))
  const quantities = resolution.parts.map((_, index) => (index === plateIndex ? 1 : 5))
  const request = buildNestRequest(sized, resolution.parts, quantities, {
    minimumGap: GAP, rotations: [0], keepOriginals: false,
  })
  assert(request, 'request builds')
  const result = nest(request)
  const plate = result.placements.find((placement) => placement.partId === String(plateIndex))
  assert(plate, 'the plate is placed')
  const small = result.placements.filter((placement) => placement.partId !== String(plateIndex))
  // 10 + 4 + 10 ≤ 40 − 2·4 leaves room for a 2×2 block, and nowhere else.
  assert(small.length === 4, `four squares go in the hole, got ${small.length}`)
  const hole = nestPlacementMatrix(plate)
  const holeBox = { minX: 30 + hole.e, minY: 30 + hole.f, maxX: 70 + hole.e, maxY: 70 + hole.f }
  for (const placement of small) {
    const m = nestPlacementMatrix(placement)
    const box = { minX: 150 + m.e, minY: 150 + m.f, maxX: 160 + m.e, maxY: 160 + m.f }
    assert(
      box.minX >= holeBox.minX + GAP - 1e-6 && box.maxX <= holeBox.maxX - GAP + 1e-6
        && box.minY >= holeBox.minY + GAP - 1e-6 && box.maxY <= holeBox.maxY - GAP + 1e-6,
      `square ${placement.copyIndex} keeps the gap inside the hole: ${JSON.stringify(box)} in ${JSON.stringify(holeBox)}`,
    )
  }
  console.log('a nest places parts in a hole: PASSED')
}

testThroughEdgeRoutedHole()
testTextCounters()
testHolesThatWouldCutAPart()
testNestPlacesPartsInTheHole()
console.log('All nesting hole tests passed')
