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

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORPUS, caseExtension, renderCase } from '../corpus'
import { loadParser, unitsMessage, validateProgram } from './validate'

const cases = CORPUS.filter((entry) => entry.machineId === 'shopbot')
// Eight native SBP cases (#966) and two Bottom-setup ones (#946).
assert.equal(cases.length, 10)
const seen: string[] = []
const recorder = { parse: (line: string) => { seen.push(line) } }
for (const entry of cases) {
  const { gcode, warnings } = renderCase(entry)
  assert.deepEqual(warnings, [], `${entry.name}: export warnings`)
  assert.equal(caseExtension(entry), 'sbp')
  assert(!/(?<!\r)\n/.test(gcode), 'SBP must retain CRLF')
  assert(gcode.includes(`IF %(25)=${entry.units === 'mm' ? 0 : 1} THEN GOTO UNIT_ERROR`))
  const message = unitsMessage(entry.units)
  const exceptions = validateProgram(recorder, gcode)
  assert.deepEqual(exceptions, [gcode.split('\n').findIndex((line) => line.trim() === message) + 1])
  assert(!seen.includes(message), 'the exact unparsed MSGBOX must be disclosed, not parsed as MS')
  if (entry.secondTool) {
    assert(gcode.includes('&Tool=1\r\nC9'))
    assert(gcode.includes('&Tool=2\r\nC9'))
  }
  if (entry.drillCycles) {
    assert((gcode.match(/^M3,/gm) ?? []).length >= 2, 'peck drill must expand to motion')
    assert(!/^G8[123]/m.test(gcode))
  }
  if (entry.name.endsWith('-arc')) {
    const direction = entry.name.includes('-ccw-') ? '-1' : '1'
    assert(new RegExp(`^CG,,.*,[T],${direction}$`, 'm').test(gcode.replace(/\r/g, '')))
  }

  // The exception cannot absorb arbitrary messages, motion, or other syntax.
  for (const replacement of [message.replace('MSGBOX', 'MSGBOX_BAD'), message + ',MS,1,2', 'MSGBOX(oops)', message.toLowerCase()]) {
    assert.throws(() => validateProgram(recorder, gcode.replace(message, replacement)), /MSGBOX/)
  }
  assert.throws(() => validateProgram(recorder, gcode.replace('UNIT_ERROR:', 'OTHER:')), /exception/)
  assert.throws(() => validateProgram(recorder, gcode.replace(/^IF.*$/m, 'SA')), /exception/)
  assert.throws(() => validateProgram(recorder, gcode + 'MS,1,2\r\n'), /exception/)
  assert.throws(() => validateProgram(recorder, message + '\n' + gcode), /exception/)
  // Error reporting keeps original file line numbers, including comments.
  const rejectMotion = { parse: (line: string) => { if (line.startsWith('MS,')) throw new Error('bad MS') } }
  const speedLine = gcode.split('\n').findIndex((line) => line.startsWith('MS,')) + 1
  assert.throws(() => validateProgram(rejectMotion, gcode), new RegExp(`line ${speedLine}: bad MS`))
}
console.log('FabMo adapter: 10 exported SBP cases, exact exception boundaries and line reporting passed.')

const validatorRoot = process.env.GCODE_VALIDATOR_DIR
  ? resolve(process.env.GCODE_VALIDATOR_DIR) : resolve('.gcode-conformance/validators')
const directory = join(validatorRoot, 'fabmo-opensbp')
if (!existsSync(join(directory, 'pin.json'))) {
  console.log('SKIP real FabMo parser tests — not installed; adapter tests alone verify no controller syntax.')
} else {
  const parser = loadParser(directory)
  // Both CG direction flags reach FabMo, rather than merely existing as chords.
  const directions = new Set<string>()
  for (const entry of cases) {
    const { gcode } = renderCase(entry)
    assert.equal(validateProgram(parser, gcode).length, 1)
    for (const line of gcode.split('\n').filter((line) => line.startsWith('CG,'))) {
      directions.add(line.trim().split(',').at(-1)!)
    }
  }
  assert.deepEqual([...directions].sort(), ['-1', '1'])
  const scratch = mkdtempSync(join(tmpdir(), 'purecut-fabmo-test-'))
  try {
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'validate.ts')
    const program = renderCase(cases.find((entry) => entry.name.endsWith('-arc'))!).gcode
    const file = join(scratch, 'mutation.sbp')
    const run = () => execFileSync(process.execPath, ['--import', 'tsx', cli, directory, file], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 })
    writeFileSync(file, program)
    assert.match(run(), /EXCEPTION line/)
    for (const cmd of ['CG', 'MS']) {
      const mutated = program.replace(new RegExp(`^${cmd},[^\r\n]*`, 'm'), `${cmd},"unterminated`)
      assert.notEqual(mutated, program)
      writeFileSync(file, mutated)
      assert.throws(run, (error: unknown) => {
        const result = error as { status?: number; stderr?: string }
        return result.status === 1 && /line \d+:/.test(result.stderr ?? '')
      }, `malformed ${cmd} must fail the CLI with the original line number`)
    }
    console.log('FabMo parser: all 8 SBP exports passed; exported CG and MS mutations rejected by CLI; 0 survivors.')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
