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

import type { GearCreationParams } from '../../sketch/gearProfile'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  GEAR_MAX_TEETH,
  GEAR_MIN_TEETH,
  validateGearProfileParams,
} from '../../sketch/gearProfile'
import type { PendingAddTool } from '../../store/types'
import { formatLength } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'

type PendingGear = Extract<NonNullable<PendingAddTool>, { shape: 'gear' }>

interface GearParameterPanelProps {
  pendingAdd: PendingGear
  units: 'mm' | 'inch'
  setPendingGearParams: (patch: Partial<GearCreationParams>) => void
}

type GearReferenceKind =
  | 'teeth'
  | 'wholeDepth'
  | 'flankProfile'
  | 'pressureAngle'
  | 'rootForm'
  | 'rootFilletRadius'
  | 'crestForm'
  | 'crestRadius'
  | 'boreDiameter'

interface GearReferenceProps {
  kind: GearReferenceKind
  params: GearCreationParams
}

interface GearFieldProps {
  children: ReactNode
  labelKey: MessageKey
  params: GearCreationParams
  reference: GearReferenceKind
}

function stopPanelKey(event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>): void {
  event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    event.currentTarget.blur()
  }
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function commitNumber(
  value: string,
  fallback: number,
  commit: (value: number) => void,
  normalize: (value: number) => number = (next) => next,
): string {
  const next = normalize(parseNumber(value, fallback))
  commit(next)
  return String(next)
}

function GearField({ children, labelKey, params, reference }: GearFieldProps) {
  const { t } = useI18n()
  return (
    <label className="canvas-workflow-panel__field canvas-workflow-panel__field--gear">
      <span>{t(labelKey)}</span>
      {children}
      <GearParameterReference kind={reference} params={params} />
    </label>
  )
}

function GearReferenceFrame({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <svg
      className="canvas-workflow-panel__gear-reference"
      viewBox="0 0 58 34"
      role="img"
      aria-label={label}
      focusable="false"
    >
      {children}
    </svg>
  )
}

