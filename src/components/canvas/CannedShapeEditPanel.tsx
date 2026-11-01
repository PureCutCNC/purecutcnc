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
 * so it is one undo step and linked copies follow. The one exception is a
 * radius the ellipse's canvas handles drag: that field is *held*, drawn by the
 * canvas from the panel's draft and kept at its stored value in the project —
 * for the rest of the session, so typing the other radius does not carry it
 * into the project — until Save (issue #1112 rt7-g review). There is no second
 * React root and no modal.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { CannedShapeParams } from '../../types/project'
import type { PendingAddTool } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import { cannedShapeLabelKey } from '../../cannedShapes'
import { registerCannedShapeEditor } from '../../cannedShapes/registry'
import type { CannedShapeEditorRequest } from '../../cannedShapes/generators/editorRequest'
import {
  editorInitialValues,
  editorNormalizedParams,
} from '../../cannedShapes/generators/editorForm'
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
  cannedEditPreviewValues,
  closeCannedEditDraft,
  getCannedEditDraft,
  openCannedEditDraft,
  seedCannedEditDraft,
  setCannedEditDraftField,
  subscribeCannedEditDraft,
} from './cannedEditDraft'
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
  return editorNormalizedParams(request, values)
}

/**
 * Whether two parameter sets fill the editor's fields with the same text: the
 * test for "this stored change is the panel's own preview, not a canvas drag".
 */
function sameEditorFields(
  request: CannedShapeEditorRequest,
  a: CannedShapeParams,
  b: CannedShapeParams,
): boolean {
  const left = editorInitialValues(request, a)
  const right = editorInitialValues(request, b)
  return request.fields.every((field) => left[field.key] === right[field.key])
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
  const cannedKind = canned?.kind ?? null

  // The fields are the open session's draft, not React state: the canvas radius
  // handles write the same text, so typing and dragging are one edit path
  // (issue #1112 rt7-g).
  const draft = useSyncExternalStore(subscribeCannedEditDraft, getCannedEditDraft, getCannedEditDraft)
  const sessionDraft = draft && draft.featureId === featureId && draft.kind === cannedKind
    ? draft
    : null
  // The stored parameters as field text: what a field the handles dragged keeps
  // in the project until Save (issue #1112 rt7-g correction).
  const units = project.meta.units
  const storedValues = request && canned ? editorInitialValues(request, canned.params) : {}
  // A unit switch converts the stored parameters but not field text already on
  // screen. That draft is replaced from the project instead of previewed: its
  // numbers belong to the old unit system (issue #1112 rt7-g correction).
  const staleUnits = sessionDraft !== null && sessionDraft.units !== units
  const values = sessionDraft ? sessionDraft.values : storedValues
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

  // One session's fields, opened with the stored parameters; closing the panel
  // ends the session, which is what stops the ellipse drawing its handles.
  useEffect(() => {
    if (!canned || !request || !cannedKind) return
    const current = getCannedEditDraft()
    if (current && current.featureId === featureId && current.kind === cannedKind) return
    openCannedEditDraft(featureId, cannedKind, editorInitialValues(request, canned.params), units)
    // Opened once per panel. A stored change afterwards is a reseed, not a
    // reopen — `canned` is rebuilt on every render and would refire this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId, request, cannedKind])

  useEffect(() => () => closeCannedEditDraft(featureId), [featureId])

  const gearSizeValue = draftNumber(gearSize)
  const normalized = isGear
    ? gearDraft(gearParams, gearSizeValue)
    : flatNormalized(request, values)
  // Every valid typed draft is written into the project as it is typed, so the
  // sketch and the 3D preview follow the fields; a value the generator refuses
  // keeps the last valid preview on screen. Apply commits that one preview
  // (issue #1112 F1).
  //
  // A radius the handles dragged is the exception, and it stays one for the
  // rest of the session: its field previews at the stored value while every
  // *typed* field still previews live. Passing the whole draft here is what let
  // a keystroke in another field carry the dragged radius into the project
  // before Save (issue #1112 rt7-g correction). The canvas keeps drawing the
  // dragged radius from the draft (`cannedEditHandleParams`), so dragging is an
  // edit of the panel, never of the project.
  const previewNormalized = isGear || !request || !sessionDraft || staleUnits
    ? normalized
    : flatNormalized(request, cannedEditPreviewValues(sessionDraft, storedValues))
  const { commitPreview } = useCannedShapePreview({
    featureId,
    // A draft from another unit system is not previewed at all: its text is
    // replaced with the converted stored values by the reseed effect below.
    draft: canned && previewNormalized && !staleUnits
      ? { kind: canned.kind, params: previewNormalized }
      : null,
  })

  // A stored change the fields did not produce (an undo) lands back in the
  // fields. The panel's own live preview writes the stored parameters too, so
  // those are skipped — compared through the held-field projection the preview
  // uses, or a typed field next to a dragged one would look like someone else's
  // change and wipe the dragged text. A draft from another unit system is always
  // replaced: the projection reads the stored side, so it could never see the
  // switch.
  const storedParamsKey = canned ? JSON.stringify(canned.params) : ''
  useEffect(() => {
    if (!request || !canned) return
    if (!staleUnits && previewNormalized && sameEditorFields(request, canned.params, previewNormalized)) return
    seedCannedEditDraft(featureId, editorInitialValues(request, canned.params), units)
    // The stored parameters and the unit system are the triggers; `request` and
    // `canned` are rebuilt each render and would refire this on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedParamsKey, staleUnits, units])

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
                  setCannedEditDraftField(featureId, field.key, next)
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
 *
 * The editor's fields are opened here, synchronously, rather than waiting for
 * the panel to mount: the canvas draws the ellipse's radius handles from that
 * draft, and an open window between the panel appearing and its first effect
 * would be a frame with the panel up and no handles (issue #1112 rt7-g).
 */
function openCannedShapeEdit(featureId: string): void {
  const store = useProjectStore.getState()
  store.beginCannedShapeEdit(featureId)
  const feature = resolveFeatureInstance(useProjectStore.getState().project, featureId)
  const canned = feature?.canned
  const request = canned ? EDITOR_REQUESTS[canned.kind] ?? null : null
  if (canned && request) {
    openCannedEditDraft(
      featureId,
      canned.kind,
      editorInitialValues(request, canned.params),
      useProjectStore.getState().project.meta.units,
    )
    return
  }
  // A gear or a rotary kind edits other state, not these fields.
  closeCannedEditDraft()
}

for (const request of Object.values(EDITOR_REQUESTS)) {
  registerCannedShapeEditor(request.kind, openCannedShapeEdit)
}
registerCannedShapeEditor(GEAR_CANNED_KIND, openCannedShapeEdit)

// The four rotary kinds are edited in their own panels, through the same
// session, so they register the same opener. Without these entries Properties
// offers their Edit action disabled with "This shape's editor is not available
// yet", which stopped being true when they moved off the dialogs (issue #1112
// rt2-b) — the browser lane caught it.
for (const kind of Object.keys(ROTARY_EDIT_PARTS)) {
  registerCannedShapeEditor(kind, openCannedShapeEdit)
}
