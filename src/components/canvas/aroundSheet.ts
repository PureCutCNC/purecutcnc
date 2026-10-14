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
 * The unrolled sheet the Around view shows (issue #395 slice D2).
 *
 * One rule for where the sheet comes from: the Sketch canvas frames the bar's
 * surface unrolled flat, not the bar's own rectangle. `aroundSheet` answers
 * everything that needs to know it — the sheet rectangle, the turn lines for a
 * visible range, the clamp bands and the origin marker — and is null unless the
 * active face is Around on a round bar, so every flat-face path is untouched.
 *
 * The frame's own numbers live in `engine/aroundFrame.ts`; this module only
 * puts them in canvas terms.
 */

import { aroundFrame } from '../../engine/aroundFrame'
import type { AroundFrame } from '../../engine/aroundFrame'
import { isImportedModel } from '../../engine/setupTargets'
import { activeFace } from '../../store/helpers/activeFace'
import { resolveSketch } from '../../store/helpers/resolveFeatures'
import { getProfileBounds, getStockBounds, isAroundSetup, isRoundStock, rectProfile } from '../../types/project'
import type { Bounds2D, Clamp, ClampType, MachiningSetup, Operation, Point, Project, SetupFace, Stock } from '../../types/project'

/** The project fields the sheet is read from. */
export type AroundSheetProject = Pick<
  Project,
  'stock' | 'setups' | 'activeSetupId' | 'clamps' | 'origin' | 'features' | 'featureDefinitions'
>

/** One line across the sheet at a full turn. */
export interface AroundTurnLine {
  /** The across coordinate the line sits at: `sheetStart + k · circumference`. */
  readonly across: number
  /** `k = 0` is the start line — the top of the bar with the rotary at zero. */
  readonly solid: boolean
}

/** The clamp types a bar is actually held by; everything else is not drawn. */
const BAND_CLAMP_TYPES: ReadonlySet<ClampType> = new Set<ClampType>(['chuck', 'tailstock'])

/**
 * More turn lines than this means the view is zoomed so far out that the lines
 * cannot be told apart (or panned an absurd distance): drawing them would only
 * cost time. The sheet's own edges still read.
 */
const MAX_TURN_LINES = 2000

/**
 * An imported model as the Around sheet shows it (issue #1015 slice K): the
 * model lives inside the bar, so the sheet cannot draw its geometry — a band
 * at the model's extent along the bar is what tells the user where it is.
 */
export interface AroundModelBand {
  readonly featureId: string
  readonly name: string
  /** The model's extent along the bar, clipped to the sheet's own extent. */
  readonly along: { readonly min: number; readonly max: number }
}

export interface AroundSheet {
  readonly axis: 'x' | 'y'
  /** Across coordinate of the sheet's zero line: the top of the bar at a = 0. */
  readonly sheetStart: number
  readonly circumference: number
  readonly radius: number
  readonly centre: number
  /** The sheet as the view frames it: bar extent along × one circumference across. */
  readonly rect: Bounds2D
  /** The bar's extent along its own axis: the sheet's extents on that axis. */
  readonly along: { readonly min: number; readonly max: number }
  /** A line at every full turn in the requested across range, beyond the sheet too. */
  readonly turnLines: readonly AroundTurnLine[]
  /** Chuck and tailstock as bands: the extent along the bar, the whole sheet across. */
  readonly clampBands: readonly Clamp[]
  /** The visible imported models as bands: the extent along the bar, the whole sheet across. */
  readonly modelBands: readonly AroundModelBand[]
  /** The origin marker: the origin's along coordinate on the start line. */
  readonly origin: Point & { readonly name: string }
}

/**
 * The sheet the active face shows, or null on Top, on Bottom and on a block
 * stock. `view` is the across range to place turn lines in; without it the
 * sheet's own two edges are the only turns reported.
 */
export function aroundSheet(
  project: AroundSheetProject,
  view?: { acrossMin: number; acrossMax: number },
): AroundSheet | null {
  if (activeFace(project) !== 'around') return null
  if (!isRoundStock(project.stock)) return null
  const frame = aroundFrame(project.stock)
  const bounds = getStockBounds(project.stock)
  const rect: Bounds2D = frame.axis === 'x'
    ? { minX: bounds.minX, maxX: bounds.maxX, minY: frame.sheetStart, maxY: frame.sheetStart + frame.circumference }
    : { minX: frame.sheetStart, maxX: frame.sheetStart + frame.circumference, minY: bounds.minY, maxY: bounds.maxY }
  const along = frame.axis === 'x'
    ? { min: bounds.minX, max: bounds.maxX }
    : { min: bounds.minY, max: bounds.maxY }
  const range = view ?? { acrossMin: frame.sheetStart, acrossMax: frame.sheetStart + frame.circumference }
  return {
    axis: frame.axis,
    sheetStart: frame.sheetStart,
    circumference: frame.circumference,
    radius: frame.radius,
    centre: frame.centre,
    rect,
    along,
    turnLines: aroundTurnLines(frame, range.acrossMin, range.acrossMax),
    clampBands: project.clamps.filter((clamp) => BAND_CLAMP_TYPES.has(clamp.type)).map((clamp) => aroundClampBand(clamp, frame, range)),
    modelBands: aroundModelBands(project, frame.axis, along),
    origin: { ...aroundOrigin(project.origin, frame), name: project.origin.name },
  }
}

/**
 * The visible imported models as bands along the bar (issue #1015 slice K). The
 * model's footprint is its silhouette profile — the mesh itself is never loaded
 * — placed by its instance transform; `along` is clipped to the sheet, so a
 * model running past the bar still reads.
 */
export function aroundModelBands(
  project: Pick<Project, 'features' | 'featureDefinitions'>,
  axis: 'x' | 'y',
  sheetAlong: { readonly min: number; readonly max: number },
): AroundModelBand[] {
  const bands: AroundModelBand[] = []
  for (const feature of project.features) {
    if (!feature.visible || !isImportedModel(project, feature)) continue
    const definition = project.featureDefinitions[feature.definitionId]
    if (!definition) continue
    const bounds = getProfileBounds(resolveSketch(definition, feature.transform).profile)
    const min = axis === 'x' ? bounds.minX : bounds.minY
    const max = axis === 'x' ? bounds.maxX : bounds.maxY
    bands.push({
      featureId: feature.id,
      name: feature.name,
      along: { min: Math.max(min, sheetAlong.min), max: Math.min(max, sheetAlong.max) },
    })
  }
  return bands
}

/**
 * The sheet a view between two world corners shows, with the turn lines for
 * that across range (issue #395). The canvas uses this rather than
 * `aroundSheet`: the range is the viewport, so every full turn on screen is a
 * line, and turns past the sheet come with it.
 */
export function aroundSheetForView(
  project: AroundSheetProject,
  worldA: Point,
  worldB: Point,
): AroundSheet | null {
  if (!isRoundStock(project.stock)) return null
  const range = project.stock.axis === 'x'
    ? { acrossMin: Math.min(worldA.y, worldB.y), acrossMax: Math.max(worldA.y, worldB.y) }
    : { acrossMin: Math.min(worldA.x, worldB.x), acrossMax: Math.max(worldA.x, worldB.x) }
  return aroundSheet(project, range)
}

/**
 * The sheet an Around operation is cut on, or null for a flat operation — the
 * setup booklet draws that operation's own frame rather than the workspace's.
 */
export function aroundSheetForOperation(
  project: Project,
  operation: Pick<Operation, 'id' | 'setupId'>,
): AroundSheet | null {
  const setup = setupOfOperation(project, operation)
  if (!setup || !isAroundSetup(setup) || !isRoundStock(project.stock)) return null
  return aroundSheet({ ...project, activeSetupId: setup.id }, undefined)
}

/**
 * The operation's setup. An operation naming no setup belongs to the project's
 * first setup (Top), as the export and the CAM panel have it; one naming a
 * missing setup answers null here rather than throwing.
 */
function setupOfOperation(
  project: Pick<Project, 'setups'>,
  operation: Pick<Operation, 'id' | 'setupId'>,
): MachiningSetup | null {
  if (operation.setupId === undefined) return project.setups[0] ?? null
  return project.setups.find((setup) => setup.id === operation.setupId) ?? null
}

/**
 * A line across the sheet at every full turn in `[acrossMin, acrossMax]`,
 * including turns past the sheet. `k = 0` is the start line.
 */
export function aroundTurnLines(
  frame: Pick<AroundFrame, 'sheetStart' | 'circumference'>,
  acrossMin: number,
  acrossMax: number,
): AroundTurnLine[] {
  const { sheetStart, circumference } = frame
  if (!(circumference > 0) || !Number.isFinite(acrossMin) || !Number.isFinite(acrossMax)) return []
  const min = Math.min(acrossMin, acrossMax)
  const max = Math.max(acrossMin, acrossMax)
  // The epsilon keeps a range endpoint that sits exactly on a turn (the sheet's
  // own edges) from losing that turn to rounding.
  const first = Math.ceil((min - sheetStart) / circumference - 1e-9)
  const last = Math.floor((max - sheetStart) / circumference + 1e-9)
  if (last < first || last - first + 1 > MAX_TURN_LINES) return []
  const lines: AroundTurnLine[] = []
  for (let k = first; k <= last; k += 1) {
    lines.push({ across: sheetStart + k * circumference, solid: k === 0 })
  }
  return lines
}

/**
 * A clamp as the sheet holds it: its extent along the bar, the whole requested
 * across range. A chuck or tailstock holds every turn of the bar, so the band
 * is drawn — and snapped — across the whole visible range like the turn lines;
 * without one, it is the sheet's own single circumference.
 */
export function aroundClampBand(
  clamp: Clamp,
  frame: Pick<AroundFrame, 'axis' | 'sheetStart' | 'circumference'>,
  range?: { readonly acrossMin: number; readonly acrossMax: number },
): Clamp {
  const start = range ? Math.min(range.acrossMin, range.acrossMax) : frame.sheetStart
  const end = range ? Math.max(range.acrossMin, range.acrossMax) : frame.sheetStart + frame.circumference
  return frame.axis === 'x'
    ? { ...clamp, y: start, h: end - start }
    : { ...clamp, x: start, w: end - start }
}

/** The origin marker on the sheet: its along coordinate, on the start line. */
export function aroundOrigin(origin: Point, frame: Pick<AroundFrame, 'axis' | 'sheetStart'>): Point {
  return frame.axis === 'x'
    ? { x: origin.x, y: frame.sheetStart }
    : { x: frame.sheetStart, y: origin.y }
}

/**
 * The sheet as a block stock, so the ordinary outline, grid and fit code draws
 * and frames it with no Around branch of its own. `thickness` is the radius,
 * the unrolled height (`engine/aroundFrame.ts`).
 */
export function aroundSheetStock(stock: Stock, sheet: AroundSheet): Stock {
  return {
    profile: rectProfile(sheet.rect.minX, sheet.rect.minY, sheet.rect.maxX - sheet.rect.minX, sheet.rect.maxY - sheet.rect.minY),
    thickness: sheet.radius,
    material: stock.material,
    color: stock.color,
    visible: stock.visible,
    origin: { ...stock.origin },
  }
}

/** The face a feature is authored on; a feature naming none is on Top. */
export function authoredOnFace(feature: { authoringFace?: SetupFace }, face: SetupFace): boolean {
  return (feature.authoringFace ?? 'top') === face
}
