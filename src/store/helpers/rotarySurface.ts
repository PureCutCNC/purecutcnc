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
 * Which surface Thread/Flutes measure their depth from (issue #1112 slice H,
 * decision 10).
 *
 * A Thread or Flutes band lying wholly on **one Turn** takes that Turn's
 * diameter: the radial depth starts at the turned surface instead of the bar
 * surface, and the dialog shows it read-only. A band over the plain bar uses
 * the bar, exactly as before. An **imported model** never supplies a diameter
 * (a mesh is not known to be round), so the depth falls back to the bar surface
 * and the row says so. A band spanning two diameters or a taper is not guessed:
 * it is warned about and measured from the bar.
 *
 * The resolver is shared by the dialog and the tree, so the number shown and
 * the cut generated cannot disagree. Nothing is stored on the Thread: its
 * instance Z span is the persisted result, and an edit of the Turn moves it by
 * re-running this resolver (`syncRotaryPatternSurfaces`).
 */

import { getProfileBounds, type Project } from '../../types/project'
import type { MessageKey } from '../../i18n/locales/en'
import type { RotaryPatternFrame } from '../../engine/rotaryPatterns'
import { rotaryPatternFrame } from '../../engine/rotaryPatterns'
import { TURN_CANNED_KIND } from '../../cannedShapes/generators/kinds'
import { FLUTES_CANNED_KIND, THREAD_CANNED_KIND } from '../../cannedShapes/generators/kinds'
import { normalizeTurnCannedParams } from '../../cannedShapes/generators/turn'
import {
  turnProfileRadiusRange,
  type TurnCannedProfile,
} from '../../cannedShapes/generators/turnProfile'
import { rotarySolidAlong } from '../../cannedShapes/generators/rotarySolidParams'
import { resolveFeatureInstance } from './resolveFeatures'
import { normalizeThreadCannedParams } from '../../cannedShapes/generators/thread'
import { normalizeFlutesCannedParams } from '../../cannedShapes/generators/flutes'

/** Numeric slack for the band and diameter comparisons. */
const TOLERANCE = 1e-6

export type RotaryPatternSurfaceKind = 'bar' | 'turn' | 'model' | 'twoDiameters' | 'taper'

export interface RotaryPatternSurface {
  kind: RotaryPatternSurfaceKind
  /** The diameter the depth is measured from: the bar's for every non-Turn kind. */
  diameter: number
  /** The one Turn the band lies wholly on (`kind === 'turn'`). */
  turnFeatureId?: string
  turnName?: string
  /** The model rows the band crosses (`kind === 'model'`). */
  modelNames?: string[]
}

/** The numbers a surface is resolved from: the pattern's band, from the chuck end. */
export interface RotaryPatternBand {
  start: number
  length: number
}

function bandAlong(frame: RotaryPatternFrame, band: RotaryPatternBand): { min: number; max: number } | null {
  if (!Number.isFinite(band.start) || !Number.isFinite(band.length) || band.length <= 0) return null
  const first = frame.alongOrigin + frame.alongDirection * band.start
  const second = first + frame.alongDirection * band.length
  return { min: Math.min(first, second), max: Math.max(first, second) }
}

function overlap(
  first: { min: number; max: number },
  second: { min: number; max: number },
): { min: number; max: number } | null {
  const min = Math.max(first.min, second.min)
  const max = Math.min(first.max, second.max)
  return max - min > TOLERANCE ? { min, max } : null
}

interface TurnBand {
  id: string
  name: string
  alongMin: number
  alongMax: number
  /** Constant radius of a plain-diameter Turn. */
  diameterRadius: number
  /** A profile Turn's copied outlines; the band's range is read per overlap. */
  profile?: TurnCannedProfile
}

function turnBands(project: Project): TurnBand[] {
  const bands: TurnBand[] = []
  for (const feature of project.features) {
    const definition = project.featureDefinitions[feature.definitionId]
    if (definition?.canned?.kind !== TURN_CANNED_KIND) continue
    const params = normalizeTurnCannedParams(definition.canned.params)
    if (!params) continue
    const { alongStart, alongEnd } = rotarySolidAlong(params.frame, params.start, params.length)
    bands.push({
      id: feature.id,
      name: feature.name,
      alongMin: alongStart,
      alongMax: alongEnd,
      diameterRadius: params.diameter / 2,
      ...(params.profile ? { profile: params.profile } : {}),
    })
  }
  return bands
}

