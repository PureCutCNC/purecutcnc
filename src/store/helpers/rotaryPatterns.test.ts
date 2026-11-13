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
 * Thread/Flutes sheet geometry (issue #1016 C1 slice A).
 *
 * Mutations checked one at a time against these assertions:
 * - lead taken as `pitch` instead of `starts * pitch`: multi-start lead test
 * - start offsets dropped or not divided by starts/count: spacing tests
 * - X/Y mapping swapped: `rotarySheetPoint` and the Y-bar tests
 * - zero taken from the sheet's first edge instead of `frame.zero`: centered-zero test
 * - along endpoints recomputed/rounded instead of `start..start+length`: endpoint test
 * - start measured from the minimum end instead of the chuck end on a Y bar:
 *   the frame and Y-bar start tests
 * - handedness constant flipped on one axis: the independent chirality test
 * - depth allowed at the radius: the radius-limit refusal
 * - `hand: 'left'` ignored, or applied to the right hand: the hand
 *   chirality test and the omitted-vs-right identity assertion
 * Run with: npx tsx src/store/helpers/rotaryPatterns.test.ts
 */

import assert from 'node:assert/strict'
import { newProject, roundStock } from '../../types/project'
import type { Project } from '../../types/project'
import {
  buildRotaryPatternLines,
  rotaryHandedness,
  rotaryPatternFrame,
  rotarySheetPoint,
  THREAD_DEPTH_PER_PITCH,
} from './rotaryPatterns'
import type { RotaryPatternFrame, RotarySheetLine } from './rotaryPatterns'

function bar(axis: 'x' | 'y'): Project {
  const project = newProject('Patterns', axis === 'x' ? 'mm' : 'inch')
  project.meta.projectType = 'rotary'
  project.stock = axis === 'x' ? roundStock(40, 200, 'x', { x: 10, y: 30 }) : roundStock(2, 8, 'y', { x: 3, y: 5 })
  return project
}

function frameOf(axis: 'x' | 'y'): RotaryPatternFrame {
  const frame = rotaryPatternFrame(bar(axis))
  assert.ok(frame, `bar ${axis} has a pattern frame`)
  return frame
}

/** A bar of either axis in either unit system, for the direction matrix. */
function frameFor(axis: 'x' | 'y', units: 'mm' | 'inch'): RotaryPatternFrame {
  const project = newProject('Directions', units)
  project.meta.projectType = 'rotary'
  project.stock = units === 'mm'
    ? roundStock(40, 200, axis, { x: 10, y: 30 })
    : roundStock(2, 8, axis, { x: 3, y: 5 })
  const frame = rotaryPatternFrame(project)
  assert.ok(frame, `bar ${axis}/${units} has a pattern frame`)
  return frame
}

function lines(result: ReturnType<typeof buildRotaryPatternLines>, label: string): RotarySheetLine[] {
  assert.ok(result.ok, `${label}: expected lines, got ${result.ok ? '' : result.reason}`)
  return result.lines
}

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

/**
 * The pure sheet builder never reads a tool — only a Follow line operation
 * does — so flutes fixtures carry only geometry fields.
 */

/** The absolute along coordinate a requested start/length reaches on `frame`. */
function alongFrom(frame: RotaryPatternFrame, value: number): number {
  return frame.alongOrigin + frame.alongDirection * value
}

/** The two absolute endpoints of a band, drawn low→high in stock coordinates. */
function band(frame: RotaryPatternFrame, start: number, length: number): { start: number; end: number } {
  const a = alongFrom(frame, start)
  const b = alongFrom(frame, start + length)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/**
 * The material point at a sheet coordinate, derived straight from the frozen
 * rotary convention (`rotaryFrame.ts`): `a = 360·(across − zero)/C`, and at
 * radius `r` the point is `r·sin a` across the bar and `r·cos a` up. Physical
 * Y is −project Y (the project frame is Y-down), and the bar axis is the
 * project axis, so along `x` the along direction is physical +X and along `y`
 * it is physical −Y. This knows nothing about the builder's slope sign.
 */
function physicalPoint(
  frame: Pick<RotaryPatternFrame, 'axis' | 'zero' | 'circumference'>,
  along: number,
  across: number,
  radius: number,
): { x: number; y: number; z: number } {
  const a = (360 * (across - frame.zero)) / frame.circumference
  const radians = (a * Math.PI) / 180
  if (frame.axis === 'x') return { x: along, y: -radius * Math.sin(radians), z: radius * Math.cos(radians) }
  return { x: radius * Math.sin(radians), y: -along, z: radius * Math.cos(radians) }
}

/** True when the sampled helix is right-handed about the along direction. */
function isRightHanded(frame: RotaryPatternFrame, line: RotarySheetLine): boolean {
  const acrossSpan = line.acrossEnd - line.acrossStart
  if (acrossSpan === 0) return false
  // Sample so the meridian advances 18° between points: far enough from the
  // numerical floor, well short of the 180° where two points share a meridian
  // and the triple product degenerates.
  const step = Math.min(0.1, (0.05 * frame.circumference) / Math.abs(acrossSpan))
  const points = [0.45, 0.45 + step, 0.45 + 2 * step].map((t) => physicalPoint(
    frame,
    line.alongStart + (line.alongEnd - line.alongStart) * t,
    line.acrossStart + acrossSpan * t,
    frame.radius / 2,
  ))
  const first = { x: points[1].x - points[0].x, y: points[1].y - points[0].y, z: points[1].z - points[0].z }
  const second = { x: points[2].x - points[1].x, y: points[2].y - points[1].y, z: points[2].z - points[1].z }
  const cross = {
    x: first.y * second.z - first.z * second.y,
    y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x,
  }
  // The physical travel direction of this line: project X is physical +X, and
  // project Y is physical −Y. Judging the hand fixes the along vector to the
  // direction the line is actually drawn, not to a constant axis sign.
  const projectAlongSign = Math.sign(line.alongEnd - line.alongStart)
  const along = frame.axis === 'x'
    ? { x: projectAlongSign, y: 0, z: 0 }
    : { x: 0, y: -projectAlongSign, z: 0 }
  return cross.x * along.x + cross.y * along.y + cross.z * along.z > 0
}

console.log('Testing frames, sheet mapping and centered zero...')
{
  assert.equal(THREAD_DEPTH_PER_PITCH, 0.61, 'the UI default depth is 0.61 x pitch (a 60 degree thread)')
  const x = frameOf('x')
  assert.deepEqual(x, {
    axis: 'x',
    zero: 50,
    circumference: 40 * Math.PI,
    radius: 20,
    alongOrigin: 10,
    alongDirection: 1,
  })
  const y = frameOf('y')
  near(y.zero, 4, 'Y bar zero is the centreline')
  near(y.circumference, 2 * Math.PI, 'Y bar circumference')
  near(y.radius, 1, 'Y bar radius')
  near(y.alongOrigin, 13, 'Y bar along origin is the chuck end (the stock maximum)')
  assert.equal(y.alongDirection, -1, 'Y bar start runs away from the maximum')
  assert.equal(rotaryPatternFrame(newProject()), null, 'block stock has no pattern frame')

  // Across is the other axis; along is the bar's own axis.
  assert.deepEqual(rotarySheetPoint(x, 12, 50), { x: 12, y: 50 })
  assert.deepEqual(rotarySheetPoint(y, 7, 4), { x: 4, y: 7 })
}

console.log('Testing thread pitch, lead, starts and endpoints...')
{
  for (const axis of ['x', 'y'] as const) {
    const frame = frameOf(axis)
    const depth = axis === 'x' ? 1.2 : 0.2
    // Single start: one full circumference across per pitch along.
    const single = lines(buildRotaryPatternLines(frame, {
      kind: 'thread', start: 25, length: 30, pitch: 2, depth,
    }), `${axis} single`)
    assert.equal(single.length, 1, `${axis}: one start`)
    const singleBand = band(frame, 25, 30)
    near(single[0].alongStart, singleBand.start, `${axis}: requested band start from the chuck end`)
    near(single[0].alongEnd, singleBand.end, `${axis}: requested band end`)
    near(single[0].acrossStart, frame.zero, `${axis}: a single start begins on the zero line`)
    near(
      Math.abs(single[0].acrossEnd - single[0].acrossStart),
      frame.circumference * 30 / 2,
      `${axis}: single-start slope is C per pitch`,
    )
    assert.equal(isRightHanded(frame, single[0]), true, `${axis}: single-start thread is right-hand`)

    // Multiple starts: lead = starts * pitch, and the starts sit C/n apart.
    const triple = lines(buildRotaryPatternLines(frame, {
      kind: 'thread', start: 4, length: 18.5, pitch: 1.25, starts: 3, depth: 0.7,
    }), `${axis} three starts`)
    assert.equal(triple.length, 3, `${axis}: one line per start`)
    for (let index = 1; index < 3; index++) {
      near(
        triple[index].acrossStart - triple[index - 1].acrossStart,
        frame.circumference / 3,
        `${axis}: starts are C/n apart`,
      )
    }
    const expectedAcross = frame.circumference * 18.5 / (3 * 1.25)
    const tripleBand = band(frame, 4, 18.5)
    for (const line of triple) {
      near(line.alongStart, tripleBand.start, `${axis}: multi-start band start`)
      near(line.alongEnd, tripleBand.end, `${axis}: multi-start band end`)
      near(Math.abs(line.acrossEnd - line.acrossStart), expectedAcross, `${axis}: lead is starts*pitch`)
      assert.equal(isRightHanded(frame, line), true, `${axis}: every start is right-hand`)
    }
    assert.equal(typeof rotaryHandedness(axis), 'number')
  }

  // Start 0 is the chuck end on either axis: the minimum on X, the maximum on Y.
  const offOrigin = frameOf('x')
  const late = lines(buildRotaryPatternLines(offOrigin, {
    kind: 'thread', start: 0, length: 5, pitch: 1, depth: 1,
  }), 'bar start')
  near(late[0].alongStart, 10, 'X start 0 sits at the bar minimum')
  const yFrame = frameOf('y')
  const yStart = lines(buildRotaryPatternLines(yFrame, {
    kind: 'thread', start: 0, length: 5, pitch: 1, depth: 0.2,
  }), 'Y bar start')
  near(yStart[0].alongStart, 8, 'Y band runs from the far end of the chuck-end band')
  near(yStart[0].alongEnd, 13, 'Y band reaches the chuck end')
}

console.log('Testing thread hand: left reverses only the physical hand...')
{
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      const frame = frameFor(axis, units)
      const pitch = units === 'mm' ? 2 : 0.05
      const depth = units === 'mm' ? 1.2 : 0.1
      const start = units === 'mm' ? 25 : 1
      const length = units === 'mm' ? 30 : 3
      for (const starts of [1, 3]) {
        const base = { kind: 'thread' as const, start, length, pitch, starts, depth }
        const where = `${axis}/${units}/starts=${starts}`
        const right = lines(buildRotaryPatternLines(frame, { ...base, hand: 'right' }), `${where} right`)
        const omitted = lines(buildRotaryPatternLines(frame, base), `${where} omitted`)
        const left = lines(buildRotaryPatternLines(frame, { ...base, hand: 'left' }), `${where} left`)

        // Omitted is exactly the right hand: the existing default geometry,
        // field for field.
        assert.deepEqual(omitted, right, `${where}: an omitted hand is exactly the right hand`)
        assert.equal(right.length, starts, `${where}: one line per start`)
        assert.equal(left.length, starts, `${where}: the left hand keeps every start`)

        const lead = starts * pitch
        for (let index = 0; index < starts; index++) {
          // Everything but the hand is untouched: the same along endpoints, the
          // same across start (so the C/starts spacing holds) and the same lead
          // magnitude.
          near(left[index].alongStart, right[index].alongStart, `${where}: left keeps the along start`)
          near(left[index].alongEnd, right[index].alongEnd, `${where}: left keeps the along end`)
          near(left[index].acrossStart, right[index].acrossStart, `${where}: left keeps the across start`)
          near(
            left[index].acrossEnd - left[index].acrossStart,
            -(right[index].acrossEnd - right[index].acrossStart),
            `${where}: left negates only the across slope`,
          )
          near(
            Math.abs(right[index].acrossEnd - right[index].acrossStart),
            frame.circumference * length / lead,
            `${where}: lead is starts * pitch`,
          )
          if (index > 0) {
            near(
              left[index].acrossStart - left[index - 1].acrossStart,
              frame.circumference / starts,
              `${where}: the starts stay C/starts apart`,
            )
          }
          // The hand itself, re-derived from physical points instead of the
          // builder's sign constant.
          assert.equal(isRightHanded(frame, right[index]), true, `${where}: the right hand really is right-hand`)
          assert.equal(isRightHanded(frame, omitted[index]), true, `${where}: the default really is right-hand`)
          assert.equal(isRightHanded(frame, left[index]), false, `${where}: the left hand really is left-hand`)
        }
      }
    }
  }
}

