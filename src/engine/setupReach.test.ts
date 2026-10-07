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

import { circleProfile, defaultTool, newProject, polygonProfile, rectProfile } from '../types/project'
import type { Operation, Project, SketchFeature } from '../types/project'
import { projectWithFeatures, withBottomSetup } from '../test/projectFixtures'
import { convertProjectUnits } from '../utils/units'
import { featureReachFootprint, cutMoveZAtFeature } from './setupReachGeometry'
import { operationCutRange, throughFeatureCoverage } from './setupReach'
import { computeOperationToolpath } from './toolpaths/generateOperation'
import type { ToolpathMove, ToolpathResult } from './toolpaths/types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function equal(actual: unknown, expected: unknown, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`)
}
function feature(id: string, x: number, y: number, radius: number): SketchFeature {
  return {
    id, name: id, kind: 'circle', folderId: null, operation: 'subtract',
    sketch: { profile: circleProfile(x, y, radius), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    z_top: 20, z_bottom: 0, authoringFace: 'top', visible: true, locked: false,
  }
}
function operation(id: string): Operation {
  return {
    id, name: id, kind: 'pocket', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: ['tiny', 'large'] }, toolRef: 't1',
    stepdown: 4, stepover: 0.4, feed: 600, plungeFeed: 180, rpm: 12000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 9,
    finishWalls: true, finishFloor: true, carveDepth: 1, maxCarveDepth: 1,
  }
}
function fixture(axis: 'x' | 'y' = 'x'): Project {
  const base = newProject('Reach attribution', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.origin = { name: 'Origin', x: 0, y: 80, z: 20, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 4, maxCutDepth: 25 }]
  return withBottomSetup(projectWithFeatures({ ...base, operations: [operation('top'), operation('bottom')] }, [
    feature('tiny', 20, 20, 1), feature('large', 26, 26, 4),
  ]), { axis, operationIds: ['bottom'] })
}
function generated(project: Project): Map<string, ToolpathResult> {
  return new Map(project.operations.map((op) => {
    const result = computeOperationToolpath(project, op)?.result
    assert(result && result.moves.length > 0, `${op.id} must actually generate cutting motion`)
    return [op.id, result]
  }))
}
function minimumSegmentDistance(moves: ToolpathMove[], x: number, y: number): number {
  return Math.min(...moves.filter((m) => m.kind !== 'rapid').map((m) => {
    const dx = m.to.x - m.from.x, dy = m.to.y - m.from.y
    const length = dx * dx + dy * dy
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - m.from.x) * dx + (y - m.from.y) * dy) / length))
    return Math.hypot(m.from.x + t * dx - x, m.from.y + t * dy - y)
  }))
}
function testNeighborDoesNotReachTinyHole(): void {
  for (const axis of ['x', 'y'] as const) {
    const project = fixture(axis)
    const paths = generated(project)
    for (const op of project.operations) {
      const isolated = { ...op, target: { source: 'features' as const, featureIds: ['tiny'] } }
      equal(computeOperationToolpath(project, isolated)?.result.moves.length, 0, 'cutter cannot fit tiny hole')
      assert(minimumSegmentDistance(paths.get(op.id)!.moves, 20, 20) > 3, 'every combined cutting segment misses hole plus cutter radius')
      equal(operationCutRange(project, op, paths.get(op.id)!, 'tiny'), null, 'neighbor must not credit reach to untouched tiny hole')
    }
    const tiny = throughFeatureCoverage(project, 'tiny', paths)
    equal([tiny?.status, tiny?.gap, tiny?.overlap, tiny?.top.range, tiny?.bottom.range], ['gap', 20, null, null, null], 'untouched target leaves full stock thickness')
    const large = throughFeatureCoverage(project, 'large', paths)
    equal([large?.status, large?.overlap, large?.top.range, large?.bottom.range], ['meets', 2, { min: 9, max: 20 }, { min: 0, max: 11 }], 'actual large-hole cuts still meet')
    const individual = { ...project, operations: project.operations.map((op) => ({ ...op, target: { source: 'features' as const, featureIds: ['large'] } })) }
    equal(throughFeatureCoverage(individual, 'large', generated(individual)), large, 'individual and multi-target legitimate reach agree')
  }
}

