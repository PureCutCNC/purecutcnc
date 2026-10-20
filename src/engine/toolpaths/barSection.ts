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
 * The bar's real horizontal section at one Z, for clearing generators
 * (#1054 slice 3).
 *
 * A round bar is narrower near its crown, so a Top or Bottom clearing pass that
 * cuts the feature's whole XY footprint at a shallow level spends most of its
 * path in air beside the bar. The approved plan is to intersect each clearing
 * level with the section the bar actually has there, and to start the first
 * entry from the bar's surface over that region instead of from the box top.
 *
 * Everything here reads the project in the **setup frame** the generators see:
 * `projectInSetupFrame` has already turned a Bottom setup, and `unrolledProject`
 * has already removed the bar for an Around operation, so `barSeedsModel` is
 * false there by construction. A square blank's section is the full side at
 * every Z, so this module answers `null` for it: clipping to the full side is
 * the identity and the entry is already at the stock top. Block projects are
 * `null` too. Both therefore take exactly the path they took before.
 *
 * The clip is applied to the **material** region at each level, before the
 * generator insets by the cutter radius — never to the tool path. That is what
 * keeps the pocket's own walls where they are: the wall is a material boundary
 * inside the bar, untouched by a clip that only removes air outside it, while
 * the offset still lets the cutter's edge reach the bar's surface.
 */

import type { Point, Project } from '../../types/project'
import { isRoundStock } from '../../types/project'
import { barCentre, barInscribedRadius, barPivotZ, isBarStock } from '../../types/barStock'
import { barSeedsModel } from '../../store/helpers/projectType'
import { intersectClipperPaths } from './modelProtection'
import { DEFAULT_CLIPPER_SCALE } from './geometry'
import type { ClipperPath } from './types'

/** How far a region may stand outside the section before it is worth clipping. */
const SECTION_EPSILON = 1e-7

/** The bar's horizontal cross-section at one setup-frame Z. */
export interface BarSection {
  /** The axis the bar runs along; the section is a band across the other one. */
  readonly axis: 'x' | 'y'
  /** The centreline's across coordinate: Y for an X bar, X for a Y bar. */
  readonly centre: number
  /**
   * Half the section's width across the bar:
   * `sqrt(R^2 - (z - pivot)^2)` for a round bar. Zero at the crown and outside
   * the bar, where there is no material at that Z.
   */
  readonly halfWidth: number
  readonly pivotZ: number
  readonly radius: number
}

/**
 * The round bar's section at setup-frame Z, or `null` when this project has no
 * bar section to clip against — a block, a square blank (full side at every Z)
 * or an Around sheet. `halfWidth <= 0` means the level is empty.
 */
export function barSectionAtZ(project: Pick<Project, 'meta' | 'stock'>, z: number): BarSection | null {
  if (!barSeedsModel(project) || !isBarStock(project.stock) || !isRoundStock(project.stock)) return null
  if (!Number.isFinite(z)) return null
  const stock = project.stock
  const pivotZ = barPivotZ(stock)
  const radius = barInscribedRadius(stock)
  const dz = z - pivotZ
  const remaining = radius * radius - dz * dz
  return {
    axis: stock.axis,
    centre: barCentre(stock),
    halfWidth: remaining > 0 ? Math.sqrt(remaining) : 0,
    pivotZ,
    radius,
  }
}

/** The section's closed band as `[min, max]` across the bar. */
export function barSectionBand(section: BarSection): { min: number; max: number } {
  return { min: section.centre - section.halfWidth, max: section.centre + section.halfWidth }
}

function acrossOf(section: BarSection, point: { x: number; y: number }): number {
  return section.axis === 'x' ? point.y : point.x
}

/**
 * True when every vertex of every loop already sits inside the section's band.
 * A sufficient condition for "the clip changes nothing", and the reason a
 * pocket that fits inside the bar keeps its previous byte-for-byte path.
 */
export function barSectionContains(
  section: BarSection,
  loops: ReadonlyArray<ReadonlyArray<Point>>,
): boolean {
  const band = barSectionBand(section)
  for (const loop of loops) {
    for (const point of loop) {
      const across = acrossOf(section, point)
      if (across < band.min - SECTION_EPSILON || across > band.max + SECTION_EPSILON) return false
    }
  }
  return true
}

/**
 * Intersect a Clipper path set with the section's band. The along-bar extent is
 * left alone: that is the stock's length, not its shape. Returns the input
 * array itself when nothing can be clipped, so callers can keep the previous
 * geometry by identity.
 */
export function clipPathsToBarSection(section: BarSection, paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) return paths
  const band = barSectionBand(section)
  const scale = DEFAULT_CLIPPER_SCALE
  let minAlong = Infinity
  let maxAlong = -Infinity
  let minAcross = Infinity
  let maxAcross = -Infinity
  for (const path of paths) {
    for (const point of path) {
      const along = section.axis === 'x' ? point.X : point.Y
      const across = section.axis === 'x' ? point.Y : point.X
      if (along < minAlong) minAlong = along
      if (along > maxAlong) maxAlong = along
      if (across < minAcross) minAcross = across
      if (across > maxAcross) maxAcross = across
    }
  }
  if (!(minAcross <= maxAcross)) return paths
  const bandMin = band.min * scale
  const bandMax = band.max * scale
  if (minAcross >= bandMin - SECTION_EPSILON * scale && maxAcross <= bandMax + SECTION_EPSILON * scale) {
    return paths
  }
  // One project unit of padding along the bar keeps the closing edges outside
  // anything the subject touches, so the intersection is only about the band.
  const pad = scale
  const rect: ClipperPath = section.axis === 'x'
    ? [
        { X: minAlong - pad, Y: bandMin },
        { X: maxAlong + pad, Y: bandMin },
        { X: maxAlong + pad, Y: bandMax },
        { X: minAlong - pad, Y: bandMax },
      ]
    : [
        { X: bandMin, Y: minAlong - pad },
        { X: bandMax, Y: minAlong - pad },
        { X: bandMax, Y: maxAlong + pad },
        { X: bandMin, Y: maxAlong + pad },
      ]
  return intersectClipperPaths(paths, [rect])
}

