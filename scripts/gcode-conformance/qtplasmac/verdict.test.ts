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
import { judge, mismatch } from './verdict'
import type { Rule, SimProgramReport, SimRun, TraceEvent } from './verdict'

const FILTERED = [
  'G21 G40 G49 G64 P0.1 G80 G90 G92.1 G94 G97', // 1
  'M190 P1', // 2
  'M66 P3 L3 Q1', // 3
  'G00 X15 Y50', // 4
  'M03 $0 S1', // 5
  'G01 X20 Y50', // 6
  'G01 X20 Y80', // 7
  'M05 $0', // 8
  'G00 X0 Y0', // 9
  'M02', // 10
]

/** A clean run: rapid, M3, held feed, torch fires, cut, stop, M5, rapid home. */
const CLEAN_EVENTS: TraceEvent[] = [
  [100, 0, 0, 0, 0, 0],
  [1400, 0, 0, 1, 4, 1],
  [1580, 0, 0, 0, 0, 0],
  [1600, 1, 0, 0, 0, 0],
  [1602, 1, 0, 2, 6, 0],
  [4200, 1, 1, 2, 6, 0],
  [4500, 1, 1, 2, 6, 1],
  [5000, 1, 1, 2, 7, 1],
  [5300, 1, 1, 2, 7, 0],
  [5302, 1, 1, 0, 0, 0],
  [5320, 0, 0, 0, 0, 0],
  [5322, 0, 0, 1, 9, 0],
  [5900, 0, 0, 1, 9, 1],
  [6600, 0, 0, 0, 0, 0],
]

function cleanRun(overrides: Partial<SimRun> = {}): SimRun {
  return {
    timedOut: false,
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
    [5322, 0, 0, 2, 7, 1],
    [5700, 0, 0, 0, 0, 0],
    [5702, 0, 0, 1, 9, 1],
    [6600, 0, 0, 0, 0, 0],
  ]
  const findings = judge(report({ run: cleanRun({ events }) }))
  assert.deepEqual(findings.map((finding) => finding.rule), ['torch'])
  assert.match(findings[0].message, /outside any torch-on\/torch-off pair at line 7: G01 X20 Y80/)
}

// One servo period of cutting with the torch off is enough.
{
  const events: TraceEvent[] = [
    ...CLEAN_EVENTS.slice(0, 8),
    [5299, 1, 0, 2, 7, 1],
    ...CLEAN_EVENTS.slice(8),
  ]
  const findings = judge(report({ run: cleanRun({ events }) }))
  assert.deepEqual(findings.map((finding) => finding.rule), ['torch'])
  assert.match(findings[0].message, /QtPlasmaC's torch output off/)
}

// A rapid with the torch off is not a cut.
assert.deepEqual(rules(report({
  run: cleanRun({ events: [...CLEAN_EVENTS, [6700, 0, 0, 1, 9, 1], [6800, 0, 0, 0, 0, 0]] }),
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

// A trace with holes proves nothing, in either direction.
assert.deepEqual(rules(report({ run: cleanRun({ traceComplete: false }) })), ['trace'])
// Neither rejected nor run: the harness lost the case.
assert.deepEqual(rules(report({ run: null })), ['trace'])

// Expectations: a negative case must fail for exactly its own rule.
assert.equal(mismatch('pass', []), null)
assert.match(mismatch('pass', [{ rule: 'torch', message: 'x' }]) ?? '', /expected to pass/)
assert.equal(mismatch({ fails: 'torch' }, [{ rule: 'torch', message: 'x' }, { rule: 'torch', message: 'y' }]), null)
assert.match(mismatch({ fails: 'torch' }, []) ?? '', /but it passed/)
assert.match(mismatch({ fails: 'torch' }, [{ rule: 'interpreter', message: 'x' }]) ?? '', /rejected for: interpreter/)
assert.match(
  mismatch({ fails: 'torch' }, [{ rule: 'torch', message: 'x' }, { rule: 'material', message: 'y' }]) ?? '',
  /rejected for: torch, material/,
)

console.log('qtplasmac verdict rules: ok')