console.log('Testing flute count, twist sign and straight flutes...')
{
  for (const axis of ['x', 'y'] as const) {
    const frame = frameOf(axis)
    const count = 4
    const twisted = lines(buildRotaryPatternLines(frame, {
      kind: 'flutes', start: 12, length: 40, count, twist: 1.5, depth: 0.8,
    }), `${axis} twisted flutes`)
    assert.equal(twisted.length, count, `${axis}: one line per flute`)
    for (let index = 1; index < count; index++) {
      near(
        twisted[index].acrossStart - twisted[index - 1].acrossStart,
        frame.circumference / count,
        `${axis}: flutes are C/count apart`,
      )
    }
    const fluteBand = band(frame, 12, 40)
    for (const line of twisted) {
      near(line.alongStart, fluteBand.start, `${axis}: flute band start from the chuck end`)
      near(line.alongEnd, fluteBand.end, `${axis}: flute band end`)
      near(Math.abs(line.acrossEnd - line.acrossStart), 1.5 * frame.circumference, `${axis}: twist*C across`)
      assert.equal(isRightHanded(frame, line), true, `${axis}: positive twist is right-hand`)
    }

    // Negative twist is the other hand; straight is neither.
    const left = lines(buildRotaryPatternLines(frame, {
      kind: 'flutes', start: 0, length: 10, count: 1, twist: -0.75, depth: 0.5,
    }), `${axis} left twist`)
    near(
      left[0].acrossEnd - left[0].acrossStart,
      -rotaryHandedness(axis) * 0.75 * frame.circumference,
      `${axis}: negative twist flips the slope`,
    )
    assert.equal(isRightHanded(frame, left[0]), false, `${axis}: negative twist is left-hand`)

    const straightLine = lines(buildRotaryPatternLines(frame, {
      kind: 'flutes', start: 0, length: 10, count: 3, twist: 0, depth: 0.5,
    }), `${axis} straight flutes`)
    for (const line of straightLine) {
      near(line.acrossStart, line.acrossEnd, `${axis}: straight flute keeps its across coordinate`)
    }
  }
}

