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
import { useI18n } from '../../i18n/i18nContext'
import { flippedZRange, resolveStockSpan } from '../../store/helpers/activeFace'
import type { FlippedZRange } from '../../store/helpers/activeFace'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { useProjectStore } from '../../store/projectStore'
import { convertLength, formatLength } from '../../utils/units'
import { ZRangeSlider } from './ZRangeSlider'

interface FaceZRangeProps {
  /** The selected machinable features, all authored on the Bottom face. */
  features: readonly ResolvedSketchFeature[]
}

interface Row {
  feature: ResolvedSketchFeature
  span: StockZSpan
  z: FlippedZRange
  /** Open paths and Lines engrave on one surface: only their top is theirs to set. */
  surfaceOnly: boolean
}

function common(values: readonly number[]): number | null {
  return values.length > 0 && values.every((value) => Math.abs(value - values[0]) < 1e-9) ? values[0] : null
}

/** Drop the float noise `thickness − z` leaves behind, far below any real length. */
function tidy(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

/**
 * The Z range of features authored on the Bottom face (issue #945). It is the
 * same control Top features use and it reads the same way: Z is the height
 * above the table as the stock sits on the machine — flipped, bottom face up —
 * so a pocket cut 0.25 deep from the bottom of 0.75 stock reads 0.75 → 0.5,
 * exactly as that pocket reads on Top.
 *
 * It is a view of the stored stock span, which is shown beneath it: every
 * edit goes back through `spanFromFaceDepth`, an entry that would turn the
 * span inside out is refused rather than swapped, and only the side that
 * changed is written.
 */
export function FaceZRange({ features }: FaceZRangeProps) {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const updateFeature = useProjectStore((state) => state.updateFeature)
  const beginHistoryTransaction = useProjectStore((state) => state.beginHistoryTransaction)
  const commitHistoryTransaction = useProjectStore((state) => state.commitHistoryTransaction)
  const units = project.meta.units
  const stock = project.stock
  const thickness = stock.thickness

  const rows: Row[] = features.flatMap((feature) => {
    const span = resolveStockSpan(project, feature)
    return span
      ? [{
          feature,
          span,
          z: flippedZRange(span, stock),
          surfaceOnly: !feature.sketch.profile.closed || feature.operation === 'line',
        }]
      : []
  })
  if (rows.length === 0) return null
  const solidRows = rows.filter((row) => !row.surfaceOnly)
  // Like Top: with only open paths selected the bottom sits on the table and is locked.
  const bottomLocked = solidRows.length === 0

  function commit(patch: { top?: number; bottom?: number }): boolean {
    const planned: Array<{ row: Row; span: StockZSpan }> = []
    for (const row of rows) {
      const top = patch.top ?? row.z.top
      const bottom = row.surfaceOnly ? 0 : (patch.bottom ?? row.z.bottom)
      // Flipped height back to a depth from the bottom face.
      const span = spanFromFaceDepth({ start: thickness - top, end: thickness - bottom }, 'bottom', stock)
      if (!span) return false
      planned.push({ row, span })
    }
    beginHistoryTransaction()
    for (const { row, span } of planned) {
      // Write back only the side the edit changed, so the untouched side
      // keeps its stored value — a named dimension included.
      const next: { z_top?: number; z_bottom?: number } = {}
      if (patch.bottom !== undefined && !row.surfaceOnly) next.z_top = tidy(span.z_top)
      if (patch.top !== undefined) next.z_bottom = tidy(span.z_bottom)
      if (next.z_top !== undefined || next.z_bottom !== undefined) updateFeature(row.feature.id, next)
    }
    commitHistoryTransaction()
    return true
  }

  const spanBottom = common(rows.map((row) => row.span.z_bottom))
  const spanTop = common(rows.map((row) => row.span.z_top))
  const mixed = t('featureTree.properties.select.mixedValues')

  return (
    <div className="face-z-range" data-face="bottom">
      <ZRangeSlider
        selectionKey={`face-${rows.map((row) => row.feature.id).join(',')}`}
        zTop={common(rows.map((row) => row.z.top))}
        zBottom={bottomLocked ? 0 : common(solidRows.map((row) => row.z.bottom))}
        domainMin={0}
        domainMax={Math.max(
          thickness,
          ...rows.map((row) => row.z.top),
          ...solidRows.map((row) => row.z.bottom),
          convertLength(1, 'mm', units),
        )}
        units={units}
        bottomLocked={bottomLocked}
        mixedPlaceholder={mixed}
        onCommit={commit}
      />
      <label className="properties-field">
        <span>{t('featureTree.face.stockSpan')}</span>
        <div className="properties-locked-field face-z-range__span" data-testid="stock-z-span">
          <span>
            {spanBottom === null || spanTop === null
              ? mixed
              : `${formatLength(spanTop, units)} → ${formatLength(spanBottom, units)} ${units === 'inch' ? 'in' : 'mm'}`}
          </span>
        </div>
      </label>
      <p className="face-z-range__hint">{t('featureTree.face.zHintBottom')}</p>
    </div>
  )
}
