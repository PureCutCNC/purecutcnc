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

import { spanFromFaceDepth } from '../../engine/setupOrientation'
import type { StockZSpan } from '../../engine/setupOrientation'
import type { FlippedZRange } from '../../store/helpers/activeFace'
import type { Stock } from '../../types/project'

/** One Bottom feature as the Z range control sees it (issue #945). */
export interface FaceZRow {
  featureId: string
  /** The stored stock-space span. */
  span: StockZSpan
  /** The span as shown: the stock flipped, bottom face up. */
  z: FlippedZRange
  /** Open paths and Lines engrave on one surface: only their top is theirs to set. */
  surfaceOnly: boolean
}

export interface FaceZWrite {
  featureId: string
  patch: { z_top?: number; z_bottom?: number }
}

const EPSILON = 1e-9

/** Drop the float noise `thickness − z` leaves behind, far below any real length. */
function tidy(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

/**
 * The stock-space writes for an edit of the flipped Z range, or null when the
 * edit would turn any span inside out — it is refused, never swapped.
 *
 * Only the side an edit changed is written, so the untouched side keeps its
 * stored value, a named dimension included. One case needs both: a Line or
 * open path runs from its surface to the far face, and one moved here from
 * Top still carries a Top span, whose far side is somewhere else. Writing
 * only its surface would leave a span the store has to swap, so when its top
 * is edited the far side is put at the far face as well.
 */
export function planFaceZEdit(
  rows: readonly FaceZRow[],
  patch: { top?: number; bottom?: number },
  stock: Pick<Stock, 'thickness'>,
): FaceZWrite[] | null {
  const writes: FaceZWrite[] = []
  for (const row of rows) {
    const top = patch.top ?? row.z.top
    const bottom = row.surfaceOnly ? 0 : (patch.bottom ?? row.z.bottom)
    // Flipped height back to a depth from the bottom face.
    const span = spanFromFaceDepth({ start: stock.thickness - top, end: stock.thickness - bottom }, 'bottom', stock)
    if (!span) return null
    const next: FaceZWrite['patch'] = {}
    if (patch.bottom !== undefined && !row.surfaceOnly) next.z_top = tidy(span.z_top)
    if (patch.top !== undefined) {
      next.z_bottom = tidy(span.z_bottom)
      if (row.surfaceOnly && Math.abs(row.span.z_top - span.z_top) > EPSILON) next.z_top = tidy(span.z_top)
    }
    if (next.z_top !== undefined || next.z_bottom !== undefined) writes.push({ featureId: row.featureId, patch: next })
  }
  return writes
}