interface TurnOverlap extends TurnBand {
  overlapMin: number
  overlapMax: number
  radiusMin: number
  radiusMax: number
  step: boolean
}

function turnOverlaps(project: Project, range: { min: number; max: number }): TurnOverlap[] {
  const overlaps: TurnOverlap[] = []
  for (const turn of turnBands(project)) {
    const overlapRange = overlap(range, { min: turn.alongMin, max: turn.alongMax })
    if (!overlapRange) continue
    // The surface over the *pattern's* band matters, not the whole Turn: a
    // pattern on the constant section of a stepped profile is on one diameter.
    if (turn.profile) {
      const sampled = turnProfileRadiusRange(turn.profile, overlapRange.min, overlapRange.max)
      if (!sampled) continue
      overlaps.push({
        ...turn,
        overlapMin: overlapRange.min,
        overlapMax: overlapRange.max,
        radiusMin: sampled.min,
        radiusMax: sampled.max,
        step: sampled.step,
      })
    } else {
      overlaps.push({
        ...turn,
        overlapMin: overlapRange.min,
        overlapMax: overlapRange.max,
        radiusMin: turn.diameterRadius,
        radiusMax: turn.diameterRadius,
        step: false,
      })
    }
  }
  return overlaps
}

interface ModelBand {
  name: string
  alongMin: number
  alongMax: number
}

function modelBands(project: Project, axis: 'x' | 'y'): ModelBand[] {
  const bands: ModelBand[] = []
  for (const feature of project.features) {
    const definition = project.featureDefinitions[feature.definitionId]
    if (!definition) continue
    // The Turn is a model too, and it supplies the diameter rather than
    // warning; every other model is a shape we do not read a radius from.
    if (definition.canned?.kind === TURN_CANNED_KIND) continue
    if (definition.kind !== 'stl' || definition.operation !== 'model') continue
    const resolved = resolveFeatureInstance(project, feature.id)
    if (!resolved) continue
    // Models are authored on Top regardless of the face they belong to, and
    // their placement frame is the silhouette box in the project plane.
    const bounds = getProfileBounds(resolved.sketch.profile)
    bands.push({
      name: feature.name,
      alongMin: axis === 'x' ? bounds.minX : bounds.minY,
      alongMax: axis === 'x' ? bounds.maxX : bounds.maxY,
    })
  }
  return bands
}

/**
 * The surface a Thread/Flutes depth is measured from. `bar` means the plain
 * bar (as before this decision); `turn` names the one Turn; `model`,
 * `twoDiameters` and `taper` are the warned cases and all measure from the bar.
 */
export function rotaryPatternSurface(
  project: Project,
  band: RotaryPatternBand,
): RotaryPatternSurface {
  const barDiameter = project.stock.thickness
  const frame = rotaryPatternFrame(project)
  const range = frame ? bandAlong(frame, band) : null
  if (!frame || !range) return { kind: 'bar', diameter: barDiameter }

  const models = modelBands(project, frame.axis)
    .map((model) => ({ ...model, overlap: overlap(range, { min: model.alongMin, max: model.alongMax }) }))
    .filter((model) => model.overlap !== null)
  if (models.length > 0) {
    return {
      kind: 'model',
      diameter: barDiameter,
      modelNames: models.map((model) => model.name),
    }
  }

  const turns = turnOverlaps(project, range)
  if (turns.length === 0) return { kind: 'bar', diameter: barDiameter }
  if (turns.length > 1) return { kind: 'twoDiameters', diameter: barDiameter }

  const turn = turns[0]
  if (!turn) return { kind: 'bar', diameter: barDiameter }
  const coversWhole = turn.alongMin <= range.min + TOLERANCE && turn.alongMax >= range.max - TOLERANCE
  const constant = turn.radiusMax - turn.radiusMin <= TOLERANCE
  if (!coversWhole) {
    // Part of the band is still plain bar. The same diameter on both is not a
    // guess; a different one is.
    const sameAsBar = constant && Math.abs(turn.radiusMax - barDiameter / 2) <= TOLERANCE
    return sameAsBar
      ? { kind: 'bar', diameter: barDiameter }
      : { kind: 'twoDiameters', diameter: barDiameter }
  }
  if (!constant) {
    return {
      kind: turn.step ? 'twoDiameters' : 'taper',
      diameter: barDiameter,
    }
  }
  return {
    kind: 'turn',
    diameter: turn.radiusMax * 2,
    turnFeatureId: turn.id,
    turnName: turn.name,
  }
}

