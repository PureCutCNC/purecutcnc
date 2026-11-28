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
 * The combined model as a simulation-grid height raster (issue #1268).
 *
 * The model is the solid the viewport already folds (`buildCombinedModelSolid`
 * in `csg.ts`), plus the imported models a flat fold leaves out because the
 * viewport draws them as their own mesh. Seen from a setup's face it is that
 * project turned into the setup's frame (`projectInSetupFrame`, the same turn
 * the simulation runs on), with the other face's blind subtracts removed
 * exactly as generation removes them (`withoutUnreachableSubtracts`). Its top
 * surface is sampled at every grid cell centre: the highest model triangle over
 * that point, or the stock bottom where the model has no material.
 *
 * A heightfield only sees the topmost surface, so an undercut reads as solid
 * down to the stock bottom; that is the same limit the simulation itself has.
 */

import type { Manifold as ManifoldSolid, ManifoldToplevel } from 'manifold-3d'
import { flatFaceProject } from '../aroundFrame'
import { barStockSolid, buildCombinedModelSolid, getManifoldModule, loadSTLTransformedGeometry, ROUND_BAR_SEGMENTS } from '../csg'
import { DEFAULT_ARC_STEP_RADIANS } from '../profilePolyline'
import { projectInSetupFrame } from '../setupFrameProject'
import { setupFace, setupFrame, type SetupFrame } from '../setupOrientation'
import { withoutUnreachableSubtracts } from '../setupTargets'
import { modelFeatures } from '../../store/helpers/featureRoles'
import { barSeedsModel } from '../../store/helpers/projectType'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { barMaxRadius, isBarStock } from '../../types/barStock'
import { getStockBounds, type MachiningSetup, type Project, type SetupFace } from '../../types/project'
import type { SimulationGrid } from './types'

/** A flat setup's view of the project: the turn the simulation runs on. */
export interface ModelSetupView {
  /** The project turned into the setup's frame; the same object for Top. */
  localProject: Project
  /** The rotation frame, or undefined for Top. */
  frame: SetupFrame | undefined
  face: Exclude<SetupFace, 'around'>
}

/**
 * The setup-local project a flat (Top/Bottom) setup simulates and verifies
 * against. Around features are dropped (`flatFaceProject`), as the per-setup
 * simulation drops them. Throws for an Around setup or an orientation this
 * build cannot machine (`setupFrame`).
 */
export function modelSetupView(project: Project, setup?: Pick<MachiningSetup, 'orientation' | 'kind'>): ModelSetupView {
  if (setup?.kind === 'around') throw new RangeError('model verification: an Around setup has no flat frame')
  const face = setup ? setupFace(setup) : 'top'
  const frame = setup && setup.orientation.angleDeg !== 0 ? setupFrame(setup.orientation, project.stock) : undefined
  return {
    localProject: projectInSetupFrame(flatFaceProject(project), frame),
    frame,
    face: face === 'bottom' ? 'bottom' : 'top',
  }
}

/**
 * How far the tessellated model can stand from the true one, in project
 * units: the chord sagitta of the curve step the fold tessellates profiles
 * with, at the largest radius a profile inside the stock can have (half the
 * stock's plan diagonal), and for a bar the sagitta of its faceted cylinder.
 * An upper bound, so it never under-reports what the mesh cannot resolve.
 */
export function modelTessellationTolerance(project: Project): number {
  const bounds = getStockBounds(project.stock)
  const planRadius = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2
  let tolerance = planRadius * (1 - Math.cos(DEFAULT_ARC_STEP_RADIANS / 2))
  if (isBarStock(project.stock)) {
    tolerance = Math.max(tolerance, barMaxRadius(project.stock) * (1 - Math.cos(Math.PI / ROUND_BAR_SEGMENTS)))
  }
  return tolerance
}

/**
 * Raise `heights` to every triangle's height at each cell centre it covers.
 * `stride` is the number of floats per vertex in `positions`.
 */
