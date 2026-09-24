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
 * A text feature reaches an operation through its shapes, not its own
 * operation (#861).
 *
 * An outline text resolves into glyph outlines carrying its operation and
 * counters carrying the inverse. So an add "O" has a subtract counter an inside
 * route or pocket can cut, and a subtract "O" has an add island an outside
 * route can walk around. Both resolvers used to filter the selected features by
 * their own operation before expanding them, which threw an add text out whole
 * and left the counter uncut unless the text was exploded.
 *
 * Run with: npx tsx src/engine/toolpaths/textCounterTargets.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures, resolvedFeature } from '../../test/projectFixtures'
import { getTextFontOptions, resolveTextFeatureShapes } from '../../text'
import { isOperationTargetValid } from '../../store/helpers/operationDefaults'
import { flattenProfile } from './geometry'
import { resolveInsideEdgeRegions, resolvePocketRegions } from './resolver'
import { generateEdgeRouteToolpath } from './edge'
import type { ResolvedPocketResult, ToolpathResult } from './types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

function tool(): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: '2mm endmill', diameter: 2, defaultStepdown: 2, defaultStepover: 0.4 }
}

/** An outline text in the default mm stock (100 x 80, top at z 20). */
function textFeature(id: string, text: string, operation: 'add' | 'subtract'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'text',
    text: { text, style: 'outline', fontId: getTextFontOptions('outline')[0].id, size: 30 },
    folderId: null,
    sketch: {
      profile: rectProfile(20, 20, 30, 40),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 20,
    z_bottom: 14,
    visible: true,
    locked: false,
  }
}

function makeOperation(kind: Operation['kind'], featureId: string): Operation {
  return {
    id: 'op1', name: 'op', kind, pass: 'rough', enabled: true, showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [featureId] },
    toolRef: 't1',
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, roundOutsideCorners: false,
    stockToLeaveRadial: 0, stockToLeaveAxial: 0, finishWalls: false, finishFloor: false,
    carveDepth: 0, maxCarveDepth: 0, cutDirection: 'conventional', machiningOrder: 'level_first',
  } as Operation
}

function projectWith(feature: SketchFeature, operation: Operation): Project {
  const project = projectWithFeatures({ ...newProject('text-counters', 'mm'), tools: [tool()] }, [feature])
  return { ...project, operations: [operation] }
}

