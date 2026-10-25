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

import type { Bounds2D, SetupFace } from '../../types/project'

/**
 * What the setup properties dialog shows for a face (issue #1102).
 *
 * A Top setup only has a face and an origin; its flip axis and registration
 * are fixed no-ops, so the dialog hides them and the stored values pass
 * through untouched. A Bottom setup is the flip, so it shows all of them.
 * An Around setup is not a flip at all: only its name and notes are written.
 */
export function setupDialogSections(face: SetupFace): { flip: boolean; registration: boolean; faceUp: boolean } {
  const flip = face === 'bottom'
  return { flip, registration: flip, faceUp: face !== 'around' }
}

/**
 * A stock-space point as the operator measures it (issue #1102): X and Y from
 * the stock's front-left corner in machine directions (+X right, +Y away from
 * the operator), Z up from the bottom of the stock. Sketch Y grows towards the
 * front, so Y is flipped; the setup program header describes the origin the
 * same way (`describeTouchOff`).
 */
export function originFromFrontLeft(
  point: { x: number; y: number; z: number },
  bounds: Pick<Bounds2D, 'minX' | 'maxY'>,
): { x: number; y: number; z: number } {
  return { x: point.x - bounds.minX, y: bounds.maxY - point.y, z: point.z }
}
