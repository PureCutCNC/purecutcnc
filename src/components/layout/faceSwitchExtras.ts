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

import type { SetupFace, SetupOrientation } from '../../types/project'

/** The stock axis a Bottom setup turns the part about. */
export type FlipAxis = SetupOrientation['axis']

export interface FaceSwitchExtrasInput {
  /** The face the workspace is drawing on. */
  face: SetupFace
  /** Whether the project carries both faces: a flip only then. */
  bothFaces: boolean
  /** The active setup's flip axis. */
  axis: FlipAxis
}

/** What the switch carries beyond its segments (issue #1102 slice E). */
export interface FaceSwitchExtras {
  /**
   * The axis of the short "Flipped about X/Y" chip to show after the segments
   * and the Other side toggle, or null when there is no flip to report.
   */
  flipChip: FlipAxis | null
}

/**
 * The switch's extras: a Bottom view is the only place the stock is turned,
 * and only once both faces are in use — on a Top-only project there is no
 * flip to explain and no second face to reach.
 */
export function faceSwitchExtras({ face, bothFaces, axis }: FaceSwitchExtrasInput): FaceSwitchExtras {
  return { flipChip: face === 'bottom' && bothFaces ? axis : null }
}
