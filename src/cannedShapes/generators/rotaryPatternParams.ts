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
 * Shared parameter validation for the rotary canned shapes (issue #1112 F).
 *
 * Thread and Flutes both store the Around frame they were drawn against next
 * to their own numbers. That snapshot is what makes the stored parameters
 * regenerate every line deterministically: unlike the gear, the geometry
 * depends on the bar's circumference and its absolute position along the bar,
 * and a generator is not given the project when it runs.
 */

import type { CannedShapeParams } from '../../types/project'
import type { RotaryPatternFrame } from '../../engine/rotaryPatterns'

/** The frame fields stored inside a rotary shape's parameters. */
export type StoredRotaryPatternFrame = RotaryPatternFrame

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** True when `value` is a complete, usable stored frame. */
export function isStoredRotaryPatternFrame(value: unknown): value is StoredRotaryPatternFrame {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return (frame.axis === 'x' || frame.axis === 'y')
    && (frame.alongDirection === 1 || frame.alongDirection === -1)
    && isFiniteNumber(frame.zero)
    && isFiniteNumber(frame.circumference)
    && isFiniteNumber(frame.radius)
    && isFiniteNumber(frame.alongOrigin)
    && frame.circumference > 0
    && frame.radius > 0
}

/** A deep copy of the frame, so a definition never shares one params object. */
export function cloneStoredRotaryPatternFrame(frame: StoredRotaryPatternFrame): StoredRotaryPatternFrame {
  return {
    axis: frame.axis,
    zero: frame.zero,
    circumference: frame.circumference,
    radius: frame.radius,
    alongOrigin: frame.alongOrigin,
    alongDirection: frame.alongDirection,
  }
}

/** Convert the frame's length fields when the project changes units. */
export function convertStoredRotaryPatternFrame(
  frame: StoredRotaryPatternFrame,
  convertLength: (value: number) => number,
): StoredRotaryPatternFrame {
  return {
    ...frame,
    zero: convertLength(frame.zero),
    circumference: convertLength(frame.circumference),
    radius: convertLength(frame.radius),
    alongOrigin: convertLength(frame.alongOrigin),
  }
}

/** True when every named field is a finite number. */
export function hasFiniteNumbers(params: CannedShapeParams, keys: readonly string[]): boolean {
  return keys.every((key) => isFiniteNumber(params[key]))
}

/** The frame if the parameter set carries one, otherwise null. */
export function storedFrameOf(params: CannedShapeParams): StoredRotaryPatternFrame | null {
  return isStoredRotaryPatternFrame(params.frame) ? params.frame : null
}
