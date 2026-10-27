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
 * Built-in canned-shape generators.
 *
 * Slices D–G add their generator module here: export it from its own file and
 * append it to this list. Nothing else in the model changes. The registry seeds
 * its map from this list at module load, so a saved project's shapes are
 * available after a reload without any UI having opened.
 *
 * Slice A ships no real shape deliberately; slice D adds the five flat shapes,
 * slice E the gear and slice F the Around Thread and Flutes.
 */

import type { RegisteredCannedShapeGenerator } from '../types'
import { ellipseCannedShape } from './ellipse'
import { slotCannedShape } from './slot'
import { ngonCannedShape } from './ngon'
import { roundRectCannedShape } from './roundRect'
import { chamferRectCannedShape } from './chamferRect'
import { gearCannedShape } from './gear'
import { threadCannedShape } from './thread'
import { flutesCannedShape } from './flutes'

export const BUILT_IN_CANNED_SHAPES: readonly RegisteredCannedShapeGenerator[] = [
  ellipseCannedShape,
  slotCannedShape,
  ngonCannedShape,
  roundRectCannedShape,
  chamferRectCannedShape,
  gearCannedShape,
  threadCannedShape,
  flutesCannedShape,
]
