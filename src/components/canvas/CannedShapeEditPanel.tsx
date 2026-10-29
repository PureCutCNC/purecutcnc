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
 * Edit a canned shape in the canvas side panel (issue #1112 DE2 review).
 *
 * Creation and editing share one surface: the Properties "Edit <shape>…"
 * button arms a `canned-edit` pending session, and this panel renders the same
 * page-level workflow panel the creation tools use. Every valid field value is
 * previewed live through `useCannedShapePreview`, and Apply commits that preview
 * so it is one undo step and linked copies follow. There is no second React root
 * and no modal.
 */

import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { CannedShapeParams } from '../../types/project'
import type { PendingAddTool } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import { cannedShapeLabelKey } from '../../cannedShapes'
import { registerCannedShapeEditor } from '../../cannedShapes/registry'
import type { CannedShapeEditorRequest } from '../../cannedShapes/generators/editorRequest'
import { editorInitialValues, editorParamsFromValues } from '../../cannedShapes/generators/editorForm'
import { ELLIPSE_EDITOR_REQUEST } from '../../cannedShapes/generators/ellipse'
import { SLOT_EDITOR_REQUEST } from '../../cannedShapes/generators/slot'
import { NGON_EDITOR_REQUEST } from '../../cannedShapes/generators/ngon'
import { ROUND_RECT_EDITOR_REQUEST } from '../../cannedShapes/generators/roundRect'
import { CHAMFER_RECT_EDITOR_REQUEST } from '../../cannedShapes/generators/chamferRect'
import {
  GEAR_CANNED_KIND,
  normalizeGearCannedParams,
  type GearCannedParams,
} from '../../cannedShapes/generators/gear'
import {
  defaultGearCreationParams,
  normalizeGearCreationParams,
  validateGearProfileParams,
  type GearCreationParams,
} from '../../sketch/gearProfile'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import { CanvasWorkflowCancel, CanvasWorkflowConfirm } from './CanvasWorkflowAction'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'
import { useCannedShapePreview } from '../useCannedShapePreview'
import { CannedShapeEditReference } from './CreationParameterReferences'
import { GearFields } from './GearParameterPanel'
import { RotaryPatternPanel } from './RotaryPatternPanel'
import { RotarySolidPanel } from './RotarySolidPanel'
import {
  POLYGON_CANNED_KIND,
  TURN_CANNED_KIND,
  FLUTES_CANNED_KIND,
  THREAD_CANNED_KIND,
} from '../../cannedShapes/generators/kinds'

type PendingCannedEdit = Extract<PendingAddTool, { shape: 'canned-edit' }>

/** The creation parameters a stored gear holds; the centre is placement. */
function gearCreationParamsOf(params: GearCannedParams): GearCreationParams {
  return {
    teeth: params.teeth,
    wholeDepth: params.wholeDepth,
    flankProfile: params.flankProfile,
    pressureAngleDeg: params.pressureAngleDeg,
    rootForm: params.rootForm,
    rootFilletRadius: params.rootFilletRadius,
    crestForm: params.crestForm,
    crestRadius: params.crestRadius,
    boreDiameter: params.boreDiameter,
  }
}

interface CannedShapeEditPanelProps {
  pending: PendingCannedEdit
  containerRef: RefObject<HTMLElement | null>
  canvasRef: RefObject<HTMLElement | null>
  clearTransientCanvasState: () => void
}

/** The four canned rotary kinds, edited in their own canvas panels. */
const ROTARY_EDIT_PARTS: Record<string, { shape: 'solid'; kind: 'turn' | 'polygon' } | { shape: 'pattern'; kind: 'thread' | 'flutes' }> = {
  [TURN_CANNED_KIND]: { shape: 'solid', kind: 'turn' },
  [POLYGON_CANNED_KIND]: { shape: 'solid', kind: 'polygon' },
  [THREAD_CANNED_KIND]: { shape: 'pattern', kind: 'thread' },
  [FLUTES_CANNED_KIND]: { shape: 'pattern', kind: 'flutes' },
}

const EDITOR_REQUESTS: Record<string, CannedShapeEditorRequest> = Object.fromEntries(
  [
    ELLIPSE_EDITOR_REQUEST,
    SLOT_EDITOR_REQUEST,
    NGON_EDITOR_REQUEST,
    ROUND_RECT_EDITOR_REQUEST,
    CHAMFER_RECT_EDITOR_REQUEST,
  ].map((request) => [request.kind, request]),
)

function flatNormalized(
  request: CannedShapeEditorRequest | null,
  values: Record<string, string>,
): CannedShapeParams | null {
  if (!request) return null
  const candidate = editorParamsFromValues(request, values)
  return candidate ? request.normalize(candidate) : null
}

/** A gear field's number, or `NaN` when the text is unusable. */
function draftNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text)
}

