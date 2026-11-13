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
 * No bundled definition pauses twice for one tool change (#1057 slice K).
 *
 * GRBL 1.1 and Generic write their own `M0` tool-change line *and* asked for
 * the separate `pauseAfterChange` pause, so one change stopped the controller
 * twice (Frank's report: `M5`, `M0 ; Tool change: 1/4" Endmill`, `M0`). The
 * fix is the two bundled definitions, not the emitter: a definition may pause
 * once, whether the pause is written in `commands` or by `pauseAfterChange`.
 * Projects keep their own embedded snapshot; only the bundled defaults change.
 *
 * The two-tool conformance fixture is used so a program really contains two
 * changes, and both units are rendered so a units-specific tool-change template
 * cannot hide a second pause.
 *
 * Run with: npx tsx src/engine/gcode/toolChangePause.test.ts
 */

import assert from 'node:assert/strict'
import { BUNDLED_DEFINITIONS } from './definitions'
import { CORPUS, renderCase } from '../../../scripts/gcode-conformance/corpus'

/** A controller delay word: M0/M00/M1/M01, with or without a trailing comment. */
const PAUSE = /^\s*M(?:0{1,2}|0?1)\b/

/** A line whose first word is a pause, ignoring comment-only lines. */
function isPause(line: string): boolean {
  if (/^\s*(?:;|'|\(|%)/.test(line)) return false
  return PAUSE.test(line)
}

console.log('Testing no bundled definition writes two consecutive pauses for one tool change...')

for (const bundled of BUNDLED_DEFINITIONS) {
  for (const units of ['mm', 'inch'] as const) {
    const name = `sbp-${units}-tool-change`
    const entry = CORPUS.find((candidate) => candidate.name === name)
    assert(entry, `fixture: the two-tool ${units} case exists`)
    const { gcode } = renderCase({ ...entry, machineId: bundled.id, units })
    const lines = gcode.split(/\r?\n/)
    for (let index = 1; index < lines.length; index++) {
      assert(
        !(isPause(lines[index - 1]) && isPause(lines[index])),
        `${bundled.id}/${units}: two consecutive pause lines at a tool change:\n`
          + `${lines.slice(Math.max(0, index - 3), index + 2).join('\n')}\n\n${gcode}`,
      )
    }
  }
}

// The two defaults that carried the doubling keep exactly one pause per
// change, and it is the line that names the tool — the pause was removed, not
// the tool-change message.
for (const id of ['generic', 'grbl']) {
  const definition = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === id)
  assert(definition, `${id}: the bundled definition exists`)
  assert.equal(definition.toolChange.pauseAfterChange, false, `${id}: the separate pause is off`)
  assert(
    definition.toolChange.commands.some((command) => isPause(command)),
    `${id}: the tool-change command still pauses once`,
  )
}

console.log('gcode tool-change pause tests passed')
