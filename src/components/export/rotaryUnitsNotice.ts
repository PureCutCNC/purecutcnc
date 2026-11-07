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


import { pinRotaryAxis, rotaryEnforcesMm, rotaryFollowsStock, rotaryWord } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import { projectType } from '../../store/helpers/projectType'
import type { Project } from '../../types/project'

type RotaryNoticeDefinition = Pick<MachineDefinition, 'rotary' | 'coordinateSystem'>

/**
 * True when a rotary project on this machine must change its units before its
 * rotary operations export (#1153): the project is a rotary one, it is in
 * inch, and the machine's controller converts the angle like a length. A
 * project that is not rotary never shows the notice, whatever the machine. The
 * export refuses those operations either way; this is the warning beforehand.
 */
export function rotaryProjectNeedsMm(
  project: Pick<Project, 'meta' | 'stock'>,
  definition: Pick<MachineDefinition, 'rotary'> | null | undefined,
): boolean {
  return projectType(project) === 'rotary'
    && project.meta.units === 'inch'
    && rotaryEnforcesMm(definition)
}

/** What the export dialog says about a machine that follows the bar (#1153). */
export type RotaryFollowsStockNote =
  | { kind: 'own'; axis: 'X' | 'Y' }
  | { kind: 'borrowed'; axis: 'X' | 'Y'; motor: 'X' | 'Y' }

/**
 * The note for a bundled rotary machine in a rotary project: the A orientation
 * follows the stock, so the dialog names the axis it resolved to and, for a
 * borrowed motor, which motor now drives the rotary. Null for a machine that
 * names its own axis, and for a project that is not rotary.
 */
export function rotaryFollowsStockNote(
  project: Pick<Project, 'meta' | 'stock'>,
  definition: RotaryNoticeDefinition | null | undefined,
): RotaryFollowsStockNote | null {
  if (!definition || !rotaryFollowsStock(definition) || projectType(project) !== 'rotary') return null
  const pinned = pinRotaryAxis(definition, project.stock)
  const rotary = pinned.rotary
  if (!rotary) return null
  const axis = rotary.about === 'x' ? 'X' : 'Y'
  if (rotary.drive === 'own') return { kind: 'own', axis }
  const word = rotaryWord(pinned)
  return word === 'X' || word === 'Y' ? { kind: 'borrowed', axis, motor: word } : null
}
