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
// Pure state for the Nest panel (issue #848): what is being nested, on which
// project, and whether the form can run. No React here, so it is unit-tested.

import { discardNestFromProject } from '../../store/helpers/nestApply'
import {
  findNestForSelection,
  nestEdgeClearance,
  nestGapForPart,
  nestSheetRing,
  resolveNestParts,
  type NestPartSpec,
  type NestPartsResolution,
} from '../../store/helpers/nestPart'
import type { NestMargins, NestRecord, NestSettings, Project } from '../../types/project'

/**
 * Finer rotation steps offered after the presets (#867). Each divides 360, and
 * each costs search time: every angle is tried for every copy, and every
 * relative angle between two parts needs its own no-fit polygon.
 */
export const NEST_ROTATION_STEPS = [45, 30, 15] as const

export type NestRotationStep = typeof NEST_ROTATION_STEPS[number]
export type NestRotationPreset = 'quarter' | 'grain' | 'none' | `step${NestRotationStep}`

/** The angles 0, step, 2·step, … below a full turn. */
export function rotationsForStep(step: number): number[] {
  return Array.from({ length: Math.round(360 / step) }, (_, index) => index * step)
}

/** Every rotation choice, in the order the panel lists them. */
export const NEST_ROTATIONS: Record<NestRotationPreset, number[]> = {
  quarter: rotationsForStep(90),
  grain: [0, 180],
  none: [0],
  step45: rotationsForStep(45),
  step30: rotationsForStep(30),
  step15: rotationsForStep(15),
}

export function presetForRotations(rotations: number[]): NestRotationPreset {
  const key = [...rotations].sort((a, b) => a - b).join()
  const presets = Object.keys(NEST_ROTATIONS) as NestRotationPreset[]
  return presets.find((preset) => NEST_ROTATIONS[preset].join() === key) ?? 'quarter'
}

/** The step a preset rotates by, or null for the fixed presets. */
export function stepOfPreset(preset: NestRotationPreset): NestRotationStep | null {
  return NEST_ROTATION_STEPS.find((step) => preset === `step${step}`) ?? null
}

export interface NestSubject {
  /** The project the nest is computed on: with the nest being replaced already discarded. */
  base: Project
  /** The existing nest this selection belongs to; Nest replaces it, Discard removes it. */
  replaceNest: NestRecord | null
  parts: NestPartsResolution
  /** The tools' clearance, the smallest gap allowed; null when no edge route cuts any part. */
  gapFloor: number | null
  /** How far the cut reaches outside a part, kept on top of a margin; null when no edge route cuts any part. */
  edgeClearance: number | null
}

export function nestSubject(project: Project, selectedIds: string[]): NestSubject {
  const replaceNest = findNestForSelection(project, selectedIds)
  const base = replaceNest ? discardNestFromProject(project, replaceNest.id) ?? project : project
  const parts = resolveNestParts(base, replaceNest ? replaceNest.parts.flatMap((part) => part.sourceIds) : selectedIds)
  return {
    base,
    replaceNest,
    parts,
    gapFloor: parts.ok ? nestGapForPart(base, parts.parts.flatMap((part) => part.featureIds)) : null,
    edgeClearance: parts.ok ? nestEdgeClearance(base, parts.parts.flatMap((part) => part.featureIds)) : null,
  }
}

export function subjectParts(subject: NestSubject): NestPartSpec[] {
  return subject.parts.ok ? subject.parts.parts : []
}

export interface NestForm {
  /** Per part, parts on the sheet — originals included. */
  quantities: number[]
  rotation: NestRotationPreset
  gap: number | null
  keepOriginals: boolean
  /** Uncut stock per stock edge; a side left empty is NaN until the user fills it. */
  margins: NestMargins
}

export const NO_MARGINS: NestMargins = { top: 0, bottom: 0, left: 0, right: 0 }

export const MARGIN_SIDES = ['top', 'bottom', 'left', 'right'] as const satisfies readonly (keyof NestMargins)[]

/** One part defaults to a sheet's worth; several default to one each, which arranges them. */
export const DEFAULT_NEST_QUANTITY = 10

export function initialNestForm(subject: NestSubject): NestForm {
  const parts = subjectParts(subject)
  const previous = subject.replaceNest
  const quantities = parts.map((part) => {
    const recorded = previous?.parts.find((entry) => entry.sourceIds.some((id) => part.featureIds.includes(id)))
    return recorded?.quantity ?? (parts.length === 1 ? DEFAULT_NEST_QUANTITY : 1)
  })
  if (previous) {
    return {
      quantities,
      rotation: presetForRotations(previous.settings.rotations),
      gap: Math.max(previous.settings.minimumGap, subject.gapFloor ?? 0),
      keepOriginals: previous.settings.keepOriginals,
      margins: { ...(previous.settings.margins ?? NO_MARGINS) },
    }
  }
  return { quantities, rotation: 'quarter', gap: subject.gapFloor, keepOriginals: false, margins: { ...NO_MARGINS } }
}

export type NestFormError = 'quantity' | 'gap-missing' | 'gap-below-tool' | 'margin-invalid' | 'margins-no-room'

/**
 * Checks the form. `roomForMargins` is the caller's answer from
 * {@link marginsLeaveRoom}, which needs the stock.
 */
export function validateNestForm(form: NestForm, gapFloor: number | null, roomForMargins = true): NestFormError | null {
  if (form.quantities.length === 0 || form.quantities.some((quantity) => !Number.isInteger(quantity) || quantity < 1)) {
    return 'quantity'
  }
  // Keeping every original with nothing to copy would be an empty nest.
  if (form.keepOriginals && form.quantities.every((quantity) => quantity < 2)) return 'quantity'
  if (form.gap === null || !Number.isFinite(form.gap) || form.gap <= 0) return 'gap-missing'
  // The floor is a machining fact — the cutter cannot pass through less — so it can be raised, never lowered.
  if (gapFloor !== null && form.gap < gapFloor - 1e-9) return 'gap-below-tool'
  if (MARGIN_SIDES.some((side) => !Number.isFinite(form.margins[side]) || form.margins[side] < 0)) return 'margin-invalid'
  if (!roomForMargins) return 'margins-no-room'
  return null
}

/** Whether the stock keeps any room once `margins`, and the cut's reach past each part, are taken off (#881). */
export function marginsLeaveRoom(subject: NestSubject, margins: NestMargins): boolean {
  if (MARGIN_SIDES.some((side) => !Number.isFinite(margins[side]) || margins[side] < 0)) return true
  return nestSheetRing(subject.base, margins, subject.edgeClearance ?? 0) !== null
}

export function nestSettingsFromForm(form: NestForm): NestSettings {
  return {
    rotations: [...NEST_ROTATIONS[form.rotation]],
    minimumGap: form.gap ?? 0,
    keepOriginals: form.keepOriginals,
    // No margins are stored as none, so a nest without them is saved as before.
    ...(MARGIN_SIDES.some((side) => form.margins[side] > 0) ? { margins: { ...form.margins } } : {}),
  }
}

export interface EditWatch {
  /** Take the current state as the search's own, after it applied a layout. */
  accept(): void
  /** Whether the user changed the project since the last `accept`. */
  edited(): boolean
}

/**
 * Tells the keep-improving search whether the project was edited under it
 * (#864). It watches undo history, not the project: UI state such as a tree
 * folder revealed for the new selection is written into the project too, but
 * only real edits, undo, redo and started drags replace `history`.
 */
export function watchForEdits(getHistory: () => object): EditWatch {
  let expected = getHistory()
  return {
    accept: () => { expected = getHistory() },
    edited: () => getHistory() !== expected,
  }
}
