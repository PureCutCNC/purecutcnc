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
 * Run with: npx tsx src/utils/units.test.ts
 */

import { defaultTool, newProject, rectProfile } from '../types/project'
import type {
  DimensionAnnotation,
  FeatureDefinition,
  Matrix2D,
  Project,
  SketchFeature,
} from '../types/project'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { convertProjectUnits } from './units'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps
}

const MM_PER_INCH = 25.4

const freeDim: DimensionAnnotation = {
  id: 'dim0001',
  type: 'aligned',
  a: { kind: 'free', point: { x: 25.4, y: 50.8 } },
  b: { kind: 'free', point: { x: 0, y: 0 } },
  offset: 12.7,
  labelOffset: 5,
  textOverride: null,
  precisionOverride: null,
  visible: true,
  locked: false,
}

const anchoredAngleDim: DimensionAnnotation = {
  id: 'dim0002',
  type: 'angle',
  a: { kind: 'vertex', target: { source: 'feature', featureId: 'f0001' }, vertexIndex: 0 },
  b: { kind: 'vertex', target: { source: 'feature', featureId: 'f0001' }, vertexIndex: 1 },
  c: { kind: 'vertex', target: { source: 'feature', featureId: 'f0001' }, vertexIndex: 2 },
  offset: 25.4,
  textOverride: null,
  precisionOverride: null,
  visible: true,
  locked: false,
}

// ── mm → inch conversion of annotations ─────────────────────
{
  const base: Project = { ...newProject('units-test', 'mm'), annotations: [freeDim, anchoredAngleDim] }
  const inch = convertProjectUnits(base, 'inch')

  const a = inch.annotations[0]
  assert(a.a.kind === 'free' && approx(a.a.point.x, 25.4 / MM_PER_INCH), 'free anchor x converts to inch')
  assert(a.a.kind === 'free' && approx(a.a.point.y, 50.8 / MM_PER_INCH), 'free anchor y converts to inch')
  assert(approx(a.offset, 12.7 / MM_PER_INCH), 'offset converts to inch')
  assert(a.labelOffset !== undefined && approx(a.labelOffset, 5 / MM_PER_INCH), 'labelOffset converts to inch')

  // anchored angle dim: anchors are references (no coords) and stay intact; offset still converts
  const angle = inch.annotations[1]
  assert(angle.a.kind === 'vertex' && angle.a.vertexIndex === 0, 'anchored vertex reference unchanged')
  assert(approx(angle.offset, 25.4 / MM_PER_INCH), 'angle dim offset converts (length)')

  console.log('mm→inch annotation conversion PASS')
}

// ── round-trip mm → inch → mm is identity ───────────────────
{
  const base: Project = { ...newProject('units-test', 'mm'), annotations: [freeDim] }
  const round = convertProjectUnits(convertProjectUnits(base, 'inch'), 'mm')
  const a = round.annotations[0]
  assert(a.a.kind === 'free' && approx(a.a.point.x, 25.4, 1e-7), 'round-trip free x')
  assert(approx(a.offset, 12.7, 1e-7), 'round-trip offset')
  assert(a.labelOffset !== undefined && approx(a.labelOffset, 5, 1e-7), 'round-trip labelOffset')
  console.log('round-trip annotation conversion PASS')
}

