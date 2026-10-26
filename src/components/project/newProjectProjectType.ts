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
 * The New project dialog's project type tiles (issue #1102, proposal 16).
 *
 * The type is the dialog's first choice, so it reads as three tiles instead of
 * a dropdown. Two decisions live here so they can be pinned without a
 * renderer: which one-line meta each tile shows, and which tile an arrow key
 * moves to. The type itself stays the dialog's `projectTypeChoice` state, and
 * the tiles are one radio group, so Tab enters it once and the arrows move
 * the choice.
 */

import type { ProjectType } from '../../types/project'
import { PROJECT_TYPES } from '../feature-tree/projectTypeChoice'

/** The catalog key naming a type's one-line meta. */
export type ProjectTypeMetaKey =
  | 'dialogs.newProject.projectTypeMillingMeta'
  | 'dialogs.newProject.projectTypePlasmaMeta'
  | 'dialogs.newProject.projectTypeRotaryMeta'

/** The meta line a type's tile shows under its title. */
export function projectTypeMetaKey(type: ProjectType): ProjectTypeMetaKey {
  switch (type) {
    case 'milling':
      return 'dialogs.newProject.projectTypeMillingMeta'
    case 'plasma':
      return 'dialogs.newProject.projectTypePlasmaMeta'
    case 'rotary':
      return 'dialogs.newProject.projectTypeRotaryMeta'
  }
}

/**
 * The type an arrow key moves to, wrapping at both ends of `PROJECT_TYPES`.
 * ArrowRight and ArrowDown move forward, ArrowLeft and ArrowUp back, in the
 * order the three tiles are drawn. Any other key keeps the current choice.
 */
export function projectTypeKeyNav(current: ProjectType, key: string): ProjectType {
  const step = key === 'ArrowRight' || key === 'ArrowDown'
    ? 1
    : key === 'ArrowLeft' || key === 'ArrowUp'
      ? -1
      : 0
  if (step === 0) {
    return current
  }

  const count = PROJECT_TYPES.length
  const index = PROJECT_TYPES.indexOf(current)
  return PROJECT_TYPES[(index + step + count) % count]
}
