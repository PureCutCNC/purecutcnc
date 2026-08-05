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

/** A minimal, unambiguously valid program every interpreter must accept. */
const SMOKE_PROGRAM = 'G21\nG90\nG0 X0 Y0\nG1 X1 Y0 F100\nM2\n'

/**
 * Arc probes, byte-identical except the G3 target, so the only variable
 * between them is whether the arc is geometrically consistent.
 *
 * Two questions, deliberately separated — controllers differ in tolerance,
 * not just in whether they check:
 *
 * 1. **Does it check arc geometry at all?** The gross probe is off by 1 mm on
 *    a 10 mm radius. Every controller that checks rejects that. One that
 *    accepts it is not checking — its verdicts mean "this parses", and a
 *    rubber stamp that looks like coverage is worse than no coverage.
 * 2. **Is it as strict as our export invariant?** The tight probe is the
 *    issue #447 block as the controller received it: radii disagreeing by
 *    0.0106 mm. GRBL rejects it (0.005 mm limit); LinuxCNC's rs274 accepts it
 *    — measured, its threshold sits between 0.028 and 0.029 mm, absolute and
 *    radius-independent. Conflating the two questions mislabels a genuinely
 *    looser controller as one that checks nothing.
 */
const ARC_PROBE_VALID = 'G21\nG90\nG0 X10 Y0\nG1 F600\nG3 X0 Y10 I-10 J0\nM2\n'
const ARC_PROBE_GROSS = 'G21\nG90\nG0 X10 Y0\nG1 F600\nG3 X0 Y11 I-10 J0\nM2\n'
const ARC_PROBE_TIGHT_PREFIX = 'G21\nG90\nG0 X11.109 Y16.962\nG1 F600\n'
const ARC_PROBE_TIGHT = `${ARC_PROBE_TIGHT_PREFIX}G3 X11.314 Y16.647 I0.339 J0.002\nM2\n`

function binaryPresent(validator: Validator): boolean {
  if (validator.binary.includes('/')) return existsSync(validator.binary)
  try {
    execFileSync('which', [validator.binary], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Confirm the binary actually works the way we invoke it.
 *
 * An interpreter that rejects a trivially valid program is misconfigured —
 * wrong CLI flags, a missing tool table — not strict. Without this probe such
 * a validator would report every corpus case as a rejection and read as a
 * catastrophic export bug. Skipping loudly is the honest failure mode.
 */
function smokeTestPasses(validator: Validator): boolean {
  return probe(validator, 'smoke', SMOKE_PROGRAM) === null
}

function probe(validator: Validator, label: string, program: string): string | null {
  const file = join(OUT_DIR, `_probe-${label}-${validator.name}.ngc`)
  writeFileSync(file, program, 'utf8')
  return runValidator(validator, file)
}

type ArcTier = 'strict' | 'tolerant' | 'syntax-only'

/**
 * Classify how far an interpreter's arc checking goes.
 *
 * `strict`      — rejects a 0.0106 mm mismatch, i.e. at least as strict as
 *                 the export invariant in arcFitting.ts.
 * `tolerant`    — checks arcs but accepts that mismatch; it would not have
 *                 caught issue #447.
 * `syntax-only` — accepts a 1 mm error on a 10 mm radius, so it is not
 *                 judging arc geometry at all.
 *
 * A validator that rejects the *valid* probe is misconfigured rather than
 * strict, and is reported as syntax-only so its verdicts are not trusted.
 */
function classifyArcChecking(validator: Validator): ArcTier {
  if (probe(validator, 'arc-valid', ARC_PROBE_VALID) !== null) return 'syntax-only'
  if (probe(validator, 'arc-gross', ARC_PROBE_GROSS) === null) return 'syntax-only'
  return probe(validator, 'arc-tight', ARC_PROBE_TIGHT) !== null ? 'strict' : 'tolerant'
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

  const present = VALIDATORS.filter(binaryPresent)
  const available: Array<{ validator: Validator; tier: ArcTier }> = []

  for (const validator of VALIDATORS) {
    if (!present.includes(validator)) {
      console.log(`\nSKIP ${validator.name} — not installed (${validator.description})`)
      console.log('     install with: scripts/gcode-conformance/setup-validators.sh')
      continue
    }
    if (!smokeTestPasses(validator)) {
      console.log(`\nSKIP ${validator.name} — present but rejected a known-good program.`)
      console.log('     The binary or its invocation is wrong; treating as unusable')
      console.log('     rather than reporting every case as a rejection.')
      continue
    }
    const tier = classifyArcChecking(validator)
    if (tier === 'syntax-only') {
      console.log(`\nNOTE ${validator.name} accepted a grossly invalid arc.`)
      console.log('     Its verdicts mean "this parses", not "these arcs are valid".')
    } else if (tier === 'tolerant') {
      console.log(`\nNOTE ${validator.name} checks arc geometry but is looser than`)
      console.log('     the exporter\'s own invariant — it would not have caught #447.')
    }
    available.push({ validator, tier })
  }

  if (available.length === 0) {
    console.log('\nNo controller interpreters available; corpus exported but not validated.')
    console.log('This is a pass, not a verification.')
    return
  }

  let failures = 0
  const validated = new Set<string>()
  const arcVerified = new Set<string>()
  for (const { validator, tier } of available) {
    console.log(`\n── ${validator.name} (${tier}) ─────────────────────`)
    for (const { entry, file } of files) {
      if (!validator.machines.includes(entry.machineId)) continue
      validated.add(entry.name)
      if (tier === 'strict') arcVerified.add(entry.name)
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

  // Parsed-only cases must not be counted as arc-verified ones.
  const syntaxOnly = files.filter(({ entry }) => (
    validated.has(entry.name) && !arcVerified.has(entry.name)
  ))
  const strict = available.filter((a) => a.tier === 'strict').map((a) => a.validator.name)
  console.log(`\n${arcVerified.size}/${files.length} cases verified against the strictest known controller rules`
    + `${strict.length > 0 ? ` (${strict.join(', ')})` : ''}.`)
  if (syntaxOnly.length > 0) {
    console.log(`${syntaxOnly.length} further case(s) parsed cleanly but were not arc-verified:`)
    for (const { entry } of syntaxOnly) console.log(`  ${entry.name}`)
  }
}

main()
