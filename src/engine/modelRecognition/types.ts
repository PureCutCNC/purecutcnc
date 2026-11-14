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

import type { Point, SketchProfile } from '../../types/project'

/**
 * A triangle mesh **in the frame of one face**: Z points at the tool, so the
 * detector looks straight down -Z. Putting a model into that frame (instance
 * transform, orientation, a Bottom setup's turn, the Around unroll) is the
 * caller's job; nothing in this folder knows about faces.
 */
export interface RecognitionMesh {
  positions: Float32Array
  index: Uint32Array
}

/** A round outline, kept beside the profile so a caller can make a `circle` feature. */
export interface RecognizedCircle {
  center: Point
  radius: number
}

/**
 * What a cavity's straight walls end on.
 *
 * - `through`: they reach the model's underside.
 * - `flat`: a flat floor (which may itself have deeper openings in it).
 * - `taper`: the void goes on below but narrows — a drill-point cone, a floor
 *   fillet. `zBottom` is where the walls stop being vertical.
 * - `open`: the void goes on below and is at least as wide — the neck of a
 *   T-slot, a hole into a hollow.
 */
export type CavityBottom = 'through' | 'flat' | 'taper' | 'open'

/** Material standing inside a cavity (a boss in a pocket). */
export interface RecognizedIsland {
  profile: SketchProfile
  outline: Point[]
  circle: RecognizedCircle | null
  zBottom: number
  /**
   * The highest level with material inside the outline, so a chamfered or
   * domed top is kept whole rather than cut off at the end of the straight wall.
   */
  zTop: number
}

/** One enclosed void with vertical walls that the tool can reach from above. */
export interface RecognizedCavity {
  /** `hole` when the outline is a circle, `pocket` otherwise. */
  shape: 'hole' | 'pocket'
  bottom: CavityBottom
  profile: SketchProfile
  /** The outline as a plain polygon, counter-clockwise in the mesh's XY. */
  outline: Point[]
  circle: RecognizedCircle | null
  zBottom: number
  zTop: number
  islands: RecognizedIsland[]
  /**
   * True when the span was carried up through a band whose walls are not
   * vertical (a chamfered or rounded rim). The outline is the straight part's.
   */
  flaredAbove: boolean
}

/**
 * Why a void was seen but not returned as a cavity.
 *
 * - `undercut`: material covers part of it from above.
 * - `taperedWalls`: its walls are never vertical (draft, a cone, a dome).
 * - `openMesh`: a section through it has an unclosed contour.
 */
export type SkipReason = 'undercut' | 'taperedWalls' | 'openMesh'

export interface SkippedCavity {
  reason: SkipReason
  outline: Point[]
  zBottom: number
  zTop: number
}

export interface ModelRecognitionResult {
  cavities: RecognizedCavity[]
  skipped: SkippedCavity[]
  /**
   * True when the mesh had more candidate levels than the detector examines
   * (a relief with hundreds of flat steps). The result is then incomplete.
   */
  levelsTruncated: boolean
  /**
   * True when any section had an unclosed contour. A void whose own wall has
   * the gap leaves no loop at all, so it is missing from both lists; this is
   * the only sign of it.
   */
  meshOpen: boolean
}
