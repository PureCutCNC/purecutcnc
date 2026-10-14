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

export function simulationBarAngle(pose: { x: number; y: number }, frame: AroundFrame): number {
  return 360 * ((frame.axis === 'x' ? pose.y : pose.x) - frame.sheetStart) / frame.circumference
}
