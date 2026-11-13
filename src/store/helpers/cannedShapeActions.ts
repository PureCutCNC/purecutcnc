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
 * What a Move and the three transforms (Resize, Rotate, Mirror) mean for a
 * canned rotary shape (issue #1112 rt7-f, item 42 retest).
 *
 * Frank: "copy is allowed in top and Around, but move is only in Top for all
 * rotary features. we should allow move in the Around ... Also the rotate,
 * resize, mirror should probably not be allowed in the context menu (resize
 * should point to the edit, others not allowed ...)".
 *
 * Two rules, and this is the one home for both so the context menu, the
 * toolbar, the keyboard commands and the store action cannot disagree:
 *
 * 1. **Move is a bar edit, not a face edit.** A Turn, Polygon, Thread or Flutes
 *    stores its band as a start/length from the chuck end, and `rotaryMove.ts`
 *    is the one rule for moving it — a start along the bar, projected, clamped
 *    and with the across part kept only where the commit has always kept it.
 *    That edit belongs to the bar's own coordinates and reads the same on Top
 *    and on the Around sheet (which is stock X/Y, unrolled across), so the
 *    authoring face says nothing about whether it may run. The menu therefore
 *    drops its other-face refusal for a selection made only of these four
 *    kinds — the same reasoning that offers "Edit {shape}…" on every face
 *    (rt7-c). A selection holding anything else keeps the generic 2D move,
 *    where one displacement still has to mean one thing, so it keeps the face's
 *    refusal (`rotaryMoveAxis` is the same "every row" rule).
 *
 * 2. **Resize, Rotate and Mirror cannot be expressed by a generated shape.** A
 *    Thread's diameter is its Depth over the surface it sits on, a Turn's band
 *    is its start/length — none of them is a 2D offset a transform could scale
 *    or turn without disagreeing with the parameters. So the three are refused
 *    for the four rotary kinds, and the *reason* is what each entry point
 *    shows: Rotate and Mirror say what Offset/Join already say ("Expand to
 *    features first"), while Resize names the editor that does own the size
 *    ("Change the size in Edit Thread…"), because that editor is reachable from
 *    every face. Every other canned kind (an ellipse, a slot…) keeps today's
 *    behaviour: its outline is a plain profile and the transforms still apply.
 *
 * The refusals are answered here as a reason discriminator, never as a
 * sentence: the text is the locales' business, and the callers pass the same
 * key through `t`.
 */

import type { CannedShapeData, Project } from '../../types/project'
import { cannedShapeLabelKey } from '../../cannedShapes'
import { isBarStock } from '../../types/barStock'
import { ROTARY_MOVE_KINDS } from './rotaryMove'

/** The transform actions a rotary canned shape refuses. */
export type CannedShapeTransformAction = 'resize' | 'rotate' | 'mirror'

/**
 * Why a transform cannot start on this selection.
 *
 * `useEditor` carries the label key of the shape whose own editor does own the
 * value. `expand` is the shared generated-shape refusal the menu already shows
 * for Offset and Join.
 */
export type CannedShapeTransformRefusal =
  | { readonly reason: 'useEditor'; readonly shapeKey: string | null }
  | { readonly reason: 'expand' }

/** The part of a feature these rules read: whether it is a generated shape, and which kind. */
export interface CannedActionFeature {
  canned?: CannedShapeData | null
}

/**
 * True for the four canned kinds whose band lies on the bar — Turn, Polygon,
 * Thread, Flutes. The same set `rotaryMove.ts` moves, read from one place so a
 * kind added to the move rule cannot silently keep Rotate.
 */
export function isRotaryCannedFeature(feature: CannedActionFeature | null | undefined): boolean {
  return !!feature?.canned && ROTARY_MOVE_KINDS.includes(feature.canned.kind)
}

/**
 * True when a Move of this selection is the canned rotary band move: a bar, and
 * every selected row one of the four kinds.
 *
 * This is the condition under which Move is offered on any face. It is
 * deliberately "every row", not "some": a mixed selection falls back to the
 * generic 2D move, which the authoring face still gates.
 */
export function isRotaryCannedMoveSelection(
  project: Pick<Project, 'stock'>,
  features: readonly CannedActionFeature[],
): boolean {
  if (features.length === 0) return false
  if (!isBarStock(project.stock)) return false
  return features.every(isRotaryCannedFeature)
}

/** True when the selection holds at least one of the four rotary kinds. */
export function hasRotaryCannedFeature(features: readonly CannedActionFeature[]): boolean {
  return features.some(isRotaryCannedFeature)
}

/**
 * The refusal one of the three transforms gets on this selection, or `null`
 * when it may run.
 *
 * `features` is read in priority order: a Resize names the editor of the first
 * rotary canned row, so a caller passes the primary (right-clicked) row first.
 */
export function cannedShapeTransformRefusal(
  features: readonly CannedActionFeature[],
  action: CannedShapeTransformAction,
): CannedShapeTransformRefusal | null {
  const rotary = features.filter(isRotaryCannedFeature)
  if (rotary.length === 0) return null
  if (action !== 'resize') return { reason: 'expand' }
  return { reason: 'useEditor', shapeKey: cannedShapeLabelKey(rotary[0].canned) }
}
