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

import { newProject, rectProfile, roundStock, type MachiningSetup, type SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { useProjectStore } from '../../store/projectStore'
import type { SelectionState } from '../../store/types'
import { computeSketchViewTransform, worldToCanvas } from './viewTransform'

/**
 * Two imported models whose bands overlap at (20, 6) / (6, 20), while only the
 * first model's *flat* footprint covers that point. On Around the bands are the
 * model's click targets, so a fix that leaves flat footprints in the hit test
 * still selects `first` here (issue #1112 I2).
 */
export function aroundSelectionFixture(axis: 'x' | 'y' = 'x') {
  const base = newProject('Around picking', 'mm')
  const stock = roundStock(40, 100, axis)
  const setup: MachiningSetup = {
    id: 'around',
    name: 'Around',
    kind: 'around',
    orientation: { axis, angleDeg: 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
  const model = (id: string, across: number): SketchFeature => ({
    id,
    name: id,
    kind: 'stl',
    stl: null,
    folderId: null,
    operation: 'model',
    authoringFace: 'top',
    visible: true,
    locked: false,
    z_top: 10,
    z_bottom: 0,
    sketch: {
      profile: axis === 'x' ? rectProfile(10, across, 40, 4) : rectProfile(across, 10, 4, 40),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  })
  const project = projectWithFeatures({
    ...base,
    stock,
    setups: [...base.setups, setup],
    activeSetupId: setup.id,
    meta: { ...base.meta, projectType: 'rotary', showDimensions: false, showFeatureInfo: false },
  }, [model('first', 4), model('second', 30)])
  const selection: SelectionState = {
    ...useProjectStore.getState().selection,
    mode: 'feature' as const,
    selectedFeatureIds: [],
    selectedFeatureId: null,
    hoveredFeatureId: null,
    selectedClampIds: [],
    selectedTabIds: [],
    selectedNode: null,
  }
  const viewState = { zoom: 1, panX: 0, panY: 0 }
  const canvas = {
    width: 800,
    height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as HTMLCanvasElement
  const point = axis === 'x' ? { x: 20, y: 6 } : { x: 6, y: 20 }
  const screen = (world = point) => worldToCanvas(
    world,
    computeSketchViewTransform(project, canvas.width, canvas.height, viewState),
  )
  return { project, selection, viewState, canvas, point, screen }
}
