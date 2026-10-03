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
 * Verdict rules for the QtPlasmaC simulator check (issue #954).
 *
 * The simulator driver (`sim/driver.py`) only observes: what QtPlasmaC's load
 * filter said, what the interpreter said, and a servo-rate trace of the run.
 * Everything that turns those observations into "this program is acceptable"
 * lives here, as pure functions, so the rules are unit-tested without a
 * container (`verdict.test.ts`).
 */

/**
 * One change in the run trace:
 * `[sample, spindleOn, torchOn, motionType, programLine, moving]`.
 *
 * Sampled every servo period (1 kHz); an event is kept only when something
 * changed, so each one holds until the next. `spindleOn` is the program's own
 * M3/M5 (`spindle.0.on`), `torchOn` is QtPlasmaC's torch output
 * (`plasmac.torch-on`), `motionType` is LinuxCNC's `motion.motion-type`.
 */
export type TraceEvent = [
  sample: number, spindleOn: number, torchOn: number, motionType: number, programLine: number, moving: number,
]

export interface SimRun {
  timedOut: boolean
  /** Messages LinuxCNC put on its error channel during the run. */
  errors: string[]
  seconds: number
  atEnd: { spindleOn: boolean; torchOn: boolean; machineOn: boolean }
  /** False when the sampler dropped or overran samples: the trace has holes. */
  traceComplete: boolean
  samples: number
  /** What QtPlasmaC had loaded when the program's first M3 took effect. */
  firstTorchOn: { material: number; cutFeedRate: number } | null
  events: TraceEvent[]
}

export interface SimProgramReport {
  name: string
  /** Text of the load filter's dialog; empty when it had nothing to say. */
  filterErrors: string
  filterWarnings: string
  /** The program as QtPlasmaC's filter rewrote it; trace line numbers index this. */
  filtered: string[]
  /** Null when the filter refused the file, so nothing was interpreted. */
  preview: {
    error: { line: number; message: string } | null
    /** The last line that produces motion, per the interpreter. */
    lastMotionLine: number
    motionLines: number
  } | null
  /** Null when the program never reached a run. */
  run: SimRun | null
}

/**
 * - `load`        QtPlasmaC's load filter reported an error or a warning.
 * - `interpreter` LinuxCNC's interpreter rejected a line, or the run raised an error.
 * - `completion`  the run did not get to the end of the program cleanly.
 * - `torch`       a cutting move happened with the torch off.
 * - `material`    the torch fired before the program selected a material.
 * - `trace`       the harness could not observe the run; nothing is proven.
 */
export type Rule = 'load' | 'interpreter' | 'completion' | 'torch' | 'material' | 'trace'

export interface Finding {
  rule: Rule
  message: string
}

/** `motion.motion-type`: 2 is a feed move (G1), 3 an arc (G2/G3). */
const MOTION_FEED = 2
const MOTION_ARC = 3

/**
 * The material QtPlasmaC falls back to. The driver resets to it before every
 * run, so a torch that fires on it means the program never selected one.
 * Defined as material 0 in `sim/materials-*.cfg`.
 */
export const DEFAULT_MATERIAL = 0

function lineText(report: SimProgramReport, line: number): string {
  const text = report.filtered[line - 1]
  return text === undefined ? `line ${line}` : `line ${line}: ${text.trim()}`
}

function flatten(text: string): string {
  return text.split('\n').map((part) => part.trim()).filter(Boolean).join(' ')
}

function judgeLoad(report: SimProgramReport): Finding[] {
  const findings: Finding[] = []
  if (report.filterErrors) {
    findings.push({ rule: 'load', message: `QtPlasmaC load filter error: ${flatten(report.filterErrors)}` })
  }
  // Warnings fail too. QtPlasmaC's own wording is that they "may affect the
  // quality of the process" and should all be fixed before running — an
  // exporter that provokes one is emitting something QtPlasmaC objects to.
  if (report.filterWarnings) {
    findings.push({ rule: 'load', message: `QtPlasmaC load filter warning: ${flatten(report.filterWarnings)}` })
  }
  return findings
}

function judgeTorch(report: SimProgramReport, run: SimRun): Finding[] {
  let cuttingEvents = 0
  const outsidePair = new Set<number>()
  const torchNotFired = new Set<number>()
  for (const [, spindleOn, torchOn, motionType, line, moving] of run.events) {
    // A feed move is "current" from the moment M3 is issued, but QtPlasmaC
    // holds it while it probes, pierces and waits for arc-OK. Only a move
    // that is actually travelling is cutting.
    const cutting = moving === 1 && (motionType === MOTION_FEED || motionType === MOTION_ARC)
    if (!cutting) continue
    cuttingEvents += 1
    if (spindleOn === 0) outsidePair.add(line)
    else if (torchOn === 0) torchNotFired.add(line)
  }

  const findings: Finding[] = []
  for (const line of [...outsidePair].sort((a, b) => a - b)) {
    findings.push({
      rule: 'torch',
      message: `cutting move outside any torch-on/torch-off pair at ${lineText(report, line)}`,
    })
  }
  for (const line of [...torchNotFired].sort((a, b) => a - b)) {
    findings.push({
      rule: 'torch',
      message: `cutting move after M3 but with QtPlasmaC's torch output off at ${lineText(report, line)}`,
    })
  }
  // A program that never cuts would satisfy "every cut has the torch on"
  // vacuously, and a green case that proves nothing is worse than a red one.
  if (cuttingEvents === 0) {
    findings.push({ rule: 'torch', message: 'no cutting move was observed during the run' })
  }
  return findings
}

function judgeMaterial(run: SimRun): Finding[] {
  if (run.firstTorchOn?.material !== DEFAULT_MATERIAL) return []
  return [{
    rule: 'material',
    message: `the torch fired on QtPlasmaC's default material (${DEFAULT_MATERIAL}): `
      + 'no material select took effect before the first torch-on',
  }]
}

function judgeCompletion(report: SimProgramReport, run: SimRun): Finding[] {
  const findings: Finding[] = []
  if (run.timedOut) {
    findings.push({ rule: 'completion', message: `the run did not finish within ${run.seconds} s` })
  }
  if (!run.atEnd.machineOn) {
    findings.push({ rule: 'completion', message: 'the machine was no longer on when the run ended' })
  }
  if (run.atEnd.spindleOn || run.atEnd.torchOn) {
    findings.push({ rule: 'completion', message: 'the torch was still on when the run ended' })
  }
  // LinuxCNC hands each error message to one reader only, and the QtPlasmaC
  // GUI reads the same channel — so an empty error list does not prove a
  // clean run. This does: the interpreter says which line moves last, and a
  // run that stopped early never executed it.
  const lastMotionLine = report.preview?.lastMotionLine ?? 0
  const reached = run.events.some(([, , , motionType, line]) => motionType !== 0 && line === lastMotionLine)
  if (lastMotionLine > 0 && !reached && !run.timedOut) {
    findings.push({
      rule: 'completion',
      message: `the run stopped before the program's last move (${lineText(report, lastMotionLine)})`,
    })
  }
  return findings
}

/** Every reason this program is not acceptable to QtPlasmaC. Empty means it passed. */
export function judge(report: SimProgramReport): Finding[] {
  const findings = judgeLoad(report)

  if (report.preview?.error) {
    const { line, message } = report.preview.error
    findings.push({ rule: 'interpreter', message: `interpreter error near ${lineText(report, line)} — ${message}` })
  }

  const run = report.run
  if (!run) {
    // The driver skips the run exactly when the filter or the interpreter
    // already rejected the file. Anything else is the harness losing a case.
    if (findings.length === 0) {
      findings.push({ rule: 'trace', message: 'the program was neither rejected nor run' })
    }
    return findings
  }

  if (!run.traceComplete) {
    findings.push({ rule: 'trace', message: 'the run trace has gaps; the torch rules cannot be judged' })
    return findings
  }
  for (const error of run.errors) {
    findings.push({ rule: 'interpreter', message: `LinuxCNC error during the run: ${flatten(error)}` })
  }
  findings.push(...judgeCompletion(report, run), ...judgeTorch(report, run), ...judgeMaterial(run))
  return findings
}

export type Expectation = 'pass' | { fails: Rule }

/**
 * Compare a verdict with what the corpus case expects. Null means it matches.
 *
 * A case that must fail has to fail for exactly its own reason. A negative
 * fixture that is rejected for something unrelated would look green while the
 * rule it exists to exercise had stopped working.
 */
export function mismatch(expect: Expectation, findings: Finding[]): string | null {
  const rules = [...new Set(findings.map((finding) => finding.rule))]
  if (expect === 'pass') {
    return rules.length === 0 ? null : 'expected to pass'
  }
  if (rules.length === 0) return `expected to be rejected (${expect.fails}) but it passed`
  if (rules.length === 1 && rules[0] === expect.fails) return null
  return `expected to be rejected for "${expect.fails}" only, but was rejected for: ${rules.join(', ')}`
}