/** The instance Z span a Thread/Flutes depth gets on this surface. */
export function rotaryPatternSurfaceSpan(
  project: Project,
  band: RotaryPatternBand,
  depth: number,
): { surface: RotaryPatternSurface; zTop: number; zBottom: number } {
  const surface = rotaryPatternSurface(project, band)
  const barRadius = project.stock.thickness / 2
  // Around features store Top-like heights: the bar surface is the stock
  // thickness, so a surface at radius r is at barRadius + r.
  const zTop = barRadius + surface.diameter / 2
  return { surface, zTop, zBottom: zTop - depth }
}

/** The warning a Thread/Flutes row and dialog show, or null on a plain bar/Turn. */
export interface RotaryPatternSurfaceWarning {
  key: MessageKey
  values?: Record<string, string | number>
}

export function rotaryPatternSurfaceWarning(
  surface: RotaryPatternSurface,
): RotaryPatternSurfaceWarning | null {
  switch (surface.kind) {
    case 'model':
      return {
        key: 'dialogs.rotary.surface.model',
        values: { model: surface.modelNames?.join(', ') ?? '' },
      }
    case 'twoDiameters':
      return { key: 'dialogs.rotary.surface.twoDiameters' }
    case 'taper':
      return { key: 'dialogs.rotary.surface.taper' }
    case 'bar':
    case 'turn':
      return null
  }
}

function patternParams(project: Project, featureId: string): { start: number; length: number; depth: number } | null {
  const feature = project.features.find((row) => row.id === featureId)
  if (!feature) return null
  const definition = project.featureDefinitions[feature.definitionId]
  if (!definition?.canned) return null
  if (definition.canned.kind === THREAD_CANNED_KIND) {
    const params = normalizeThreadCannedParams(definition.canned.params)
    return params ? { start: params.start, length: params.length, depth: params.depth } : null
  }
  if (definition.canned.kind === FLUTES_CANNED_KIND) {
    const params = normalizeFlutesCannedParams(definition.canned.params)
    return params ? { start: params.start, length: params.length, depth: params.depth } : null
  }
  return null
}

/**
 * The warning for every Thread/Flutes row that is not simply on the bar or on
 * one Turn. The tree translates the key; the helper only decides which rows
 * warn, so a row and the dialog cannot disagree.
 */
export function rotaryPatternSurfaceWarnings(
  project: Project,
  featureIds?: readonly string[],
): Map<string, RotaryPatternSurfaceWarning> {
  const warnings = new Map<string, RotaryPatternSurfaceWarning>()
  const ids = featureIds ?? project.features.map((feature) => feature.id)
  for (const id of ids) {
    const params = patternParams(project, id)
    if (!params) continue
    const surface = rotaryPatternSurface(project, params)
    const warning = rotaryPatternSurfaceWarning(surface)
    if (warning) warnings.set(id, warning)
  }
  return warnings
}

/**
 * After a Turn's parameters change, move every Thread/Flutes that follows it
 * onto the new surface. The band and the number come from the same resolver
 * the dialog uses; an unchanged span is left byte-identical (no history churn).
 */
export function syncRotaryPatternSurfaces(
  project: Project,
  features: Project['features'],
  featureDefinitions: Project['featureDefinitions'],
): Project['features'] {
  let changed = false
  const next = features.map((feature) => {
    const definition = featureDefinitions[feature.definitionId]
    if (definition?.canned?.kind !== THREAD_CANNED_KIND
      && definition?.canned?.kind !== FLUTES_CANNED_KIND) {
      return feature
    }
    const params = patternParams(
      { ...project, features, featureDefinitions },
      feature.id,
    )
    if (!params) return feature
    const span = rotaryPatternSurfaceSpan(
      { ...project, features, featureDefinitions },
      params,
      params.depth,
    )
    const zTop = typeof feature.z_top === 'number' ? feature.z_top : 0
    const zBottom = typeof feature.z_bottom === 'number' ? feature.z_bottom : 0
    if (Math.abs(zTop - span.zTop) <= TOLERANCE && Math.abs(zBottom - span.zBottom) <= TOLERANCE) {
      return feature
    }
    changed = true
    return { ...feature, z_top: span.zTop, z_bottom: span.zBottom }
  })
  return changed ? next : features
}
