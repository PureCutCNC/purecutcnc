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
 * Turn and Polygon in the canvas side panel (issue #1112 rt2-b item 18).
 *
 * Frank: "the newly added canned features do not follow the same UI/UX as the
 * existing one ... we should use the same dialog style". The four rotary kinds
 * are now created and edited in the same page-level canvas panel every other
 * canned shape uses — same layout, same field style, same Create/Cancel and
 * Save/Cancel actions, no modal — instead of a centred dialog. The fields,
 * their validation, the refusal reasons and the store actions are unchanged:
 * creation still calls `addRotarySolid` once (one generated model feature and
 * no folder or operation), and editing still rebuilds the model through the
 * same `updateFeature` path every other Properties edit takes.
 *
 * A Turn/Polygon belongs to the bar, not to a face (item 20), so creation is
 * offered on Top and Bottom as well as Around on either bar shape. The model
 * produced from any of them is identical: it stores the bar frame it was drawn
 * against, and the feature-tree place is the same.
 *
 * Live preview: an **edit** previews every valid draft through
 * `useCannedShapePreview`, so the sketch and the 3D model follow the fields
 * inside one history transaction that Save commits as one undo step. Creation
 * has no row to write into yet and ships without a preview for 0.6.0 (the
 * handoff allows that; the panel is created by the same store action either
 * way).
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useProjectStore } from '../../store/projectStore'
import type {
  RotarySolidInput,
  RotarySolidRefusal,
  TurnProfileRefreshReason,
} from '../../store/helpers/rotarySolids'
import {
  rotarySolidCannedData,
  rotarySolidInputProblem,
  turnProfileCandidates,
  turnProfileFromFeature,
  turnProfileRefreshState,
} from '../../store/helpers/rotarySolids'
import { Select } from '../Select'
import type { RotarySolidCannedKind } from '../../store/types'
import type { TurnCannedProfile } from '../../cannedShapes/generators/turnProfile'
import { turnProfileBand } from '../../cannedShapes/generators/turnProfile'
import { useCannedShapePreview } from '../useCannedShapePreview'
import { formHasChanges } from '../common/formDraft'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { formatLength } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import { aroundUnavailableReason } from '../../store/helpers/activeFace'
import { generateCannedShapeMesh } from '../../cannedShapes'
import { MAX_POLYGON_SIDES, normalizePolygonCannedParams } from '../../cannedShapes/generators/polygon'
import { normalizeTurnCannedParams } from '../../cannedShapes/generators/turn'
import {
  rotarySolidBarLength,
  rotarySolidFrame,
} from '../../cannedShapes/generators/rotarySolidParams'
import { CanvasWorkflowCancel, CanvasWorkflowConfirm } from './CanvasWorkflowAction'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useRotaryPanelChrome, useRotaryPanelKeyboard, type RotaryPanelHostRefs } from './useRotaryPanelChrome'
import { useRotaryPanelContextClose } from './rotaryPanelContext'

/** UI bounds for the polygon side count, matching `buildRotaryPolygonPrism`. */
const MIN_POLYGON_SIDES = 3

/**
 * Every refusal has human text. A field-level refusal reuses the message the
 * field itself shows, so one problem never reads two different ways.
 */
const REFUSAL_KEYS: Record<RotarySolidRefusal, MessageKey> = {
  notRotaryProject: 'dialogs.rotarySolid.refusal.notRotaryProject',
  setupAxisMismatch: 'dialogs.rotarySolid.refusal.setupAxisMismatch',
  notOnBar: 'dialogs.rotarySolid.refusal.notOnBar',
  invalidStart: 'dialogs.rotarySolid.error.start',
  invalidLength: 'dialogs.rotarySolid.error.length',
  invalidAlongRange: 'dialogs.rotarySolid.error.range',
  invalidSides: 'dialogs.rotarySolid.error.sides',
  invalidAcrossFlats: 'dialogs.rotarySolid.error.acrossFlats',
  invalidRotation: 'dialogs.rotarySolid.error.rotation',
  invalidDiameter: 'dialogs.rotarySolid.error.diameter',
  diameterExceedsStock: 'dialogs.rotarySolid.error.diameterExceedsStock',
  polygonExceedsStock: 'dialogs.rotarySolid.error.acrossFlatsBound',
  geometryNotRepresentable: 'dialogs.rotarySolid.refusal.geometryNotRepresentable',
  creationFailed: 'dialogs.rotarySolid.refusal.creationFailed',
  profileEmpty: 'dialogs.rotarySolid.profile.error.empty',
  profileCrossesAxis: 'dialogs.rotarySolid.profile.error.crossesAxis',
  profileDoublesBack: 'dialogs.rotarySolid.profile.error.doublesBack',
  profileMultipleOutlines: 'dialogs.rotarySolid.profile.error.multiple',
  profileExceedsStock: 'dialogs.rotarySolid.profile.error.exceedsStock',
  profileOutOfBar: 'dialogs.rotarySolid.profile.error.outOfBar',
  profileMissingSource: 'dialogs.rotarySolid.profile.error.missingSource',
  profileUnsupportedSource: 'dialogs.rotarySolid.profile.error.unsupported',
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value)
}

