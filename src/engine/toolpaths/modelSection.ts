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

import type { SketchFeature } from '../../types/project'
import type { STLTransformedData } from '../csg'
import type { ClipperPath } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  normalizeWinding,
  toClipperPath,
} from './geometry'
import { simplifyClosedRing } from './arcReconstruction'
import { getMeshSliceIndex, sliceMeshAtZDetailed } from './meshSlicing'
import { unionClipperPathsEvenOdd } from './modelProtection'
import { significantSilhouettePaths } from './silhouette'

export interface ModelSection {
  paths: ClipperPath[]
  /** Greatest contour deviation introduced by decimation. */
  deviation: number
  /** Unclosed chains at the requested section, if any. */
  openChainCount: number
}

const EMPTY_MODEL_SECTION: ModelSection = {
  paths: [],
  deviation: 0,
  openChainCount: 0,
}

/** Mesh-slice decimation bound shared by model-protection consumers. */
const SLICE_DECIMATION_TOLERANCE_FRACTION = 0.01
const MIN_SLICE_DECIMATION_TOLERANCE = 0.002
const MAX_SLICE_DECIMATION_TOLERANCE = 0.02

export function sliceDecimationTolerance(toolRadius: number): number {
  return Math.min(
    MAX_SLICE_DECIMATION_TOLERANCE,
    Math.max(MIN_SLICE_DECIMATION_TOLERANCE, toolRadius * SLICE_DECIMATION_TOLERANCE_FRACTION),
  )
}

/**
 * Converts a model silhouette into a Clipper keep-out. A model without an
 * imported silhouette retains the legacy sketch-profile fallback.
 */
export function modelSilhouetteClipperPaths(modelFeature: SketchFeature): ClipperPath[] {
  if (modelFeature.kind === 'stl' && modelFeature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(modelFeature.stl.silhouettePaths)
      .map((path) => toClipperPath(normalizeWinding(path, true), DEFAULT_CLIPPER_SCALE))
  }

  const modelProfile = flattenProfile(modelFeature.sketch.profile)
  return [toClipperPath(modelProfile.points)]
}

/**
 * Resolves the closed part of one transformed model section.  A sample just
 * above the requested level avoids horizontal triangle degeneracies while
 * retaining the section's true Z semantics. Open chains deliberately remain
 * separate from closed paths so callers can fall back to the whole silhouette
 * only when no usable cross-section exists (issue #781).
 */
export function resolveClosedModelSection(
  model: STLTransformedData,
  z: number,
  decimationTolerance: number,
): ModelSection {
  const index = getMeshSliceIndex(model)
  const sampleEpsilon = Math.max(Math.abs(index.maxZ - index.minZ) * 1e-6, 1e-6)
  const withinModel = z <= index.maxZ - sampleEpsilon && z >= index.minZ - sampleEpsilon
  if (!withinModel) return EMPTY_MODEL_SECTION

  const sampleZ = Math.min(
    index.maxZ - sampleEpsilon,
    Math.max(index.minZ + sampleEpsilon, z + sampleEpsilon),
  )
  const slice = sliceMeshAtZDetailed(index, sampleZ)
  let deviation = 0
  const paths = slice.polygons
    .filter((polygon) => polygon.length >= 3)
    .map((polygon) => {
      const simplified = simplifyClosedRing(polygon.map(([x, y]) => ({ x, y })), decimationTolerance)
      if (simplified.deviation > deviation) deviation = simplified.deviation
      return toClipperPath(normalizeWinding(simplified.points, false), DEFAULT_CLIPPER_SCALE)
    })

  return {
    paths: unionClipperPathsEvenOdd(paths),
    deviation,
    openChainCount: slice.openChainCount,
  }
}
