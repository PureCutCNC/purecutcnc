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
 */

import type { MachineDefinition } from '../../engine/gcode/types'
import type { ToolpathResult } from '../../engine/toolpaths/types'

type OperationWithToolpath = { toolpath: Pick<ToolpathResult, 'moves'> }

/** True when the dialog should show the rotary-zeroing note. */
export function shouldShowRotaryZeroNotice(
  operations: readonly OperationWithToolpath[],
  definition: Pick<MachineDefinition, 'rotary'> | null | undefined,
): boolean {
  // A machine with no rotary block cannot run a turning operation at all (the
  // emitter refuses it), and there is no A on it to zero.
  if (definition?.rotary == null) return false
  const zeroA = (definition.rotary.zeroA ?? '').trim()
  if (zeroA.length > 0) return false
  return operations.some(({ toolpath }) => toolpath.moves.some(
    (move) => move.from.a !== undefined || move.to.a !== undefined,
  ))
}
