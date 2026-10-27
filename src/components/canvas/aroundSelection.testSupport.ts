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

import { newProject, rectProfile, roundStock, type SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { useProjectStore } from '../../store/projectStore'
import { computeSketchViewTransform, worldToCanvas } from './viewTransform'

export function aroundSelectionFixture(axis: 'x' | 'y' = 'x') {
  const base = newProject('Around picking', 'mm')
  const stock = roundStock(40, 100, axis)
  const setup = { ...base.setups[0], id: 'around', kind: 'around' as const,
    orientation: { kind: 'around' as const, aAxis: axis, stockRadius: 20, seam: 'back' as const } }
  const model = (id: string, across: number): SketchFeature => ({
    id, name: id, kind: 'stl', stl: null, folderId: null, operation: 'model',
    authoringFace: 'top', visible: true, locked: false, z_top: 10, z_bottom: 0,
    sketch: { profile: axis === 'x' ? rectProfile(10, across, 40, 4) : rectProfile(across, 10, 4, 40),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  })
  const project = projectWithFeatures({ ...base, stock, projectType: 'rotary',
    setups: [...base.setups, setup], activeSetupId: setup.id,
    meta: { ...base.meta, showDimensions: false, showFeatureInfo: false },
  }, [model('first', 4), model('second', 30)])
  const selection = { ...useProjectStore.getState().selection, mode: 'feature' as const,
    selectedFeatureIds: [], selectedFeatureId: null, hoveredFeatureId: null,
    selectedClampIds: [], selectedTabIds: [], selectedNode: null }
  const viewState = { zoom: 1, panX: 0, panY: 0 }
  const canvas = { width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLCanvasElement
  const point = axis === 'x' ? { x: 20, y: 6 } : { x: 6, y: 20 }
  const screen = (world = point) => worldToCanvas(world,
    computeSketchViewTransform(project, canvas.width, canvas.height, viewState))
  return { project, selection, viewState, canvas, point, screen }
}
