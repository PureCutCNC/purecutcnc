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
 * The Thread and Flutes dialog (issues #1016 C1, #1112 F).
 *
 * One component creates and edits both canned shapes. Creation calls
 * `addRotaryPattern` once, which writes one canned feature and no operation;
 * editing updates the feature's stored parameters through the same
 * `updateFeature` path every other Properties edit takes. The dialog has no
 * Tool field — a Follow line operation is added to the feature the ordinary
 * way (decision 3).
 *
 * Lengths are project units, and start/length are measured from the **chuck
 * end**, the same as Turn/Polygon (decision 4). The inch thread field is
 * threads per inch and is converted to a physical pitch before the store call.
 * A flute's twist field is a magnitude; the physical hand signs the stored
 * value, so Left is that positive number negated and a straight (0) flute is
 * straight in either hand.
 *
 * The dialog is opened from one module store: the creation drawer's rotary
 * group calls `openRotaryPatternCreate`, and the canned-shape editor registry
 * (the Properties "Edit thread…/Edit flutes…" button) calls
 * `openRotaryPatternEdit`. One host, mounted once by AppShell, renders it, so
 * the drawer closing on hover cannot unmount an open dialog and the expanded
 * Properties modal cannot mount a second one. The host closes a create dialog
 * as soon as Around stops being the available, active face, and any dialog,
 * create or Edit, when the bar, units, document or face behind it change — the
 * same context key Turn/Polygon uses (`rotaryDialogContext.ts`).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../../../store/projectStore'
import {
  THREAD_DEPTH_PER_PITCH,
  rotaryPatternCannedData,
  rotaryPatternFrame,
  type RotaryPatternInput,
  type RotaryPatternRefusal,
} from '../../../store/helpers/rotaryPatterns'
import { getStockBounds } from '../../../types/project'
import { useCannedShapePreview } from '../../useCannedShapePreview'
import { formHasChanges } from '../../common/formDraft'
import { useRestoreCanvasFocus } from '../../../utils/useRestoreCanvasFocus'
import { formatLength } from '../../../utils/units'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { resolveFeatureInstance } from '../../../store/helpers/resolveFeatures'
import { activeFace, aroundSketchAuthoringAvailable } from '../../../store/helpers/activeFace'
import { normalizeFlutesCannedParams } from '../../../cannedShapes/generators/flutes'
import { normalizeThreadCannedParams } from '../../../cannedShapes/generators/thread'
import {
  rotaryPatternSurface,
  rotaryPatternSurfaceOfFeature,
  rotaryPatternSurfaceSpan,
  rotaryPatternSurfaceSpanOn,
  rotaryPatternSurfaceWarning,
} from '../../../store/helpers/rotarySurface'
import { RotaryDirectionField } from './RotaryDirectionField'
import {
  closeRotaryPatternDialog,
  dialogRequestSnapshot,
  subscribeDialogRequest,
  type RotaryPatternKind,
} from './rotaryPatternDialogState'
import { rotaryDialogContextKey } from './rotaryDialogContext'

export type { RotaryPatternKind } from './rotaryPatternDialogState'

/** UI caps, so a typo cannot ask the store for hundreds of lines. */
const MAX_THREAD_STARTS = 32
const MAX_FLUTE_COUNT = 64
const MM_DEFAULT_PITCH = 1.5
const INCH_DEFAULT_TPI = 20

/**
 * Every refusal has human text. A field-level refusal reuses the message the
 * field itself shows, so the same problem never reads two different ways.
 */
const REFUSAL_KEYS: Record<RotaryPatternRefusal, MessageKey> = {
  aroundUnavailable: 'dialogs.rotary.error.around',
  aroundNotActive: 'dialogs.rotary.refusal.aroundNotActive',
  invalidStart: 'dialogs.rotary.error.start',
  invalidLength: 'dialogs.rotary.error.length',
  invalidDepth: 'dialogs.rotary.error.depth',
  invalidPitch: 'dialogs.rotary.error.pitch',
  invalidStarts: 'dialogs.rotary.error.starts',
  invalidCount: 'dialogs.rotary.error.count',
  invalidTwist: 'dialogs.rotary.error.twist',
  depthReachesCentreline: 'dialogs.rotary.error.depthCentreline',
  creationFailed: 'dialogs.rotary.refusal.creationFailed',
}

/** The second sentence an `aroundUnavailable` refusal adds, naming the cause. */
const AROUND_DETAIL_KEYS: Record<string, MessageKey> = {
  needsRotaryProject: 'dialogs.rotary.around.needsRotaryProject',
  needsRoundBar: 'dialogs.rotary.around.needsRoundBar',
  needsRotaryMachine: 'dialogs.rotary.around.needsRotaryMachine',
  machineAxisMismatch: 'dialogs.rotary.around.machineAxisMismatch',
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value)
}

