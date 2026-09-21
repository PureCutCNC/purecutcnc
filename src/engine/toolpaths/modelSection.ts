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
import type { ToolpathWarning } from './warningCodes'
import { appendUniqueWarning } from './warningDedup'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  normalizeWinding,
  toClipperPath,
} from './geometry'
import { simplifyClosedRing } from './arcReconstruction'
import { getMeshSliceIndex, sliceMeshAtZDetailed } from './meshSlicing'
import { unionClipperPaths, unionClipperPathsEvenOdd } from './modelProtection'
import { significantSilhouettePaths } from './silhouette'

export interface ModelSection {
  paths: ClipperPath[]
  /** Greatest contour deviation introduced by decimation. */
  deviation: number
  /** Unclosed chains at the requested section, if any. */
  openChainCount: number
}

/** Imported-model data needed to protect 2.5D clearing at individual Z levels. */
export interface ImportedModelSection {
  featureId: string
  geometry: STLTransformedData | null
  silhouettePaths: ClipperPath[]
  decimationTolerance: number
}

/**
 * One top-down model-section pass. Consumers that need the raw section as
 * well as its cumulative keep-out share the same mesh slice rather than
 * resolving it twice.
 */
export interface CumulativeModelKeepOutPlan {
  keepOutsByLevel: ReadonlyMap<number, ClipperPath[]>
  sectionsByLevel: ReadonlyMap<number, ReadonlyMap<string, ModelSection>>
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

/**
 * Returns one imported-model section at a machining level. Only an unresolved
 * open slice uses the conservative whole silhouette.
 */
function modelPathsAtLevel(
  modelSections: readonly ImportedModelSection[],
  z: number,
  warnings: ToolpathWarning[],
  sectionsByFeatureId?: Map<string, ModelSection>,
): ClipperPath[] {
  return modelSections.flatMap(({ featureId, geometry, silhouettePaths, decimationTolerance }) => {
    // `modelSilhouetteClipperPaths` normalizes outlines clockwise for direct
    // offsetting. The cumulative union keeps outer rings counter-clockwise;
    // mixing those orientations cancels a repeated fallback silhouette under
    // Clipper's non-zero fill rule.
    const cumulativeSilhouettePaths = silhouettePaths.map((path) => [...path].reverse())
    if (!geometry) {
      if (silhouettePaths.length > 0) {
        appendUniqueWarning(warnings, { code: 'surface3dLoadFailed' })
      }
      return cumulativeSilhouettePaths
    }

    const section = resolveClosedModelSection(geometry, z, decimationTolerance)
    sectionsByFeatureId?.set(featureId, section)
    if (section.paths.length > 0) {
      return section.paths
    }
    if (section.openChainCount > 0) {
      if (silhouettePaths.length > 0) {
        appendUniqueWarning(warnings, { code: 'surface3dOpenMesh' })
      }
      return cumulativeSilhouettePaths
    }
    return []
  })
}

/**
 * A flat endmill removes a vertical column above its tip, so a cut at a lower
 * Z must avoid every model section already encountered above it. The levels
 * arrive top-to-bottom, matching the 3D surface generators' cumulative
 * protection invariant.
 */
export function buildCumulativeModelKeepOutPlan(
  modelSections: readonly ImportedModelSection[],
  levels: readonly number[],
  warnings: ToolpathWarning[],
): CumulativeModelKeepOutPlan {
  const keepOutsByLevel = new Map<number, ClipperPath[]>()
  const sectionsByLevel = new Map<number, ReadonlyMap<string, ModelSection>>()
  let protectedAbovePaths: ClipperPath[] = []

  for (const z of levels) {
    const sectionsAtLevel = new Map<string, ModelSection>()
    const pathsAtLevel = modelPathsAtLevel(modelSections, z, warnings, sectionsAtLevel)
    if (pathsAtLevel.length > 0) {
      protectedAbovePaths = unionClipperPaths([
        ...protectedAbovePaths,
        ...pathsAtLevel,
      ])
    }
    keepOutsByLevel.set(z, protectedAbovePaths)
    sectionsByLevel.set(z, sectionsAtLevel)
  }

  return { keepOutsByLevel, sectionsByLevel }
}

/**
 * A flat endmill removes a vertical column above its tip, so a cut at a lower
 * Z must avoid every model section already encountered above it.
 */
export function buildCumulativeModelKeepOuts(
  modelSections: readonly ImportedModelSection[],
  levels: readonly number[],
  warnings: ToolpathWarning[],
): ReadonlyMap<number, ClipperPath[]> {
  return buildCumulativeModelKeepOutPlan(modelSections, levels, warnings).keepOutsByLevel
}
