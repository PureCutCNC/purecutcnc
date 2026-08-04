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
 * G-code conformance runner (issue #450).
 *
 * Exports the corpus and feeds every file to each *available* controller
 * interpreter. The unit tests re-derive controller rules in TypeScript, which
 * encodes our belief about them; these binaries are the rules themselves.
 *
 * Validators are optional. A machine with none installed still gets a green
 * run and a clear message about what was skipped — the check is meant to be
 * usable by anyone, and enforced where the binaries exist.
 *
 * Run with: npm run check:gcode
 * Install validators with: scripts/gcode-conformance/setup-validators.sh
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CORPUS, caseExtension, renderCase } from './corpus'
import type { CorpusCase } from './corpus'

const ROOT_DIR = resolve(process.cwd(), '.gcode-conformance')
/** Wiped every run — regenerated from the current exporter. */
const OUT_DIR = join(ROOT_DIR, 'corpus')
/** Deliberately *not* under OUT_DIR: built binaries must survive the wipe. */
const VALIDATOR_DIR = process.env.GCODE_VALIDATOR_DIR
  ? resolve(process.env.GCODE_VALIDATOR_DIR)
  : join(ROOT_DIR, 'validators')

interface Validator {
  name: string
  /** What this binary actually is, for the skip message. */
  description: string
  binary: string
  /** Machine-definition ids this interpreter can actually parse. Feeding it a
   *  dialect it does not speak produces a syntax error that says nothing about
   *  whether the *arcs* are valid, so those cases are skipped, not failed. */
  machines: string[]
  /** Build the argv for one corpus file. */
  args: (file: string) => string[]
  /**
   * Decide the verdict from the run. Interpreters differ: some exit non-zero,
   * some only print. Returning a string marks a rejection and is reported.
   */
  rejection: (output: string, status: number) => string | null
}

const VALIDATORS: Validator[] = [
  {
    name: 'grbl-gvalidate',
    description: "GRBL 1.1's own gcode.c, built for the desktop via grbl-sim",
    binary: join(VALIDATOR_DIR, 'gvalidate.exe'),
    // Determined empirically: grbl parses these dialects, but rejects mach3
    // and uccnc output on the %% wrapper, O program number and N line numbers
    // long before reaching any arc.
    machines: ['grbl', 'grblhal', 'generic', 'linuxcnc'],
    args: (file) => [file],
    rejection: (output, status) => {
      // gvalidate prints `error:NN` and exits with that code.
      const match = output.match(/error:(\d+)/)
      if (match) return `grbl error:${match[1]}${match[1] === '33' ? ' (Gcode invalid target)' : ''}`
      return status === 0 ? null : `exited ${status}`
    },
  },
  {
    name: 'linuxcnc-rs274',
    description: "LinuxCNC's standalone RS-274NGC interpreter",
    binary: process.env.RS274_BIN ?? 'rs274',
    machines: ['linuxcnc', 'generic'],
    args: (file) => ['-g', file],
    rejection: (output, status) => {
      // rs274 reports parse failures on stderr and exits non-zero.
      if (status !== 0) {
        const line = output.split('\n').find((l) => /error|failed/i.test(l))
        return line?.trim() || `exited ${status}`
      }
      return null
    },
  },
]

function validatorAvailable(validator: Validator): boolean {
  if (validator.binary.includes('/')) return existsSync(validator.binary)
  try {
    execFileSync('which', [validator.binary], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function runValidator(validator: Validator, file: string): string | null {
  try {
    const output = execFileSync(validator.binary, validator.args(file), {
      encoding: 'utf8',
      stdio: 'pipe',
      // grbl's simulator persists a fake EEPROM into its working directory.
      // Run from the corpus dir so that artifact lands somewhere disposable
      // instead of the repo root.
      cwd: OUT_DIR,
    })
    return validator.rejection(output, 0)
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
    return validator.rejection(output, err.status ?? 1)
  }
}

function exportCorpus(): Array<{ entry: CorpusCase; file: string }> {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  return CORPUS.map((entry) => {
    const { gcode, warnings } = renderCase(entry)
    const file = join(OUT_DIR, `${entry.name}.${caseExtension(entry)}`)
    writeFileSync(file, gcode, 'utf8')
    if (warnings.length > 0) {
      console.log(`  ${entry.name}: export warnings — ${warnings.join(', ')}`)
    }
    return { entry, file }
  })
}

function main(): void {
  console.log(`Exporting ${CORPUS.length} corpus cases to ${OUT_DIR}`)
  const files = exportCorpus()

  const available = VALIDATORS.filter(validatorAvailable)
  const missing = VALIDATORS.filter((v) => !available.includes(v))

  for (const validator of missing) {
    console.log(`\nSKIP ${validator.name} — not installed (${validator.description})`)
    console.log('     install with: scripts/gcode-conformance/setup-validators.sh')
  }

  if (available.length === 0) {
    console.log('\nNo controller interpreters available; corpus exported but not validated.')
    console.log('This is a pass, not a verification.')
    return
  }

  let failures = 0
  const validated = new Set<string>()
  for (const validator of available) {
    console.log(`\n── ${validator.name} ─────────────────────`)
    for (const { entry, file } of files) {
      if (!validator.machines.includes(entry.machineId)) continue
      validated.add(entry.name)
      const rejection = runValidator(validator, file)
      if (rejection) {
        failures += 1
        console.log(`  FAIL ${entry.name}: ${rejection}`)
        console.log(`       covers: ${entry.covers}`)
        console.log(`       file:   ${file}`)
      } else {
        console.log(`  ok   ${entry.name}`)
      }
    }
  }

  // Never let unchecked cases read as verified ones.
  const unvalidated = files.filter(({ entry }) => !validated.has(entry.name))
  if (unvalidated.length > 0) {
    console.log('\nNot validated — no available interpreter speaks these dialects:')
    for (const { entry } of unvalidated) {
      console.log(`  ${entry.name} (${entry.machineId})`)
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} corpus case(s) rejected by a real controller interpreter.`)
    process.exit(1)
  }

  console.log(`\n${validated.size}/${files.length} cases accepted by ${available.length} interpreter(s).`)
}

main()