console.log('Testing refusals...')
{
  const frame = frameOf('x')
  const cases: Array<[string, ReturnType<typeof buildRotaryPatternLines>]> = [
    ['nonfinite start', buildRotaryPatternLines(frame, { kind: 'thread', start: NaN, length: 5, pitch: 1, depth: 1 })],
    ['negative start', buildRotaryPatternLines(frame, { kind: 'thread', start: -1, length: 5, pitch: 1, depth: 1 })],
    ['zero length', buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 0, pitch: 1, depth: 1 })],
    ['negative length', buildRotaryPatternLines(frame, { kind: 'flutes', start: 0, length: -1, count: 1, twist: 0, depth: 1 })],
    ['zero depth', buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 5, pitch: 1, depth: 0 })],
    ['nonfinite depth', buildRotaryPatternLines(frame, { kind: 'flutes', start: 0, length: 5, count: 1, twist: 0, depth: Infinity })],
    ['depth at the radius', buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 5, pitch: 1, depth: frame.radius })],
    ['depth past the radius', buildRotaryPatternLines(frame, { kind: 'flutes', start: 0, length: 5, count: 1, twist: 0, depth: frame.radius + 1 })],
    ['zero pitch', buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 5, pitch: 0, depth: 1 })],
    ['negative pitch', buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 5, pitch: -1, depth: 1 })],
    ['fractional starts', buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 5, pitch: 1, starts: 1.5, depth: 1 })],
    ['zero starts', buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 5, pitch: 1, starts: 0, depth: 1 })],
    ['fractional count', buildRotaryPatternLines(frame, { kind: 'flutes', start: 0, length: 5, count: 2.5, twist: 1, depth: 1 })],
    ['nonfinite twist', buildRotaryPatternLines(frame, { kind: 'flutes', start: 0, length: 5, count: 2, twist: NaN, depth: 1 })],
  ]
  for (const [label, result] of cases) {
    assert.equal(result.ok, false, `${label} is refused`)
  }
  assert.equal(
    (buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 5, pitch: 1, depth: frame.radius }) as { reason: string }).reason,
    'depthReachesCentreline',
    'a depth exactly at the radius is refused as reaching the centreline',
  )
  // Just inside the radius is accepted, just outside is not.
  assert.equal(buildRotaryPatternLines(frame, { kind: 'thread', start: 0, length: 5, pitch: 1, depth: frame.radius - 1e-9 }).ok, true)
  assert.equal(buildRotaryPatternLines(frame, { kind: 'flutes', start: 0, length: 5, count: 1, twist: 0, depth: frame.radius + 1e-9 }).ok, false)
}

console.log('All rotary pattern helper tests passed.')
