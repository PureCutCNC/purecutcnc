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

import type { MachiningSetup, Project, RegistrationReference, RegistrationTarget, SetupFace } from '../../types/project'
import { convertLength, type Units } from '../../utils/units'

/**
 * The values the setup properties dialog writes on a face (issue #1112 F4).
 *
 * Save is enabled by a real difference, so the dialog compares the saved setup
 * and its draft through this one shape. Registration points are compared as the
 * numbers the store holds, in the project's own units (`meta.units`), never as
 * the text the inputs show — a display-unit or rounding difference alone can
 * never look like an edit.
 */
export interface SetupFormValues {
  name: string
  notes: string
  /** Absent for an Around setup, which stores neither of these fields. */
  flipAxis?: MachiningSetup['orientation']['axis']
  registration?: RegistrationReference[]
}

/** The shape a saved setup and a draft both pass through. */
type SetupFormSource = Pick<MachiningSetup, 'name' | 'notes' | 'orientation' | 'registration'>

/**
 * The face's writable values, normalised the way Save stores them: it covers
 * exactly the fields Save writes, so a stray flip axis or registration in an
 * Around dialog's state cannot enable Save (an Around setup is not a flip and
 * stores only its name and notes, issue #395), and the name is trimmed because
 * `updateSetup` trims it, so a trailing space changes nothing.
 */
export function setupFormValues(source: SetupFormSource, face: SetupFace): SetupFormValues {
  const values: SetupFormValues = { name: source.name.trim(), notes: source.notes }
  if (face === 'around') return values
  return {
    ...values,
    flipAxis: source.orientation.axis,
    registration: source.registration,
  }
}

/** Every coordinate pair a registration target stores, in a stable order. */
function targetCoordinates(target: RegistrationTarget): [number, number][] {
  if (target.type === 'point') return [[target.point.x, target.point.y]]
  if (target.type === 'edge') return [[target.start.x, target.start.y], [target.end.x, target.end.y]]
  // A feature reference names a feature and stores no length of its own.
  return []
}

/**
 * The same references with every stored length converted, the way the store
 * rewrites them when a project's units are **converted** — used to move a
 * pending edit with the project instead of discarding it (#1112 r4-4). It uses
 * `convertLength`, the store's own arithmetic, so a pending point and the saved
 * copy of the same point end up as the same numbers. Feature references carry
 * no length and are left alone; ids, kinds and order are preserved so a
 * converted draft still compares with the saved list.
 */
export function convertRegistration(
  references: RegistrationReference[],
  from: Units,
  to: Units,
): RegistrationReference[] {
  if (from === to) return references
  const convertPoint = (point: { x: number; y: number }): { x: number; y: number } => ({
    x: convertLength(point.x, from, to),
    y: convertLength(point.y, from, to),
  })
  return references.map((reference) => {
    const { target } = reference
    if (target.type === 'point') return { ...reference, target: { ...target, point: convertPoint(target.point) } }
    if (target.type === 'edge') {
      return { ...reference, target: { ...target, start: convertPoint(target.start), end: convertPoint(target.end) } }
    }
    return reference
  })
}

/**
 * The lengths a unit conversion rewrites, in a stable order, so two project
 * snapshots can be compared slot by slot. The stock and the project's own
 * settings come first because they exist in every project: a setup's
 * registration can be empty, and a switching dialog still has to tell a
 * conversion from a reinterpret when it is.
 */
function projectLengths(project: Project): number[] {
  const lengths = [
    project.stock.thickness,
    project.meta.maxTravelZ,
    project.meta.operationClearanceZ,
    project.meta.clampClearanceXY,
    project.meta.clampClearanceZ,
    project.grid.extent,
    project.grid.majorSpacing,
    project.grid.minorSpacing,
    project.grid.snapIncrement,
  ]
  for (const setup of project.setups) {
    for (const reference of setup.registration) {
      for (const [x, y] of targetCoordinates(reference.target)) lengths.push(x, y)
    }
  }
  return lengths
}

/**
 * The scale a unit switch applied to the project's stored lengths (#1112
 * r4-4): `convert` rescales them all, `reinterpret` keeps every number. Reading
 * it from the two store snapshots means a dialog open across the switch needs no
 * idea which mode ran, and cannot mistake a pending edit of its own for one.
 * When no stored length is non-zero (nothing a conversion could move) it reports
 * 1, "nothing changed", rather than an invented ratio.
 */
export function unitSwitchScale(previous: Project, next: Project): number {
  const before = projectLengths(previous)
  const after = projectLengths(next)
  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    const from = before[index]
    const to = after[index]
    // A stored zero carries no ratio, and a non-finite number is no
    // measurement either.
    if (from !== 0 && Number.isFinite(from) && Number.isFinite(to)) return to / from
  }
  return 1
}
