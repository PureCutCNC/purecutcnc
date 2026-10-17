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
 * The viewport's owned square-material surface (issue #1016 C2-R2V).
 *
 * `engine/simulation/squareMaterialMesh.ts` owns the chunked geometry and its
 * update/dispose contract; this module is the thin caller adapter that knows
 * the *physical* stock bounds. The resource cannot derive them from the grid:
 * `ceil(length / cellSize)` rounds up, so `cols * cellSize` overshoots the real
 * bar end. `getStockBounds` on the real bar is the exact source.
 *
 * The surface is drawn as the actual square blank — flats, corners and real
 * air gaps between surviving intervals — and never through the old heightfield
 * or instanced-boundary path. Its object is meant to be attached to the bar
 * turn group's content, so the frozen pivot/turn transform is the only
 * placement applied; no shader unwrap is layered on top.
 */

import * as THREE from 'three'
import type { BarStock } from '../../types/project'
import { getStockBounds } from '../../types/project'
import { isSquareStock } from '../../types/barStock'
import type { DirtyRegion, SimulationGrid } from '../../engine/simulation'
import {
  createSquareMaterialMesh,
  type SquareMaterialMeshResource,
} from '../../engine/simulation/squareMaterialMesh'
import { aroundFrameKey } from './aroundView'

/** The physical stock ends on the bar axis, in absolute project coordinates. */
export function squarePreviewAlongBounds(stock: BarStock): { min: number; max: number } {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x'
    ? { min: bounds.minX, max: bounds.maxX }
    : { min: bounds.minY, max: bounds.maxY }
}

/**
 * Everything the drawn material depends on at build time: the blank's shape,
 * side and frame, the exact stock ends, and the grid topology. The remaining
 * material itself is deliberately not here — a mutable `squareMaterial` map's
 * identity is not a cache key; the resource reads it through
 * `squareMaterialIntervals` on every rebuild.
 */
export function squarePreviewKey(grid: SimulationGrid, stock: BarStock): string {
  const along = squarePreviewAlongBounds(stock)
  return [
    aroundFrameKey(grid.squareBar?.frame ?? undefined, stock),
    grid.squareBar?.side,
    along.min,
    along.max,
    grid.originX,
    grid.originY,
    grid.cols,
    grid.rows,
    grid.cellSize,
  ].join('|')
}

/** One owned square-material surface. `dispose()` is idempotent. */
export interface SquarePreviewSurface {
  readonly object: THREE.Group
  readonly resource: SquareMaterialMeshResource
  readonly key: string
  readonly disposed: boolean
  /** `undefined` is a full reset, `null` an explicit no-op (resource contract). */
  update(grid: SimulationGrid, dirtyRegion?: DirtyRegion | null): void
  /** Remove the object from its parent and release the resource exactly once. */
  dispose(): void
}

/**
 * Build the actual square blank for `grid`. Throws a `RangeError` before
 * allocating anything when the grid is not a square simulation or the stock is
 * not a square blank — a round/flat view must never be given this surface.
 */
export function createSquarePreviewSurface(
  grid: SimulationGrid,
  stock: BarStock,
  color: THREE.ColorRepresentation,
): SquarePreviewSurface {
  if (!grid.squareBar) {
    throw new RangeError('square preview: grid has no squareBar descriptor')
  }
  if (!isSquareStock(stock)) {
    throw new RangeError('square preview: the physical stock is not a square blank')
  }
  const resource = createSquareMaterialMesh(grid, color, {
    alongBounds: squarePreviewAlongBounds(stock),
  })
  const object = resource.object
  let disposed = false
  return {
    object,
    resource,
    key: squarePreviewKey(grid, stock),
    get disposed(): boolean {
      return disposed
    },
    update(source: SimulationGrid, dirtyRegion?: DirtyRegion | null): void {
      if (disposed) {
        throw new RangeError('square preview: update() called after dispose()')
      }
      resource.update(source, dirtyRegion)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      // The resource owns the geometry and material, so bypass
      // `disposeSceneObject`: remove the object, then release exactly once.
      object.removeFromParent()
      resource.dispose()
    },
  }
}
