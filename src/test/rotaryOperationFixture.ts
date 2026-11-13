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

import { defaultTool, newProject, rectProfile, roundStock } from '../types/project'
import type { OperationKind, Project, ProjectMeta, SketchFeature } from '../types/project'
import { computeMeshBounds, serializeImportedMesh } from '../engine/importedMesh'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { convertLength } from '../utils/units'
import { projectWithFeatures } from './projectFixtures'

/**
 * A small closed asymmetric prism placed inside a bar, plus a 2D Around feature.
 *
 * `units` is the project's own unit system, and it scales **every** length in
 * the fixture — stock, prism, sketch profile, Z bounds, chuck and tool — rather
 * than relabelling a millimetre project. The default is millimetres. The inch
 * form exists for issue #1112 item 35, whose reported project is an inch rotary
 * project, so the export that reads this fixture takes the reported project's
 * unit path (G20, four decimal places) rather than the millimetre one.
 */
export function rotaryOperationFixture(
  axis: 'x' | 'y' = 'x',
  kind: OperationKind = 'rotary_finish',
  units: ProjectMeta['units'] = 'mm',
): Project {
  // Every dimension below is a millimetre value in the original fixture; `len`
  // converts it into the project's units, so mm is exactly the old fixture.
  const len = (millimetres: number) => convertLength(millimetres, 'mm', units)
  const base = newProject('Rotary operation fixture', units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = len(25)
  // A rotary project: the Around face, its setup and the rotary operations
  // exist only in one (issue #1028).
  base.meta.projectType = 'rotary'
  base.stock = roundStock(len(12), len(30), axis)
  base.tools = [{
    ...defaultTool(units, 1),
    id: 't1',
    type: 'ball_endmill',
    diameter: len(2),
    defaultStepover: len(0.8),
    defaultStepdown: len(1),
  }]
  const positions = new Float32Array([
    3, -2, 4, 27, -2, 4, 27, 2, 4, 3, 2, 4,
    3, -2, 8, 27, -2, 9, 27, 2, 9, 3, 2, 8,
  ])
  // Centre the prism over the real bar's across coordinate (6); Y bar swaps XY.
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] += 6
    if (axis === 'y') [positions[i], positions[i + 1]] = [positions[i + 1], positions[i]]
    positions[i] = len(positions[i])
    positions[i + 1] = len(positions[i + 1])
    positions[i + 2] = len(positions[i + 2])
  }
  const index = new Uint32Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7])
  base.modelAssets = { asset: serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl') }
  const profile = axis === 'x'
    ? rectProfile(len(3), len(4), len(24), len(4))
    : rectProfile(len(4), len(3), len(4), len(24))
  const model: SketchFeature = {
    id: 'model', name: 'Model', kind: 'stl', operation: 'model', authoringFace: 'top', folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: len(9), z_bottom: len(4), visible: true, locked: false,
  }
  const around: SketchFeature = { ...model, id: 'sketch', name: 'Sketch', kind: 'rect', operation: 'subtract', stl: null, authoringFace: 'around', z_top: len(12), z_bottom: len(10) }
  const project = projectWithFeatures(base, [model, around])
  project.setups.push({ ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = [{
    id: 'chuck', name: 'Chuck', type: 'chuck', x: 0, y: 0,
    w: axis === 'x' ? len(2) : len(12),
    h: axis === 'x' ? len(12) : len(2),
    height: len(14),
    visible: true,
  }]
  project.operations = [{
    ...defaultOperationForTarget(project, kind, 'rough', { source: 'features', featureIds: ['model'] }, 0),
    setupId: 'around',
    stockToLeaveRadial: len(0.4),
  }]
  return project
}

/**
 * The same fixture with a second imported model (`second`) and a Region mask
 * (`region`) available, for the per-model preceding-rough rule and its cache
 * dependency (#1045 slice V). Both models share the one mesh asset.
 */
export function rotaryMultiModelFixture(axis: 'x' | 'y' = 'x', kind: OperationKind = 'rotary_finish'): Project {
  const project = rotaryOperationFixture(axis, kind)
  const model = project.features.find((feature) => feature.id === 'model')
  const definition = model ? project.featureDefinitions[model.definitionId] : undefined
  if (!model || !definition) throw new Error('rotaryOperationFixture is missing its model definition')
  const second = { ...model, id: 'second', name: 'Second' }
  const region: SketchFeature = {
    id: 'region', name: 'Region', kind: 'rect', operation: 'region', authoringFace: 'around', folderId: null,
    sketch: {
      profile: definition.profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: definition.dimensions,
      constraints: [],
    },
    z_top: 10, z_bottom: 0, visible: true, locked: false,
  }
  return projectWithFeatures(project, [...project.features, second, region])
}
