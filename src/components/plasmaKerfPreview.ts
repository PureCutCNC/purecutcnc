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
 * Plasma kerf-width preview model (issue #961, slice A).
 *
 * Display only: the band is a *visualisation* of the kerf the plasma generator
 * already offsets by, so it is derived from the generated moves and the torch
 * the same way `src/engine/toolpaths/plasma.ts` derives its cut path. Nothing
 * here feeds toolpath generation, G-code, the store or the `.camj` format.
 *
 * The band is centred on the torch path (the cut moves) and exactly one kerf
 * wide. The kerf is the torch's diameter, so its edge lands on the drawn part
 * line — the same coincidence `plasma.test.ts` pins for the generator.
 */

import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import type { ToolpathMove } from '../engine/toolpaths/types'
import { findOperationTool } from '../toolPolicy'
import type { Project } from '../types/project'

export interface PlasmaKerfPoint {
  x: number
  y: number
}

export interface PlasmaKerfSegment {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

export interface PlasmaKerfGeometry {
  /** Every `cut` move, in move order. */
  contour: PlasmaKerfSegment[]
  /** Every `lead_in` and `lead_out` move, in move order. */
  leads: PlasmaKerfSegment[]
  /** The `to` of every `plunge` move, in move order (plasma.ts writes one per cut). */
  pierces: PlasmaKerfPoint[]
}

/** Share of the ordinary stroke strength the band is drawn at. */
export const PLASMA_KERF_BAND_ALPHA = 0.35

/** Pierce marker radius in screen pixels. */
export const PLASMA_PIERCE_MARKER_RADIUS_PX = 5

/**
 * Kerf width in project units for the operation with this id, or null when it
 * is not a `plasma_profile` operation with a plasma torch of finite, positive
 * diameter. Uses findOperationTool + normalizeToolForProject.
 *
 * Stock space throughout, like the moves it is measured against: the width is
 * in the project's own units whatever unit the torch itself was stored in.
 */
export function plasmaKerfWidth(project: Project, operationId: string): number | null {
  const operation = project.operations.find((candidate) => candidate.id === operationId)
  if (!operation || operation.kind !== 'plasma_profile') return null
  const tool = findOperationTool(project, operation)
  if (!tool) return null
  const width = 2 * normalizeToolForProject(tool, project).radius
  return Number.isFinite(width) && width > 0 ? width : null
}

function segmentOf(move: ToolpathMove): PlasmaKerfSegment {
  return { fromX: move.from.x, fromY: move.from.y, toX: move.to.x, toY: move.to.y }
}

const geometryCache = new WeakMap<object, PlasmaKerfGeometry>()

/**
 * Pure split of the moves; cached by toolpath identity in a WeakMap, like
 * `toolpathLayerBuckets`.
 *
 * The split is a pure function of the move kinds, so it depends on neither
 * visibility nor the project and caches on the toolpath object's identity.
 * `ToolpathResult` objects come out of the generation cache and are
 * referentially stable between regens, so a hit costs a WeakMap lookup and a
 * miss one pass per regen — the same property the layer buckets rely on.
 *
 * The kind-only split means a non-plasma toolpath still yields whatever its
 * kinds say; callers gate on `plasmaKerfWidth` first, so only plasma paths
 * reach a renderer.
 */
export function plasmaKerfGeometry(toolpath: { moves: readonly ToolpathMove[] }): PlasmaKerfGeometry {
  const cached = geometryCache.get(toolpath)
  if (cached !== undefined) {
    return cached
  }
  const contour: PlasmaKerfSegment[] = []
  const leads: PlasmaKerfSegment[] = []
  const pierces: PlasmaKerfPoint[] = []
  for (const move of toolpath.moves) {
    switch (move.kind) {
      case 'cut':
        contour.push(segmentOf(move))
        break
      case 'lead_in':
      case 'lead_out':
        leads.push(segmentOf(move))
        break
      case 'plunge':
        pierces.push({ x: move.to.x, y: move.to.y })
        break
      default:
        // rapids and retractions contribute nothing to the band.
        break
    }
  }
  const geometry: PlasmaKerfGeometry = { contour, leads, pierces }
  geometryCache.set(toolpath, geometry)
  return geometry
}
