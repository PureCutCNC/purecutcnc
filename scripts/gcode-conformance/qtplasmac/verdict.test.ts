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
 * Verdict rules of the QtPlasmaC simulator check, exercised without a
 * container. Runs first in `npm run check:gcode:qtplasmac`, so the rules are
 * tested even on a machine that cannot run the simulator.
 *
 * The traces are shaped like real ones recorded from the simulator: the feed
 * move becomes "current" as soon as M3 is issued, sits still while QtPlasmaC
 * probes and pierces, and only then travels.
 */

import assert from 'node:assert/strict'
import { boundaryDistance, judge, mismatch } from './verdict'
import type { Rule, SimProgramReport, SimRun, SimStall, TraceEvent } from './verdict'

const FILTERED = [
  'M190 P1', // 1
  'M66 P3 L3 Q1', // 2
  'F#<_hal[plasmac.cut-feed-rate]>', // 3
  'G00 X15 Y50', // 4
  'M03 $0 S1', // 5
  'G01 X20 Y50', // 6
  'G01 X20 Y80', // 7
  'M05 $0', // 8
  'G00 X0 Y0', // 9
  'M02', // 10
]

/** A trace event; a cutting move runs at the loaded material's feed unless told otherwise. */
function ev(
  sample: number, spindleOn: number, torchOn: number, motionType: number, line: number, moving: number,
  feed = moving === 1 && motionType >= 2 ? 5000 : 0, materialFeed = 5000,
): TraceEvent {
  return [sample, spindleOn, torchOn, motionType, line, moving, feed, materialFeed]
}

/** A clean run: rapid, M3, held feed, torch fires, cut, stop, M5, rapid home. */
const CLEAN_EVENTS: TraceEvent[] = [
  ev(100, 0, 0, 0, 0, 0),
  ev(1400, 0, 0, 1, 4, 1),
  ev(1580, 0, 0, 0, 0, 0),
  ev(1600, 1, 0, 0, 0, 0),
  ev(1602, 1, 0, 2, 6, 0),
  ev(4200, 1, 1, 2, 6, 0),
  ev(4500, 1, 1, 2, 6, 1),
  ev(5000, 1, 1, 2, 7, 1),
  ev(5300, 1, 1, 2, 7, 0),
  ev(5302, 1, 1, 0, 0, 0),
  ev(5320, 0, 0, 0, 0, 0),
  ev(5322, 0, 0, 1, 9, 0),
  ev(5900, 0, 0, 1, 9, 1),
  ev(6600, 0, 0, 0, 0, 0),
]

function cleanRun(overrides: Partial<SimRun> = {}): SimRun {
  return {
    timedOut: false,
    stall: null,
    pierceZCounts: [-6767783],
    zBoundaryCounts: 1000,
    errors: [],
    seconds: 6.5,
    atEnd: { spindleOn: false, torchOn: false, machineOn: true },
    traceComplete: true,
    samples: 6500,
    firstTorchOn: { material: 1, cutFeedRate: 5000 },
    events: CLEAN_EVENTS,
    ...overrides,
  }
}

function report(overrides: Partial<SimProgramReport> = {}): SimProgramReport {
  return {
    name: 'case',
    filterErrors: '',
    filterWarnings: '',
    filtered: FILTERED,
    preview: { error: null, lastMotionLine: 9, motionLines: 4 },
    run: cleanRun(),
    ...overrides,
  }
}

function rules(input: SimProgramReport): Rule[] {
  return [...new Set(judge(input).map((finding) => finding.rule))]
}

// A correct program passes, including the stretch where the feed move is
// current but QtPlasmaC is still probing with the torch off.
assert.deepEqual(judge(report()), [])

