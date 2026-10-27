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
 * Canned Thread and Flutes on the Around face (issue #1112 slice F).
 *
 * Each is **one canned feature** drawing all its lines as open outlines, the
 * way Text stores a string and draws glyphs. Creation adds no operation and
 * the dialog has no Tool field: a Follow line operation targets the feature
 * through the ordinary Add / Use current selection / right-click paths, and
 * the toolpath resolver expands the canned lines back into the same open paths
 * the old folder of lines carried (decision 3).
 *
 * The stored parameters are the dialog's numbers plus the Around frame the
 * shape was drawn against. That frame snapshot is what makes save → load →
 * regenerate exact: the geometry depends on the bar's circumference, its zero
 * line and its absolute position along the bar, and a canned generator is not
 * given the project when it runs. Start and length are measured from the
 * **chuck end**, the same as Turn/Polygon (decision 4); `alongDirection` keeps
 * that mapping explicit for a Y bar.
 *
 * Old projects are untouched: existing Thread/Flutes folders stay a folder of
 * lines plus an Engrave operation, because this module no longer creates that
 * shape and nothing migrates what is already stored.
 */

import type { StateCreator } from 'zustand'
import type {
  CannedShapeData,
  CannedShapeParams,
  Project,
  SketchFeature,
} from '../../types/project'
import { activeFace, aroundSketchAuthoringAvailable, aroundUnavailableReason } from './activeFace'
import { cannedShapeFrame } from '../../cannedShapes'
import { buildRotaryPatternLines, rotaryPatternFrame, rotarySheetPoint } from '../../engine/rotaryPatterns'
import type {
  RotaryPatternFrame,
  RotaryPatternGeometryRefusal,
} from '../../engine/rotaryPatterns'
import {
  FLUTES_CANNED_KIND,
  THREAD_CANNED_KIND,
} from '../../cannedShapes/generators/kinds'
import { normalizeFlutesCannedParams } from '../../cannedShapes/generators/flutes'
import { normalizeThreadCannedParams } from '../../cannedShapes/generators/thread'
import { uniqueName } from '../../import'
import { buildShapeFeature } from './buildShapeFeature'
import { createDefinitionForFeature } from './featureDefinitions'
import { rotaryPatternSurfaceSpan } from './rotarySurface'
import type { ProjectStore } from '../types'

export { THREAD_DEPTH_PER_PITCH, rotaryPatternFrame, buildRotaryPatternLines, rotaryHandedness, rotarySheetPoint } from '../../engine/rotaryPatterns'
export type { RotaryPatternFrame, RotarySheetLine } from '../../engine/rotaryPatterns'

// ---------------------------------------------------------------------------
// Public input / result (frozen for the dialogs)
// ---------------------------------------------------------------------------

export interface ThreadPatternInput {
  kind: 'thread'
  /** Distance from the chuck end, project units. */
  start: number
  /** Length along the bar, project units. */
  length: number
  /** Physical pitch in project units; the inch dialog converts TPI first. */
  pitch: number
  /** Number of starts; defaults to 1. Lead is `starts * pitch`. */
  starts?: number
  /** Thread hand; `left` reverses the physical helix. Omitted is right. */
  hand?: 'right' | 'left'
  /** Depth below the bar surface, project units. */
  depth: number
}

export interface FlutesPatternInput {
  kind: 'flutes'
  start: number
  length: number
  count: number
  /** Turns of twist over the requested length; positive right, `0` straight. */
  twist: number
  depth: number
}

export type RotaryPatternInput = ThreadPatternInput | FlutesPatternInput

export type RotaryPatternRefusal =
  /** Around cannot be entered: not rotary, no round bar, no rotary machine, axis mismatch. */
  | 'aroundUnavailable'
  /** Around is available but the workspace is not on it. */
  | 'aroundNotActive'
  | RotaryPatternGeometryRefusal
  /** The feature could not be handed to the store (a race or a refused write). */
  | 'creationFailed'

export interface RotaryPatternCreated {
  ok: true
  /** The one canned feature drawing every line. */
  featureId: string
}

export interface RotaryPatternRefused {
  ok: false
  reason: RotaryPatternRefusal
  /** For `aroundUnavailable`, which Around precondition failed. */
  detail?: string
}

export type RotaryPatternResult = RotaryPatternCreated | RotaryPatternRefused

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * The stored canned data for one input against `frame`, or `null` when the
 * generator would refuse it. One function builds it for creation and for an
 * edit, so the two paths can never drift.
 */
export function rotaryPatternCannedData(
  frame: RotaryPatternFrame,
  input: RotaryPatternInput,
): CannedShapeData | null {
  if (input.kind === 'thread') {
    const params = normalizeThreadCannedParams({
      start: input.start,
      length: input.length,
      pitch: input.pitch,
      starts: input.starts ?? 1,
      depth: input.depth,
      hand: input.hand ?? 'right',
      frame,
    } as unknown as CannedShapeParams)
    return params ? { kind: THREAD_CANNED_KIND, params } : null
  }
  const params = normalizeFlutesCannedParams({
    start: input.start,
    length: input.length,
    count: input.count,
    twist: input.twist,
    depth: input.depth,
    frame,
  } as unknown as CannedShapeParams)
  return params ? { kind: FLUTES_CANNED_KIND, params } : null
}

// ---------------------------------------------------------------------------
// Store action
// ---------------------------------------------------------------------------

interface RotaryPatternPlan {
  ok: true
  feature: SketchFeature
}

type RotaryPatternPlanResult = RotaryPatternPlan | RotaryPatternRefused

function planRotaryPattern(project: Project, input: RotaryPatternInput): RotaryPatternPlanResult {
  // Thread and Flutes are round-bar sheet geometry, so they stay round-bar
  // authoring even though the Around face itself is workflow-available on a
  // square blank (issue #1016 C2-U1). The refusal keeps the C1 reason strings.
  if (!aroundSketchAuthoringAvailable(project)) {
    return {
      ok: false,
      reason: 'aroundUnavailable',
      detail: aroundUnavailableReason(project) ?? 'needsRoundBar',
    }
  }
  if (activeFace(project) !== 'around') return { ok: false, reason: 'aroundNotActive' }

  const frame = rotaryPatternFrame(project)
  if (!frame) return { ok: false, reason: 'aroundUnavailable', detail: 'needsRoundBar' }

  // The pure builder is the authority on the numbers, so a refusal never
  // touches the project, the history or the selection.
  const built = buildRotaryPatternLines(frame, input)
  if (!built.ok) return built
  const canned = rotaryPatternCannedData(frame, input)
  if (!canned) return { ok: false, reason: 'creationFailed' }

  const first = built.lines[0]
  const worldProfile = {
    start: rotarySheetPoint(frame, first.alongStart, first.acrossStart),
    segments: [{
      type: 'line' as const,
      to: rotarySheetPoint(frame, first.alongEnd, first.acrossEnd),
    }],
    closed: false,
  }
  const baseName = input.kind === 'thread' ? 'Thread' : 'Flutes'
  const name = uniqueName(baseName, [
    ...project.features.map((feature) => feature.name),
    ...project.featureFolders.map((folder) => folder.name),
  ])
  const draft = buildShapeFeature(project, 'line', 'composite', worldProfile, name, input.depth)
  const frameProfile = cannedShapeFrame(canned) ?? worldProfile
  // A band wholly on one Turn measures its depth from that Turn's surface
  // (decision 10); on the plain bar this is exactly the old thickness span.
  const span = rotaryPatternSurfaceSpan(project, input, input.depth)
  const feature: SketchFeature = {
    ...draft,
    // Creation adds no operation and no tool: the row is an ordinary Line, so
    // a Follow line operation can target it like any other open feature.
    operation: 'line',
    authoringFace: 'around',
    canned,
    // Around stores Top-like heights: the bar surface is the stock thickness,
    // the centreline half of it, and a Turn's surface sits at half + radius.
    z_top: span.zTop,
    z_bottom: span.zBottom,
    sketch: { ...draft.sketch, orientationAngle: 0, profile: frameProfile },
  }
  return { ok: true, feature }
}

/**
 * The store action. One history transition creates the canned feature. A
 * refusal changes nothing: no feature and no history entry.
 */
export function createAddRotaryPatternAction(
  _set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): ProjectStore['addRotaryPattern'] {
  return (input) => {
    const state = get()
    const planned = planRotaryPattern(state.project, input)
    if (!planned.ok) return planned

    const before = new Set(state.project.features.map((feature) => feature.id))
    const { definitionId, definition } = createDefinitionForFeature(state.project, planned.feature)
    state.addFeature({
      ...planned.feature,
      definitionId,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      _clonedDefinition: definition,
    } as SketchFeature & { _clonedDefinition: typeof definition })

    const created = get().project.features.find((feature) => !before.has(feature.id))
    return created ? { ok: true, featureId: created.id } : { ok: false, reason: 'creationFailed' }
  }
}
