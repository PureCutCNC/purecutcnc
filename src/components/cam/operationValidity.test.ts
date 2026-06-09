/**
 * Tests for the shared operation-validity helpers.
 *
 * Two concerns are covered:
 *  1. `validQuickOperationsForFeature` — the feature → quick-operation mapping
 *     that the App.tsx context menu depends on.
 *  2. `getOperationAddHint` — golden hint values, so the extraction out of
 *     CAMPanel.tsx is provably behaviour-preserving (same inputs → same hints).
 *
 * Run with: npx tsx src/components/cam/operationValidity.test.ts
 */

import {
  getOperationAddHint,
  quickOperationLabel,
  validQuickOperationsForFeature,
} from './operationValidity'
import type { SelectionState } from '../../store/types'
import {
  newProject,
  rectProfile,
  type FeatureKind,
  type FeatureOperation,
  type Project,
  type SketchFeature,
} from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFeature(
  id: string,
  operation: FeatureOperation,
  kind: FeatureKind = 'polygon',
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    stl: kind === 'stl' ? null : undefined,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function projectWith(features: SketchFeature[]): Project {
  return { ...newProject(), features }
}

function selectionFor(featureIds: string[]): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: featureIds[0] ?? null,
    selectedFeatureIds: featureIds,
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
  }
}

// ── validQuickOperationsForFeature ────────────────────────────────

function testSubtractFeatureOffersPocketingNotSurface(): void {
  const project = projectWith([makeFeature('sub', 'subtract')])
  const kinds = validQuickOperationsForFeature(project, 'sub').map((op) => op.kind)

  assert(kinds.includes('pocket'), 'subtract feature should offer pocket')
  assert(kinds.includes('edge_route_inside'), 'subtract feature should offer inside route')
  assert(!kinds.includes('edge_route_outside'), 'subtract feature should not offer outside route')
  assert(!kinds.includes('surface_clean'), 'subtract feature should not offer surface clean')
  assert(!kinds.includes('rough_surface'), 'subtract feature should not offer rough surface')
  assert(!kinds.includes('finish_surface'), 'subtract feature should not offer finish surface')
}

function testAddFeatureOffersOutsideRouteAndSurfaceClean(): void {
  const project = projectWith([makeFeature('add', 'add')])
  const kinds = validQuickOperationsForFeature(project, 'add').map((op) => op.kind)

  assert(kinds.includes('edge_route_outside'), 'add feature should offer outside route')
  assert(kinds.includes('surface_clean'), 'add feature should offer surface clean')
  assert(!kinds.includes('pocket'), 'add feature should not offer pocket')
  assert(!kinds.includes('edge_route_inside'), 'add feature should not offer inside route')
  assert(!kinds.includes('rough_surface'), 'add feature should not offer rough surface')
}

function testStlModelOffersSurfaceOperations(): void {
  const project = projectWith([makeFeature('model', 'model', 'stl')])
  const kinds = validQuickOperationsForFeature(project, 'model').map((op) => op.kind)

  assert(kinds.includes('rough_surface'), 'stl model should offer rough surface')
  assert(kinds.includes('finish_surface'), 'stl model should offer finish surface')
  assert(kinds.includes('finish_surface_cleanup'), 'stl model should offer finish surface cleanup')
  assert(!kinds.includes('pocket'), 'stl model should not offer pocket')
}

function testRegionFeatureOffersNothing(): void {
  const project = projectWith([makeFeature('reg', 'region')])
  assert(
    validQuickOperationsForFeature(project, 'reg').length === 0,
    'region feature should offer no quick operations',
  )
}

function testMissingFeatureOffersNothing(): void {
  const project = projectWith([makeFeature('sub', 'subtract')])
  assert(
    validQuickOperationsForFeature(project, 'does-not-exist').length === 0,
    'unknown feature id should offer no quick operations',
  )
}

function testQuickOperationCarriesDefaultPassAndLabel(): void {
  const project = projectWith([makeFeature('sub', 'subtract')])
  const ops = validQuickOperationsForFeature(project, 'sub')
  const pocket = ops.find((op) => op.kind === 'pocket')

  assert(pocket !== undefined, 'expected a pocket quick operation')
  assert(pocket?.pass === 'rough', 'quick operations should default to the rough pass')
  assert(pocket?.label === 'Create Pocket', `expected friendly label, got ${pocket?.label}`)
  assert(quickOperationLabel('edge_route_outside') === 'Create Outside Route', 'outside-route label mismatch')
}

// ── getOperationAddHint (golden, behaviour-preserving) ────────────

function testGetOperationAddHintGoldenValues(): void {
  const project = projectWith([
    makeFeature('sub', 'subtract'),
    makeFeature('add', 'add'),
    makeFeature('model', 'model', 'stl'),
    makeFeature('circle', 'subtract', 'circle'),
  ])

  // Valid selections return null.
  assert(getOperationAddHint(project, selectionFor(['sub']), 'pocket') === null, 'subtract+pocket should be valid')
  assert(getOperationAddHint(project, selectionFor(['add']), 'edge_route_outside') === null, 'add+edge-out should be valid')
  assert(getOperationAddHint(project, selectionFor(['model']), 'rough_surface') === null, 'model+rough should be valid')
  assert(getOperationAddHint(project, selectionFor(['model']), 'finish_surface') === null, 'model+finish should be valid')
  assert(getOperationAddHint(project, selectionFor(['circle']), 'drilling') === null, 'circle+drilling should be valid')

  // Invalid selections return the exact hint strings the CAM panel renders.
  assert(
    getOperationAddHint(project, selectionFor([]), 'pocket') === 'Select one or more compatible features first',
    'empty+pocket hint mismatch',
  )
  assert(
    getOperationAddHint(project, selectionFor([]), 'drilling') === 'Select one or more circle features first',
    'empty+drilling hint mismatch',
  )
  assert(
    getOperationAddHint(project, selectionFor(['sub']), 'surface_clean')
      === 'Surface clean only accepts add/model features plus optional closed regions',
    'subtract+surface-clean hint mismatch',
  )
  assert(
    getOperationAddHint(project, selectionFor(['add']), 'v_carve')
      === 'V-Carve offset only accepts subtract features plus optional closed regions',
    'add+v_carve hint mismatch',
  )
  assert(
    getOperationAddHint(project, selectionFor(['add']), 'pocket')
      === 'This operation only accepts subtract features plus optional closed regions',
    'add+pocket hint mismatch',
  )
}

testSubtractFeatureOffersPocketingNotSurface()
testAddFeatureOffersOutsideRouteAndSurfaceClean()
testStlModelOffersSurfaceOperations()
testRegionFeatureOffersNothing()
testMissingFeatureOffersNothing()
testQuickOperationCarriesDefaultPassAndLabel()
testGetOperationAddHintGoldenValues()

console.log('operationValidity tests passed')