/** The gear fields exactly as typed, before the creation clamp touches them. */
function rawGearDraft(params: GearCreationParams, size: number): GearCreationParams & { outsideRadius: number } {
  return { ...params, outsideRadius: size }
}

/**
 * The gear preview for a draft, or `null` while the draft is not a gear.
 *
 * The **raw** draft is validated: `normalizeGearCreationParams` rounds and
 * clamps (a tooth count of 1 becomes the 6-tooth minimum), so normalizing
 * first would turn a value the gear refuses into a different, valid shape and
 * draw it with no error. Only a draft the validator accepts is normalized, and
 * that is what reaches the preview and the generator (#1112 F1 review).
 */
function gearDraft(params: GearCreationParams, size: number): CannedShapeParams | null {
  if (validateGearProfileParams({ ...rawGearDraft(params, size), center: { x: 0, y: 0 } }).length > 0) {
    return null
  }
  return normalizeGearCannedParams({
    ...normalizeGearCreationParams(params),
    outsideRadius: size,
  })
}

/**
 * Edit a canned shape in the canvas side panel.
 *
 * The four canned rotary kinds render the same page-level panel creation uses
 * (issue #1112 rt2-b): they carry a bar frame, a mesh and a live preview of
 * their own, so they have their own field components. Everything else — the
 * five flat shapes and the gear — renders below.
 */
export function CannedShapeEditPanel(props: CannedShapeEditPanelProps) {
  const project = useProjectStore((state) => state.project)
  const cancelPendingAdd = useProjectStore((state) => state.cancelPendingAdd)
  const feature = resolveFeatureInstance(project, props.pending.featureId)
  const rotary = feature?.canned ? ROTARY_EDIT_PARTS[feature.canned.kind] ?? null : null
  const hostRefs = {
    containerRef: props.containerRef,
    canvasRef: props.canvasRef,
    clearTransientCanvasState: props.clearTransientCanvasState,
  }
  if (rotary?.shape === 'solid') {
    return (
      <RotarySolidPanel
        kind={rotary.kind}
        featureId={props.pending.featureId}
        onClose={cancelPendingAdd}
        {...hostRefs}
      />
    )
  }
  if (rotary?.shape === 'pattern') {
    return (
      <RotaryPatternPanel
        kind={rotary.kind}
        featureId={props.pending.featureId}
        onClose={cancelPendingAdd}
        {...hostRefs}
      />
    )
  }
  return <FlatCannedShapeEditPanel {...props} />
}

