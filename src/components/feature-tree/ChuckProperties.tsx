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

import { useState } from 'react'
import type { BarStock, Clamp, ProjectMeta, Stock } from '../../types/project'
import { useI18n } from '../../i18n/i18nContext'
import { convertLength, formatLength } from '../../utils/units'
import { STANDARD_CHUCKS, chuckOutOfRange, chuckSizePatch, roundWorkholdingDiameter } from '../../store/helpers/roundWorkholding'
import { Select } from '../Select'
import { DraftNumberInput } from './DraftNumberInput'

type Props = { clamp: Clamp; stock: BarStock; units: ProjectMeta['units']; onChange: (patch: Partial<Clamp>) => void }

export function ChuckProperties({ clamp, stock, units, onChange }: Props) {
  const { t } = useI18n()
  const data = clamp.chuck
  const knownSize = STANDARD_CHUCKS.some((size) => size.id === data?.size)
  const range = data?.clampingRangeMm
  const setLimit = (key: 'min' | 'max', value: number) => {
    if (!range) return
    const next = { ...range, [key]: convertLength(value, units, 'mm') }
    if (next.min < 0 || next.max < next.min || !Number.isFinite(value)) return
    onChange({ chuck: { ...data, clampingRangeMm: next } })
  }
  return <>
    <label className="properties-field">
      <span>{t('featureTree.properties.chuckSize')}</span>
      <Select value={knownSize ? data?.size ?? '' : ''}
        options={[
          ...(!knownSize ? [{ value: '', label: `${t('featureTree.properties.chuckExisting')} · Ø${formatLength(roundWorkholdingDiameter(clamp, stock), units)}${data?.size ? ` (${data.size})` : ''}` }] : []),
          ...STANDARD_CHUCKS.map((size) => ({ value: size.id, label: size.label })),
        ]}
        onChange={(id) => { if (id) onChange(chuckSizePatch(id, stock, units)) }} />
    </label>
    {range ? (['min', 'max'] as const).map((limit) => <label className="properties-field" key={limit}>
      <span>{t(limit === 'min' ? 'featureTree.properties.chuckMin' : 'featureTree.properties.chuckMax')}</span>
      <DraftNumberInput key={`${clamp.id}-${limit}-${range[limit]}`} value={convertLength(range[limit], 'mm', units)}
        units={units} min={0} onCommit={(next) => setLimit(limit, next)} />
    </label>) : <>
      <UnsetChuckRange key={`${clamp.id}-${units}`} units={units} onCommit={(clampingRangeMm) => onChange({ chuck: { ...data, clampingRangeMm } })} />
      <span className="properties-hint">{t('featureTree.properties.chuckUnknownRange')}</span>
    </>}
    <label className="properties-field">
      <span>{t('featureTree.properties.chuckJaws')}</span>
      <Select value={String(data?.jawCount ?? 3)} options={[3, 4, 6].map((count) => ({ value: String(count), label: String(count) }))}
        onChange={(value) => {
          const jawCount = Number(value)
          if (jawCount === 3 || jawCount === 4 || jawCount === 6) onChange({ chuck: { ...data, jawCount } })
        }} />
    </label>
    <span className="properties-hint">{t('featureTree.properties.chuckSquareRange')}</span>
    <ChuckRangeWarning clamp={clamp} stock={stock} units={units} />
  </>
}

/** Shared by the chuck Properties and its tree-row chip. */
export function ChuckRangeWarning({ clamp, stock, units, compact = false }: { clamp: Clamp; stock: Stock; units: ProjectMeta['units']; compact?: boolean }) {
  const { t } = useI18n()
  if (!chuckOutOfRange(clamp, stock, units)) return null
  const message = t('featureTree.properties.chuckOutOfRange')
  if (compact) return <span role="img" aria-label={message} title={message}>⚠</span>
  return <span role="alert" className="properties-hint" title={message}>⚠ {message}</span>
}

/** Unknown legacy capacity starts blank; entering limits never picks/resizes equipment. */
function UnsetChuckRange({ units, onCommit }: { units: ProjectMeta['units']; onCommit: (range: { min: number; max: number }) => void }) {
  const { t } = useI18n()
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const commit = () => {
    if (min.trim() === '' || max.trim() === '') return
    const low = Number(min), high = Number(max)
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low) return
    onCommit({ min: convertLength(low, units, 'mm'), max: convertLength(high, units, 'mm') })
  }
  return <>
    <label className="properties-field">
      <span>{t('featureTree.properties.chuckMin')}</span>
      <input type="number" step="any" min={0} value={min} onChange={(event) => setMin(event.target.value)} onBlur={commit} />
    </label>
    <label className="properties-field">
      <span>{t('featureTree.properties.chuckMax')}</span>
      <input type="number" step="any" min={0} value={max} onChange={(event) => setMax(event.target.value)} onBlur={commit} />
    </label>
  </>
}