function ring(points: { x: number, y: number }[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

function regionArea(result: ResolvedPocketResult): number {
  return result.bands.reduce(
    (total, band) => total + band.regions.reduce(
      (sum, region) => sum + ring(region.outer) - region.islands.reduce((holes, island) => holes + ring(island), 0),
      0,
    ),
    0,
  )
}

/** The resolved text's shapes with `operation`, as flattened rings. */
function shapeRings(project: Project, featureId: string, operation: 'add' | 'subtract') {
  return resolveTextFeatureShapes(resolvedFeature(project, featureId))
    .filter((shape) => shape.operation === operation)
    .map((shape) => flattenProfile(shape.profile).points)
}

function bounds(points: { x: number, y: number }[]) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

function cutPoints(result: ToolpathResult) {
  return result.moves
    .filter((move) => move.kind === 'cut')
    .flatMap((move) => [move.from, move.to])
}

const hasWrongRole = (warnings: { code: string }[] | undefined) =>
  (warnings ?? []).some((warning) => warning.code === 'targetsMissingOrWrongRole')

console.log('\nText features target operations through their shapes (#861)')

// ── 1. Inside edge route resolves an add text to its counter ──────────
{
  const operation = makeOperation('edge_route_inside', 'text')
  const project = projectWith(textFeature('text', 'O', 'add'), operation)
  const counters = shapeRings(project, 'text', 'subtract')
  const counterArea = counters.reduce((sum, points) => sum + ring(points), 0)
  const result = resolveInsideEdgeRegions(project, operation)
  const area = regionArea(result)

  check('an add "O" has exactly one counter', counters.length === 1, `got ${counters.length}`)
  check(
    'inside route region is the counter',
    counterArea > 0 && Math.abs(area - counterArea) / counterArea < 0.01,
    `region area ${area.toFixed(2)}, counter area ${counterArea.toFixed(2)} (bands: ${result.bands.length})`,
  )
  check('no wrong-role warning', !hasWrongRole(result.warnings), JSON.stringify(result.warnings))
  check(
    'the target stays valid when the operation kind changes',
    isOperationTargetValid(project, 'edge_route_inside', operation.target),
    'isOperationTargetValid refused an add text with a counter',
  )
}

// ── 2. Pocket resolves an add text to its counter ─────────────────────
{
  const operation = makeOperation('pocket', 'text')
  const project = projectWith(textFeature('text', 'O', 'add'), operation)
  const counterArea = shapeRings(project, 'text', 'subtract').reduce((sum, points) => sum + ring(points), 0)
  const result = resolvePocketRegions(project, operation)
  const area = regionArea(result)

  check(
    'pocket region is the counter',
    counterArea > 0 && Math.abs(area - counterArea) / counterArea < 0.01,
    `region area ${area.toFixed(2)}, counter area ${counterArea.toFixed(2)} (bands: ${result.bands.length})`,
  )
  check('no wrong-role warning', !hasWrongRole(result.warnings), JSON.stringify(result.warnings))
}

// ── 3. The inside route toolpath stays inside the counter ────────────
{
  const operation = makeOperation('edge_route_inside', 'text')
  const project = projectWith(textFeature('text', 'O', 'add'), operation)
  const counter = bounds(shapeRings(project, 'text', 'subtract')[0])
  const result = generateEdgeRouteToolpath(project, operation)
  const points = cutPoints(result)
  const inside = points.every((point) => (
    point.x > counter.minX && point.x < counter.maxX && point.y > counter.minY && point.y < counter.maxY
  ))

  check('inside route cuts', points.length > 0, `no cut moves (warnings: ${JSON.stringify(result.warnings)})`)
  check('every cut sits inside the counter', inside, 'a cut left the counter — the outline was routed')
  check('no wrong-role warning', !hasWrongRole(result.warnings), JSON.stringify(result.warnings))
}

// ── 4. An add text without a counter is still refused ────────────────
{
  const operation = makeOperation('edge_route_inside', 'text')
  const project = projectWith(textFeature('text', 'L', 'add'), operation)
  const result = resolveInsideEdgeRegions(project, operation)

  check('an add "L" resolves to nothing', result.bands.length === 0, `got ${result.bands.length} bands`)
  check('and says the target has the wrong role', hasWrongRole(result.warnings), JSON.stringify(result.warnings))
  check(
    'and is not a valid inside route target',
    !isOperationTargetValid(project, 'edge_route_inside', operation.target),
    'isOperationTargetValid accepted an add text with no counter',
  )
}

// ── 5. Outside route walks around a subtract text's island ───────────
{
  const operation = makeOperation('edge_route_outside', 'text')
  const project = projectWith(textFeature('text', 'O', 'subtract'), operation)
  const outline = bounds(shapeRings(project, 'text', 'subtract')[0])
  const island = bounds(shapeRings(project, 'text', 'add')[0])
  const result = generateEdgeRouteToolpath(project, operation)
  const points = cutPoints(result)
  const cut = points.length > 0 ? bounds(points) : null

  check('outside route cuts', points.length > 0, `no cut moves (warnings: ${JSON.stringify(result.warnings)})`)
  check(
    'it routes the island, inside the glyph outline',
    cut !== null
      && cut.minX > outline.minX && cut.maxX < outline.maxX
      && cut.minY > outline.minY && cut.maxY < outline.maxY
      && cut.minX < island.minX && cut.maxX > island.maxX,
    `cut ${JSON.stringify(cut)}, outline ${JSON.stringify(outline)}, island ${JSON.stringify(island)}`,
  )
  check('no wrong-role warning', !hasWrongRole(result.warnings), JSON.stringify(result.warnings))
  check(
    'the target stays valid when the operation kind changes',
    isOperationTargetValid(project, 'edge_route_outside', operation.target),
    'isOperationTargetValid refused a subtract text with an island',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