// A feed move after M5 is cutting outside any torch pair, and names its line.
{
  const events: TraceEvent[] = [
    ...CLEAN_EVENTS.slice(0, 11),
    ev(5322, 0, 0, 2, 7, 1),
    ev(5700, 0, 0, 0, 0, 0),
    ev(5702, 0, 0, 1, 9, 1),
    ev(6600, 0, 0, 0, 0, 0),
  ]
  const findings = judge(report({ run: cleanRun({ events }) }))
  assert.deepEqual(findings.map((finding) => finding.rule), ['torch'])
  assert.match(findings[0].message, /outside any torch-on\/torch-off pair at line 7: G01 X20 Y80/)
}

// One servo period of cutting with the torch off is enough.
{
  const events: TraceEvent[] = [
    ...CLEAN_EVENTS.slice(0, 8),
    ev(5299, 1, 0, 2, 7, 1),
    ...CLEAN_EVENTS.slice(8),
  ]
  const findings = judge(report({ run: cleanRun({ events }) }))
  assert.deepEqual(findings.map((finding) => finding.rule), ['torch'])
  assert.match(findings[0].message, /QtPlasmaC's torch output off/)
}

// A rapid with the torch off is not a cut.
assert.deepEqual(rules(report({
  run: cleanRun({ events: [...CLEAN_EVENTS, ev(6700, 0, 0, 1, 9, 1), ev(6800, 0, 0, 0, 0, 0)] }),
})), [])

// A program that never cuts cannot pass by having nothing to check.
assert.deepEqual(rules(report({
  preview: { error: null, lastMotionLine: 4, motionLines: 1 },
  run: cleanRun({ firstTorchOn: null, events: CLEAN_EVENTS.slice(0, 3) }),
})), ['torch'])

// The torch firing on the default material means no material was selected.
assert.deepEqual(rules(report({ run: cleanRun({ firstTorchOn: { material: 0, cutFeedRate: 1000 } }) })), ['material'])

// QtPlasmaC's filter refusing the file is a load failure and nothing else.
assert.deepEqual(rules(report({
  filterErrors: 'The Material selected is missing from the material file.\nLine: 2',
  preview: null,
  run: null,
})), ['load'])

// A filter warning is a failure too.
assert.deepEqual(rules(report({ filterWarnings: 'Line 6: F1000 does not match Material_1\'s feed rate of 5000' })), ['load'])

// An interpreter error on load is reported with the line QtPlasmaC would show.
{
  const findings = judge(report({
    preview: { error: { line: 7, message: 'R i j k words all missing for arc' }, lastMotionLine: 6, motionLines: 2 },
    run: null,
  }))
  assert.deepEqual(findings.map((finding) => finding.rule), ['interpreter'])
  assert.match(findings[0].message, /line 7: G01 X20 Y80 — R i j k words all missing for arc/)
}

// An error raised during the run fails it even if the trace looks complete.
assert.deepEqual(rules(report({ run: cleanRun({ errors: ['Linear move on line 7 would exceed joint 0\'s positive limit'] }) })), ['interpreter'])

// A run that stops before its last move did not complete, whatever the error
// channel said.
assert.deepEqual(rules(report({ run: cleanRun({ events: CLEAN_EVENTS.slice(0, 11) }) })), ['completion'])
assert.deepEqual(rules(report({ run: cleanRun({ timedOut: true }) })), ['completion'])
assert.deepEqual(rules(report({
  run: cleanRun({ atEnd: { spindleOn: true, torchOn: true, machineOn: true } }),
})), ['completion'])

// The stall of issue #954, as the simulator reported it when forced: torch on,
// plasmac waiting for ever at a Z target. That is the simulator, so it must
// read as "nothing proven" and never as a verdict on the program — here a
// program that would otherwise also be blamed for an unfinished run and for
// never cutting.
{
  const stall: SimStall = {
    plasmacState: 'CUT_HEIGHT', zCounts: -6998000, zOffset: -69.98, offsetScale: 1e-5, feedHold: true, torchOn: true, arcOk: true,
  }
  const stalledRun = cleanRun({
    timedOut: true,
    stall,
    seconds: 120.02,
    atEnd: { spindleOn: true, torchOn: true, machineOn: true },
    events: CLEAN_EVENTS.slice(0, 6),
  })
  const findings = judge(report({ run: stalledRun }))
  assert.deepEqual(findings.map((finding) => finding.rule), ['trace'])
  assert.match(findings[0].message, /simulator stalled, not the program: plasmac sat in CUT_HEIGHT at Z count -6998000/)
  // A timeout anywhere else is still the program's: say where plasmac was.
  const elsewhere = judge(report({ run: { ...stalledRun, stall: { ...stall, plasmacState: 'CUT_MODE_01' } } }))
  assert.ok(elsewhere.some((finding) => finding.rule === 'completion' && /plasmac in CUT_MODE_01/.test(finding.message)))
  assert.ok(!elsewhere.some((finding) => finding.rule === 'trace'))
}

// The sheet height must keep pierces clear of the heights plasmac truncates
// to. Counts are negative (the torch is below where it started), and the
// imperial machine's step is 2540 counts, not 1000.
assert.equal(boundaryDistance(-6767783, 1000), 217)
assert.equal(boundaryDistance(-6768000, 1000), 0)
assert.equal(boundaryDistance(-6678983, 1000), 17)
// Close from either side counts.
assert.equal(boundaryDistance(-6679017, 1000), 17)
assert.deepEqual(rules(report({ run: cleanRun({ pierceZCounts: [-6679017] }) })), ['trace'])
assert.equal(boundaryDistance(-6966578, 2540), 642)
assert.deepEqual(rules(report({ run: cleanRun({ pierceZCounts: [-6767783, -6767783] }) })), [])
{
  const findings = judge(report({ run: cleanRun({ pierceZCounts: [-6767783, -6678983] }) }))
  assert.deepEqual(findings.map((finding) => finding.rule), ['trace'])
  assert.match(findings[0].message, /pierce at Z count -6678983, 17 count\(s\) from a height plasmac can stall on/)
}

// A trace with holes proves nothing, in either direction.
assert.deepEqual(rules(report({ run: cleanRun({ traceComplete: false }) })), ['trace'])
// Neither rejected nor run: the harness lost the case.
assert.deepEqual(rules(report({ run: null })), ['trace'])

// The material select must be followed by the wait, then the feed word.
function sequenceFindings(lines: string[]): string[] {
  return judge(report({ filtered: lines }))
    .filter((finding) => finding.rule === 'material-wait')
    .map((finding) => finding.message)
}
const BODY = FILTERED.slice(3)
assert.deepEqual(sequenceFindings(FILTERED), [])
// The wait removed.
assert.match(
  sequenceFindings(['M190 P1', 'F#<_hal[plasmac.cut-feed-rate]>', ...BODY])[0],
  /material select at line 1: M190 P1 is not followed by the wait M66 P3 L3 Qn; next is line 2: F#<_hal/,
)
// The wait after the feed word, or before the select.
assert.equal(sequenceFindings(['M190 P1', 'F#<_hal[plasmac.cut-feed-rate]>', 'M66 P3 L3 Q1', ...BODY]).length, 1)
assert.equal(sequenceFindings(['M66 P3 L3 Q1', 'M190 P1', 'F#<_hal[plasmac.cut-feed-rate]>', ...BODY]).length, 1)
// A wait on the wrong input, in the wrong mode, or with no timeout is not the wait.
assert.equal(sequenceFindings(['M190 P1', 'M66 P2 L3 Q1', 'F1000', ...BODY]).length, 1)
assert.equal(sequenceFindings(['M190 P1', 'M66 P3 L0', 'F1000', ...BODY]).length, 1)
assert.equal(sequenceFindings(['M190 P1', 'M66 P3 L3 Q0', 'F1000', ...BODY]).length, 1)
// Comments, blank lines, spacing and word order do not matter; a literal feed
// and the unit-converted feed the filter writes both count as the feed word.
assert.deepEqual(sequenceFindings(['m190 p1 (steel)', '', '(wait)', 'M66 L3 Q2.5 P3 ; wait', 'F 1000', ...BODY]), [])
assert.deepEqual(sequenceFindings(['M190 P1', 'M66 P3 L3 Q1', 'F[#<_hal[plasmac.cut-feed-rate]> * 0.03937]', ...BODY]), [])
// Select and wait but no feed word before the torch fires.
assert.match(
  sequenceFindings(['M190 P1', 'M66 P3 L3 Q1', ...BODY])[0],
  /no feed word between the material change at line 1: M190 P1 and the torch-on at line 4: M03/,
)
// Every material change is checked, not only the first; one at the very end too.
assert.equal(sequenceFindings([...FILTERED.slice(0, 9), 'M190 P2', 'F#<_hal[plasmac.cut-feed-rate]>', 'M02']).length, 1)
assert.match(sequenceFindings([...FILTERED.slice(0, 9), 'M190 P-1'])[0], /the program ends there/)
// M30 is a program end, not a torch-on.
assert.deepEqual(sequenceFindings(['M190 P1', 'M66 P3 L3 Q1', 'M30']), [])

// A cut at the previous material's feed — what a missing wait does on the
// machine — is caught from the run, with the line it starts on.
{
  const events = CLEAN_EVENTS.map((event): TraceEvent => (event[6] > 0 ? ev(event[0], 1, 1, 2, event[4], 1, 4000) : event))
  const findings = judge(report({ run: cleanRun({ events }) }))
  assert.deepEqual(findings.map((finding) => finding.rule), ['feed'])
  assert.match(findings[0].message, /cut at feed 4000 while the loaded material's cut feed is 5000, first at line 6/)
}
// A unit-converted feed that differs only by rounding is the same feed.
assert.deepEqual(rules(report({
  run: cleanRun({ events: CLEAN_EVENTS.map((event): TraceEvent => (event[6] > 0 ? ev(event[0], 1, 1, 2, event[4], 1, 4999.99) : event)) }),
})), [])

// QtPlasmaC's velocity reduction leaves a one-period artefact in the derived
// feed each time it changes. That is not a cut at the wrong feed; ten periods is.
function withMismatchFor(periods: number): TraceEvent[] {
  return [
    ...CLEAN_EVENTS.slice(0, 7),
    ev(4700, 1, 1, 2, 6, 1, 8333.333),
    ev(4700 + periods, 1, 1, 2, 6, 1),
    ...CLEAN_EVENTS.slice(7),
  ]
}
assert.deepEqual(rules(report({ run: cleanRun({ events: withMismatchFor(1) }) })), [])
assert.deepEqual(rules(report({ run: cleanRun({ events: withMismatchFor(10) }) })), ['feed'])

// Expectations: a negative case must fail for exactly its own rules.
assert.equal(mismatch('pass', []), null)
assert.match(mismatch('pass', [{ rule: 'torch', message: 'x' }]) ?? '', /expected to pass/)
assert.equal(mismatch({ fails: ['torch'] }, [{ rule: 'torch', message: 'x' }, { rule: 'torch', message: 'y' }]), null)
assert.match(mismatch({ fails: ['torch'] }, []) ?? '', /but it passed/)
assert.match(mismatch({ fails: ['torch'] }, [{ rule: 'interpreter', message: 'x' }]) ?? '', /rejected for: interpreter/)
assert.match(
  mismatch({ fails: ['torch'] }, [{ rule: 'torch', message: 'x' }, { rule: 'material', message: 'y' }]) ?? '',
  /rejected for: material, torch/,
)
// Two expected rules: both must fire, in any order, and one alone is a mismatch.
const both = { fails: ['material-wait', 'feed'] as Rule[] }
assert.equal(mismatch(both, [{ rule: 'feed', message: 'x' }, { rule: 'material-wait', message: 'y' }]), null)
assert.match(mismatch(both, [{ rule: 'feed', message: 'x' }]) ?? '', /exactly "feed, material-wait", but was rejected for: feed/)

console.log('qtplasmac verdict rules: ok')
