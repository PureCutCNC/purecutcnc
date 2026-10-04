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

/** Adapter to the unmodified, externally built FabMo OpenSBP grammar (#966). */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FABMO_COMMIT = '147325ca628e5b5148880b5fc3542605076935c5'

export interface FabMoParser {
  parse: (line: string) => unknown
}

/** Exact exported text only. Not a general MSGBOX or unknown-command escape. */
export function unitsMessage(units: 'mm' | 'inch'): string {
  const fileUnits = units === 'mm' ? 'mm' : 'inches'
  const controlUnits = units === 'mm' ? 'inches' : 'mm'
  return `MSGBOX(This part file is in ${fileUnits} but the control software is set to ${controlUnits}. Nothing was cut.,16,Wrong units)`
}

export function validateProgram(parser: FabMoParser, program: string): number[] {
  const lines = program.split(/\r?\n/)
  const exceptions: number[] = []
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    // The exporter writes whole-line comments. Keep original line numbers.
    if (line === '' || line.startsWith("'")) continue
    if (/^MSGBOX/i.test(line)) {
      const units = line === unitsMessage('mm') ? 'mm'
        : line === unitsMessage('inch') ? 'inch' : null
      const guard = `IF %(25)=${units === 'mm' ? 0 : 1} THEN GOTO UNIT_ERROR`
      // Only the unreachable-on-success units-error footer may be excluded.
      if (units === null || exceptions.length !== 0
        || lines[index - 1]?.trim() !== 'UNIT_ERROR:'
        || lines[index - 2]?.trim() !== "'"
        || lines[index - 3]?.trim() !== 'END'
        || lines[index + 1]?.trim() !== 'END'
        || lines.slice(index + 2).some((rest) => rest.trim() !== '')
        || !lines.slice(0, index - 3).some((rest) => rest.trim() === guard)) {
        throw new Error(`line ${index + 1}: MSGBOX is outside the exact units-guard exception`)
      }
      exceptions.push(index + 1)
      continue
    }
    try {
      parser.parse(line)
    } catch (error) {
      throw new Error(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return exceptions
}

export function loadParser(directory: string): FabMoParser {
  const metadata = JSON.parse(readFileSync(resolve(directory, 'pin.json'), 'utf8')) as { commit?: string }
  if (metadata.commit !== FABMO_COMMIT) throw new Error('FabMo validator pin mismatch; rerun setup-validators.sh')
  const require = createRequire(import.meta.url)
  return require(resolve(directory, 'engine/runtime/opensbp/sbp_parser.js')) as FabMoParser
}

function main(): void {
  try {
    const [, , directory, file] = process.argv
    if (!directory || !file) throw new Error('usage: validate.ts <validator directory> <program.sbp>')
    const exceptions = validateProgram(loadParser(directory), readFileSync(file, 'utf8'))
    for (const line of exceptions) {
      console.log(`EXCEPTION line ${line}: exact MSGBOX units-error message (FabMo grammar gap; SB3/SB4 confirmation pending)`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
