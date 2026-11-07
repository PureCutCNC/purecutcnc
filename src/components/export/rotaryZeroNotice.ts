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
 * The export dialog's rotary-zeroing note (#1103 slice ca-h, part 3).
 *
 * When the program turns the bar and the machine carries no "Zero A" line,
 * every rotary operation ends facing 0 up and the program pauses between two
 * of them so the operator can zero A by hand. That is the only place the
 * operator learns they must start with A zeroed at 0 up, so the dialog says
 * it once, before the file is written.
 *
 * A machine whose rotary block has a Zero A line zeroes itself, so the note is
 * not shown; a program that never turns A has nothing to zero.
 *
 * A Top or Bottom program turns the bar too, through its setup's opening
 * manual-index turn. No toolpath move carries that angle (it is emitted from
 * the setup, not the path), so asking only the moves said "nothing to zero"
 * about a program that contains `G0 A0` (#1152 correction round 1, finding 4).
 * The setup's own face — and the same manual-indexing conditions the emitter
 * checks — decide it instead.
 */

import type { MachineDefinition } from '../../engine/gcode/types'
import { pinRotaryAxis, rotaryWord } from '../../engine/gcode/types'
import { manualIndexingApplies } from '../../store/helpers/projectType'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { Project, SetupFace } from '../../types/project'

type OperationWithToolpath = { toolpath: Pick<ToolpathResult, 'moves'> }

/** One exported program: the setup it belongs to and the operations it cuts. */
export interface RotaryZeroNoticeProgram {
  /** The setup's face; a Top/Bottom program turns the bar by manual index. */
  face: SetupFace
  operations: readonly OperationWithToolpath[]
}

/** True when the program should show the rotary-zeroing note. */
export function shouldShowRotaryZeroNotice(
  programs: readonly RotaryZeroNoticeProgram[],
  definition: Pick<MachineDefinition, 'rotary' | 'coordinateSystem'> | null | undefined,
  project: Pick<Project, 'meta' | 'stock' | 'setups'>,
): boolean {
  // A machine with no rotary block cannot run a turning operation at all (the
  // emitter refuses it), and there is no A on it to zero.
  if (definition?.rotary == null) return false
  const zeroA = (definition.rotary.zeroA ?? '').trim()
  if (zeroA.length > 0) return false
  // A Top/Bottom setup of a rotary bar project turns the bar itself, when the
  // machine has a rotary word to turn (the emitter's own conditions: such a
  // project is split per setup, and the emitter plans the turn from the setup —
  // a project with no setup plans none).
  const manualIndexTurns = manualIndexingApplies(project)
    && (project.setups?.length ?? 0) > 0
    && rotaryWord(pinRotaryAxis(definition, project.stock)) !== null
  return programs.some((program) => {
    if (manualIndexTurns && program.face !== 'around') return true
    return program.operations.some(({ toolpath }) => toolpath.moves.some(
      (move) => move.from.a !== undefined || move.to.a !== undefined,
    ))
  })
}