function GearParameterReference({ kind, params }: GearReferenceProps) {
  const { t } = useI18n()
  const pressureAngle = params.pressureAngleDeg * Math.PI / 180
  const pressureEndX = 29 + Math.sin(pressureAngle) * 20
  const pressureEndY = 29 - Math.cos(pressureAngle) * 20

  if (kind === 'teeth') {
    return (
      <GearReferenceFrame label={t('canvas.gear.ref.teeth')}>
        <circle className="gear-reference__guide" cx="29" cy="17" r="10" />
        <path className="gear-reference__guide" d="M29 3v7M43 17h-7M29 31v-7M15 17h7M39 7l-5 5M39 27l-5-5M19 27l5-5M19 7l5 5" />
        <path className="gear-reference__accent-fill" d="M26 3h6l2 8-5 4-5-4z" />
        <circle className="gear-reference__outline" cx="29" cy="17" r="5" />
      </GearReferenceFrame>
    )
  }

  if (kind === 'wholeDepth') {
    return (
      <GearReferenceFrame label={t('canvas.gear.ref.wholeDepth')}>
        <path className="gear-reference__outline" d="M12 27L21 7h16l9 20" />
        <path className="gear-reference__guide" d="M11 7h38M11 27h38" />
        <path className="gear-reference__accent" d="M49 8v18" />
        <path className="gear-reference__accent-fill" d="M49 6l-3 5h6zM49 28l-3-5h6z" />
      </GearReferenceFrame>
    )
  }

  if (kind === 'flankProfile') {
    const flankPath = params.flankProfile === 'involute'
      ? 'M14 28C16 19 21 10 29 6C37 10 42 19 44 28'
      : 'M14 28L24 6H34L44 28'
    return (
      <GearReferenceFrame label={t('canvas.gear.ref.flankProfile')}>
        <path className="gear-reference__guide" d="M29 4v27" />
        <path className="gear-reference__outline" d="M14 28h30" />
        <path className="gear-reference__accent" d={flankPath} />
      </GearReferenceFrame>
    )
  }

  if (kind === 'pressureAngle') {
    return (
      <GearReferenceFrame label={t('canvas.gear.ref.pressureAngle')}>
        <path className="gear-reference__outline" d="M15 29h28" />
        <path className="gear-reference__guide" d="M29 29V7" />
        <path className="gear-reference__accent" d={`M29 29L${pressureEndX.toFixed(2)} ${pressureEndY.toFixed(2)}`} />
        <path className="gear-reference__accent" d="M29 18A11 11 0 0 1 36 20" />
        <circle className="gear-reference__accent-fill" cx={pressureEndX} cy={pressureEndY} r="1.6" />
      </GearReferenceFrame>
    )
  }

  if (kind === 'rootForm') {
    const rootPath = params.rootForm === 'rounded'
      ? 'M10 5L20 25Q29 31 38 25L48 5'
      : params.rootForm === 'flat'
        ? 'M10 5L22 26H36L48 5'
        : 'M10 5L29 29L48 5'
    return (
      <GearReferenceFrame label={t('canvas.gear.ref.rootForm')}>
        <path className="gear-reference__outline" d="M10 5L20 25M38 25L48 5" />
        <path className="gear-reference__accent" d={rootPath} />
      </GearReferenceFrame>
    )
  }

  if (kind === 'rootFilletRadius') {
    return (
      <GearReferenceFrame label={t('canvas.gear.ref.rootFilletRadius')}>
        <path className="gear-reference__outline" d="M10 5L20 25Q29 31 38 25L48 5" />
        <path className="gear-reference__guide" d="M29 27L21 25" />
        <circle className="gear-reference__guide" cx="29" cy="27" r="8" />
        <path className="gear-reference__accent" d="M21 25Q29 31 37 25" />
        <circle className="gear-reference__accent-fill" cx="29" cy="27" r="1.5" />
      </GearReferenceFrame>
    )
  }

  if (kind === 'crestForm') {
    const crestPath = params.crestForm === 'rounded'
      ? 'M16 28L21 10Q29 2 37 10L42 28'
      : 'M16 28L22 8H36L42 28'
    return (
      <GearReferenceFrame label={t('canvas.gear.ref.crestForm')}>
        <path className="gear-reference__guide" d="M29 5v24" />
        <path className="gear-reference__accent" d={crestPath} />
      </GearReferenceFrame>
    )
  }

  if (kind === 'crestRadius') {
    return (
      <GearReferenceFrame label={t('canvas.gear.ref.crestRadius')}>
        <path className="gear-reference__outline" d="M16 28L22 12Q29 5 36 12L42 28" />
        <path className="gear-reference__guide" d="M29 10L22 12" />
        <circle className="gear-reference__guide" cx="29" cy="10" r="7" />
        <path className="gear-reference__accent" d="M22 12Q29 4 36 12" />
        <circle className="gear-reference__accent-fill" cx="29" cy="10" r="1.5" />
      </GearReferenceFrame>
    )
  }

  return (
    <GearReferenceFrame label={t('canvas.gear.ref.boreDiameter')}>
      <circle className="gear-reference__outline" cx="29" cy="17" r="13" />
      <circle className="gear-reference__accent" cx="29" cy="17" r="5" />
      <path className="gear-reference__accent" d="M24 17h10" />
      <path className="gear-reference__accent-fill" d="M23 17l4-3v6zM35 17l-4-3v6z" />
    </GearReferenceFrame>
  )
}

