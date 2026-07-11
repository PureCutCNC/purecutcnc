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

import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { getFeatureGeometryProfiles } from '../text'
import { newProject, rectProfile } from '../types/project'
import type { Project, SketchFeature } from '../types/project'
import {
  buildBatchedLines,
  computeLineBatch,
  computeLineProfileBatch,
  disposeBatchedLines,
  LINE_DEFAULT_COLOR,
  LINE_SUBTRACT_COLOR,
} from './lineBatcher'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeProject(): Project {
  return newProject('line-batch-test', 'mm')
}

function makeLineFeature(
  id: string,
  points: { x: number; y: number }[],
  closed = false,
  operation: SketchFeature['operation'] = 'line',
  zTop = 5,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'composite',
    folderId: null,
    sketch: {
      profile: {
        start: points[0],
        segments: points.slice(1).map((to) => ({ type: 'line' as const, to })),
        closed,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function testOpenAndClosedCounts(): void {
  const project = makeProject()
  const open = makeLineFeature('open', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ])
  const closed = makeLineFeature('closed', [
    { x: 20, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 10 },
    { x: 20, y: 10 },
  ], true)

  const result = computeLineBatch(project, [open, closed])
  assert(result.meta.objectCount === 1, 'non-empty pure batch represents one object')
  assert(result.meta.segmentCount === 6, `expected 6 segments, got ${result.meta.segmentCount}`)
  assert(result.meta.vertexCount === 12, `expected 12 endpoints, got ${result.meta.vertexCount}`)
  assert(result.positions.length === 36, `expected 36 floats, got ${result.positions.length}`)
}

function testActualGeometryHasNoConnector(): void {
  const project = makeProject()
  const first = makeLineFeature('first', [{ x: 0, y: 0 }, { x: 5, y: 0 }])
  const second = makeLineFeature('second', [{ x: 100, y: 100 }, { x: 105, y: 100 }])
  const result = buildBatchedLines(project, [first, second])

  assert(result.lines.length === 1, 'same-colour features share one draw object')
  assert(result.lines[0] instanceof LineSegments2, 'batch uses LineSegments2')
  const geometry = result.lines[0].geometry
  const starts = geometry.getAttribute('instanceStart')
  const ends = geometry.getAttribute('instanceEnd')
  assert(starts.count === 2 && ends.count === 2, 'geometry contains exactly two independent segments')
  assert(starts.getX(0) === 0 && ends.getX(0) === 5, 'first segment endpoints preserved')
  assert(starts.getX(1) === 100 && ends.getX(1) === 105, 'second segment endpoints preserved')
  assert(result.meta.segmentCount === 2, 'no cross-feature connector is counted or rendered')
  disposeBatchedLines(result.lines)
}

function testBaseColourBatches(): void {
  const project = makeProject()
  const green = makeLineFeature('green', [{ x: 0, y: 0 }, { x: 1, y: 0 }])
  const blue = makeLineFeature(
    'blue',
    [{ x: 2, y: 0 }, { x: 3, y: 0 }],
    false,
    'subtract',
  )
  const result = buildBatchedLines(project, [green, blue])
  assert(result.lines.length === 2, 'green and subtract-blue geometry use two bounded batches')
  assert(result.lines[0].material.color.getHex() === LINE_DEFAULT_COLOR, 'default batch remains green')
  assert(result.lines[1].material.color.getHex() === LINE_SUBTRACT_COLOR, 'subtract batch remains blue')
  disposeBatchedLines(result.lines)
}

function testClosedSolidExcluded(): void {
  const project = makeProject()
  const solid = makeLineFeature(
    'solid',
    [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
    true,
    'add',
  )
  const result = computeLineBatch(project, [solid])
  assert(result.meta.segmentCount === 0, 'closed Add solid is not a line overlay')
}

function testMultiProfileTextUsesGlyphs(): void {
  const project = makeProject()
  const textFeature: SketchFeature = {
    ...makeLineFeature(
      'text',
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      true,
    ),
    kind: 'text',
    text: { text: 'AB', style: 'skeleton', fontId: 'simple_stroke', size: 10 },
    sketch: {
      ...makeLineFeature('frame', [{ x: 0, y: 0 }, { x: 100, y: 0 }]).sketch,
      profile: rectProfile(0, 0, 100, 100),
    },
  }
  const glyphProfiles = getFeatureGeometryProfiles(textFeature)
  assert(glyphProfiles.length > 1, 'fixture resolves to multiple glyph profiles')
  const expected = computeLineProfileBatch(
    glyphProfiles.map((profile) => ({ profile, zTop: 5 })),
  )
  const actual = computeLineBatch(project, [textFeature])
  assert(actual.meta.segmentCount === expected.segmentCount, 'every glyph profile is emitted')
  assert(actual.meta.segmentCount > 4, 'text frame is not substituted for glyph strokes')
}

function test2980ContoursStayOneBatch(): void {
  const project = makeProject()
  const features = Array.from({ length: 2980 }, (_, index) => makeLineFeature(
    `f${index}`,
    [{ x: index * 2, y: 0 }, { x: index * 2 + 1, y: 0 }],
  ))
  const result = computeLineBatch(project, features)
  assert(result.meta.objectCount === 1, '2,980 same-colour contours remain one batch')
  assert(result.meta.segmentCount === 2980, 'one segment per contour')
  assert(result.meta.vertexCount === 5960, 'two endpoints per contour')
}

function testDisposalOwnsGeometryAndMaterial(): void {
  const result = buildBatchedLines(makeProject(), [
    makeLineFeature('dispose', [{ x: 0, y: 0 }, { x: 1, y: 0 }]),
  ])
  let geometryDisposed = false
  let materialDisposed = false
  result.lines[0].geometry.dispose = () => { geometryDisposed = true }
  result.lines[0].material.dispose = () => { materialDisposed = true }
  disposeBatchedLines(result.lines)
  assert(geometryDisposed && materialDisposed, 'batch disposal releases geometry and material')
}

const tests = [
  ['open and closed counts', testOpenAndClosedCounts],
  ['actual geometry has no connector', testActualGeometryHasNoConnector],
  ['base colour batches', testBaseColourBatches],
  ['closed solid excluded', testClosedSolidExcluded],
  ['multi-profile text uses glyphs', testMultiProfileTextUsesGlyphs],
  ['2,980 contours stay one batch', test2980ContoursStayOneBatch],
  ['disposal owns geometry and material', testDisposalOwnsGeometryAndMaterial],
] as const

let passed = 0
for (const [name, test] of tests) {
  test()
  passed += 1
  console.log(`${name}: PASSED`)
}
console.log(`\nlineBatcher.test.ts: ${passed} passed, 0 failed`)
