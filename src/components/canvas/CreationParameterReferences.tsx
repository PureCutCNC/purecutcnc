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

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PendingAddTool } from '../../store/types'
import { useI18n } from '../../i18n/i18nContext'
import { I18nProvider } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/locales/en'
import { useProjectStore } from '../../store/projectStore'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import { registerCannedShapeEditor } from '../../cannedShapes/registry'
import type { CannedShapeEditorRequest } from '../../cannedShapes/generators/editorRequest'
import { editorInitialValues, editorParamsFromValues } from '../../cannedShapes/generators/editorForm'
import { ELLIPSE_EDITOR_REQUEST } from '../../cannedShapes/generators/ellipse'
import { SLOT_EDITOR_REQUEST } from '../../cannedShapes/generators/slot'
import { NGON_EDITOR_REQUEST } from '../../cannedShapes/generators/ngon'
import { ROUND_RECT_EDITOR_REQUEST } from '../../cannedShapes/generators/roundRect'
import { CHAMFER_RECT_EDITOR_REQUEST } from '../../cannedShapes/generators/chamferRect'

type PendingNgon = Extract<PendingAddTool, { shape: 'ngon' }>
type PendingRectCorner = Extract<PendingAddTool, { shape: 'roundrect' | 'chamferrect' }>

interface NgonParameterPanelProps {
  pendingAdd: PendingNgon
  setPendingNgonSides: (sides: number) => void
}

interface RectCornerParameterPanelProps {
  pendingAdd: PendingRectCorner
  setPendingRectCorner: (corner: number) => void
}

interface CreationParameterFieldProps {
  children: ReactNode
  labelKey: MessageKey
  reference: ReactNode
}

function stopPanelKey(event: ReactKeyboardEvent<HTMLInputElement>): void {
  event.stopPropagation()
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function commitNumber(
  value: string,
  fallback: number,
  commit: (value: number) => void,
  normalize: (value: number, fallback: number) => number = (next) => next,
): string {
  const next = normalize(parseNumber(value, fallback), fallback)
  commit(next)
  return String(next)
}

function normalizeNgonSides(value: number): number {
  return Math.max(3, Math.min(50, Math.round(value)))
}

function normalizeCorner(value: number, fallback: number): number {
  return value < 0 ? fallback : value
}

function CreationParameterField({ children, labelKey, reference }: CreationParameterFieldProps) {
  const { t } = useI18n()
  return (
    <label className="canvas-workflow-panel__field canvas-workflow-panel__field--reference">
      <span>{t(labelKey)}</span>
      {children}
      {reference}
    </label>
  )
}

function CreationReferenceFrame({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <svg
      className="canvas-workflow-panel__parameter-reference"
      viewBox="0 0 58 34"
      role="img"
      aria-label={label}
      focusable="false"
    >
      {children}
    </svg>
  )
}

function polygonPath(sides: number): string {
  const displaySides = Math.max(3, Math.min(16, sides))
  const points = Array.from({ length: displaySides }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / displaySides
    return `${(29 + Math.cos(angle) * 11).toFixed(2)} ${(17 + Math.sin(angle) * 11).toFixed(2)}`
  })
  return `M${points.join('L')}Z`
}

function NgonSidesReference({ sides }: { sides: number }) {
  const { t } = useI18n()
  return (
    <CreationReferenceFrame label={t('canvas.param.ref.ngonSides')}>
      <path className="gear-reference__guide" d="M29 5v24M16 17h26" />
      <path className="gear-reference__outline" d={polygonPath(sides)} />
      <path className="gear-reference__accent" d="M29 6L38.5 12.5" />
      <circle className="gear-reference__accent-fill" cx="29" cy="6" r="1.5" />
      <circle className="gear-reference__accent-fill" cx="38.5" cy="12.5" r="1.5" />
    </CreationReferenceFrame>
  )
}

function RectCornerReference({ kind }: { kind: PendingRectCorner['shape'] }) {
  const { t } = useI18n()
  if (kind === 'roundrect') {
    return (
      <CreationReferenceFrame label={t('canvas.param.ref.roundRectCorner')}>
        <path className="gear-reference__outline" d="M10 28V11Q10 6 15 6H48" />
        <path className="gear-reference__guide" d="M21 17L10 17M21 17V6" />
        <path className="gear-reference__accent" d="M10 17A11 11 0 0 1 21 6" />
        <circle className="gear-reference__accent-fill" cx="21" cy="17" r="1.5" />
      </CreationReferenceFrame>
    )
  }

  return (
    <CreationReferenceFrame label={t('canvas.param.ref.chamferRectCorner')}>
      <path className="gear-reference__outline" d="M10 28V16L20 6H48" />
      <path className="gear-reference__guide" d="M10 16H20V6" />
      <path className="gear-reference__accent" d="M10 16L20 6" />
      <path className="gear-reference__accent-fill" d="M10 16l4-1-3-3zM20 6l-4 1 3 3z" />
    </CreationReferenceFrame>
  )
}