function movesAt(x: number, y: number, z: number, kind: ToolpathMove['kind'] = 'cut'): ToolpathResult {
  return { operationId: 'top', moves: [{ kind, from: { x, y, z }, to: { x, y, z } }], warnings: [], bounds: null }
}
function testGeometryAndUnits(): void {
  const project = fixture(), op = project.operations[0]
  equal(operationCutRange(project, op, movesAt(24, 20, 9), 'tiny'), null, 'one diameter beyond the outline is not cutter contact')
  equal(operationCutRange(project, op, movesAt(22.8, 22.8, 9), 'tiny'), null, 'inside expanded bounding box but outside circular footprint')
  equal(operationCutRange(project, op, movesAt(22.5, 20, 9), 'tiny'), { min: 9, max: 20 }, 'actual radius overlap counts')
  equal(operationCutRange(project, op, movesAt(23, 20, 9), 'tiny'), null, 'ambiguous exact tangency is conservatively excluded')
  equal(operationCutRange(project, op, movesAt(20, 20, 9, 'rapid'), 'tiny'), null, 'rapids do not prove cutting')
  for (const type of ['ball_endmill', 'v_bit', 'drill'] as const) {
    const pointed = { ...project, tools: project.tools.map((tool) => ({ ...tool, type })) }
    equal(operationCutRange(pointed, op, movesAt(22.5, 20, 9), 'tiny'), null, `${type}: full shank radius is not tip reach`)
    equal(operationCutRange(pointed, op, movesAt(20, 20, 9), 'tiny'), { min: 9, max: 20 }, `${type}: actual tip inside target counts`)
  }
  const inchTool = { ...project, tools: project.tools.map((tool) => ({ ...tool, units: 'inch' as const, diameter: 4 / 25.4 })) }
  equal(operationCutRange(inchTool, op, movesAt(22.5, 20, 9), 'tiny'), { min: 9, max: 20 }, 'tool radius normalized from inch to mm')
  equal(operationCutRange(inchTool, op, movesAt(24, 20, 9), 'tiny'), null, 'normalized tool does not grow to full diameter')
  const inches = convertProjectUnits(project, 'inch')
  const paths = generated(inches)
  equal(throughFeatureCoverage(inches, 'tiny', paths)?.status, 'gap', 'same false-positive fixture in inch projects')
  const coverage = throughFeatureCoverage(inches, 'large', paths)
  assert(coverage?.status === 'meets' && Math.abs(coverage.overlap! - 2 / 25.4) < 1e-8, 'inch legitimate overlap retains physical depth')

  const polygon = { ...feature('shape', 0, 0, 1), kind: 'polygon' as const,
    sketch: { ...feature('shape', 0, 0, 1).sketch, profile: polygonProfile([{ x: 20, y: 20 }, { x: 22, y: 20 }, { x: 22, y: 22 }, { x: 20, y: 22 }]) } }
  const square = projectWithFeatures({ ...project, features: [], featureDefinitions: {} }, [polygon])
  equal(operationCutRange(square, op, movesAt(23.5, 23.5, 9), 'shape'), null, 'round cutter expansion does not fill miter corner')
  equal(operationCutRange(square, op, movesAt(23.3, 23.3, 9), 'shape'), { min: 9, max: 20 }, 'actual corner intersection counts')
  const concave = { ...polygon, sketch: { ...polygon.sketch, profile: polygonProfile([
    { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 14 }, { x: 14, y: 14 }, { x: 14, y: 30 }, { x: 10, y: 30 },
  ]) } }
  const elbow = projectWithFeatures({ ...project, features: [], featureDefinitions: {} }, [concave])
  equal(operationCutRange(elbow, op, movesAt(25, 25, 9), 'shape'), null, 'concave empty area inside bounds is not credited')
  equal(operationCutRange(elbow, op, movesAt(12, 25, 9), 'shape'), { min: 9, max: 20 }, 'concave arm is credited')

  const open = { ...polygon, kind: 'composite' as const, operation: 'line' as const, sketch: { ...polygon.sketch, profile: {
    start: { x: 10, y: 10 }, segments: [{ type: 'line' as const, to: { x: 30, y: 30 } }], closed: false,
  } } }
  const line = projectWithFeatures({ ...project, features: [], featureDefinitions: {} }, [open])
  equal(operationCutRange(line, op, movesAt(20, 20, 9), 'shape'), { min: 9, max: 20 }, 'open target stroke still records actual cutting')
  equal(operationCutRange(line, op, movesAt(10, 30, 9), 'shape'), null, 'empty space in open target bounding box is not cutting')

  const model: SketchFeature = { ...polygon, kind: 'stl', operation: 'model', stl: {
    format: 'stl', meshAssetId: 'fixture', scale: 1, axisSwap: 'none', silhouettePaths: [
      [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }],
      [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }, { x: 20, y: 30 }],
    ],
  } }
  const footprint = featureReachFootprint(model, 2)
  equal(cutMoveZAtFeature(footprint, movesAt(25, 25, 9).moves[0]), [], 'model silhouette hole remains empty')
  equal(cutMoveZAtFeature(footprint, movesAt(15, 25, 9).moves[0]), [9, 9], 'model silhouette material is credited')
}
function testSegmentDepthAndTransforms(): void {
  const project = fixture(), op = project.operations[0]
  // The endpoints miss the target. Only the middle cuts there, and the deep
  // endpoint belongs elsewhere. Using that endpoint would overstate reach.
  const ramp: ToolpathResult = { operationId: op.id, bounds: null, warnings: [], moves: [
    { kind: 'cut', from: { x: 10, y: 20, z: 18 }, to: { x: 30, y: 20, z: 2 } },
  ] }
  const top = operationCutRange(project, op, ramp, 'tiny')
  assert(top && top.min > 7.59 && top.min < 7.61 && top.max === 20, 'clip sloped cut to actual target: deepest contact is near Z 7.6, not Z 2')
  const bottom = operationCutRange(project, project.operations[1], ramp, 'tiny')
  assert(bottom && bottom.max > 12.39 && bottom.max < 12.41 && bottom.min === 0, 'Bottom credits only highest intersecting part near Z 12.4')
  const crossing = { ...ramp, moves: ramp.moves.map((move) => ({ ...move, from: { ...move.from, z: 9 }, to: { ...move.to, z: 9 } })) }
  equal(operationCutRange(project, op, crossing, 'tiny'), { min: 9, max: 20 }, 'constant-depth segment through target counts even when both endpoints miss')
  const retreat = { ...ramp, moves: [{ kind: 'plunge' as const, from: { x: 20, y: 20, z: 9 }, to: { x: 20, y: 20, z: 22 } }] }
  equal(operationCutRange(project, op, retreat, 'tiny'), { min: 9, max: 20 }, 'feed retreat does not discard the actual cut at its start')

  for (const axis of ['x', 'y'] as const) {
    const base = fixture(axis)
    const transformed: Project = { ...base, stock: { ...base.stock, profile: rectProfile(10, 5, 100, 80) },
      features: base.features.map((f) => ({ ...f, transform: { a: 0, b: 1, c: -1, d: 0, e: 70, f: 10 } })),
    }
    const paths = generated(transformed)
    equal(throughFeatureCoverage(transformed, 'tiny', paths)?.status, 'gap', `${axis}: rotated and translated target is not credited at its original bounds`)
    equal(throughFeatureCoverage(transformed, 'large', paths)?.status, 'meets', `${axis}: generated stock-space reach agrees with resolved instance transform`)
    equal(operationCutRange(transformed, transformed.operations[0], movesAt(20, 20, 9), 'tiny'), null, 'definition-local points do not count for relocated instance')
    equal(operationCutRange(transformed, transformed.operations[0], movesAt(50, 30, 9), 'tiny'), { min: 9, max: 20 }, 'resolved instance centre counts')
  }
}

testNeighborDoesNotReachTinyHole()
testGeometryAndUnits()
testSegmentDepthAndTransforms()
console.log('Setup reach attribution tests passed')
