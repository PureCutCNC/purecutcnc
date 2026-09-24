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

// The serializable form of a nest request, for running the packer in a worker.
// Functions cannot cross postMessage, so the caller's growth strategy travels
// as data and is rebuilt on the other side.

import { expandByHalfGap, largestFirst } from './defaults'
import type { NestGravity, NestPart, NestRequest, NestRing } from './types'

export interface NestJob {
  sheet: NestRing
  obstacles: NestRing[]
  parts: NestPart[]
  minimumGap: number
  /**
   * Extra growth per side on top of half the gap — the flattening chord
   * tolerance, so curves flattened for packing never cost clearance.
   */
  growthPadding: number
  /**
   * Grown footprints are simplified within this tolerance (and padded for it)
   * before packing. Fewer vertices make every no-fit polygon cheaper — glyph
   * outlines went from 30 s to 1.2 s for an alphabet (#855). 0 disables it.
   */
  simplifyTolerance?: number
  gravity?: NestGravity
}

/** Rebuilds the packer request: grow by half the gap plus the padding, largest parts first. */
export function requestFromJob(job: NestJob): NestRequest {
  return {
    sheet: job.sheet,
    obstacles: job.obstacles,
    parts: job.parts,
    minimumGap: job.minimumGap,
    expandFootprint: (rings, minimumGap) => expandByHalfGap(
      rings,
      minimumGap + 2 * job.growthPadding,
      job.simplifyTolerance ?? 0,
    ),
    orderParts: largestFirst,
    gravity: job.gravity,
  }
}
