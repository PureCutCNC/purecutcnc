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
import type { OperationKind, Project, SketchFeature } from '../types/project'
import { computeMeshBounds, serializeImportedMesh } from '../engine/importedMesh'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { projectWithFeatures } from './projectFixtures'

/** A small closed asymmetric prism placed inside a bar, plus a 2D Around feature. */
export function rotaryOperationFixture(axis: 'x' | 'y' = 'x', kind: OperationKind = 'rotary_finish'): Project {
  const base = newProject('Rotary operation fixture', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 25
  // A rotary project: the Around face, its setup and the rotary operations
  // exist only in one (issue #1028).
  base.meta.projectType = 'rotary'
  base.stock = roundStock(12, 30, axis)
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', type: 'ball_endmill', diameter: 2, defaultStepover: 0.8, defaultStepdown: 1 }]
  const positions = new Float32Array([
    3, -2, 4, 27, -2, 4, 27, 2, 4, 3, 2, 4,
    3, -2, 8, 27, -2, 9, 27, 2, 9, 3, 2, 8,
  ])
  // Centre the prism over the real bar's across coordinate (6); Y bar swaps XY.
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] += 6
    if (axis === 'y') [positions[i], positions[i + 1]] = [positions[i + 1], positions[i]]
  }
  const index = new Uint32Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7])
  base.modelAssets = { asset: serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl') }
  const profile = axis === 'x' ? rectProfile(3, 4, 24, 4) : rectProfile(4, 3, 4, 24)
  const model: SketchFeature = {
    id: 'model', name: 'Model', kind: 'stl', operation: 'model', authoringFace: 'top', folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: 9, z_bottom: 4, visible: true, locked: false,
  }
  const around: SketchFeature = { ...model, id: 'sketch', name: 'Sketch', kind: 'rect', operation: 'subtract', stl: null, authoringFace: 'around', z_top: 12, z_bottom: 10 }
  const project = projectWithFeatures(base, [model, around])
  project.setups.push({ ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = [{ id: 'chuck', name: 'Chuck', type: 'chuck', x: 0, y: 0, w: axis === 'x' ? 2 : 12, h: axis === 'x' ? 12 : 2, height: 14, visible: true }]
  project.operations = [{ ...defaultOperationForTarget(project, kind, 'rough', { source: 'features', featureIds: ['model'] }, 0), setupId: 'around', stockToLeaveRadial: 0.4 }]
  return project
}
