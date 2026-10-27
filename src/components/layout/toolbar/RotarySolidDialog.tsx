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
 * The Turn and Polygon dialog (issue #1112 slice G).
 *
 * One component creates and edits both canned models. Creation calls
 * `addRotarySolid` once, which writes one generated model feature and no
 * folder or operation; editing rebuilds that model's mesh through the same
 * `updateFeature` path every other Properties edit takes. The dialog has no
 * Tool field — rotary rough and finish are added to the model the ordinary way
 * (decision 3).
 *
 * Lengths are project units, and start/length are measured from the **chuck
 * end**, the same as Thread/Flutes (decision 4). A Turn on a square blank is
 * the old Square to round target; on a round bar it is the same cylinder inside
 * the bar.
 *
 * The dialog is opened from one module store: the creation drawer's rotary
 * group calls `openRotarySolidCreate`, and the canned-shape editor registry
 * (the Properties "Edit turn…/Edit polygon…" button) calls
 * `openRotarySolidEdit`. One host, mounted once by AppShell, renders it, so the
 * drawer closing on hover cannot unmount an open dialog and the expanded
 * Properties modal cannot mount a second one. A create dialog closes as soon as
 * Around stops being the available, active face. Any dialog, create or Edit,
 * closes when the bar, units, document or face behind it change — one context
 * key shared with Thread/Flutes (`rotaryDialogContext.ts`).
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../../../store/projectStore'
import type {
  RotarySolidInput,
  RotarySolidRefusal,
  TurnProfileRefreshReason,
} from '../../../store/helpers/rotarySolids'
import {
  rotarySolidCannedData,
  rotarySolidInputProblem,
  turnProfileCandidates,
  turnProfileFromFeature,
  turnProfileRefreshState,
} from '../../../store/helpers/rotarySolids'
import { Select } from '../../Select'
import type { TurnCannedProfile } from '../../../cannedShapes/generators/turnProfile'
import { turnProfileBand } from '../../../cannedShapes/generators/turnProfile'
import { useRestoreCanvasFocus } from '../../../utils/useRestoreCanvasFocus'
import { formatLength } from '../../../utils/units'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { resolveFeatureInstance } from '../../../store/helpers/resolveFeatures'
import { activeFace, aroundUnavailableReason } from '../../../store/helpers/activeFace'
import { generateCannedShapeMesh } from '../../../cannedShapes'
import { MAX_POLYGON_SIDES, normalizePolygonCannedParams } from '../../../cannedShapes/generators/polygon'
import { normalizeTurnCannedParams } from '../../../cannedShapes/generators/turn'
import {
  rotarySolidBarLength,
  rotarySolidFrame,
} from '../../../cannedShapes/generators/rotarySolidParams'
import {
  closeRotarySolidDialog,
  dialogRequestSnapshot,
  subscribeDialogRequest,
  type RotarySolidKind,
} from './rotarySolidDialogState'
import { rotaryDialogContextKey } from './rotaryDialogContext'

export type { RotarySolidKind } from './rotarySolidDialogState'

/** UI bounds for the polygon side count, matching `buildRotaryPolygonPrism`. */
const MIN_POLYGON_SIDES = 3

/**
 * Every refusal has human text. A field-level refusal reuses the message the
 * field itself shows, so one problem never reads two different ways.
 */
const REFUSAL_KEYS: Record<RotarySolidRefusal, MessageKey> = {
  notRotaryProject: 'dialogs.rotarySolid.refusal.notRotaryProject',
  notAroundFace: 'dialogs.rotarySolid.refusal.notAroundFace',
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

// ---------------------------------------------------------------------------
// The dialog host (creation drawer + Properties editor)
// ---------------------------------------------------------------------------

/** Rendered once by AppShell; opens the create or edit dialog when asked. */
export function RotarySolidDialogHost() {
  const request = useSyncExternalStore(
    subscribeDialogRequest,
    dialogRequestSnapshot,
    dialogRequestSnapshot,
  )
  const project = useProjectStore((state) => state.project)
  const projectKey = useProjectStore((state) => state.projectKey)
  const face = activeFace(project)
  const available = aroundUnavailableReason(project) === null
  const context = rotaryDialogContextKey(project, projectKey)
  const lastContext = useRef(context)

  useEffect(() => {
    if (request && !request.featureId && (face !== 'around' || !available)) {
      closeRotarySolidDialog()
    }
  }, [request, face, available])

  // A form is opened against one physical context: the bar, the units, the
  // machine origin and the document. A change to any of them drops it, for
  // creation and for Edit, instead of leaving numbers measured against a bar
  // that is no longer there. Filling a create dialog is a face workflow, so it
  // closes when Around stops being the available, active face; an Edit form is
  // reached from Properties on any face, so it is only tied to the context key.
  useEffect(() => {
    if (request && lastContext.current !== context) {
      closeRotarySolidDialog()
    }
    lastContext.current = context
  }, [request, context])

  if (!request || typeof document === 'undefined') return null
  const key = `${request.kind}-${request.featureId ?? 'create'}`
  return createPortal(
    <RotarySolidDialog
      key={key}
      kind={request.kind}
      featureId={request.featureId}
      onClose={closeRotarySolidDialog}
    />,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface RotarySolidDialogProps {
  kind: RotarySolidKind
  featureId?: string
  onClose: () => void
}

export function RotarySolidDialog({ kind, featureId, onClose }: RotarySolidDialogProps) {
  useRestoreCanvasFocus()
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDivElement>(null)
  const project = useProjectStore((state) => state.project)
  const addRotarySolid = useProjectStore((state) => state.addRotarySolid)
  const updateFeature = useProjectStore((state) => state.updateFeature)
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

  useEffect(() => {
    if (editing && !stored) onClose()
  }, [editing, stored, onClose])

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
  // The copied profile is dialog state until Apply writes it: Pick and Refresh
  // both replace this copy, and the source is only re-read by Refresh.
  const [profile, setProfile] = useState<TurnCannedProfile | null>(() => storedTurn?.profile ?? null)
  const [profileSourceId, setProfileSourceId] = useState(() => storedTurn?.profile?.sourceFeatureId ?? '')
  const [profileError, setProfileError] = useState<RotarySolidRefusal | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  // A close can outlive the click that opened the edit; the guard keeps a late
  // continuation from writing after the user left.
  const activeRef = useRef(true)

  useEffect(() => () => {
    activeRef.current = false
  }, [])

  // The form owns the keyboard while it is open: focus starts on the first
  // field the user fills, Tab/Shift+Tab wrap inside the frame and Escape
  // closes; unmounting returns focus to the canvas.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('#rotary-solid-start')?.focus()
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const node = dialogRef.current
      if (!node) return
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...node.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      )]
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      const inside = active instanceof HTMLElement && node.contains(active)
      if (!inside) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

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
  const problemText = problem === null ? null : refusalText(problem)

  function handleApply() {
    if (problem !== null || !frame) return
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
      // One parameter write, one history entry. The store rebuilds the mesh
      // and re-fits every instance's span from its own placement — the edited
      // row and every linked copy keep their own Z centre and scale, so a
      // diameter change cannot reset the edited instance or misalign a copy.
      // Pinning the mesh's raw Z bounds here would do exactly that.
      updateFeature(featureId, { canned })
      if (activeRef.current) onClose()
      return
    }

    const result = addRotarySolid(buildInput())
    if (result.ok) {
      onClose()
      return
    }
    setRefusal(refusalText(result.reason))
  }

  // The source name is live while the source exists: a rename must show the
  // new name, not the name copied when the profile was picked. Only a deleted
  // (or unavailable) source falls back to the snapshot.
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

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog dialog--import dialog--rotary rotary-solid-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rotary-solid-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="rotary-solid-dialog-title">{t(titleKey)}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={t('dialogs.common.close')} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--import">
          <div className="dialog-section">
            {kind === 'turn' ? (
              <div className="dialog-section-group rotary-dialog__profile" role="group" aria-label={t('dialogs.rotarySolid.profile.pick')}>
                <label className="dialog-section-title">{t('dialogs.rotarySolid.profile.pick')}</label>
                <div className="properties-field rotary-dialog__profile-row">
                  <Select
                    value={profileSourceId}
                    options={profileOptions}
                    onChange={pickProfile}
                  />
                  <button
                    className="feat-btn rotary-dialog__profile-refresh"
                    type="button"
                    disabled={profileRefresh?.canRefresh !== true}
                    title={refreshUnavailable ?? undefined}
                    onClick={refreshProfile}
                  >
                    {t('dialogs.rotarySolid.profile.refresh')}
                  </button>
                </div>
                {profileBand ? (
                  <p className="rotary-dialog__note rotary-dialog__profile-summary">
                    {t('dialogs.rotarySolid.profile.summary', {
                      name: profileSourceName,
                      diameter: formatLength(profileBand.diameter, units),
                      length: formatLength(profileBand.length, units),
                      units: unitLabel,
                    })}
                  </p>
                ) : null}
                {profile && profileRefresh?.canRefresh === false ? (
                  <p className="rotary-dialog__note rotary-dialog__profile-missing">
                    {refreshReasonText(profileRefresh.reason)}
                  </p>
                ) : null}
                {profile ? (
                  <p className="rotary-dialog__note">{t('dialogs.rotarySolid.profile.setsShape')}</p>
                ) : null}
              </div>
            ) : null}

            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="rotary-solid-start">
                {t('dialogs.rotarySolid.start', { units: unitLabel })}
              </label>
              <div className="properties-field">
                <input
                  id="rotary-solid-start"
                  type="number"
                  min="0"
                  step="any"
                  value={start}
                  disabled={profile !== null}
                  onChange={changeField(setStart)}
                />
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="rotary-solid-length">
                {t('dialogs.rotarySolid.length', { units: unitLabel })}
              </label>
              <div className="properties-field">
                <input
                  id="rotary-solid-length"
                  type="number"
                  min="0"
                  step="any"
                  value={length}
                  disabled={profile !== null}
                  onChange={changeField(setLength)}
                />
              </div>
            </div>

            {kind === 'turn' ? (
              <div className="dialog-section-group">
                <label className="dialog-section-title" htmlFor="rotary-solid-diameter">
                  {t('dialogs.rotarySolid.diameter', { units: unitLabel })}
                </label>
                <div className="properties-field">
                  <input
                    id="rotary-solid-diameter"
                    type="number"
                    min="0"
                    step="any"
                    value={diameter}
                    disabled={profile !== null}
                    onChange={changeField(setDiameter)}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-solid-sides">
                    {t('dialogs.rotarySolid.sides')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-solid-sides"
                      type="number"
                      min={MIN_POLYGON_SIDES}
                      max={MAX_POLYGON_SIDES}
                      step="1"
                      value={sides}
                      onChange={changeField(setSides)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-solid-across-flats">
                    {t('dialogs.rotarySolid.acrossFlats', { units: unitLabel })}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-solid-across-flats"
                      type="number"
                      min="0"
                      step="any"
                      value={acrossFlats}
                      onChange={changeField(setAcrossFlats)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-solid-rotation">
                    {t('dialogs.rotarySolid.rotation')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-solid-rotation"
                      type="number"
                      step="any"
                      value={rotation}
                      onChange={changeField(setRotation)}
                    />
                  </div>
                </div>
              </>
            )}

            <p className="rotary-dialog__note">{t('dialogs.rotarySolid.note')}</p>
            {kind === 'polygon' ? (
              <p className="rotary-dialog__note rotary-dialog__limit-note">
                {t('dialogs.rotarySolid.polygonNote')}
              </p>
            ) : null}

            {problemText !== null ? (
              <div className="cam-field-message rotary-dialog__error" role="alert">{problemText}</div>
            ) : null}
            {refusal !== null ? (
              <div className="cam-field-message rotary-dialog__error" role="alert">{refusal}</div>
            ) : null}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="feat-btn" type="button" onClick={onClose}>
            {t('dialogs.common.cancel')}
          </button>
          <button
            className="feat-btn feat-btn--primary rotary-dialog__create"
            type="button"
            disabled={problem !== null}
            onClick={handleApply}
          >
            {editing ? t('dialogs.common.apply') : t('dialogs.rotarySolid.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