/**
 * A default field value that reads back as exactly the same number. Rounding to
 * four decimals widened a valid stock dimension past its own physical bound (a
 * 20.00006 side defaulted to 20.0001 and a 23.70006 length to 23.7001, so the
 * form opened refusing its own default), so the default is the shortest
 * round-tripping decimal.
 */
function tidy(value: number): string {
  return Number.isFinite(value) ? String(value) : ''
}

/**
 * The picture beside the profile picker (item 17): the outline of half the part
 * drawn on the bar's side view, and the part it turns into. Drawn with the
 * panel's existing reference-SVG classes so it reads in light and dark themes,
 * and labelled for a screen reader.
 */
function TurnProfileFigure() {
  const { t } = useI18n()
  return (
    <figure className="rotary-panel__profile-figure">
      <svg viewBox="0 0 132 48" role="img" aria-label={t('dialogs.rotarySolid.profile.picture')} focusable="false">
        {/* The bar seen from the side, with its axis on the centreline. */}
        <rect className="turn-figure__outline" x="4" y="9" width="52" height="30" rx="1.5" />
        <path className="turn-figure__guide" d="M1 24h58" strokeDasharray="7 2 1 2" />
        {/* The drawn half profile: one side of the centreline, inside the bar. */}
        <path className="turn-figure__accent" d="M12 24V16h12V11h6v9h10v-5h8v5" />
        {/* The part that profile makes when revolved about the axis. */}
        <path className="turn-figure__outline" d="M74 24V16h12V11h6v9h10v-5h8v5" />
        <path className="turn-figure__outline" d="M74 24v8h12v5h6v-9h10v5h8v-5" />
        <path className="turn-figure__guide" d="M70 24h58" strokeDasharray="7 2 1 2" />
      </svg>
      <figcaption>{t('dialogs.rotarySolid.profile.explanation')}</figcaption>
    </figure>
  )
}

interface RotarySolidPanelProps extends RotaryPanelHostRefs {
  kind: RotarySolidCannedKind
  /** Present when Properties reopened the panel for an existing model. */
  featureId?: string
  onClose: () => void
}

