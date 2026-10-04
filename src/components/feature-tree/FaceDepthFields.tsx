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

import { depthFromFace, spanFromFaceDepth } from '../../engine/setupOrientation'
import type { FaceDepthSpan, StockZSpan } from '../../engine/setupOrientation'
import { useI18n } from '../../i18n/i18nContext'
import { resolveStockSpan } from '../../store/helpers/activeFace'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { useProjectStore } from '../../store/projectStore'
import type { SetupFace } from '../../types/project'
import { formatLength } from '../../utils/units'
import { DraftNumberInput } from './DraftNumberInput'

interface FaceDepthFieldsProps {
  /** The selected machinable features, all authored on the Bottom face. */
  features: readonly ResolvedSketchFeature[]
}

// Top keeps its Z-range slider; these fields are how a Bottom feature is dimensioned.
const FACE: SetupFace = 'bottom'

interface DepthRow {
  feature: ResolvedSketchFeature
  span: StockZSpan
  depth: FaceDepthSpan
  /** Open paths and Lines engrave on one surface: only where they start is theirs to set. */
  surfaceOnly: boolean
}

function common(values: readonly number[]): number | null {
  return values.length > 0 && values.every((value) => Math.abs(value - values[0]) < 1e-9) ? values[0] : null
}

/**
 * Depth entered from the bottom face, for features authored there (issue #945). The
 * fields are a view of the stored stock span: every edit goes back through
 * `spanFromFaceDepth`, an entry that would turn the span inside out is
 * refused rather than swapped, and only the side that changed is written.
 */
export function FaceDepthFields({ features }: FaceDepthFieldsProps) {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const updateFeature = useProjectStore((state) => state.updateFeature)
  const beginHistoryTransaction = useProjectStore((state) => state.beginHistoryTransaction)
  const commitHistoryTransaction = useProjectStore((state) => state.commitHistoryTransaction)
  const units = project.meta.units
  const stock = project.stock

  const rows: DepthRow[] = features.flatMap((feature) => {
    const span = resolveStockSpan(project, feature)
    return span
      ? [{
          feature,
          span,
          depth: depthFromFace(span, FACE, stock),
          surfaceOnly: !feature.sketch.profile.closed || feature.operation === 'line',
        }]
      : []
  })
  if (rows.length === 0) return null
  const solidRows = rows.filter((row) => !row.surfaceOnly)

  /** The span each row would get, or null when any of them refuses the entry. */
  function plan(next: (row: DepthRow) => FaceDepthSpan | null): Array<{ row: DepthRow; span: StockZSpan }> | null {
    const planned: Array<{ row: DepthRow; span: StockZSpan }> = []
    for (const row of rows) {
      const depth = next(row)
      if (!depth) continue
      const span = spanFromFaceDepth(depth, FACE, stock)
      if (!span) return null
      planned.push({ row, span })
    }
    return planned
  }

  function commit(planned: Array<{ row: DepthRow; span: StockZSpan }> | null) {
    if (!planned) return
    beginHistoryTransaction()
    for (const { row, span } of planned) {
      // Write back only the side the entry changed, so the untouched side
      // keeps its stored value — a named dimension included.
      const patch: { z_top?: number; z_bottom?: number } = {}
      if (span.z_top !== row.span.z_top) patch.z_top = span.z_top
      if (span.z_bottom !== row.span.z_bottom) patch.z_bottom = span.z_bottom
      if (patch.z_top !== undefined || patch.z_bottom !== undefined) updateFeature(row.feature.id, patch)
    }
    commitHistoryTransaction()
  }

  // A surface-only feature runs from its surface to the far face.
  const withStart = (row: DepthRow, start: number): FaceDepthSpan => (
    row.surfaceOnly ? { start, end: Math.max(stock.thickness, start) } : { start, end: row.depth.end }
  )
  const withEnd = (row: DepthRow, end: number): FaceDepthSpan | null => (
    row.surfaceOnly ? null : { start: row.depth.start, end }
  )

  const startValue = common(rows.map((row) => row.depth.start))
  const endValue = common(solidRows.map((row) => row.depth.end))
  const spanBottom = common(rows.map((row) => row.span.z_bottom))
  const spanTop = common(rows.map((row) => row.span.z_top))
  const mixed = t('featureTree.properties.select.mixedValues')
  const key = rows.map((row) => `${row.feature.id}:${row.span.z_bottom}:${row.span.z_top}`).join('|')

  return (
    <div className="face-depth" data-face={FACE}>
      {solidRows.length > 0 ? (
        <label className="properties-field">
          <span>{t('featureTree.face.depthFromBottom')}</span>
          <DraftNumberInput
            key={`end-${key}`}
            value={endValue}
            units={units}
            placeholder={endValue === null ? mixed : undefined}
            validate={(value) => plan((row) => withEnd(row, value)) !== null}
            onCommit={(value) => commit(plan((row) => withEnd(row, value)))}
          />
        </label>
      ) : null}
      <label className="properties-field">
        <span>{t(solidRows.length > 0 ? 'featureTree.face.startFromBottom' : 'featureTree.face.surfaceFromBottom')}</span>
        <DraftNumberInput
          key={`start-${key}`}
          value={startValue}
          units={units}
          placeholder={startValue === null ? mixed : undefined}
          validate={(value) => plan((row) => withStart(row, value)) !== null}
          onCommit={(value) => commit(plan((row) => withStart(row, value)))}
        />
      </label>
      <label className="properties-field">
        <span>{t('featureTree.face.stockSpan')}</span>
        <div className="properties-locked-field face-depth__span" data-testid="stock-z-span">
          <span>
            {spanBottom === null || spanTop === null
              ? mixed
              : `${formatLength(spanBottom, units)} → ${formatLength(spanTop, units)} ${units === 'inch' ? 'in' : 'mm'}`}
          </span>
        </div>
      </label>
      <p className="face-depth__hint">
        {t('featureTree.face.depthHintBottom')}
      </p>
    </div>
  )
}