/** A number that round-trips through the field without scientific notation. */
function tidy(value: number): string {
  return String(Number(value.toFixed(4)))
}

// ---------------------------------------------------------------------------
// The dialog host (creation drawer + Properties editor)
// ---------------------------------------------------------------------------

/** Rendered once by AppShell; opens the create or edit dialog when asked. */
export function RotaryPatternDialogHost() {
  const request = useSyncExternalStore(
    subscribeDialogRequest,
    dialogRequestSnapshot,
    dialogRequestSnapshot,
  )
  const project = useProjectStore((state) => state.project)
  const projectKey = useProjectStore((state) => state.projectKey)
  const face = activeFace(project)
  const available = aroundSketchAuthoringAvailable(project)
  const context = rotaryDialogContextKey(project, projectKey)
  const lastContext = useRef(context)

  // A create form belongs to the Around workspace: leaving it (or losing
  // availability) closes the dialog, so a half-filled form cannot reappear
  // with numbers that belong to a face the user left.
  useEffect(() => {
    if (request && !request.featureId && (face !== 'around' || !available)) closeRotaryPatternDialog()
  }, [request, face, available])

  // The numbers are measured against the live bar, so a change to the bar, the
  // units, the machine origin or the document drops the form — for creation and
  // for Edit, exactly like Turn/Polygon. Only a create form is tied to the
  // Around face; Edit is reached from Properties on any face.
  useEffect(() => {
    if (request && lastContext.current !== context) closeRotaryPatternDialog()
    lastContext.current = context
  }, [request, context])

  if (!request || typeof document === 'undefined') return null
  const key = `${request.kind}-${request.featureId ?? 'create'}`
  return createPortal(
    <RotaryPatternDialog
      key={key}
      kind={request.kind}
      featureId={request.featureId}
      onClose={closeRotaryPatternDialog}
    />,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface RotaryPatternDialogProps {
  kind: RotaryPatternKind
  featureId?: string
  onClose: () => void
}

export function RotaryPatternDialog({ kind, featureId, onClose }: RotaryPatternDialogProps) {
  useRestoreCanvasFocus()
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const addRotaryPattern = useProjectStore((state) => state.addRotaryPattern)
  const units = project.meta.units
  const unitLabel = units === 'inch' ? 'in' : 'mm'
  const editing = featureId !== undefined
  const feature = editing ? resolveFeatureInstance(project, featureId) : null
  const storedCanned = feature?.canned && feature.canned.kind === kind ? feature.canned : null
  // Normalize against the dialog's own kind, so a stored thread never gets read
  // as flutes (or the reverse) and each branch keeps its concrete type.
  const storedThread = kind === 'thread'
    ? normalizeThreadCannedParams(storedCanned?.params ?? {})
    : null
  const storedFlutes = kind === 'flutes'
    ? normalizeFlutesCannedParams(storedCanned?.params ?? {})
    : null
  const stored = storedThread ?? storedFlutes

  useEffect(() => {
    if (editing && !stored) onClose()
  }, [editing, stored, onClose])

  const frame = stored?.frame ?? rotaryPatternFrame(project)
  const bounds = getStockBounds(project.stock)
  const barLength = frame
    ? (frame.axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY)
    : 0
  // The depth is measured from the surface the pattern cuts, not always from
  // the bar: a band wholly on one Turn takes that Turn's diameter (decision
  // 10). A new pattern's defaults use the full-bar band; an existing row is
  // resolved from its placed band below.
  const defaultSurfaceRadius = rotaryPatternSurface(project, { start: 0, length: barLength }).diameter / 2

  const [start, setStart] = useState(() => (stored ? String(stored.start) : '0'))
  const [length, setLength] = useState(() => (stored ? String(stored.length) : tidy(barLength)))
  const [pitchText, setPitchText] = useState(() => {
    if (storedThread) {
      return tidy(units === 'inch' ? 1 / storedThread.pitch : storedThread.pitch)
    }
    return units === 'inch' ? String(INCH_DEFAULT_TPI) : String(MM_DEFAULT_PITCH)
  })
  const [starts, setStarts] = useState(() => (storedThread ? String(storedThread.starts) : '1'))
  const [depth, setDepth] = useState(() => {
    if (stored) return String(stored.depth)
    return tidy(
      kind === 'thread'
        ? THREAD_DEPTH_PER_PITCH * (units === 'inch' ? 1 / INCH_DEFAULT_TPI : MM_DEFAULT_PITCH)
        : defaultSurfaceRadius / 4 || THREAD_DEPTH_PER_PITCH,
    )
  })
  // Once the user edits the depth, the pitch default no longer owns it. An
  // existing shape already has a chosen depth, so editing its pitch never
  // silently rewrites it.
  const [depthEdited, setDepthEdited] = useState(() => stored !== null)
  const [count, setCount] = useState(() => (storedFlutes ? String(storedFlutes.count) : '4'))
  const [twist, setTwist] = useState(() => (storedFlutes ? String(Math.abs(storedFlutes.twist)) : '0'))
  // The only direction state in either dialog: the physical hand, right by
  // default. An edit starts from the stored hand.
  const [direction, setDirection] = useState<'right' | 'left'>(() => {
    if (storedThread) return storedThread.hand
    if (storedFlutes) return storedFlutes.twist < 0 ? 'left' : 'right'
    return 'right'
  })
  const [refusal, setRefusal] = useState<string | null>(null)
  // An existing row is read through its placement, with the same resolver the
  // store sync uses: a moved Thread cuts the surface where the user put it, not
  // the one its stored band was typed over. The resolver takes the band from
  // the feature's definition, so the live draft is resolved as a draft
  // definition: the line follows the fields without a second copy of the
  // placement maths. A new pattern has no placement yet, so its draft band is
  // resolved directly.
  const placedSurface = editing && featureId && stored && feature
    ? (() => {
        const definition = project.featureDefinitions[feature.definitionId]
        const canned = definition ? rotaryPatternCannedData(stored.frame, buildInput()) : null
        if (!definition || !canned) return null
        return rotaryPatternSurfaceOfFeature({
          ...project,
          featureDefinitions: {
            ...project.featureDefinitions,
            [feature.definitionId]: { ...definition, canned },
          },
        }, featureId)
      })()
    : null
  const surface = placedSurface
    ?? rotaryPatternSurface(project, { start: parseNumber(start), length: parseNumber(length) })
  const surfaceRadius = surface.diameter / 2
  const surfaceWarning = rotaryPatternSurfaceWarning(surface)
  // A close can outlive the click that opened the edit; the guard keeps a
  // late continuation from writing after the user left.
  const activeRef = useRef(true)
  // What Apply would write, as the form holds it (issue #1112 F4): editing a
  // stored pattern without changing a field used to rewrite identical
  // parameters as a new undo step, so the button is greyed out while nothing
  // differs. The one field the dialog transforms stays in the form the user
  // typed — a stored inch pitch read back as threads per inch is rounded, and
  // re-deriving it would make an untouched inch dialog look edited — and a
  // flute's hand is signed onto its twist exactly as `buildInput` signs it, so
  // flipping the hand of a straight flute is not a change.
  const draftFields = kind === 'thread'
    ? {
        start: parseNumber(start),
        length: parseNumber(length),
        pitch: parseNumber(pitchText),
        starts: parseNumber(starts),
        depth: parseNumber(depth),
        hand: direction,
      }
    : {
        start: parseNumber(start),
        length: parseNumber(length),
        count: parseNumber(count),
        twist: (direction === 'left' ? -1 : 1) * parseNumber(twist),
        depth: parseNumber(depth),
      }
  // The values the form opened with: a draft that never left them writes nothing.
  const [openedFields] = useState(draftFields)

  useEffect(() => () => {
    activeRef.current = false
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handlePitchChange(value: string) {
    setPitchText(value)
    if (depthEdited) return
    const physicalPitch = units === 'inch' ? 1 / parseNumber(value) : parseNumber(value)
    if (Number.isFinite(physicalPitch) && physicalPitch > 0) {
      setDepth(tidy(THREAD_DEPTH_PER_PITCH * physicalPitch))
    }
  }

  function threadProblem(): string | null {
    if (!frame) return t('dialogs.rotary.error.around')
    const startValue = parseNumber(start)
    if (!Number.isFinite(startValue) || startValue < 0) return t('dialogs.rotary.error.start')
    const lengthValue = parseNumber(length)
    if (!Number.isFinite(lengthValue) || lengthValue <= 0) return t('dialogs.rotary.error.length')
    const rawPitch = parseNumber(pitchText)
    if (!Number.isFinite(rawPitch) || rawPitch <= 0) {
      return units === 'inch' ? t('dialogs.rotary.error.tpi') : t('dialogs.rotary.error.pitch')
    }
    const startsValue = parseNumber(starts)
    if (!Number.isInteger(startsValue) || startsValue < 1 || startsValue > MAX_THREAD_STARTS) {
      return t('dialogs.rotary.error.starts', { max: MAX_THREAD_STARTS })
    }
    const depthValue = parseNumber(depth)
    if (!Number.isFinite(depthValue) || depthValue <= 0) return t('dialogs.rotary.error.depth')
    if (surfaceRadius > 0 && depthValue >= surfaceRadius) return t('dialogs.rotary.error.depthCentreline')
    return null
  }

  function flutesProblem(): string | null {
    if (!frame) return t('dialogs.rotary.error.around')
    const startValue = parseNumber(start)
    if (!Number.isFinite(startValue) || startValue < 0) return t('dialogs.rotary.error.start')
    const lengthValue = parseNumber(length)
    if (!Number.isFinite(lengthValue) || lengthValue <= 0) return t('dialogs.rotary.error.length')
    const countValue = parseNumber(count)
    if (!Number.isInteger(countValue) || countValue < 1 || countValue > MAX_FLUTE_COUNT) {
      return t('dialogs.rotary.error.count', { max: MAX_FLUTE_COUNT })
    }
    const twistValue = parseNumber(twist)
    if (!Number.isFinite(twistValue) || twistValue < 0) return t('dialogs.rotary.error.twist')
    const depthValue = parseNumber(depth)
    if (!Number.isFinite(depthValue) || depthValue <= 0) return t('dialogs.rotary.error.depth')
    if (surfaceRadius > 0 && depthValue >= surfaceRadius) return t('dialogs.rotary.error.depthCentreline')
    return null
  }

  const problem = kind === 'thread' ? threadProblem() : flutesProblem()
  // Creation has no stored shape to compare against and keeps its own gate.
  const untouched = editing && !formHasChanges(openedFields, draftFields)

  // Live preview (issue #1112 F1): every valid draft is written into the
  // project through the ordinary `updateFeature` path — parameters plus the Z
  // span they imply — so the sketch and the 3D model follow the fields instead
  // of waiting for Apply. A draft the dialog refuses is never written, and
  // closing without Apply restores the stored lines exactly; Apply commits the
  // preview as one undo step.
  const previewDraft = editing && featureId && stored && problem === null
    ? rotaryPatternCannedData(stored.frame, buildInput())
    : null
  const previewSpan = previewDraft
    ? (placedSurface
        ? rotaryPatternSurfaceSpanOn(project, placedSurface, parseNumber(depth))
        : rotaryPatternSurfaceSpan(project, buildInput(), parseNumber(depth)))
    : null
  const { commitPreview } = useCannedShapePreview({
    featureId: featureId ?? null,
    draft: previewDraft,
    span: previewSpan ? { z_top: previewSpan.zTop, z_bottom: previewSpan.zBottom } : null,
  })

  function buildInput(): RotaryPatternInput {
    const depthValue = parseNumber(depth)
    if (kind === 'thread') {
      const rawPitch = parseNumber(pitchText)
      return {
        kind: 'thread',
        start: parseNumber(start),
        length: parseNumber(length),
        pitch: units === 'inch' ? 1 / rawPitch : rawPitch,
        starts: parseNumber(starts),
        hand: direction,
        depth: depthValue,
      }
    }
    return {
      kind: 'flutes',
      start: parseNumber(start),
      length: parseNumber(length),
      count: parseNumber(count),
      // The field is a magnitude; the physical hand signs it. Zero stays zero
      // either way, so a straight flute is straight in both hands.
      twist: (direction === 'left' ? -1 : 1) * parseNumber(twist),
      depth: depthValue,
    }
  }

  function handleApply() {
    // Nothing to write while the form still holds the stored pattern.
    if (problem !== null || untouched) return
    if (editing && featureId) {
      if (!stored) return
      const input = buildInput()
      const canned = rotaryPatternCannedData(stored.frame, input)
      if (!canned) {
        setRefusal(t('dialogs.rotary.refusal.creationFailed'))
        return
      }
      // One parameter write, one history entry: the preview already wrote this
      // draft (parameters plus the Z span they imply) inside a transaction, and
      // committing it is what makes the whole edit one undo step (issue #1112).
      // The span comes from the **placed** band the dialog line shows, not the
      // stored band the row was drawn over: an unchanged Apply after moving the
      // row must keep the span it already follows, not push it back to the old
      // surface.
      const depthValue = parseNumber(depth)
      const span = placedSurface
        ? rotaryPatternSurfaceSpanOn(project, placedSurface, depthValue)
        : rotaryPatternSurfaceSpan(project, input, depthValue)
      commitPreview(canned, { z_top: span.zTop, z_bottom: span.zBottom })
      if (activeRef.current) onClose()
      return
    }

    const result = addRotaryPattern(buildInput())
    if (result.ok) {
      onClose()
      return
    }
    const base = t(REFUSAL_KEYS[result.reason], {
      max: result.reason === 'invalidStarts' ? MAX_THREAD_STARTS : MAX_FLUTE_COUNT,
    })
    const detailKey = result.reason === 'aroundUnavailable' && result.detail
      ? AROUND_DETAIL_KEYS[result.detail]
      : undefined
    setRefusal(detailKey ? `${base} ${t(detailKey)}` : base)
  }

  const titleKey: MessageKey = kind === 'thread'
    ? (editing ? 'dialogs.rotary.thread.editTitle' : 'dialogs.rotary.thread.title')
    : (editing ? 'dialogs.rotary.flutes.editTitle' : 'dialogs.rotary.flutes.title')

  // A corrupt parameter set has no editable form; the effect above closes it.
  if (editing && !stored) return null

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--import dialog--rotary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rotary-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="rotary-dialog-title">{t(titleKey)}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={t('dialogs.common.close')} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--import">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="rotary-start">
                {t('dialogs.rotary.start', { units: unitLabel })}
              </label>
              <div className="properties-field">
                <input
                  id="rotary-start"
                  type="number"
                  min="0"
                  step="any"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="rotary-length">
                {t('dialogs.rotary.length', { units: unitLabel })}
              </label>
              <div className="properties-field">
                <input
                  id="rotary-length"
                  type="number"
                  min="0"
                  step="any"
                  value={length}
                  onChange={(event) => setLength(event.target.value)}
                />
              </div>
            </div>

            {surface.kind === 'turn' ? (
              <p className="rotary-dialog__note rotary-dialog__surface-note">
                {t('dialogs.rotary.surface.onTurn', {
                  name: surface.turnName ?? '',
                  diameter: formatLength(surface.diameter, units),
                  units: unitLabel,
                })}
              </p>
            ) : surfaceWarning ? (
              <p className="rotary-dialog__note rotary-dialog__surface-warning" role="status">
                {t(surfaceWarning.key, surfaceWarning.values)}
              </p>
            ) : null}

            {kind === 'thread' ? (
              <>
                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-pitch">
                    {units === 'inch' ? t('dialogs.rotary.thread.tpi') : t('dialogs.rotary.thread.pitch', { units: unitLabel })}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-pitch"
                      type="number"
                      min="0"
                      step="any"
                      value={pitchText}
                      onChange={(event) => handlePitchChange(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-starts">
                    {t('dialogs.rotary.thread.starts')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-starts"
                      type="number"
                      min="1"
                      max={MAX_THREAD_STARTS}
                      step="1"
                      value={starts}
                      onChange={(event) => setStarts(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-depth">
                    {t('dialogs.rotary.depth', { units: unitLabel })}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-depth"
                      type="number"
                      min="0"
                      step="any"
                      value={depth}
                      onChange={(event) => {
                        setDepthEdited(true)
                        setDepth(event.target.value)
                      }}
                    />
                  </div>
                </div>

                <RotaryDirectionField value={direction} onChange={setDirection} />

                <p className="rotary-dialog__note">{t('dialogs.rotary.thread.note')}</p>
              </>
            ) : (
              <>
                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-count">
                    {t('dialogs.rotary.flutes.count')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-count"
                      type="number"
                      min="1"
                      max={MAX_FLUTE_COUNT}
                      step="1"
                      value={count}
                      onChange={(event) => setCount(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-twist">
                    {t('dialogs.rotary.flutes.twist')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-twist"
                      type="number"
                      step="any"
                      value={twist}
                      onChange={(event) => setTwist(event.target.value)}
                    />
                  </div>
                </div>

                <RotaryDirectionField value={direction} onChange={setDirection} />

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-depth">
                    {t('dialogs.rotary.depth', { units: unitLabel })}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-depth"
                      type="number"
                      min="0"
                      step="any"
                      value={depth}
                      onChange={(event) => {
                        setDepthEdited(true)
                        setDepth(event.target.value)
                      }}
                    />
                  </div>
                </div>
              </>
            )}

            {problem !== null ? (
              <div className="cam-field-message rotary-dialog__error" role="alert">{problem}</div>
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
            disabled={problem !== null || untouched}
            onClick={handleApply}
          >
            {editing ? t('dialogs.common.apply') : t('dialogs.rotary.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
