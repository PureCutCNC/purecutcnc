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
 *
 * Run with: npx tsx src/sketch/dimensions.test.ts
 */

import {
  circleProfile,
  newProject,
  rectProfile,
} from '../types/project'
import type {
  DimensionAnnotation,
  Project,
  SketchFeature,
  SketchProfile,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import {
  angleBetween,
  dimensionLayout,
  isDimensionDangling,
  measureValue,
  resolveAnchor,
} from './dimensions'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
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
    z_top: 10,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function projectWith(features: SketchFeature[]): Project {
  const base = newProject('dim-test', 'mm')
  return projectWithFeatures(base, features)
}

// A 10×6 rectangle whose corners are well-known.
const rect = rectProfile(0, 0, 10, 6)
const rectFeature = makeFeature('f0001', rect)

function makeDim(partial: Partial<DimensionAnnotation> & Pick<DimensionAnnotation, 'type' | 'a'>): DimensionAnnotation {
  return {
    id: 'dim0001',
    offset: 2,
    visible: true,
    locked: false,
    textOverride: null,
    precisionOverride: null,
    ...partial,
  }
}

// ── resolveAnchor ───────────────────────────────────────────
{
  const project = projectWith([rectFeature])
  const target = { source: 'feature' as const, featureId: 'f0001' }

  // rectProfile vertices: (0,0) (10,0) (10,6) (0,6)
  const v0 = resolveAnchor({ kind: 'vertex', target, vertexIndex: 0 }, project)
  assert(!!v0 && approx(v0.x, 0) && approx(v0.y, 0), 'vertex 0 = (0,0)')
  const v2 = resolveAnchor({ kind: 'vertex', target, vertexIndex: 2 }, project)
  assert(!!v2 && approx(v2.x, 10) && approx(v2.y, 6), 'vertex 2 = (10,6)')

  // segment 0 is the bottom edge (0,0)->(10,0); midpoint (5,0)
  const mid = resolveAnchor({ kind: 'midpoint', target, segmentIndex: 0 }, project)
  assert(!!mid && approx(mid.x, 5) && approx(mid.y, 0), 'midpoint of bottom edge = (5,0)')

  // origin + free
  const origin = resolveAnchor({ kind: 'origin' }, project)
  assert(!!origin && approx(origin.x, project.origin.x) && approx(origin.y, project.origin.y), 'origin anchor resolves')
  const free = resolveAnchor({ kind: 'free', point: { x: 3, y: 7 } }, project)
  assert(!!free && approx(free.x, 3) && approx(free.y, 7), 'free anchor resolves to its point')

  console.log('resolveAnchor PASS')
}

// ── center anchor on a circle ───────────────────────────────
{
  const circleFeature = makeFeature('f0002', circleProfile(4, 5, 3))
  const project = projectWith([circleFeature])
  const target = { source: 'feature' as const, featureId: 'f0002' }
  const center = resolveAnchor({ kind: 'center', target, segmentIndex: 0 }, project)
  assert(!!center && approx(center.x, 4) && approx(center.y, 5), 'circle center = (4,5)')
  // a center anchor on a line segment is invalid
  const badCenter = resolveAnchor({ kind: 'center', target: { source: 'feature', featureId: 'f0001' }, segmentIndex: 0 }, projectWith([rectFeature]))
  assert(badCenter === null, 'center on a non-arc segment is null')
  console.log('center anchor PASS')
}

// ── dangling references ─────────────────────────────────────
{
  const project = projectWith([rectFeature])
  const missing = resolveAnchor({ kind: 'vertex', target: { source: 'feature', featureId: 'nope' }, vertexIndex: 0 }, project)
  assert(missing === null, 'missing feature → null')
  const outOfRange = resolveAnchor({ kind: 'vertex', target: { source: 'feature', featureId: 'f0001' }, vertexIndex: 99 }, project)
  assert(outOfRange === null, 'out-of-range vertex → null')
  console.log('dangling references PASS')
}

// ── auto-update when geometry moves ─────────────────────────
{
  const target = { source: 'feature' as const, featureId: 'f0001' }
  const before = projectWith([rectFeature])
  const movedFeature = makeFeature('f0001', rectProfile(100, 100, 10, 6)) // translated +100,+100
  const after = projectWith([movedFeature])
  const anchor = { kind: 'vertex' as const, target, vertexIndex: 0 }

  const p0Before = resolveAnchor(anchor, before)!
  const p0After = resolveAnchor(anchor, after)!
  assert(approx(p0Before.x, 0) && approx(p0After.x, 100) && approx(p0After.y, 100),
    'vertex anchor follows the feature when its profile moves')
  console.log('auto-update PASS')
}

// ── measureValue for each type ──────────────────────────────
{
  const project = projectWith([rectFeature])
  const target = { source: 'feature' as const, featureId: 'f0001' }
  const v0 = { kind: 'vertex' as const, target, vertexIndex: 0 } // (0,0)
  const v2 = { kind: 'vertex' as const, target, vertexIndex: 2 } // (10,6)

  const aligned = makeDim({ type: 'aligned', a: v0, b: v2 })
  assert(approx(measureValue(aligned, project)!, Math.hypot(10, 6)), 'aligned = hypot(10,6)')

  const horizontal = makeDim({ type: 'horizontal', a: v0, b: v2 })
  assert(approx(measureValue(horizontal, project)!, 10), 'horizontal = 10')

  const vertical = makeDim({ type: 'vertical', a: v0, b: v2 })
  assert(approx(measureValue(vertical, project)!, 6), 'vertical = 6')

  // radius/diameter on a circle: center (4,5), edge at start (4+3,5)=(7,5)
  const circleFeature = makeFeature('f0003', circleProfile(4, 5, 3))
  const cproject = projectWith([circleFeature])
  const ctarget = { source: 'feature' as const, featureId: 'f0003' }
  const center = { kind: 'center' as const, target: ctarget, segmentIndex: 0 }
  const edge = { kind: 'vertex' as const, target: ctarget, vertexIndex: 0 }
  const radius = makeDim({ type: 'radius', a: center, b: edge })
  assert(approx(measureValue(radius, cproject)!, 3), 'radius = 3')
  const diameter = makeDim({ type: 'diameter', a: center, b: edge })
  assert(approx(measureValue(diameter, cproject)!, 6), 'diameter = 6')

  // angle: vertex (0,0), rays to (1,0) and (0,1) → 90°
  const angle = makeDim({
    type: 'angle',
    a: { kind: 'free', point: { x: 0, y: 0 } },
    b: { kind: 'free', point: { x: 1, y: 0 } },
    c: { kind: 'free', point: { x: 0, y: 1 } },
  })
  assert(approx(measureValue(angle, project)!, 90), 'angle = 90°')
  assert(approx(angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }), 180), 'opposite rays = 180°')

  // dangling dimension → null value
  const dangling = makeDim({ type: 'horizontal', a: v0, b: { kind: 'vertex', target: { source: 'feature', featureId: 'gone' }, vertexIndex: 0 } })
  assert(measureValue(dangling, project) === null, 'dangling measure = null')
  assert(isDimensionDangling(dangling, project), 'isDimensionDangling true')

  console.log('measureValue PASS')
}

