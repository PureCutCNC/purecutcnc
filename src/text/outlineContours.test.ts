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

import ClipperLib from 'clipper-lib'
import { DEFAULT_CLIPPER_SCALE } from '../engine/toolpaths/geometry'
import { profileVertices, type FeatureOperation, type Point, type TextFontId } from '../types/project'
import { generateTextShapes } from './index'
import { cleanOutlineContour } from './outlineContours'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function signedArea(points: Point[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area * 0.5
}

function simplifiedComponentAreas(points: Point[]): number[] {
  const path = points.map((point) => ({
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }))
  return ClipperLib.Clipper.SimplifyPolygon(path, ClipperLib.PolyFillType.pftNonZero)
    .map((component) => Math.abs(ClipperLib.Clipper.Area(component)) / (DEFAULT_CLIPPER_SCALE ** 2))
}

function outlineOperations(text: string, fontId: TextFontId): FeatureOperation[] {
  return generateTextShapes(
    { text, style: 'outline', fontId, size: 100, operation: 'subtract' },
    { x: 0, y: 0 },
  ).map((shape) => shape.operation)
}

function assertOperations(actual: FeatureOperation[], expected: FeatureOperation[], label: string): void {
  assert(actual.length === expected.length, `${label} should emit ${expected.length} contours`)
  assert(actual.every((operation, index) => operation === expected[index]), `${label} should preserve contour operations`)
}

function testSyntheticSliverIsRemoved(): void {
  const contour = [
    { x: 0, y: 0 },
    { x: -0.1, y: 0 },
    { x: 0, y: -0.1 },
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]
  const cleaned = cleanOutlineContour(contour, 10)

  assert(cleaned.length === 1, 'an insignificant attached sliver should be removed after simplification')
  assert(Math.abs(Math.abs(signedArea(cleaned[0])) - 100) < 1e-6, 'the significant contour should be preserved')
}

function testSignificantComponentsAreRetained(): void {
  const contour = [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]
  const cleaned = cleanOutlineContour(contour, 10)

  assert(cleaned.length === 2, 'all significant simplified components should be retained')
  const totalArea = cleaned.reduce((sum, component) => sum + Math.abs(signedArea(component)), 0)
  assert(Math.abs(totalArea - 100.5) < 1e-6, 'retained components should preserve their combined area')
}

function testOptimerBoldFIsSimpleAtMultipleSizes(): void {
  for (const fontId of ['optimer_bold', 'optimer_bold_italic'] as const) {
    for (const size of [100, 0.4]) {
      const shapes = generateTextShapes(
        { text: 'f', style: 'outline', fontId, size, operation: 'subtract' },
        { x: 0, y: 0 },
      )
      assert(shapes.length === 1, `${fontId} f at size ${size} should emit one significant contour`)
      const components = simplifiedComponentAreas(profileVertices(shapes[0].profile))
      assert(components.length === 1, `${fontId} f at size ${size} should be a simple contour without a sliver`)
      assert(components[0] > size * size * 0.001, `${fontId} f should retain its significant main contour`)
    }
  }
}

function testHoleAndDisconnectedGlyphContoursArePreserved(): void {
  assertOperations(outlineOperations('A', 'optimer_bold'), ['subtract', 'add'], 'A')
  assertOperations(outlineOperations('B', 'optimer_bold'), ['subtract', 'add', 'add'], 'B')
  assertOperations(outlineOperations('O', 'optimer_bold'), ['subtract', 'add'], 'O')
  assertOperations(outlineOperations('i', 'optimer_bold'), ['subtract', 'subtract'], 'i')
  assertOperations(
    outlineOperations('%', 'optimer_bold'),
    ['subtract', 'add', 'subtract', 'subtract', 'add'],
    '%',
  )
  assertOperations(outlineOperations('.', 'optimer_bold'), ['subtract'], '.')

  const oShapes = generateTextShapes(
    { text: 'O', style: 'outline', fontId: 'optimer_bold', size: 100, operation: 'subtract' },
    { x: 0, y: 0 },
  )
  const outerArea = signedArea(profileVertices(oShapes[0].profile))
  const holeArea = signedArea(profileVertices(oShapes[1].profile))
  assert(Math.sign(outerArea) === -Math.sign(holeArea), 'outer and hole winding should remain opposite')
}

function testSkeletonTextIsUnchanged(): void {
  const shapes = generateTextShapes(
    { text: 'A', style: 'skeleton', fontId: 'simple_stroke', size: 10, operation: 'subtract' },
    { x: 0, y: 0 },
  )
  assert(shapes.length === 2, 'skeleton A should retain its two strokes')
  assert(shapes.every((shape) => !shape.profile.closed), 'skeleton strokes should remain open')
}

try {
  testSyntheticSliverIsRemoved()
  testSignificantComponentsAreRetained()
  testOptimerBoldFIsSimpleAtMultipleSizes()
  testHoleAndDisconnectedGlyphContoursArePreserved()
  testSkeletonTextIsUnchanged()
  console.log('All outline contour cleanup tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
