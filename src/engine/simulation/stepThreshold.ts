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
 * A height change at or below this many cells across one edge, between two
 * cells that both still hold material, is always shaded as a slope. A ball
 * finish on large stock samples each scallop with only two or three cells, so
 * the gradient reverses at nearly every edge and no neighbor "continues" it;
 * without this bound those edges were drawn as risers and the finished surface
 * turned into a grid of flat squares (issue #939). The steepest edge a scallop
 * can produce is stepover / tool diameter cells tall, so half a cell covers
 * ball finishing up to roughly 45 % stepover.
 *
 * The heights cannot tell a scallop from a real step that shallow, so the rule
 * covers both: a pocket at or below half a cell deep, or a tab within half a
 * cell of the part's top, keeps its riser but has it lit as surface rather than
 * as a crisp wall. A step onto a through cut is exempt and always a wall.
 */
export const SHALLOW_SLOPE_CELLS = 0.5
