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

import type { RotaryPassDirection } from '../../types/project'
import type { RotaryModelMesh } from './rotarySampling'

export interface RotaryFinishParams {
  /** Distance between passes, measured round the bar's surface. */
  readonly stepover: number
  /**
   * Distance between samples along a pass. In around mode it is the angular
   * step round the blank, capped so the straight move between two samples stays
   * within 0.005 mm of a convex section (#1045 slice D).
   */
  readonly sampleSpacing: number
  /** Material left on the model, measured normal to its surface. */
  readonly stockToLeave: number
  /** The along range the passes cover; the caller (a later slice) derives it from the model and the end supports. */
  readonly alongStart: number
  readonly alongEnd: number
  /**
   * Tool-tip radius from the turning pivot for the operation's first
   * positioning move and its final retract; must be above the blank's surface.
   * Every move between runs -- a retract, a traverse or a turning link --
   * travels at the blank's largest surface plus a clearance, and the first and
   * last moves go to the higher of this and that clearance.
   */
  readonly safeRadius: number
  /** Requested height-map cell size, passed to the sampler. */
  readonly requestedCellSize: number
  /**
   * Whether each pass runs along the bar (the original motion) or around it: a
   * ring at one along position, turning A round the bar, then a step along
   * (#1045 slice A). Missing reads as `'along'`, so a saved operation's motion
   * is unchanged.
   */
  readonly passDirection?: RotaryPassDirection
  /**
   * The operation target's region features as one mask, in the Around sheet's
   * **unwrapped** coordinates (#1096): along is the bar's axis, across is
   * `zero + a * pi * thickness / 360` -- the same convention the 2.5D Around
   * operations use. Omitted or null means no region and cuts the whole sampled
   * surface exactly as before.
   */
  readonly region?: RotaryRegionMask | null
  /**
   * The other STL models standing on the bar, which this operation must not cut
   * into (#1155). They are held **apart from** the target `mesh` so the along
   * range, the `rotaryModelOutsideBar` warning and the target ids stay the
   * operation's own; the sampler joins them after the target and before the
   * retained bar stubs. Omitted or empty is the target-only surface, byte for
   * byte.
   */
  readonly neighbours?: readonly RotaryModelMesh[]
}

/**
 * A region mask in the Around sheet's unwrapped coordinates (#1096).
 *
 * `RegionMask` in `regions.ts` satisfies this structurally, so the rotary
 * engine does not depend on Clipper. A **cut** link is a straight segment, and
 * a mask that can prove a whole segment inside answers that as well; point
 * membership alone is not enough there, because a strip narrower than the
 * sampling can fall between two tested points (#1096 review, P2).
 */
export interface RotaryRegionMask {
  containsPoint(point: { x: number; y: number }): boolean
  containsSegment?(from: { x: number; y: number }, to: { x: number; y: number }): boolean
}

export interface RotaryRoughParams extends RotaryFinishParams {
  /** Radial depth of each layer. */
  readonly stepdown: number
}
