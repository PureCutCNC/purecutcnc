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
 * `[sample, spindleOn, torchOn, motionType, programLine, moving, feed, materialFeed]`.
 *
 * Sampled every servo period (1 kHz); an event is kept only when something
 * changed, so each one holds until the next. `spindleOn` is the program's own
 * M3/M5 (`spindle.0.on`), `torchOn` is QtPlasmaC's torch output
 * (`plasmac.torch-on`), `motionType` is LinuxCNC's `motion.motion-type`,
 * `feed` is the F word in effect for the move being executed, with
 * QtPlasmaC's velocity reduction divided out, and `materialFeed` is the cut
 * feed of the material QtPlasmaC has loaded (`plasmac.cut-feed-rate`), both
 * in machine units per minute.
 */
export type TraceEvent = [
  sample: number, spindleOn: number, torchOn: number, motionType: number, programLine: number, moving: number,
  feed: number, materialFeed: number,
]

/** What QtPlasmaC's own sequence was doing when a run ran out of time. */
export interface SimStall {
  /** Name of plasmac's state, from the enum in LinuxCNC's plasmac.comp. */
  plasmacState: string
  /** The Z offset plasmac is commanding, in counts, and what motion has applied. */
  zCounts: number
  zOffset: number
  offsetScale: number
  feedHold: boolean
  torchOn: boolean
  arcOk: boolean
}