// ── complete project conversion keeps definitions, instances, and anchors aligned ──
{
  const base = newProject('complete-units-test', 'mm')
  const tool = defaultTool('mm', 1)
  const projectWithTool: Project = { ...base, tools: [tool] }
  const drilling = {
    ...defaultOperationForTarget(
      projectWithTool,
      'drilling',
      'rough',
      { source: 'features', featureIds: ['stl-1'] },
      0,
    ),
    stepdown: 25.4,
    feed: 254,
    plungeFeed: 127,
    stockToLeaveRadial: 2.54,
    stockToLeaveAxial: 5.08,
    carveDepth: 25.4,
    maxCarveDepth: 50.8,
    peckDepth: 12.7,
    retractHeight: 76.2,
    waterlineMicroStepover: 2.54,
    waterlineRefinementThreshold: 5.08,
    waterlineTipStepdown: 7.62,
  }

  const localDimension = {
    id: 'ld-1',
    type: 'distance' as const,
    value: 25.4,
    name: 'Width',
    segment_ids: ['edge-a'],
  }
  const textDefinition: FeatureDefinition = {
    id: 'def-text',
    kind: 'text',
    profile: rectProfile(0, 0, 25.4, 12.7),
    dimensions: [localDimension],
    text: { text: 'A', style: 'skeleton', fontId: 'simple_stroke', size: 25.4 },
    stl: null,
    operation: 'subtract',
  }
  const stlDefinition: FeatureDefinition = {
    id: 'def-stl',
    kind: 'stl',
    profile: rectProfile(0, 0, 25.4, 50.8),
    dimensions: [],
    text: null,
    stl: {
      meshAssetId: 'mesh-1',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 25.4, y: 0 },
        { x: 25.4, y: 50.8 },
      ]],
    },
    operation: 'model',
  }
  const transform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 25.4, f: 50.8 }
  const textFeature = {
    id: 'text-1',
    name: 'Text',
    kind: 'text',
    text: textDefinition.text,
    stl: null,
    folderId: null,
    sketch: {
      profile: rectProfile(25.4, 50.8, 25.4, 12.7),
      origin: { x: 25.4, y: 50.8 },
      orientationAngle: 0,
      dimensions: [localDimension],
      constraints: [{
        id: 'constraint-1',
        type: 'fixed_distance',
        segment_ids: ['text-1', 'reference-1'],
        value: 25.4,
        anchor_point: { x: 25.4, y: 50.8 },
        reference_point: { x: 50.8, y: 76.2 },
        reference_segment: {
          a: { x: 0, y: 25.4 },
          b: { x: 25.4, y: 25.4 },
        },
        reference_t: 0.25,
      }],
    },
    operation: 'subtract',
    z_top: 25.4,
    z_bottom: 0,
    visible: true,
    locked: false,
    definitionId: textDefinition.id,
    transform,
  } as SketchFeature & { definitionId: string; transform: Matrix2D }
  const stlFeature = {
    id: 'stl-1',
    name: 'Model',
    kind: 'stl',
    text: null,
    stl: stlDefinition.stl,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 25.4, 50.8),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 50.8,
    z_bottom: 0,
    visible: true,
    locked: false,
    definitionId: stlDefinition.id,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  } as SketchFeature & { definitionId: string; transform: Matrix2D }

  const anchoredDimension: DimensionAnnotation = {
    ...anchoredAngleDim,
    a: { kind: 'vertex', target: { source: 'feature', featureId: textFeature.id }, vertexIndex: 0 },
    b: { kind: 'segmentPoint', target: { source: 'feature', featureId: textFeature.id }, segmentIndex: 0, t: 0.25 },
    c: { kind: 'circleEdge', target: { source: 'feature', featureId: textFeature.id }, segmentIndex: 1, relativeAngle: Math.PI / 4 },
  }

  const project: Project = {
    ...projectWithTool,
    meta: {
      ...projectWithTool.meta,
      maxTravelZ: 254,
      operationClearanceZ: 25.4,
      clampClearanceXY: 12.7,
      clampClearanceZ: 50.8,
    },
    grid: { ...projectWithTool.grid, extent: 254, majorSpacing: 25.4, minorSpacing: 2.54, snapIncrement: 1.27 },
    stock: {
      ...projectWithTool.stock,
      profile: rectProfile(0, 0, 254, 127),
      thickness: 25.4,
      origin: { x: 25.4, y: 50.8 },
    },
    origin: { ...projectWithTool.origin, x: 25.4, y: 50.8, z: 12.7 },
    backdrop: {
      name: 'Reference',
      mimeType: 'image/png',
      imageDataUrl: 'data:image/png;base64,',
      intrinsicWidth: 100,
      intrinsicHeight: 100,
      center: { x: 127, y: 63.5 },
      width: 254,
      height: 127,
      orientationAngle: 15,
      opacity: 0.5,
      visible: true,
    },
    dimensions: { width: { id: 'width', name: 'Width', value: 25.4, formula: null } },
    annotations: [freeDim, anchoredDimension],
    modelAssets: {
      'mesh-1': {
        storage: 'mesh-v1',
        vertexCount: 0,
        triangleCount: 0,
        positions: '',
        indices: '',
        bounds: { minX: 0, maxX: 25.4, minY: 0, maxY: 50.8, minZ: 0, maxZ: 12.7 },
      },
    },
    featureDefinitions: { [textDefinition.id]: textDefinition, [stlDefinition.id]: stlDefinition },
    features: [textFeature, stlFeature],
    global_constraints: [{ id: 'gc-1', type: 'equal_spacing', feature_ids: [textFeature.id, stlFeature.id], value: 25.4 }],
    operations: [drilling],
    tabs: [{ id: 'tab-1', name: 'Tab', x: 25.4, y: 50.8, w: 12.7, h: 6.35, z_top: 5.08, z_bottom: 2.54, visible: true }],
    clamps: [{ id: 'clamp-1', name: 'Clamp', type: 'step_clamp', x: 25.4, y: 50.8, w: 76.2, h: 25.4, height: 12.7, visible: true }],
  }

  const inch = convertProjectUnits(project, 'inch')
  const inchText = inch.features[0] as SketchFeature & { transform?: Matrix2D }
  const inchConstraint = inchText.sketch.constraints[0]
  const inchAnchored = inch.annotations[1]

  assert(approx(inch.meta.maxTravelZ, 10), 'project metadata lengths convert')
  assert(approx(inch.grid.extent, 10), 'grid lengths convert')
  assert(approx(inch.stock.thickness, 1), 'stock thickness converts')
  assert(approx(inch.origin.x, 1), 'origin converts')
  assert(inch.backdrop !== null && approx(inch.backdrop.width, 10), 'backdrop converts')
  assert(approx(inch.dimensions.width.value, 1), 'named dimensions convert')
  assert(inchAnchored.a.kind === 'vertex' && inchAnchored.a.target.source === 'feature' && inchAnchored.a.target.featureId === textFeature.id, 'vertex anchor target survives')
  assert(inchAnchored.b?.kind === 'segmentPoint' && inchAnchored.b.segmentIndex === 0 && inchAnchored.b.t === 0.25, 'segment-point anchor survives')
  assert(inchAnchored.c?.kind === 'circleEdge' && inchAnchored.c.relativeAngle === Math.PI / 4, 'circle-edge anchor survives')
  assert(approx(inch.featureDefinitions['def-text'].dimensions[0].value, 1), 'definition dimension converts')
  assert(inch.featureDefinitions['def-text'].dimensions[0].segment_ids[0] === 'edge-a', 'definition dimension anchors survive')
  assert(approx(inch.featureDefinitions['def-text'].text?.size ?? 0, 1), 'text size converts')
  assert(approx(inch.featureDefinitions['def-stl'].stl?.scale ?? 0, 1 / MM_PER_INCH), 'model scale converts')
  assert(approx(inch.featureDefinitions['def-stl'].stl?.silhouettePaths?.[0]?.[1]?.x ?? 0, 1), 'model silhouette converts')
  assert(approx(inchText.transform?.e ?? 0, 1) && approx(inchText.transform?.f ?? 0, 2), 'instance translation converts')
  assert(approx(inchConstraint.value ?? 0, 1), 'local constraint value converts')
  assert(inchConstraint.segment_ids.join(',') === 'text-1,reference-1', 'local constraint anchors survive')
  assert(inchConstraint.anchor_point !== undefined && approx(inchConstraint.anchor_point.x, 1), 'local constraint anchor point converts')
  assert(approx(inch.operations[0].carveDepth, 1), 'operation carve depth converts')
  assert(approx(inch.operations[0].maxCarveDepth, 2), 'operation max carve depth converts')
  assert(approx(inch.operations[0].peckDepth ?? 0, 0.5), 'operation peck depth converts')
  assert(approx(inch.operations[0].retractHeight ?? 0, 3), 'operation retract height converts')
  assert(approx(inch.tabs[0].x, 1) && approx(inch.tabs[0].w, 0.5), 'tab lengths convert')
  assert(approx(inch.clamps[0].x, 1) && approx(inch.clamps[0].height, 0.5), 'clamp lengths convert')
  assert(inch.tools[0].units === 'mm' && inch.tools[0].diameter === tool.diameter, 'tool records retain independent units')
  assert(inch.modelAssets === project.modelAssets, 'immutable mesh assets are not rewritten')

  const round = convertProjectUnits(inch, 'mm')
  const roundText = round.features[0] as SketchFeature & { transform?: Matrix2D }
  assert(approx(round.featureDefinitions['def-text'].dimensions[0].value, 25.4, 1e-7), 'definition dimension round-trips')
  assert(round.featureDefinitions['def-text'].dimensions[0].segment_ids[0] === 'edge-a', 'dimension anchor round-trips')
  assert(approx(roundText.transform?.e ?? 0, 25.4, 1e-7), 'instance translation round-trips')
  console.log('complete project unit conversion PASS')
}

console.log('\nall units.test.ts assertions passed')