export function NgonParameterPanel({ pendingAdd, setPendingNgonSides }: NgonParameterPanelProps) {
  return (
    <div className="canvas-workflow-panel__meta canvas-workflow-panel__parameter-fields">
      <CreationParameterField labelKey="canvas.param.ngonSides" reference={<NgonSidesReference sides={pendingAdd.sides} />}>
        <input
          key={pendingAdd.session}
          className="canvas-workflow-panel__count-input"
          type="text"
          inputMode="numeric"
          defaultValue={pendingAdd.sides}
          onBlur={(event) => {
            event.currentTarget.value = commitNumber(
              event.currentTarget.value,
              pendingAdd.sides,
              setPendingNgonSides,
              normalizeNgonSides,
            )
          }}
          onKeyDown={(event) => {
            stopPanelKey(event)
            if (event.key === 'Enter') {
              event.currentTarget.value = commitNumber(
                event.currentTarget.value,
                pendingAdd.sides,
                setPendingNgonSides,
                normalizeNgonSides,
              )
            }
          }}
        />
      </CreationParameterField>
    </div>
  )
}

export function RectCornerParameterPanel({ pendingAdd, setPendingRectCorner }: RectCornerParameterPanelProps) {
  return (
    <div className="canvas-workflow-panel__meta canvas-workflow-panel__parameter-fields">
      <CreationParameterField
        labelKey={pendingAdd.shape === 'roundrect' ? 'canvas.param.cornerRadius' : 'canvas.param.chamfer'}
        reference={<RectCornerReference kind={pendingAdd.shape} />}
      >
        <input
          key={pendingAdd.session}
          className="canvas-workflow-panel__count-input"
          type="text"
          inputMode="decimal"
          defaultValue={pendingAdd.corner}
          onBlur={(event) => {
            event.currentTarget.value = commitNumber(
              event.currentTarget.value,
              pendingAdd.corner,
              setPendingRectCorner,
              normalizeCorner,
            )
          }}
          onKeyDown={(event) => {
            stopPanelKey(event)
            if (event.key === 'Enter') {
              event.currentTarget.value = commitNumber(
                event.currentTarget.value,
                pendingAdd.corner,
                setPendingRectCorner,
                normalizeCorner,
              )
            }
          }}
        />
      </CreationParameterField>
    </div>
  )
}

/**
 * The Edit <shape>… panel (issue #1112 slice D).
 *
 * The five flat canned shapes keep their parameters, so the same fields the
 * creation panel shows reopen with the current values. The dialog is mounted
 * through a tiny root of its own because its trigger lives in the Properties
 * panel ("Edit …"), a different React tree: the canned-shape registry hands the
 * opener a feature id and nothing else, which keeps the model free of UI.
 *
 * Save writes one `updateFeature` patch, so one edit is one undo step. The
 * generator's own `normalize` validates the numbers first, so Save is disabled
 * instead of writing a parameter set that would generate nothing.
 */

function CannedShapeEditReference({
  request,
  values,
}: {
  request: CannedShapeEditorRequest
  values: Record<string, string>
}) {
  const { t } = useI18n()
  switch (request.kind) {
    case 'ellipse':
      return (
        <CreationReferenceFrame label={t('canvas.param.ref.ellipse')}>
          <path className="gear-reference__outline" d="M9 17A20 11 0 0 1 49 17A20 11 0 0 1 9 17Z" />
          <path className="gear-reference__guide" d="M9 17H49M29 6v22" />
          <path className="gear-reference__accent" d="M29 17H49" />
          <circle className="gear-reference__accent-fill" cx="29" cy="17" r="1.5" />
        </CreationReferenceFrame>
      )
    case 'slot':
      return (
        <CreationReferenceFrame label={t('canvas.param.ref.slot')}>
          <path className="gear-reference__outline" d="M15 10H43A7 7 0 0 1 43 24H15A7 7 0 0 1 15 10Z" />
          <path className="gear-reference__guide" d="M15 17H43" />
          <path className="gear-reference__accent" d="M15 10v14M43 10v14" />
        </CreationReferenceFrame>
      )
    case 'ngon':
      return <NgonSidesReference sides={Number(values.sides) || 3} />
    case 'roundrect':
      return <RectCornerReference kind="roundrect" />
    case 'chamferrect':
      return <RectCornerReference kind="chamferrect" />
    default:
      return null
  }
}