function rasterTriangles(
  heights: Float32Array,
  grid: Pick<SimulationGrid, 'originX' | 'originY' | 'cellSize' | 'cols' | 'rows'>,
  positions: ArrayLike<number>,
  stride: number,
  index: ArrayLike<number>,
): void {
  const { originX, originY, cellSize, cols, rows } = grid
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t] * stride
    const b = index[t + 1] * stride
    const c = index[t + 2] * stride
    const x0 = positions[a], y0 = positions[a + 1], z0 = positions[a + 2]
    const x1 = positions[b], y1 = positions[b + 1], z1 = positions[b + 2]
    const x2 = positions[c], y2 = positions[c + 1], z2 = positions[c + 2]
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    // A vertical facet covers no cell centre; its neighbours carry the height.
    if (Math.abs(area) <= 1e-12) continue
    const inv = 1 / area
    const eps = 1e-9
    const colStart = Math.max(0, Math.ceil((Math.min(x0, x1, x2) - originX) / cellSize - 0.5))
    const colEnd = Math.min(cols - 1, Math.floor((Math.max(x0, x1, x2) - originX) / cellSize - 0.5))
    const rowStart = Math.max(0, Math.ceil((Math.min(y0, y1, y2) - originY) / cellSize - 0.5))
    const rowEnd = Math.min(rows - 1, Math.floor((Math.max(y0, y1, y2) - originY) / cellSize - 0.5))
    for (let row = rowStart; row <= rowEnd; row += 1) {
      const py = originY + (row + 0.5) * cellSize
      for (let col = colStart; col <= colEnd; col += 1) {
        const px = originX + (col + 0.5) * cellSize
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv
        const w2 = 1 - w0 - w1
        if (w0 < -eps || w1 < -eps || w2 < -eps) continue
        const z = w0 * z0 + w1 * z1 + w2 * z2
        const cell = row * cols + col
        if (z > heights[cell]) heights[cell] = z
      }
    }
  }
}

/**
 * The combined model's top surface at `grid`'s cell centres, as seen from the
 * setup's face (issue #1268). `project` is the canonical (stock-space) project
 * and `grid` must be built from `modelSetupView(project, setup).localProject`,
 * which `verifyAgainstModel` does. Cells with no model material read the
 * grid's stock bottom. Synchronous: the caller hands in the loaded Manifold
 * module. `null` when the project has no model to compare against.
 */
export function rasterModelTargetHeights(
  module: ManifoldToplevel,
  grid: SimulationGrid,
  project: Project,
  setup?: Pick<MachiningSetup, 'orientation' | 'kind'>,
): Float32Array | null {
  const view = modelSetupView(project, setup)
  const modelProject = withoutUnreachableSubtracts(view.localProject, view.face)
  const heights = new Float32Array(grid.cols * grid.rows).fill(Number.NEGATIVE_INFINITY)
  let rastered = false

  const barModel = barSeedsModel(modelProject) && isBarStock(modelProject.stock)
  let solid: ManifoldSolid | null = buildCombinedModelSolid(module, modelProject)
  // A bar fold that changes nothing returns no solid: the model is the bar.
  if (!solid && barModel && isBarStock(modelProject.stock)) solid = barStockSolid(module, modelProject.stock)
  if (solid) {
    try {
      const mesh = solid.getMesh()
      rasterTriangles(heights, grid, mesh.vertProperties, mesh.numProp, mesh.triVerts)
      rastered = true
    } finally {
      solid.delete()
    }
  }

  // The flat fold leaves imported models out (the viewport draws their own
  // mesh); their material is part of the part all the same. A bar fold already
  // carries its models.
  if (!barModel) {
    const features = modelFeatures(resolvedProjectFeatures(modelProject))
    for (const feature of features) {
      if (!feature.visible || feature.kind !== 'stl' || feature.operation !== 'model') continue
      const data = loadSTLTransformedGeometry(feature, modelProject)
      if (!data) continue
      rasterTriangles(heights, grid, data.positions, 3, data.index)
      rastered = true
    }
  }

  if (!rastered) return null
  for (let cell = 0; cell < heights.length; cell += 1) {
    if (heights[cell] < grid.stockBottomZ) heights[cell] = grid.stockBottomZ
  }
  return heights
}

/**
 * {@link rasterModelTargetHeights} with the Manifold module loaded first, so
 * it can run in a worker or a test without a viewport having loaded it.
 */
export async function buildModelTargetHeights(
  grid: SimulationGrid,
  project: Project,
  setup?: Pick<MachiningSetup, 'orientation' | 'kind'>,
): Promise<Float32Array | null> {
  const module = await getManifoldModule()
  return rasterModelTargetHeights(module, grid, project, setup)
}
