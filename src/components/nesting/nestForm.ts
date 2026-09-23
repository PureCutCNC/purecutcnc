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
  nestGapForPart,
  resolveNestPart,
  type NestPartResolution,
} from '../../store/helpers/nestPart'
import type { NestRecord, NestSettings, Project } from '../../types/project'

export type NestRotationPreset = 'quarter' | 'grain' | 'none'

export const NEST_ROTATIONS: Record<NestRotationPreset, number[]> = {
  quarter: [0, 90, 180, 270],
  grain: [0, 180],
  none: [0],
}

export function presetForRotations(rotations: number[]): NestRotationPreset {
  const key = [...rotations].sort((a, b) => a - b).join()
  if (key === NEST_ROTATIONS.grain.join()) return 'grain'
  if (key === NEST_ROTATIONS.none.join()) return 'none'
  return 'quarter'
}

export interface NestSubject {
  /** The project the nest is computed on: with the nest being replaced already discarded. */
  base: Project
  /** The existing nest this selection belongs to; Nest replaces it, Discard removes it. */
  replaceNest: NestRecord | null
  part: NestPartResolution
  /** The tool's clearance, the smallest gap allowed; null when no edge route cuts the part. */
  gapFloor: number | null
}

export function nestSubject(project: Project, selectedIds: string[]): NestSubject {
  const replaceNest = findNestForSelection(project, selectedIds)
  const base = replaceNest ? discardNestFromProject(project, replaceNest.id) ?? project : project
  const part = resolveNestPart(base, replaceNest ? replaceNest.sourceIds : selectedIds)
  return {
    base,
    replaceNest,
    part,
    gapFloor: part.ok ? nestGapForPart(base, part.featureIds) : null,
  }
}

export interface NestForm {
  /** Parts on the sheet, originals included. */
  quantity: number
  rotation: NestRotationPreset
  gap: number | null
  keepOriginals: boolean
}

export const DEFAULT_NEST_QUANTITY = 10

export function initialNestForm(subject: NestSubject): NestForm {
  const previous = subject.replaceNest?.settings
  if (previous) {
    return {
      quantity: previous.quantity,
      rotation: presetForRotations(previous.rotations),
      gap: Math.max(previous.minimumGap, subject.gapFloor ?? 0),
      keepOriginals: previous.keepOriginals,
    }
  }
  return { quantity: DEFAULT_NEST_QUANTITY, rotation: 'quarter', gap: subject.gapFloor, keepOriginals: false }
}

export type NestFormError = 'quantity' | 'gap-missing' | 'gap-below-tool'

export function validateNestForm(form: NestForm, gapFloor: number | null): NestFormError | null {
  if (!Number.isInteger(form.quantity) || form.quantity < 1 || (form.keepOriginals && form.quantity < 2)) {
    return 'quantity'
  }
  if (form.gap === null || !Number.isFinite(form.gap) || form.gap <= 0) return 'gap-missing'
  // The floor is a machining fact — the cutter cannot pass through less — so it can be raised, never lowered.
  if (gapFloor !== null && form.gap < gapFloor - 1e-9) return 'gap-below-tool'
  return null
}

export function nestSettingsFromForm(form: NestForm): NestSettings {
  return {
    quantity: form.quantity,
    rotations: [...NEST_ROTATIONS[form.rotation]],
    minimumGap: form.gap ?? 0,
    keepOriginals: form.keepOriginals,
  }
}
