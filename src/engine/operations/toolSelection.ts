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
 * Picks a sensible tool when an operation is created (from the CAM panel or the
 * feature-local quick-operation context menu). The previous behaviour always
 * referenced `project.tools[0]`, which produced wrong/no toolpaths (e.g. a
 * V-carve against a flat endmill) and `null` tools on empty projects.
 *
 * Selection considers, in this order:
 *  - operation type → a best-first list of acceptable tool types,
 *  - project units → bundled-library entries are converted before comparison,
 *  - feature size → the largest tool within `autoToolDiameterLimit()` (a
 *    fraction of the feature's smallest dimension, capped at 1/4" for routing
 *    kinds); smallest available otherwise.
 *
 * Within each preferred type the function prefers a tool the project already
 * has, otherwise it imports the matching bundled-library entry. This module is
 * pure so it can be unit-tested without the store or the browser.
 */

import type { OperationKind, OperationTarget, Project, Tool, ToolType } from '../../types/project'
import { getStockBounds } from '../../types/project'
import { isMachinable } from '../../store/helpers/featureRoles'
import { getFeatureGeometryBounds } from '../../text'
import { convertLength, convertToolUnits } from '../../utils/units'
import type { ToolLibraryEntry } from '../../toolLibrary'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'

/**
 * Auto-created operations keep primary cutters comfortably below the narrowest
 * target span. A purely clearance-based limit can otherwise pick a half- or
 * three-quarter-inch tool for a small 2.5D part and hide its details. Rest
 * machining can still clear what a conservative first cutter leaves behind.
 */
export const AUTO_TOOL_OUTSIDE_FRACTION = 0.15
export const AUTO_TOOL_INTERIOR_FRACTION = 0.2

/**
 * Ceiling for auto-picked routing cutters, whatever the part size. 1/4" is the
 * everyday woodworking cutter; bigger tools are something the user opts into by
 * choosing them on the operation (#876).
 */
export const AUTO_TOOL_MAX_DIAMETER_INCH = 0.25

/** Kinds whose auto-picked tool is held to `AUTO_TOOL_MAX_DIAMETER_INCH`. */
function hasAutoToolCeiling(kind: OperationKind): boolean {
  switch (kind) {
    case 'pocket':
    case 'edge_route_inside':
    case 'edge_route_outside':
    case 'follow_line':
    case 'rough_surface':
    case 'finish_surface':
    case 'finish_surface_cleanup':
      return true
    // Drills are sized to the hole, a V-bit's reach comes from its angle rather
    // than its diameter, and facing the stock wants a wide cutter.
    case 'drilling':
    case 'v_carve':
    case 'v_carve_medial':
    case 'surface_clean':
      return false
  }
}

/**
 * Acceptable tool types for an operation kind, best-first. The first type that
 * has any candidate (existing tool or library entry) wins.
 */
export function preferredToolTypes(kind: OperationKind): ToolType[] {
  switch (kind) {
    case 'v_carve':
    case 'v_carve_medial':
      return ['v_bit']
    case 'drilling':
      // The engine only warns (not errors) when a non-drill bit is used, and the
      // bundled library ships no drills, so a flat endmill is an acceptable last resort.
      return ['drill', 'flat_endmill']
    case 'finish_surface':
    case 'finish_surface_cleanup':
      return ['ball_endmill', 'flat_endmill']
    case 'rough_surface':
      return ['flat_endmill', 'ball_endmill']
    case 'pocket':
    case 'edge_route_inside':
    case 'edge_route_outside':
    case 'surface_clean':
    case 'follow_line':
      return ['flat_endmill', 'ball_endmill']
  }
}

/**
 * Characteristic feature size in project units: the smallest bounding-box
 * min-dimension across the target's machining features (so the chosen tool fits
 * every target). Falls back to the stock bounds for stock targets. Returns
 * `null` when no usable size can be determined.
 */
export function targetFeatureSize(project: Project, target: OperationTarget): number | null {
  if (target.source === 'stock') {
    const bounds = getStockBounds(project.stock)
    const dim = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    return dim > 0 ? dim : null
  }

  const features = resolveFeatureInstances(project, target.featureIds).filter(isMachinable)

  if (features.length === 0) {
    return null
  }

  let smallest = Infinity
  for (const feature of features) {
    const bounds = getFeatureGeometryBounds(feature)
    const dim = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    if (dim > 0) {
      smallest = Math.min(smallest, dim)
    }
  }
  return Number.isFinite(smallest) ? smallest : null
}