function FlatCannedShapeEditPanel({
  pending,
  containerRef,
  canvasRef,
  clearTransientCanvasState,
}: CannedShapeEditPanelProps) {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const cancelPendingAdd = useProjectStore((state) => state.cancelPendingAdd)
  const featureId = pending.featureId
  const feature = resolveFeatureInstance(project, featureId)
  const canned = feature?.canned ?? null
  const request = canned ? EDITOR_REQUESTS[canned.kind] ?? null : null
  const isGear = canned?.kind === GEAR_CANNED_KIND
  const storedGear = isGear && canned ? normalizeGearCannedParams(canned.params) : null

  const [values, setValues] = useState<Record<string, string>>(
    () => (request && canned ? editorInitialValues(request, canned.params) : {}),
  )
  const [gearParams, setGearParams] = useState<GearCreationParams>(
    () => (storedGear ? gearCreationParamsOf(storedGear) : defaultGearCreationParams(20)),
  )
  const [gearSize, setGearSize] = useState(() => String(storedGear?.outsideRadius ?? 20))

  const panel = useCanvasWorkflowPanel({
    open: true,
    phaseKey: `canned-edit-${featureId}`,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    pageLevel: true,
    focusCanvasOnOpen: false,
  })

  // The row can vanish while the panel is open (undo, delete, a different
  // selection). Close rather than edit something that no longer exists.
  useEffect(() => {
    if (!canned) cancelPendingAdd()
  }, [canned, cancelPendingAdd])

  const gearSizeValue = draftNumber(gearSize)
  const normalized = isGear
    ? gearDraft(gearParams, gearSizeValue)
    : flatNormalized(request, values)
  // Every valid draft is written into the project as it is typed, so the sketch
  // and the 3D preview follow the fields; a value the generator refuses keeps
  // the last valid preview on screen. Apply commits that one preview
  // (issue #1112 F1).
  const { commitPreview } = useCannedShapePreview({
    featureId,
    draft: canned && normalized ? { kind: canned.kind, params: normalized } : null,
  })

  if (!canned) return null

  const labelKey = cannedShapeLabelKey(canned)
  // The gear's own validator reads the draft as typed, which is the only form
  // that can report a value the creation clamp would otherwise hide.
  const gearErrors = isGear
    ? validateGearProfileParams({
        ...gearParams,
        center: { x: 0, y: 0 },
        outsideRadius: gearSizeValue,
      })
    : []
  const invalid = normalized === null

  function apply(): void {
    if (!canned || !normalized) return
    commitPreview({ kind: canned.kind, params: normalized })
    cancelPendingAdd()
  }

  return (
    <CanvasWorkflowPanel
      title={t('canvas.cannedEdit.title', {
        shape: labelKey ? t(labelKey as MessageKey) : canned.kind,
      })}
      step={t('canvas.creation.step.enterDimensions')}
      position={panel.position}
      panelRef={panel.panelRef}
      handleProps={panel.handleProps}
      actionRowProps={panel.actionRowProps}
      pageLevel
      className="canvas-workflow-panel--creation"
      moveLabel={t('canvas.creation.moveLabel')}
      actions={(
        <>
          <CanvasWorkflowConfirm
            label={t('canvas.cannedEdit.save')}
            disabled={invalid}
            onClick={apply}
          />
          <CanvasWorkflowCancel label={t('canvas.common.cancel')} onClick={cancelPendingAdd} />
        </>
      )}
    >
      {isGear ? (
        <div className="canvas-workflow-panel__meta canvas-workflow-panel__gear-fields">
          <GearFields
            params={gearParams}
            session={`edit-${featureId}`}
            // The draft holds the raw numbers: clamping and rounding here would
            // replace a refused value with a valid-looking one before the
            // validator and the preview ever see it (#1112 F1 review).
            onParams={(patch) => setGearParams((current) => ({ ...current, ...patch }))}
            size={gearSizeValue}
            // `NaN` is the draft's "not a number" marker, so a cleared size is
            // kept as empty text rather than the literal 'NaN'; the preview
            // validator then reports it instead of the field quietly keeping
            // its old value (issue #1112 H1 review).
            onSize={(value) => setGearSize(Number.isFinite(value) ? String(value) : '')}
            live
          />
        </div>
      ) : request ? (
        <div className="canvas-workflow-panel__meta canvas-workflow-panel__parameter-fields">
          {request.fields.map((field) => (
            <label
              key={field.key}
              className="canvas-workflow-panel__field canvas-workflow-panel__field--reference"
            >
              <span>{t(field.labelKey)}</span>
              <input
                className="canvas-workflow-panel__count-input"
                type="text"
                inputMode={field.integer ? 'numeric' : 'decimal'}
                value={values[field.key] ?? ''}
                onChange={(event) => {
                  const next = event.currentTarget.value
                  setValues((previous) => ({ ...previous, [field.key]: next }))
                }}
              />
            </label>
          ))}
          <div className="canvas-workflow-panel__field">
            <CannedShapeEditReference request={request} values={values} />
          </div>
        </div>
      ) : null}
      {gearErrors.length > 0 ? (
        <div className="sketch-banner-warning">{gearErrors[0]}</div>
      ) : null}
      {invalid ? (
        <p className="properties-region-note" role="alert">
          {t('canvas.cannedEdit.invalid')}
        </p>
      ) : null}
    </CanvasWorkflowPanel>
  )
}

/**
 * The registry still keeps the model free of UI: Properties asks for an opener
 * by kind, and the opener arms the same pending session creation uses.
 */
function openCannedShapeEdit(featureId: string): void {
  useProjectStore.getState().beginCannedShapeEdit(featureId)
}

for (const request of Object.values(EDITOR_REQUESTS)) {
  registerCannedShapeEditor(request.kind, openCannedShapeEdit)
}
registerCannedShapeEditor(GEAR_CANNED_KIND, openCannedShapeEdit)
