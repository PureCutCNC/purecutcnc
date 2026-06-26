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
 * Focused tests for sketch snap resolution.
 * Run with: npx tsx src/components/canvas/snappingHelpers.test.ts
 */

import { DEFAULT_SNAP_SETTINGS, type SnapSettings } from '../../sketch/snapping'
import { newProject, type Point, type Project, type SketchFeature, type SketchProfile } from '../../types/project'
import { resolveSketchSnap } from './snappingHelpers'
import type { ViewTransform } from './viewTransform'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }

function lineProfile(from: Point, to: Point): SketchProfile {
  return {
    start: from,
    segments: [{ type: 'line', to }],
    closed: false,
  }
}

function makeFeature(id: string, profile: SketchProfile): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 0,
    z_bottom: -1,
    visible: true,
    locked: false,
  }
}

function makeProject(features: SketchFeature[]): Project {
  return { ...newProject('snap-intersection-test', 'mm'), features }
}

function snapSettings(modes: SnapSettings['modes'], pixelRadius = 6): SnapSettings {
  return {
    enabled: true,
    modes,
    pixelRadius,
  }
}

function assertPointClose(actual: Point, expected: Point, message: string): void {
  const distance = Math.hypot(actual.x - expected.x, actual.y - expected.y)
  assert(distance <= 1e-6, `${message}: got (${actual.x}, ${actual.y})`)
}

function testLineLineIntersectionSnap(): void {
  console.log('Testing line-line intersection snap...')

  const project = makeProject([
    makeFeature('horizontal', lineProfile({ x: 0, y: 10 }, { x: 20, y: 10 })),
    makeFeature('vertical', lineProfile({ x: 10, y: 0 }, { x: 10, y: 20 })),
  ])

  const snap = resolveSketchSnap({
    rawPoint: { x: 10.8, y: 9.4 },
    vt,
    snapSettings: snapSettings(['intersection']),
    project,
    referencePoint: null,
  })

  assert(snap.mode === 'intersection', `expected intersection mode, got ${snap.mode}`)
  assertPointClose(snap.point, { x: 10, y: 10 }, 'expected snap point at crossing')
  assert(snap.intersection !== undefined, 'expected intersection source metadata')
  assert(snap.intersection.a.target.source === 'feature', 'expected first intersection target to be a feature')
  assert(snap.intersection.a.target.featureId === 'horizontal', `expected first target horizontal, got ${snap.intersection.a.target.featureId}`)
  assert(snap.intersection.a.segmentIndex === 0, `expected first segment index 0, got ${snap.intersection.a.segmentIndex}`)
  assert(snap.intersection.b.target.source === 'feature', 'expected second intersection target to be a feature')
  assert(snap.intersection.b.target.featureId === 'vertical', `expected second target vertical, got ${snap.intersection.b.target.featureId}`)
  assert(snap.intersection.b.segmentIndex === 0, `expected second segment index 0, got ${snap.intersection.b.segmentIndex}`)

  console.log('line-line intersection snap: PASSED')
}

function testIntersectionSnapRespectsPixelRadius(): void {
  console.log('Testing intersection snap pixel radius...')

  const project = makeProject([
    makeFeature('horizontal', lineProfile({ x: 0, y: 10 }, { x: 20, y: 10 })),
    makeFeature('vertical', lineProfile({ x: 10, y: 0 }, { x: 10, y: 20 })),
  ])

  const snap = resolveSketchSnap({
    rawPoint: { x: 14, y: 14 },
    vt,
    snapSettings: snapSettings(['intersection'], 3),
    project,
    referencePoint: null,
  })

  assert(snap.mode === null, `expected no snap outside radius, got ${snap.mode}`)
  assertPointClose(snap.point, { x: 14, y: 14 }, 'expected raw point when no snap wins')

  console.log('intersection snap pixel radius: PASSED')
}

function testPointSnapKeepsPriorityAtSharedEndpoint(): void {
  console.log('Testing point snap priority at shared endpoint...')

  const project = makeProject([
    makeFeature('horizontal', lineProfile({ x: 0, y: 0 }, { x: 20, y: 0 })),
    makeFeature('vertical', lineProfile({ x: 0, y: 0 }, { x: 0, y: 20 })),
  ])

  const snap = resolveSketchSnap({
    rawPoint: { x: 0.2, y: 0.2 },
    vt,
    snapSettings: snapSettings(['point', 'intersection']),
    project,
    referencePoint: null,
  })

  assert(snap.mode === 'point', `expected point snap to win at endpoint, got ${snap.mode}`)
  assertPointClose(snap.point, { x: 0, y: 0 }, 'expected shared endpoint')

  console.log('point snap priority at shared endpoint: PASSED')
}

function testStockIntersectionSnapHasNoLiveConstraintMetadata(): void {
  console.log('Testing stock intersection snap omits live constraint metadata...')

  const project = makeProject([
    makeFeature('vertical', lineProfile({ x: 10, y: -10 }, { x: 10, y: 20 })),
  ])

  const snap = resolveSketchSnap({
    rawPoint: { x: 10.2, y: 0.2 },
    vt,
    snapSettings: snapSettings(['intersection']),
    project,
    referencePoint: null,
  })

  assert(snap.mode === 'intersection', `expected intersection mode, got ${snap.mode}`)
  assertPointClose(snap.point, { x: 10, y: 0 }, 'expected snap point at stock-feature crossing')
  assert(snap.intersection === undefined, 'stock-involved intersections must not store live constraint metadata')

  console.log('stock intersection snap metadata: PASSED')
}

function testIntersectionSnapIsNotEnabledByDefault(): void {
  console.log('Testing intersection snap is not enabled by default...')

  assert(
    !DEFAULT_SNAP_SETTINGS.modes.includes('intersection'),
    'intersection should be opt-in because intersection resolution is pairwise over visible segments',
  )

  console.log('intersection default mode: PASSED')
}

try {
  testLineLineIntersectionSnap()
  testIntersectionSnapRespectsPixelRadius()
  testPointSnapKeepsPriorityAtSharedEndpoint()
  testStockIntersectionSnapHasNoLiveConstraintMetadata()
  testIntersectionSnapIsNotEnabledByDefault()
  console.log('\nAll snappingHelpers tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
