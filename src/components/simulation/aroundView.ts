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

import * as THREE from 'three'
import { wrapPoint, type AroundFrame } from '../../engine/aroundFrame'

/**
 * A stable key of a frame's values (issue #395 G3). `SimulationBar` and its
 * `frame` are rebuilt whenever the model's setup input is recomputed, so the
 * viewport keys its Around effects on this string and never on the object's
 * identity: an unrelated project edit must not tear the turn group down or
 * re-frame the camera. `undefined` (a flat setup) keys as `''`.
 */
export function aroundFrameKey(frame: AroundFrame | undefined): string {
  if (!frame) return ''
  return `${frame.axis}:${frame.centre}:${frame.radius}:${frame.sheetStart}:${frame.circumference}`
}

/** Two frames are the same setup when every value the viewport draws with matches. */
export function sameAroundFrame(a: AroundFrame | undefined, b: AroundFrame | undefined): boolean {
  return aroundFrameKey(a) === aroundFrameKey(b)
}

/** Pivot in viewport (x, z, y) space; children retain their stock coordinates. */
export function createBarTurnGroup(frame: AroundFrame): { pivot: THREE.Group; content: THREE.Group } {
  const pivot = new THREE.Group()
  const content = new THREE.Group()
  if (frame.axis === 'x') pivot.position.set(0, frame.radius, frame.centre)
  else pivot.position.set(frame.centre, frame.radius, 0)
  content.position.copy(pivot.position).negate()
  pivot.add(content)
  return { pivot, content }
}

/** Inverse of stockSpacePoint, with the frozen sign mapped to world Y-up. */
export function turnSimulationBar(pivot: THREE.Group, angle: number, frame: AroundFrame): void {
  const radians = angle * Math.PI / 180
  pivot.rotation.set(frame.axis === 'x' ? -radians : 0, 0, frame.axis === 'y' ? radians : 0)
}

export function simulationToolPoint(pose: { x: number; y: number; z: number }, frame?: AroundFrame): THREE.Vector3 {
  const point = frame ? wrapPoint(pose, frame) : pose
  return new THREE.Vector3(point.x, point.z, point.y)
}

export function simulationBarAngle(pose: { x: number; y: number; a?: number }, frame: AroundFrame): number {
  // The program's own angle is the truth when the pose carries it — a folded
  // point's across coordinate names the same angle mod one turn, so using it
  // leaves the picture unchanged (issue #395). The across coordinate is the
  // fallback for a pose with no rotary component.
  if (pose.a !== undefined) return pose.a
  return 360 * ((frame.axis === 'x' ? pose.y : pose.x) - frame.sheetStart) / frame.circumference
}

/** The bar view's readout (issue #395): the tool as the program has it. */
export interface BarReadout {
  x: number
  y: number
  z: number
  /** The program's angle in degrees; absent when the move carries none. */
  a?: number
}

/**
 * The bar view's X, Y, Z and A. X, Y and Z are the wrapped tool point relative
 * to the real project origin with the same sign rule the flat readout uses —
 * Y inverted because project space increases downward — so Y reads the bar's
 * centreline, constant while the bar turns, and Z is the real height. A is the
 * program's angle, never reduced to one turn, and is absent (no key) when the
 * pose has no rotary component.
 */
export function barReadout(
  pose: { x: number; y: number; z: number; a?: number },
  frame: AroundFrame,
  origin: { x: number; y: number; z: number },
): BarReadout {
  const wrapped = wrapPoint(pose, frame)
  return {
    x: wrapped.x - origin.x,
    y: origin.y - wrapped.y,
    z: wrapped.z - origin.z,
    ...(pose.a !== undefined ? { a: pose.a } : {}),
  }
}