// ── dimensionLayout: offset side + extensions ───────────────
{
  const project = projectWith([rectFeature])
  const target = { source: 'feature' as const, featureId: 'f0001' }
  const v0 = { kind: 'vertex' as const, target, vertexIndex: 0 } // (0,0)
  const v1 = { kind: 'vertex' as const, target, vertexIndex: 1 } // (10,0)

  // horizontal with +offset → line sits below (Y-down) at y = max(0,0)+2 = 2
  const hPos = makeDim({ type: 'horizontal', a: v0, b: v1, offset: 2 })
  const layoutPos = dimensionLayout(hPos, project)!
  assert(approx(layoutPos.lineStart.y, 2) && approx(layoutPos.lineEnd.y, 2), 'h+offset line at y=2')
  assert(layoutPos.extensions.length === 2, 'horizontal has 2 extension lines')
  assert(approx(layoutPos.extensions[0][0].y, 0) && approx(layoutPos.extensions[0][1].y, 2),
    'extension runs from measured point (y=0) to dim line (y=2)')

  // negative offset flips to the other side: y = min(0,0) - 2 = -2
  const hNeg = makeDim({ type: 'horizontal', a: v0, b: v1, offset: -2 })
  const layoutNeg = dimensionLayout(hNeg, project)!
  assert(approx(layoutNeg.lineStart.y, -2), 'h-offset line at y=-2')

  // aligned: dimension line parallel, shifted by perpendicular normal
  const aligned = makeDim({ type: 'aligned', a: v0, b: v1, offset: 3 })
  const la = dimensionLayout(aligned, project)!
  // dir = (1,0), normal = (0,1); both endpoints shift +3 in y
  assert(approx(la.lineStart.y, 3) && approx(la.lineEnd.y, 3), 'aligned shifted by normal*offset')
  assert(approx(la.value, 10), 'aligned value = 10')

  // dangling layout → null
  const dangling = makeDim({ type: 'horizontal', a: v0, b: { kind: 'vertex', target: { source: 'feature', featureId: 'gone' }, vertexIndex: 0 } })
  assert(dimensionLayout(dangling, project) === null, 'dangling layout = null')

  console.log('dimensionLayout PASS')
}

console.log('\nall dimensions.test.ts assertions passed')
