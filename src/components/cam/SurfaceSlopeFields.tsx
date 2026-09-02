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

import type { Operation } from '../../types/project'
import { useI18n } from '../../i18n/i18nContext'
import { surfaceSlopeRange } from '../../engine/toolpaths/finishSurfaceSlope'

export function SurfaceSlopeFields({ operation, updateOperation }: {
  operation: Operation
  updateOperation: (id: string, patch: Partial<Operation>) => void
}) {
  const { t } = useI18n()
  const range = surfaceSlopeRange(operation)
  const commit = (field: 'finishSlopeMin' | 'finishSlopeMax', value: string) => {
    const next = value.trim() === '' ? undefined : Number(value)
    updateOperation(operation.id, { [field]: next })
  }
  return (
    <div>
      <label className="properties-check">
        <input type="checkbox" checked={range !== null} onChange={(event) => updateOperation(operation.id,
          event.target.checked ? { finishSlopeMin: 0, finishSlopeMax: 30 }
            : { finishSlopeMin: undefined, finishSlopeMax: undefined })} />
        <span>{t('cam.operation.slopeFilter')}</span>
      </label>
      {range !== null && <>
        <label className="properties-field">
          <span>{t('cam.operation.slopeMin')}</span>
          <input key={`${operation.id}-min-${operation.finishSlopeMin}`} type="number" inputMode="decimal"
            step="any" min={0} max={90} defaultValue={operation.finishSlopeMin ?? ''} placeholder="0"
            onBlur={(event) => commit('finishSlopeMin', event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
        </label>
        <label className="properties-field">
          <span>{t('cam.operation.slopeMax')}</span>
          <input key={`${operation.id}-max-${operation.finishSlopeMax}`} type="number" inputMode="decimal"
            step="any" min={0} max={90} defaultValue={operation.finishSlopeMax ?? ''} placeholder="90"
            onBlur={(event) => commit('finishSlopeMax', event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
        </label>
        <p className="properties-hint">{t('cam.operation.slopeHelp')}</p>
        {range === 'invalid' && <p role="alert">{t('warnings.finishSlopeInvalid')}</p>}
      </>}
    </div>
  )
}