/**
 * Applies the 1/4" routing ceiling to a diameter limit. A `null` limit (no
 * usable target size) becomes the ceiling itself for kinds that have one.
 */
export function capAutoToolDiameter(kind: OperationKind, units: Tool['units'], limit: number | null): number | null {
  if (!hasAutoToolCeiling(kind)) return limit
  const ceiling = convertLength(AUTO_TOOL_MAX_DIAMETER_INCH, 'inch', units)
  return limit == null ? ceiling : Math.min(limit, ceiling)
}

/**
 * Largest diameter an auto-created operation may pick, in project units.
 * Shared by the quick-operation/Add path and the CAM plan so they agree.
 */
export function autoToolDiameterLimit(project: Project, kind: OperationKind, target: OperationTarget): number | null {
  const span = targetFeatureSize(project, target)
  if (kind === 'drilling') return span
  const fraction = kind === 'edge_route_outside' ? AUTO_TOOL_OUTSIDE_FRACTION : AUTO_TOOL_INTERIOR_FRACTION
  return capAutoToolDiameter(kind, project.meta.units, span == null ? null : span * fraction)
}

/**
 * Picks the largest candidate whose diameter is within `maxDiameter`; if none
 * fit (or `maxDiameter` is unknown), picks the smallest candidate.
 */
function pickBySize<T extends { diameter: number }>(candidates: T[], maxDiameter: number | null): T | null {
  if (candidates.length === 0) {
    return null
  }
  const smallest = () => candidates.reduce((best, candidate) => (candidate.diameter < best.diameter ? candidate : best))
  if (maxDiameter == null) {
    return smallest()
  }
  const fitting = candidates.filter((candidate) => candidate.diameter <= maxDiameter + 1e-9)
  if (fitting.length > 0) {
    return fitting.reduce((best, candidate) => (candidate.diameter > best.diameter ? candidate : best))
  }
  return smallest()
}

/** Converts a bundled-library entry into a project-units tool template (no id). */
function entryToProjectTool(entry: ToolLibraryEntry, toUnits: Tool['units']): Omit<Tool, 'id'> {
  const converted = convertToolUnits({ ...entry, id: '__library__' }, toUnits)
  return {
    name: converted.name,
    units: converted.units,
    type: converted.type,
    diameter: converted.diameter,
    vBitAngle: converted.vBitAngle,
    flutes: converted.flutes,
    material: converted.material,
    defaultRpm: converted.defaultRpm,
    defaultFeed: converted.defaultFeed,
    defaultPlungeFeed: converted.defaultPlungeFeed,
    defaultStepdown: converted.defaultStepdown,
    defaultStepover: converted.defaultStepover,
    maxCutDepth: converted.maxCutDepth,
  }
}

export type ToolSelection =
  | { source: 'existing'; toolId: string }
  | { source: 'import'; tool: Omit<Tool, 'id'> }
  | null

/**
 * Chooses the tool to use for a new operation. Returns an existing project tool
 * id, a project-units tool template to import from the bundled library, or
 * `null` when no acceptable tool is available (caller keeps its own fallback).
 */
export function selectToolForOperation(
  project: Project,
  kind: OperationKind,
  target: OperationTarget,
  libraryTools: ToolLibraryEntry[],
): ToolSelection {
  const units = project.meta.units
  const maxDiameter = autoToolDiameterLimit(project, kind, target)

  for (const type of preferredToolTypes(kind)) {
    const existing = pickBySize(project.tools.filter((tool) => tool.type === type), maxDiameter)
    if (existing) {
      return { source: 'existing', toolId: existing.id }
    }

    const libraryCandidates = libraryTools
      .filter((entry) => entry.type === type)
      .map((entry) => entryToProjectTool(entry, units))
    const imported = pickBySize(libraryCandidates, maxDiameter)
    if (imported) {
      return { source: 'import', tool: imported }
    }
  }

  return null
}