export interface SimRun {
  timedOut: boolean
  /** Set when the run timed out. */
  stall: SimStall | null
  /** How many times the driver had to press Cycle Start before LinuxCNC ran the program. */
  startAttempts: number
  /** The Z count QtPlasmaC held at each torch-on: the same for every pierce when the probe is deterministic. */
  pierceZCounts: number[]
  /** Spacing, in Z counts, of the heights plasmac truncates to (0.01 mm or 0.001 in). */
  zBoundaryCounts: number
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
 * - `material-wait` a material select is not followed by the confirmation
 *                 wait and then the feed word, the order the manual requires.
 * - `feed`        a cutting move ran at a feed other than the loaded
 *                 material's cut feed.
 * - `trace`       the harness could not observe the run; nothing is proven.
 */
export type Rule =
  | 'load' | 'interpreter' | 'completion' | 'torch' | 'material' | 'material-wait' | 'feed' | 'trace'

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

/** A program line with its comments and spacing removed, upper-cased. */
function codeOf(line: string): string {
  return line.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').replace(/\s+/g, '').toUpperCase()
}

const MATERIAL_SELECT = /^M190P-?\d/
const TORCH_ON = /^M0?3(?!\d)/
/** An F word: `F1000`, `F#<_hal[...]>`, or the `F[...]` the filter writes when it converts units. */
const FEED_WORD = /(^|[^A-Z_])F[#[\d.]/

/** `M66 P3 L3 Qn`: wait for digital input 3, the one QtPlasmaC raises when a material change is done. */
function isMaterialWait(code: string): boolean {
  if (!code.startsWith('M66')) return false
  const timeout = code.match(/Q([\d.]+)/)
  return /P0*3(?!\d)/.test(code) && /L0*3(?!\d)/.test(code) && timeout !== null && Number(timeout[1]) > 0
}

/**
 * The order the QtPlasmaC manual requires ("Automatic Material Handling": the
 * codes "MUST be applied in the order shown"): `M190 Pn`, then `M66 P3 L3 Qn`,
 * then the feed word, all before the next torch-on.
 *
 * Read off the program as QtPlasmaC's filter rewrote it. The order is not a
 * formality: the interpreter reads ahead, so a feed word that is not behind
 * the wait is evaluated before the material change has happened and takes the
 * previous material's feed. `judgeFeed` sees that effect in the run; this sees
 * the cause, including where the two materials happen to share a feed.
 */
function judgeMaterialSequence(report: SimProgramReport): Finding[] {
  const findings: Finding[] = []
  let pending: { line: number; stage: 'wait' | 'feed' } | null = null
  const missingWait = (selectLine: number, found: string): Finding => ({
    rule: 'material-wait',
    message: `the material select at ${lineText(report, selectLine)} is not followed by the wait `
      + `M66 P3 L3 Qn; ${found}`,
  })

  for (const [index, text] of report.filtered.entries()) {
    const line = index + 1
    const code = codeOf(text)
    if (!code) continue
    if (MATERIAL_SELECT.test(code)) {
      if (pending?.stage === 'wait') findings.push(missingWait(pending.line, `next is ${lineText(report, line)}`))
      pending = { line, stage: 'wait' }
    } else if (pending?.stage === 'wait') {
      if (isMaterialWait(code)) {
        pending = { line: pending.line, stage: 'feed' }
      } else {
        findings.push(missingWait(pending.line, `next is ${lineText(report, line)}`))
        pending = null
      }
    } else if (pending && FEED_WORD.test(code)) {
      pending = null
    } else if (pending && TORCH_ON.test(code)) {
      findings.push({
        rule: 'material-wait',
        message: `no feed word between the material change at ${lineText(report, pending.line)} `
          + `and the torch-on at ${lineText(report, line)}`,
      })
      pending = null
    }
  }
  if (pending?.stage === 'wait') findings.push(missingWait(pending.line, 'the program ends there'))
  return findings
}

/**
 * How long a feed mismatch must last, in servo periods (1 ms), to count.
 *
 * When QtPlasmaC changes its velocity reduction (`M67 E3 Qn`), the scaled feed
 * and the scale factor reach the trace one period apart, so the feed derived
 * from them is wrong for exactly that period. A cut at a stale feed lasts for
 * the whole move — hundreds of periods.
 */
const FEED_MISMATCH_MIN_SAMPLES = 10

/**
 * Every cut must run at the loaded material's cut feed.
 *
 * This is what a missing or misplaced material wait does on the machine: the
 * material changes, but the cut runs at the feed of the material that was
 * loaded before. QtPlasmaC's own filter warns about the same mismatch when the
 * feed is a literal number; for a feed read from the material it cannot.
 */
function judgeFeed(report: SimProgramReport, run: SimRun): Finding[] {
  const mismatches = new Map<string, { line: number; samples: number }>()
  run.events.forEach(([sample, , , motionType, line, moving, feed, materialFeed], index) => {
    if (moving !== 1 || (motionType !== MOTION_FEED && motionType !== MOTION_ARC)) return
    // Half a percent absorbs the rounding of a unit-converted feed.
    if (Math.abs(feed - materialFeed) <= Math.max(0.005 * materialFeed, 1e-6)) return
    const next = run.events[index + 1]
    const key = `${feed}|${materialFeed}`
    const seen = mismatches.get(key) ?? { line, samples: 0 }
    seen.samples += next ? next[0] - sample : FEED_MISMATCH_MIN_SAMPLES
    mismatches.set(key, seen)
  })
  return [...mismatches]
    .filter(([, seen]) => seen.samples >= FEED_MISMATCH_MIN_SAMPLES)
    .map(([key, seen]) => {
      const [feed, materialFeed] = key.split('|')
      return {
        rule: 'feed' as const,
        message: `cut at feed ${feed} while the loaded material's cut feed is ${materialFeed}, `
          + `first at ${lineText(report, seen.line)}`,
      }
    })
}

function judgeCompletion(report: SimProgramReport, run: SimRun): Finding[] {
  const findings: Finding[] = []
  if (run.timedOut) {
    const where = run.stall ? ` (plasmac in ${run.stall.plasmacState})` : ''
    findings.push({ rule: 'completion', message: `the run did not finish within ${run.seconds} s${where}` })
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

/**
 * States in which plasmac waits, with no timeout, for the applied Z offset to
 * equal a target it compares after truncation.
 */
const Z_TARGET_WAITS = new Set(['PROBE_HEIGHT', 'PIERCE_HEIGHT', 'PUDDLE_JUMP', 'CUT_HEIGHT', 'SAFE_HEIGHT', 'MAX_HEIGHT'])

/**
 * A run that timed out because the *simulator* stalled, not the program.
 *
 * LinuxCNC 2.9.10's plasmac can wait for ever at a Z target that is an exact
 * multiple of 0.01 mm (see `attach_float_switch` in `sim/driver.py`). The
 * driver's realtime float switch keeps the targets off those heights, so this
 * should never fire; if a change to the rig brings it back, it must read as
 * "the simulator stalled" and not as a verdict about whichever program was
 * running.
 */
function simulatorStall(run: SimRun): Finding | null {
  const stall = run.stall
  if (!run.timedOut || !stall || !Z_TARGET_WAITS.has(stall.plasmacState)) return null
  return {
    rule: 'trace',
    message: `the simulator stalled, not the program: plasmac sat in ${stall.plasmacState} at Z count `
      + `${stall.zCounts} (applied offset ${stall.zOffset}) waiting for its Z target. `
      + 'See "Why the float switch is realtime" in the README',
  }
}

/**
 * How close, in Z counts, a pierce may come to a height plasmac truncates to.
 * The other Z targets of a pierce sit a whole number of steps away from it,
 * give or take a count of rounding, so this margin covers them too.
 */
const Z_BOUNDARY_MARGIN_COUNTS = 50

/** Distance in counts from `counts` to the nearest multiple of `boundary`. */
export function boundaryDistance(counts: number, boundary: number): number {
  const offset = ((counts % boundary) + boundary) % boundary
  return Math.min(offset, boundary - offset)
}

/**
 * The simulated sheet must keep QtPlasmaC's Z targets clear of the heights
 * plasmac can stall on. The probe is deterministic, so a pierce that lands too
 * close does so on every run: this turns that into a message naming the
 * constant to move, before it can become a stall.
 */
function judgeSheetHeight(run: SimRun): Finding[] {
  const close = run.pierceZCounts.filter(
    (counts) => boundaryDistance(counts, run.zBoundaryCounts) < Z_BOUNDARY_MARGIN_COUNTS,
  )
  if (close.length === 0) return []
  return [{
    rule: 'trace',
    message: `the simulated sheet puts a pierce at Z count ${close[0]}, `
      + `${boundaryDistance(close[0], run.zBoundaryCounts)} count(s) from a height plasmac can stall on `
      + `(every ${run.zBoundaryCounts} counts); move SHEET_TOP in sim/driver.py`,
  }]
}

/** Every reason this program is not acceptable to QtPlasmaC. Empty means it passed. */
export function judge(report: SimProgramReport): Finding[] {
  const findings = judgeLoad(report)
  // A file the filter refused is replaced by a bare program end; there is no
  // sequence left to read.
  if (!report.filterErrors) findings.push(...judgeMaterialSequence(report))

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
  const stalled = simulatorStall(run)
  if (stalled) {
    findings.push(stalled)
    return findings
  }
  for (const error of run.errors) {
    findings.push({ rule: 'interpreter', message: `LinuxCNC error during the run: ${flatten(error)}` })
  }
  findings.push(
    ...judgeSheetHeight(run),
    ...judgeCompletion(report, run),
    ...judgeTorch(report, run),
    ...judgeMaterial(run),
    ...judgeFeed(report, run),
  )
  return findings
}

export type Expectation = 'pass' | { fails: Rule[] }

/**
 * Compare a verdict with what the corpus case expects. Null means it matches.
 *
 * A case that must fail has to fail for exactly its own rules — all of them
 * and no others. A negative fixture that is rejected for something unrelated,
 * or for only half of what it should trip, would look green while a rule it
 * exists to exercise had stopped working.
 */
export function mismatch(expect: Expectation, findings: Finding[]): string | null {
  const rules = [...new Set(findings.map((finding) => finding.rule))].sort()
  if (expect === 'pass') {
    return rules.length === 0 ? null : 'expected to pass'
  }
  const wanted = [...expect.fails].sort()
  if (rules.length === 0) return `expected to be rejected (${wanted.join(', ')}) but it passed`
  if (rules.join() === wanted.join()) return null
  return `expected to be rejected for exactly "${wanted.join(', ')}", but was rejected for: ${rules.join(', ')}`
}