/**
 * The highest point of the bar's surface over the given contours, or `null`
 * when this project has no round bar. Taking every contour's closest approach
 * to the centreline and the maximum surface over them is what makes this an
 * over-estimate of the surface above any single region: the entry may sit
 * anywhere inside the region and still start at or above the material.
 *
 * A loop whose across extent spans the centreline counts as reaching it, so a
 * region over the crown reports the crown — the honest answer there, and the
 * reason a centred pocket keeps its previous entry height.
 */
export function barSurfaceZOverContours(
  project: Pick<Project, 'meta' | 'stock'>,
  loops: ReadonlyArray<ReadonlyArray<Point>>,
): number | null {
  if (!barSeedsModel(project) || !isBarStock(project.stock) || !isRoundStock(project.stock)) return null
  const stock = project.stock
  const centre = barCentre(stock)
  const pivotZ = barPivotZ(stock)
  const radius = barInscribedRadius(stock)
  const acrossOfPoint = (point: { x: number; y: number }): number => (stock.axis === 'x' ? point.y : point.x)
  let closest = Infinity
  for (const loop of loops) {
    let minAcross = Infinity
    let maxAcross = -Infinity
    for (const point of loop) {
      const across = acrossOfPoint(point)
      if (across < minAcross) minAcross = across
      if (across > maxAcross) maxAcross = across
      const distance = Math.abs(across - centre)
      if (distance < closest) closest = distance
    }
    if (minAcross <= centre && maxAcross >= centre) closest = 0
  }
  if (!Number.isFinite(closest)) return null
  return pivotZ + Math.sqrt(Math.max(0, radius * radius - closest * closest))
}

/**
 * The Z a clearing region's first entry may start its descent from: the bar's
 * surface over the region plus the operation's clearance, never above the
 * global safe Z and never below the level being cut. `safeZ` is returned for
 * anything this module does not cover.
 */
export function barEntryStartZ(
  project: Pick<Project, 'meta' | 'stock'>,
  levelZ: number,
  loops: ReadonlyArray<ReadonlyArray<Point>>,
  clearance: number,
  safeZ: number,
): number {
  const surface = barSurfaceZOverContours(project, loops)
  if (surface === null) return safeZ
  return Math.max(levelZ, Math.min(safeZ, surface + Math.max(0, clearance)))
}