export function GearParameterPanel({
  pendingAdd,
  units,
  setPendingGearParams,
}: GearParameterPanelProps) {
  const { t } = useI18n()

  if (!pendingAdd.anchor || pendingAdd.outsideRadius === null) {
    return null
  }

  const { params } = pendingAdd
  const errors = validateGearProfileParams({
    ...params,
    center: pendingAdd.anchor,
    outsideRadius: pendingAdd.outsideRadius,
  })

  return (
    <>
      <div className="canvas-workflow-panel__summary">
        {t('canvas.gear.summary', { length: formatLength(pendingAdd.outsideRadius, units) })}
      </div>
      <div className="canvas-workflow-panel__meta canvas-workflow-panel__gear-fields">
        <GearField labelKey="canvas.gear.toothCount" params={params} reference="teeth">
          <input
            key={`gear-teeth-${pendingAdd.session}`}
            className="canvas-workflow-panel__count-input"
            type="text"
            inputMode="numeric"
            defaultValue={params.teeth}
            onBlur={(event) => {
              event.currentTarget.value = commitNumber(
                event.currentTarget.value,
                params.teeth,
                (value) => setPendingGearParams({ teeth: value }),
                (value) => Math.max(GEAR_MIN_TEETH, Math.min(GEAR_MAX_TEETH, Math.round(value))),
              )
            }}
            onKeyDown={stopPanelKey}
            autoFocus
          />
        </GearField>
        <GearField labelKey="canvas.gear.wholeDepth" params={params} reference="wholeDepth">
          <input
            key={`gear-depth-${pendingAdd.session}`}
            className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
            type="text"
            inputMode="decimal"
            defaultValue={params.wholeDepth}
            onBlur={(event) => {
              event.currentTarget.value = commitNumber(
                event.currentTarget.value,
                params.wholeDepth,
                (value) => setPendingGearParams({ wholeDepth: value }),
                (value) => Math.max(0, value),
              )
            }}
            onKeyDown={stopPanelKey}
          />
        </GearField>
        <GearField labelKey="canvas.gear.flankProfile" params={params} reference="flankProfile">
          <select
            className="canvas-workflow-panel__count-input canvas-workflow-panel__select-input"
            value={params.flankProfile}
            onChange={(event) => setPendingGearParams({ flankProfile: event.target.value as GearCreationParams['flankProfile'] })}
            onKeyDown={stopPanelKey}
          >
            <option value="involute">{t('canvas.gear.flank.involute')}</option>
            <option value="straight">{t('canvas.gear.flank.straight')}</option>
          </select>
        </GearField>
        {params.flankProfile === 'involute' ? (
          <GearField labelKey="canvas.gear.pressureAngle" params={params} reference="pressureAngle">
            <input
              key={`gear-pressure-${pendingAdd.session}`}
              className="canvas-workflow-panel__count-input"
              type="text"
              inputMode="decimal"
              defaultValue={params.pressureAngleDeg}
              onBlur={(event) => {
                event.currentTarget.value = commitNumber(
                  event.currentTarget.value,
                  params.pressureAngleDeg,
                  (value) => setPendingGearParams({ pressureAngleDeg: value }),
                  (value) => Math.max(10, Math.min(35, value)),
                )
              }}
              onKeyDown={stopPanelKey}
            />
          </GearField>
        ) : null}
        <GearField labelKey="canvas.gear.rootForm" params={params} reference="rootForm">
          <select
            className="canvas-workflow-panel__count-input canvas-workflow-panel__select-input"
            value={params.rootForm}
            onChange={(event) => setPendingGearParams({ rootForm: event.target.value as GearCreationParams['rootForm'] })}
            onKeyDown={stopPanelKey}
          >
            <option value="rounded">{t('canvas.gear.root.rounded')}</option>
            <option value="flat">{t('canvas.gear.root.flat')}</option>
            <option value="sharp">{t('canvas.gear.root.sharp')}</option>
          </select>
        </GearField>
        {params.rootForm === 'rounded' ? (
          <GearField labelKey="canvas.gear.rootFilletRadius" params={params} reference="rootFilletRadius">
            <input
              key={`gear-root-fillet-${pendingAdd.session}`}
              className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
              type="text"
              inputMode="decimal"
              defaultValue={params.rootFilletRadius}
              onBlur={(event) => {
                event.currentTarget.value = commitNumber(
                  event.currentTarget.value,
                  params.rootFilletRadius,
                  (value) => setPendingGearParams({ rootFilletRadius: value }),
                  (value) => Math.max(0, value),
                )
              }}
              onKeyDown={stopPanelKey}
            />
          </GearField>
        ) : null}
        <GearField labelKey="canvas.gear.crestForm" params={params} reference="crestForm">
          <select
            className="canvas-workflow-panel__count-input canvas-workflow-panel__select-input"
            value={params.crestForm}
            onChange={(event) => setPendingGearParams({ crestForm: event.target.value as GearCreationParams['crestForm'] })}
            onKeyDown={stopPanelKey}
          >
            <option value="flat">{t('canvas.gear.crest.flat')}</option>
            <option value="rounded">{t('canvas.gear.crest.rounded')}</option>
          </select>
        </GearField>
        {params.crestForm === 'rounded' ? (
          <GearField labelKey="canvas.gear.crestRadius" params={params} reference="crestRadius">
            <input
              key={`gear-crest-radius-${pendingAdd.session}`}
              className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
              type="text"
              inputMode="decimal"
              defaultValue={params.crestRadius}
              onBlur={(event) => {
                event.currentTarget.value = commitNumber(
                  event.currentTarget.value,
                  params.crestRadius,
                  (value) => setPendingGearParams({ crestRadius: value }),
                  (value) => Math.max(0, value),
                )
              }}
              onKeyDown={stopPanelKey}
            />
          </GearField>
        ) : null}
        <GearField labelKey="canvas.gear.boreDiameter" params={params} reference="boreDiameter">
          <input
            key={`gear-bore-${pendingAdd.session}`}
            className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
            type="text"
            inputMode="decimal"
            defaultValue={params.boreDiameter === 0 ? '' : params.boreDiameter}
            onBlur={(event) => {
              event.currentTarget.value = commitNumber(
                event.currentTarget.value,
                params.boreDiameter,
                (value) => setPendingGearParams({ boreDiameter: value }),
                (value) => Math.max(0, value),
              )
            }}
            onKeyDown={stopPanelKey}
          />
        </GearField>
      </div>
      {errors.length > 0 ? (
        <div className="sketch-banner-warning">{errors[0]}</div>
      ) : null}
    </>
  )
}
