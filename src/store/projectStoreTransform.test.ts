/**
 * Tests for feature transform helpers.
 *
 * Run with: npx tsx src/store/projectStoreTransform.test.ts
 */

import { getProfileBounds, rectProfile, type SketchFeature } from '../types/project'
import { resizeFeatureFromReference } from './projectStore'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

function makeFeature(kind: 'rect' | 'stl'): SketchFeature {
  return {
    id: kind,
    name: kind,
    kind,
    folderId: null,
    stl: kind === 'stl'
      ? {
          format: 'stl',
          fileData: 'data:model/stl;base64,',
          scale: 1,
          axisSwap: 'none',
        }
      : null,
    sketch: {
      profile: rectProfile(0, 0, 10, 5),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: kind === 'stl' ? 'model' : 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function testRegularFeatureCanResizeOneAxis(): void {
  console.log('Testing regular feature resize keeps axis scaling...')
  const resized = resizeFeatureFromReference(
    makeFeature('rect'),
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  )

  if (!resized) throw new Error('Assertion failed: expected resized feature')
  const bounds = getProfileBounds(resized.sketch.profile)
  assert(approx(bounds.maxX - bounds.minX, 20), `expected width 20, got ${bounds.maxX - bounds.minX}`)
  assert(approx(bounds.maxY - bounds.minY, 5), `expected height 5, got ${bounds.maxY - bounds.minY}`)
}

function testStlFeatureResizeIsUniform(): void {
  console.log('Testing STL feature resize is uniform...')
  const resized = resizeFeatureFromReference(
    makeFeature('stl'),
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  )

  if (!resized) throw new Error('Assertion failed: expected resized STL feature')
  const bounds = getProfileBounds(resized.sketch.profile)
  assert(approx(bounds.maxX - bounds.minX, 20), `expected width 20, got ${bounds.maxX - bounds.minX}`)
  assert(approx(bounds.maxY - bounds.minY, 10), `expected uniform height 10, got ${bounds.maxY - bounds.minY}`)
  assert(approx(resized.stl?.scale ?? 0, 2), `expected STL mesh scale 2, got ${resized.stl?.scale}`)
  assert(approx(Number(resized.z_bottom), 0), `expected z_bottom anchored at 0, got ${resized.z_bottom}`)
  assert(approx(Number(resized.z_top), 10), `expected z_top scaled to 10, got ${resized.z_top}`)
}

testRegularFeatureCanResizeOneAxis()
testStlFeatureResizeIsUniform()

console.log('projectStore transform tests passed')