function CannedShapeEditDialog({
  request,
  featureId,
  onClose,
}: {
  request: CannedShapeEditorRequest
  featureId: string
  onClose: () => void
}) {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const updateFeature = useProjectStore((state) => state.updateFeature)
  const feature = resolveFeatureInstance(project, featureId)
  const canned = feature?.canned?.kind === request.kind ? feature.canned : null
  const [values, setValues] = useState<Record<string, string>>(
    () => (canned ? editorInitialValues(request, canned.params) : {}),
  )

  // The feature can vanish while the dialog is open (undo, delete, make
  // unique). Close rather than edit a row that no longer exists.
  useEffect(() => {
    if (!canned) onClose()
  }, [canned, onClose])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  if (!canned) return null

  const candidate = editorParamsFromValues(request, values)
  const normalized = candidate ? request.normalize(candidate) : null
  const invalid = normalized === null
  const titleId = `canned-shape-edit-${request.kind}`

  function commit(): void {
    if (!normalized) return
    updateFeature(featureId, { canned: { kind: request.kind, params: normalized } })
    onClose()
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--import"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id={titleId}>
            {t('canvas.cannedEdit.title', { shape: t(request.labelKey) })}
          </h2>
          <button
            className="dialog-close"
            onClick={onClose}
            aria-label={t('dialogs.common.close')}
            type="button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--import">
          <div className="dialog-section">
            {request.fields.map((field) => (
              <div className="dialog-section-group" key={field.key}>
                <label className="dialog-section-title" htmlFor={`${titleId}-${field.key}`}>
                  {t(field.labelKey)}
                </label>
                <input
                  id={`${titleId}-${field.key}`}
                  type="number"
                  step="any"
                  value={values[field.key] ?? ''}
                  onChange={(event) => {
                    const next = event.target.value
                    setValues((previous) => ({ ...previous, [field.key]: next }))
                  }}
                />
              </div>
            ))}
            <div className="dialog-section-group">
              <CannedShapeEditReference request={request} values={values} />
            </div>
            {invalid ? (
              <p className="properties-region-note" role="alert">
                {t('canvas.cannedEdit.invalid')}
              </p>
            ) : null}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="feat-btn" type="button" onClick={onClose}>
            {t('dialogs.common.cancel')}
          </button>
          <button
            className="feat-btn feat-btn--primary"
            type="button"
            disabled={invalid}
            onClick={commit}
          >
            {t('canvas.cannedEdit.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface OpenCannedShapeEditDialog {
  root: Root
  host: HTMLDivElement
}

let cannedEditDialog: OpenCannedShapeEditDialog | null = null

function destroyCannedShapeEditDialog(entry: OpenCannedShapeEditDialog): void {
  entry.root.unmount()
  entry.host.remove()
}

/**
 * Open the panel for one feature. The close callback is bound to *this* dialog,
 * not to the module: a stale dialog's effect (its feature was undone, or
 * another shape was opened over it) must not unmount the dialog that replaced
 * it.
 */
function openCannedShapeEditDialog(request: CannedShapeEditorRequest, featureId: string): void {
  if (typeof document === 'undefined') return

  const previous = cannedEditDialog
  cannedEditDialog = null
  if (previous) {
    // The previous dialog's close button may be the element being clicked;
    // remove it after the event rather than during it.
    setTimeout(() => destroyCannedShapeEditDialog(previous), 0)
  }

  const host = document.createElement('div')
  host.className = 'canned-shape-edit-host'
  document.body.appendChild(host)
  const entry: OpenCannedShapeEditDialog = { root: createRoot(host), host }
  cannedEditDialog = entry

  function close(): void {
    if (cannedEditDialog !== entry) return
    cannedEditDialog = null
    setTimeout(() => destroyCannedShapeEditDialog(entry), 0)
  }

  entry.root.render(
    <I18nProvider>
      <CannedShapeEditDialog
        request={request}
        featureId={featureId}
        onClose={close}
      />
    </I18nProvider>,
  )
}

// Registering here is what makes the Properties panel's "Edit <shape>…" button
// live: the button asks the registry for the opener, and this module is part of
// the app's startup import graph (SketchCanvas).
for (const request of [
  ELLIPSE_EDITOR_REQUEST,
  SLOT_EDITOR_REQUEST,
  NGON_EDITOR_REQUEST,
  ROUND_RECT_EDITOR_REQUEST,
  CHAMFER_RECT_EDITOR_REQUEST,
]) {
  registerCannedShapeEditor(request.kind, (featureId) => openCannedShapeEditDialog(request, featureId))
}