export function RotarySolidPanel({ kind, featureId, onClose, ...hostRefs }: RotarySolidPanelProps) {
  useRestoreCanvasFocus()
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const addRotarySolid = useProjectStore((state) => state.addRotarySolid)
  const units = project.meta.units
  const unitLabel = units === 'inch' ? 'in' : 'mm'
  const editing = featureId !== undefined
  const feature = editing ? resolveFeatureInstance(project, featureId) : null
  const storedCanned = feature?.canned && feature.canned.kind === kind ? feature.canned : null
  const storedTurn = kind === 'turn'
    ? normalizeTurnCannedParams(storedCanned?.params ?? {})
    : null
  const storedPolygon = kind === 'polygon'
    ? normalizePolygonCannedParams(storedCanned?.params ?? {})
    : null
  const stored = storedTurn ?? storedPolygon
  const frame = stored?.frame ?? rotarySolidFrame(project)
  const barLength = frame ? rotarySolidBarLength(frame) : 0

  const chrome = useRotaryPanelChrome({ ...hostRefs, phaseKey: `rotary-${kind}-${featureId ?? 'create'}`, onClose })
  // The panel's one stable "leave this form" action; used in effect deps.
  const closePanel = chrome.close
  // A form is measured against one physical bar and document; either changing
  // under it drops it rather than letting numbers describe a bar that is gone.
  useRotaryPanelContextClose(closePanel)

  // Creation also needs the bar workflow behind it. On any face of a bar-stock
  // rotary project the panel stays (item 20); when the stock stops being a bar
  // the form has nothing left to describe.
  const available = aroundUnavailableReason(project) === null
  useEffect(() => {
    if (!editing && !available) closePanel()
  }, [editing, available, closePanel])

  useEffect(() => {
    if (editing && !stored) onClose()
  }, [editing, stored, onClose])

  const startRef = useRef<HTMLInputElement>(null)
  const [start, setStart] = useState(() => (stored ? String(stored.start) : '0'))
  const [length, setLength] = useState(() => (stored ? String(stored.length) : tidy(barLength)))
  const [sides, setSides] = useState(() => (storedPolygon ? String(storedPolygon.sides) : '6'))
  const [acrossFlats, setAcrossFlats] = useState(() => {
    if (storedPolygon) return String(storedPolygon.acrossFlats)
    return tidy((frame?.thickness ?? 0) * 0.75)
  })
  const [rotation, setRotation] = useState(() => (storedPolygon ? String(storedPolygon.rotation) : '0'))
  const [diameter, setDiameter] = useState(() => {
    if (storedTurn) return String(storedTurn.diameter)
    return tidy(frame?.thickness ?? 0)
  })
  // The copied profile is panel state until Save writes it: Pick and Refresh
  // both replace this copy, and the source is only re-read by Refresh.
  const [profile, setProfile] = useState<TurnCannedProfile | null>(() => storedTurn?.profile ?? null)
  const [profileSourceId, setProfileSourceId] = useState(() => storedTurn?.profile?.sourceFeatureId ?? '')
  const [profileError, setProfileError] = useState<RotarySolidRefusal | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  // A close can outlive the click that opened the edit; the guard keeps a late
  // continuation from writing after the user left.
  const activeRef = useRef(true)
  // What Save would write, as the form holds it (issue #1112 F4): editing a
  // stored model without changing a field used to rewrite identical parameters
  // as a new undo step, so the button is greyed out while nothing differs. A
  // Turn's picked profile is part of what Save writes, so a re-picked profile
  // counts even when it copies the same numbers into the fields.
  const draftFields = kind === 'turn'
    ? {
        start: parseNumber(start),
        length: parseNumber(length),
        diameter: parseNumber(diameter),
        profile: profile ?? null,
      }
    : {
        start: parseNumber(start),
        length: parseNumber(length),
        sides: parseNumber(sides),
        acrossFlats: parseNumber(acrossFlats),
        rotation: parseNumber(rotation),
      }
  // The values the form opened with: a draft that never left them writes nothing.
  const [openedFields] = useState(draftFields)

  useEffect(() => () => {
    activeRef.current = false
  }, [])

  // Focus starts on the first field the user fills; the keyboard itself (Esc
  // closes, Enter applies) is `useRotaryPanelKeyboard` below.
  useEffect(() => {
    startRef.current?.focus({ preventScroll: true })
  }, [])

  /** A store refusal describes the request as it was; the first edit clears it. */
  function changeField(setter: (next: string) => void): (event: ChangeEvent<HTMLInputElement>) => void {
    return (event) => {
      setter(event.target.value)
      setRefusal(null)
    }
  }

  const profileCandidates = kind === 'turn' && frame ? turnProfileCandidates(project) : []
  const profileRefresh = kind === 'turn' && frame && profile
    ? turnProfileRefreshState(project, frame, profile)
    : null
  const profileBand = profile && frame ? turnProfileBand(frame, profile) : null

  /** One pick or Refresh. A refusal clears the pending copy and names why. */
  function pickProfile(sourceFeatureId: string) {
    if (!frame) return
    if (sourceFeatureId === '') {
      setProfile(null)
      setProfileSourceId('')
      setProfileError(null)
      setRefusal(null)
      return
    }
    const picked = turnProfileFromFeature(project, frame, sourceFeatureId)
    if (!picked.ok) {
      setProfile(null)
      setProfileSourceId(sourceFeatureId)
      setProfileError(picked.reason)
      setRefusal(null)
      return
    }
    setProfile(picked.profile)
    setProfileSourceId(picked.profile.sourceFeatureId)
    setProfileError(null)
    setRefusal(null)
    setStart(String(picked.start))
    setLength(String(picked.length))
    setDiameter(String(picked.diameter))
  }

  function refreshProfile() {
    if (!profileSourceId || profileRefresh?.canRefresh !== true) return
    pickProfile(profileSourceId)
  }

  /** The disabled Refresh reason, in the user's terms. */
  function refreshReasonText(reason: TurnProfileRefreshReason): string {
    switch (reason) {
      case 'no-profile':
        return t('dialogs.rotarySolid.profile.refreshNoProfile')
      case 'profileMissingSource':
        return t('dialogs.rotarySolid.profile.refreshMissingSource')
      case 'profileUnsupportedSource':
        return t('dialogs.rotarySolid.profile.refreshUnsupported')
      case 'profileEmpty':
      case 'profileCrossesAxis':
      case 'profileDoublesBack':
      case 'profileMultipleOutlines':
      case 'profileExceedsStock':
      case 'profileOutOfBar':
        return refusalText(reason)
    }
  }

  function buildInput(): RotarySolidInput {
    if (kind === 'turn') {
      return {
        kind: 'turn',
        start: parseNumber(start),
        length: parseNumber(length),
        diameter: parseNumber(diameter),
        ...(profile ? { profile } : {}),
      }
    }
    return {
      kind: 'polygon',
      start: parseNumber(start),
      length: parseNumber(length),
      sides: parseNumber(sides),
      acrossFlats: parseNumber(acrossFlats),
      rotationDeg: parseNumber(rotation),
    }
  }

  /** The across-flats ceiling for this side count, or Infinity for a bad count. */
  function acrossFlatsCeiling(): number {
    if (!frame) return Number.POSITIVE_INFINITY
    const sidesValue = parseNumber(sides)
    if (!Number.isInteger(sidesValue) || sidesValue < MIN_POLYGON_SIDES || sidesValue > MAX_POLYGON_SIDES) {
      return Number.POSITIVE_INFINITY
    }
    return frame.thickness * Math.cos(Math.PI / sidesValue)
  }

  function refusalText(reason: RotarySolidRefusal): string {
    const key = REFUSAL_KEYS[reason]
    return t(key, {
      min: MIN_POLYGON_SIDES,
      max: MAX_POLYGON_SIDES,
      length: formatLength(barLength, units),
      maxSize: formatLength(kind === 'turn' ? (frame?.thickness ?? 0) : acrossFlatsCeiling(), units),
      units: unitLabel,
    })
  }

  const problem = profileError ?? (frame ? rotarySolidInputProblem(frame, buildInput()) : 'notOnBar')
  // Creation has no stored model to compare against and keeps its own gate.
  const untouched = editing && !formHasChanges(openedFields, draftFields)
  const problemText = problem === null ? null : refusalText(problem)

  // Live preview (issue #1112 F1): every valid draft is written into the project
  // through the ordinary `updateFeature` path, so the sketch and the 3D model
  // follow the fields instead of waiting for Save. A draft the panel refuses is
  // never written, and closing without Save restores the stored model exactly;
  // Save commits the preview as one undo step. Creation has no row to preview.
  const draft = editing && frame && stored && problem === null
    ? rotarySolidCannedData(stored.frame, buildInput(), units)
    : null
  const { commitPreview } = useCannedShapePreview({
    featureId: featureId ?? null,
    draft,
  })

  function handleApply() {
    // Nothing to write while the form still holds the stored model.
    if (problem !== null || !frame || untouched) return
    if (editing && featureId) {
      if (!stored) return
      const input = buildInput()
      const canned = rotarySolidCannedData(stored.frame, input, units)
      if (!canned) {
        setRefusal(t('dialogs.rotarySolid.refusal.creationFailed'))
        return
      }
      const mesh = generateCannedShapeMesh(canned)
      if (!mesh) {
        setRefusal(t('dialogs.rotarySolid.refusal.geometryNotRepresentable'))
        return
      }
      // One parameter write, one history entry. The preview already wrote this
      // draft inside a transaction; committing it is what makes the whole edit
      // one undo step. The store rebuilds the mesh and re-fits every instance's
      // span from its own placement — the edited row and every linked copy keep
      // their own Z centre and scale, so a diameter change cannot reset the
      // edited instance or misalign a copy. Pinning the mesh's raw Z bounds here
      // would do exactly that.
      commitPreview(canned)
      if (activeRef.current) closePanel()
      return
    }

    const result = addRotarySolid(buildInput())
    if (result.ok) {
      closePanel()
      return
    }
    setRefusal(refusalText(result.reason))
  }

  // The Create/Save action advertises Enter but is not a tab stop, so the form
  // itself is the keyboard route to it (review finding 2). Declared after
  // `handleApply` so the hook reads this render's validity, and before the
  // early returns below so the hook order stays fixed.
  useRotaryPanelKeyboard({
    onClose: closePanel,
    onApply: handleApply,
    canApply: problem === null && !untouched,
  })

  // The source name is live while the source exists: a rename must show the new
  // name, not the name copied when the profile was picked. Only a deleted (or
  // unavailable) source falls back to the snapshot.
  const profileSourceName = profileSourceId
    ? resolveFeatureInstance(project, profileSourceId)?.name
      ?? profile?.sourceName
      ?? storedTurn?.profile?.sourceName
      ?? profileSourceId
    : ''
  const profileOptions: Array<{ value: string; label: string }> = [
    { value: '', label: t('dialogs.rotarySolid.profile.none') },
    ...profileCandidates.map((candidate) => ({ value: candidate.id, label: candidate.name })),
  ]
  if (profileSourceId && !profileCandidates.some((candidate) => candidate.id === profileSourceId)) {
    profileOptions.push({
      value: profileSourceId,
      label: t('dialogs.rotarySolid.profile.missingOption', { name: profileSourceName }),
    })
  }
  const refreshUnavailable = profileRefresh?.canRefresh === true
    ? null
    : profileRefresh?.canRefresh === false
      ? refreshReasonText(profileRefresh.reason)
      : profileError
        ? refusalText(profileError)
        : refreshReasonText('no-profile')

  const titleKey: MessageKey = kind === 'turn'
    ? (editing ? 'dialogs.rotarySolid.turn.editTitle' : 'dialogs.rotarySolid.turn.title')
    : (editing ? 'dialogs.rotarySolid.polygon.editTitle' : 'dialogs.rotarySolid.polygon.title')

  // A corrupt parameter set has no editable form; the effect above closes it.
  if (editing && !stored) return null
  if (!frame) return null

  const fieldClass = 'canvas-workflow-panel__count-input canvas-workflow-panel__distance-input'

  return (
    <CanvasWorkflowPanel
      title={t(titleKey)}
      step={t('canvas.creation.step.enterDimensions')}
      position={chrome.position}
      panelRef={chrome.panelRef}
      handleProps={chrome.handleProps}
      actionRowProps={chrome.actionRowProps}
      pageLevel
      className="canvas-workflow-panel--rotary rotary-solid-panel"
      moveLabel={t('canvas.creation.moveLabel')}
      actions={(
        <>
          <CanvasWorkflowConfirm
            label={editing ? t('canvas.cannedEdit.save') : t('dialogs.rotarySolid.create')}
            className="rotary-panel__create"
            disabled={problem !== null || untouched}
            onClick={handleApply}
          />
          <CanvasWorkflowCancel label={t('canvas.common.cancel')} onClick={closePanel} />
        </>
      )}
    >
      {kind === 'turn' ? (
        <div className="rotary-panel__profile" role="group" aria-label={t('dialogs.rotarySolid.profile.pick')}>
          <div className="canvas-workflow-panel__field rotary-panel__profile-row">
            <span>{t('dialogs.rotarySolid.profile.pick')}</span>
            <Select
              value={profileSourceId}
              options={profileOptions}
              onChange={pickProfile}
            />
            {/*
              Refresh has nothing to refresh while None is selected, so it is
              hidden rather than shown greyed out (issue #1112 rt2-b item 16).
              Once a shape is picked it stays, disabled with the reason it
              cannot re-read its source.
            */}
            {profileSourceId === '' ? null : (
              <button
                className="feat-btn rotary-panel__profile-refresh"
                type="button"
                disabled={profileRefresh?.canRefresh !== true}
                title={refreshUnavailable ?? undefined}
                onClick={refreshProfile}
              >
                {t('dialogs.rotarySolid.profile.refresh')}
              </button>
            )}
          </div>
          {/*
            Nothing qualifies to pick: the picker said "None — one plain
            diameter" and the user had no hint how to make one appear. The hint
            is shown exactly while the list is empty (item 16).
          */}
          {profileCandidates.length === 0 ? (
            <p className="rotary-panel__note rotary-panel__profile-empty">
              {t('dialogs.rotarySolid.profile.noCandidates')}
            </p>
          ) : null}
          {profileBand ? (
            <p className="rotary-panel__note rotary-panel__profile-summary">
              {t('dialogs.rotarySolid.profile.summary', {
                name: profileSourceName,
                diameter: formatLength(profileBand.diameter, units),
                length: formatLength(profileBand.length, units),
                units: unitLabel,
              })}
            </p>
          ) : null}
          {profile && profileRefresh?.canRefresh === false ? (
            <p className="rotary-panel__note rotary-panel__profile-missing">
              {refreshReasonText(profileRefresh.reason)}
            </p>
          ) : null}
          {profile ? (
            <p className="rotary-panel__note">{t('dialogs.rotarySolid.profile.setsShape')}</p>
          ) : null}
          {/* Item 17: the explanation, with a picture of the outline and the part it makes. */}
          <TurnProfileFigure />
        </div>
      ) : null}

      <div className="canvas-workflow-panel__meta canvas-workflow-panel__rotary-fields">
        <label className="canvas-workflow-panel__field">
          <span>{t('dialogs.rotarySolid.start', { units: unitLabel })}</span>
          <input
            ref={startRef}
            id="rotary-solid-start"
            className={fieldClass}
            type="number"
            min="0"
            step="any"
            value={start}
            disabled={profile !== null}
            onChange={changeField(setStart)}
          />
        </label>

        <label className="canvas-workflow-panel__field">
          <span>{t('dialogs.rotarySolid.length', { units: unitLabel })}</span>
          <input
            id="rotary-solid-length"
            className={fieldClass}
            type="number"
            min="0"
            step="any"
            value={length}
            disabled={profile !== null}
            onChange={changeField(setLength)}
          />
        </label>

        {kind === 'turn' ? (
          <label className="canvas-workflow-panel__field">
            <span>{t('dialogs.rotarySolid.diameter', { units: unitLabel })}</span>
            <input
              id="rotary-solid-diameter"
              className={fieldClass}
              type="number"
              min="0"
              step="any"
              value={diameter}
              disabled={profile !== null}
              onChange={changeField(setDiameter)}
            />
          </label>
        ) : (
          <>
            <label className="canvas-workflow-panel__field">
              <span>{t('dialogs.rotarySolid.sides')}</span>
              <input
                id="rotary-solid-sides"
                className="canvas-workflow-panel__count-input"
                type="number"
                min={MIN_POLYGON_SIDES}
                max={MAX_POLYGON_SIDES}
                step="1"
                value={sides}
                onChange={changeField(setSides)}
              />
            </label>

            <label className="canvas-workflow-panel__field">
              <span>{t('dialogs.rotarySolid.acrossFlats', { units: unitLabel })}</span>
              <input
                id="rotary-solid-across-flats"
                className={fieldClass}
                type="number"
                min="0"
                step="any"
                value={acrossFlats}
                onChange={changeField(setAcrossFlats)}
              />
            </label>

            <label className="canvas-workflow-panel__field">
              <span>{t('dialogs.rotarySolid.rotation')}</span>
              <input
                id="rotary-solid-rotation"
                className="canvas-workflow-panel__count-input"
                type="number"
                step="any"
                value={rotation}
                onChange={changeField(setRotation)}
              />
            </label>
          </>
        )}
      </div>

      <p className="rotary-panel__note">{t('dialogs.rotarySolid.note')}</p>
      {kind === 'polygon' ? (
        <p className="rotary-panel__note rotary-panel__limit-note">
          {t('dialogs.rotarySolid.polygonNote')}
        </p>
      ) : null}

      {problemText !== null ? (
        <div className="cam-field-message rotary-panel__error" role="alert">{problemText}</div>
      ) : null}
      {refusal !== null ? (
        <div className="cam-field-message rotary-panel__error" role="alert">{refusal}</div>
      ) : null}
    </CanvasWorkflowPanel>
  )
}
