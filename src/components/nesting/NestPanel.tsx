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
// The Nest panel (issue #848, step 3 of #741): arrange N copies of a part on
// the stock. Rendered by SketchCanvas; opened by `startNest` from the
// Distribute menu. The packer runs in a worker; the result is committed with
// one `applyNest` history step. Keep improving (#862) searches on in the
// worker; its better layouts share one more history step.

import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import type { NestResult } from '../../engine/nesting'
import { buildNestJob, type NestPartSpec } from '../../store/helpers/nestPart'
import { useProjectStore } from '../../store/projectStore'
import type { MessageKey } from '../../i18n/locales/en'
import { useI18n } from '../../i18n/i18nContext'
import { CanvasWorkflowAction, CanvasWorkflowCancel } from '../canvas/CanvasWorkflowAction'
import { CanvasWorkflowPanel } from '../canvas/CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from '../canvas/useCanvasWorkflowPanel'
import {
  initialNestForm,
  nestSettingsFromForm,
  NEST_ROTATIONS,
  nestSubject,
  stepOfPreset,
  subjectParts,
  validateNestForm,
  watchForEdits,
  type NestForm,
  type NestFormError,
  type NestRotationPreset,
} from './nestForm'
import { improveNestJob, NestCancelledError, runNestJob } from './nestWorkerClient'

interface NestPanelHostProps {
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
}

type NestRun =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; placed: number; requested: number; missing: { name: string; count: number }[] }
  | { state: 'failed'; message: string }

interface NestImprove {
  running: boolean
  evaluated: number
  /** The one-shot answer, as the search re-placed it. */
  first: NestResult | null
  best: NestResult | null
  /** Why a finished search ended; null while running or after Stop. */
  ended: 'stalled' | 'changed' | null
}

/** What the result line reports for a layout of `parts` placed with `quantities`. */
function summarize(result: NestResult, parts: NestPartSpec[], quantities: number[], keepOriginals: boolean): NestRun {
  const requested = quantities.reduce((sum, quantity) => sum + quantity, 0)
  const missing = result.unplaced.map((entry) => ({ name: parts[Number(entry.partId)]?.name ?? '', count: entry.count }))
  return { state: 'done', placed: result.placements.length + (keepOriginals ? parts.length : 0), requested, missing }
}

const REFUSAL_KEYS: Record<string, MessageKey> = {
  empty: 'canvas.nest.refusal.empty',
  locked: 'canvas.nest.refusal.locked',
  model: 'canvas.nest.refusal.model',
  'external-constraint': 'canvas.nest.refusal.externalConstraint',
  'no-closed-geometry': 'canvas.nest.refusal.noClosedGeometry',
}

/** Labels of the presets that are not a step; a step's label names its angle. */
const FIXED_ROTATION_KEYS: Partial<Record<NestRotationPreset, MessageKey>> = {
  quarter: 'canvas.nest.rotation.quarter',
  grain: 'canvas.nest.rotation.grain',
  none: 'canvas.nest.rotation.none',
}

const FORM_ERROR_KEYS: Record<NestFormError, MessageKey> = {
  quantity: 'canvas.nest.error.quantity',
  'gap-missing': 'canvas.nest.error.gapMissing',
  'gap-below-tool': 'canvas.nest.error.gapBelowTool',
}

export function NestPanelHost(props: NestPanelHostProps) {
  const pendingNest = useProjectStore((s) => s.pendingNest)
  const panel = useCanvasWorkflowPanel({
    open: pendingNest !== null,
    phaseKey: pendingNest ? `nest:${pendingNest.session}` : null,
    containerRef: props.containerRef,
    canvasRef: props.canvasRef,
    clearTransientCanvasState: props.clearTransientCanvasState,
    pageLevel: true,
  })
  if (!pendingNest) return null
  // Keyed by session so reopening the panel starts from a fresh form.
  return <NestPanel key={pendingNest.session} sourceIds={pendingNest.sourceIds} panel={panel} />
}

function NestPanel({ sourceIds, panel }: { sourceIds: string[]; panel: ReturnType<typeof useCanvasWorkflowPanel> }) {
  const { t, tPlural } = useI18n()
  const project = useProjectStore((s) => s.project)
  const applyNest = useProjectStore((s) => s.applyNest)
  const discardNest = useProjectStore((s) => s.discardNest)
  const cancelNest = useProjectStore((s) => s.cancelNest)
  const setNestSearching = useProjectStore((s) => s.setNestSearching)
  const undo = useProjectStore((s) => s.undo)
  const units = project.meta.units

  // After a nest is applied the selection's rows belong to it, so the same
  // panel now targets that nest: Nest replaces it, Discard removes it.
  const subject = useMemo(() => nestSubject(project, sourceIds), [project, sourceIds])
  const parts = subjectParts(subject)
  const [form, setForm] = useState<NestForm>(() => initialNestForm(subject))
  const [run, setRun] = useState<NestRun>({ state: 'idle' })
  const [improve, setImprove] = useState<NestImprove | null>(null)
  const [partsOpen, setPartsOpen] = useState(true)
  const partsListId = useId()
  const abortRef = useRef<AbortController | null>(null)
  // The undo steps this panel pushed, and the history they left on top. Cancel
  // undoes them only while that history is still current: an edit made since
  // is someone else's, and undoing past it would take it too.
  const ownStepsRef = useRef({ count: 0, history: null as object | null })
  const busy = run.state === 'running' || improve?.running === true
  useEffect(() => () => abortRef.current?.abort(), [])

  // The part list can change under an open panel (undo, a replaced nest);
  // keep one quantity per part.
  const quantities = parts.map((_, index) => form.quantities[index] ?? 1)
  const formError = subject.parts.ok ? validateNestForm({ ...form, quantities }, subject.gapFloor) : null
  const canNest = subject.parts.ok && formError === null && !busy

  function recordOwnStep(pushed: boolean) {
    const own = ownStepsRef.current
    ownStepsRef.current = { count: own.count + (pushed ? 1 : 0), history: useProjectStore.getState().history }
  }

  function setQuantity(index: number, value: number) {
    const next = [...quantities]
    next[index] = value
    setForm({ ...form, quantities: next })
  }

  async function startNest() {
    if (!subject.parts.ok || formError) return
    const settings = nestSettingsFromForm(form)
    const job = buildNestJob(subject.base, parts, quantities, settings)
    if (!job) {
      setRun({ state: 'failed', message: t('canvas.nest.error.noStock') })
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setRun({ state: 'running' })
    setImprove(null)
    try {
      const result = await runNestJob(job, { signal: controller.signal })
      if (result.placements.length > 0) {
        const id = applyNest({
          parts: parts.map((part, index) => ({ featureIds: part.featureIds, quantity: quantities[index] })),
          placements: result.placements,
          settings,
          replaceNestId: subject.replaceNest?.id,
        })
        if (id) recordOwnStep(true)
      }
      setRun(summarize(result, parts, quantities, settings.keepOriginals))
    } catch (error: unknown) {
      if (error instanceof NestCancelledError) setRun({ state: 'idle' })
      else setRun({ state: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally {
      abortRef.current = null
    }
  }

  /**
   * Searches for a better layout of the nest on the canvas, from the same job
   * that produced it. The first better layout is one undo step and every later
   * one amends it, so Undo returns to the layout the search started from. Any
   * other change to the project stops the search.
   */
  async function startImprove() {
    const record = subject.replaceNest
    if (!record || !subject.parts.ok || busy) return
    const searchParts = parts
    const searchQuantities = searchParts.map((part) => (
      record.parts.find((entry) => entry.sourceIds.some((id) => part.featureIds.includes(id)))?.quantity ?? 1
    ))
    const job = buildNestJob(subject.base, searchParts, searchQuantities, record.settings)
    if (!job) return
    const controller = new AbortController()
    abortRef.current = controller
    let nestId = record.id
    let amend = false
    const edits = watchForEdits(() => useProjectStore.getState().history)
    let state: NestImprove = { running: true, evaluated: 0, first: null, best: null, ended: null }
    setImprove(state)
    // Better layouts are applied live; toolpaths regenerate once, at the end.
    setNestSearching(true)
    try {
      await improveNestJob(job, {
        signal: controller.signal,
        onProgress: (update) => {
          if (edits.edited()) {
            state = { ...state, ended: 'changed' }
            controller.abort()
            return
          }
          if (update.best && state.first) {
            const id = applyNest({
              parts: searchParts.map((part, index) => ({ featureIds: part.featureIds, quantity: searchQuantities[index] })),
              placements: update.best.placements,
              settings: record.settings,
              replaceNestId: nestId,
              amend,
            })
            if (id) {
              recordOwnStep(!amend)
              nestId = id
              amend = true
            }
            edits.accept()
            setRun(summarize(update.best, searchParts, searchQuantities, record.settings.keepOriginals))
          }
          state = {
            ...state,
            evaluated: update.evaluated,
            first: state.first ?? update.best ?? null,
            best: update.best ?? state.best,
          }
          setImprove(state)
        },
      })
      state = { ...state, ended: 'stalled' }
    } catch (error: unknown) {
      if (!(error instanceof NestCancelledError)) {
        setRun({ state: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      setNestSearching(false)
      if (abortRef.current === controller) abortRef.current = null
      setImprove({ ...state, running: false })
    }
  }

  /** Keeps the nest on the canvas and closes the panel. */
  function accept() {
    cancelNest()
  }

  /** Stops any search, reverts what this panel committed, and closes. */
  function cancel() {
    abortRef.current?.abort()
    const own = ownStepsRef.current
    if (own.count > 0 && useProjectStore.getState().history === own.history) {
      for (let step = 0; step < own.count; step += 1) undo()
    }
    cancelNest()
  }

  function discard() {
    discardNest(subject.replaceNest!.id)
    recordOwnStep(true)
    setRun({ state: 'idle' })
    setImprove(null)
  }

  const step = run.state === 'running'
    ? t('canvas.nest.step.running')
    : improve?.running ? t('canvas.nest.step.improving') : t('canvas.nest.step.configure')
  const quantityInput = (index: number, label: string) => (
    <input
      className="canvas-workflow-panel__count-input"
      type="number"
      inputMode="numeric"
      min={1}
      step={1}
      value={Number.isFinite(quantities[index]) ? quantities[index] : ''}
      aria-label={label}
      onChange={(event) => setQuantity(index, event.currentTarget.valueAsNumber)}
    />
  )

  return (
    <CanvasWorkflowPanel
      title={t('canvas.nest.title')}
      step={step}
      position={panel.position}
      panelRef={panel.panelRef}
      handleProps={panel.handleProps}
      actionRowProps={panel.actionRowProps}
      className="canvas-workflow-panel--nest"
      pageLevel
      actions={<CanvasWorkflowCancel label={t('canvas.common.cancel')} onClick={cancel} />}
    >
      {!subject.parts.ok ? (
        <p className="canvas-workflow-panel__warning" role="alert">{t(REFUSAL_KEYS[subject.parts.refusal])}</p>
      ) : (
        <>
          <p className="canvas-workflow-panel__summary">
            {parts.length === 1
              ? tPlural(parts[0].featureIds.length, 'canvas.nest.part.one', 'canvas.nest.part.other')
              : tPlural(parts.length, 'canvas.nest.parts.one', 'canvas.nest.parts.other')}
            {subject.replaceNest && <> · {t('canvas.nest.existing', { name: subject.replaceNest.name })}</>}
          </p>
          {parts.length > 1 && (
            <>
              <div className="canvas-workflow-panel__grid">
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.nest.quantityAll')}</span>
                  <input
                    className="canvas-workflow-panel__count-input"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={quantities.every((quantity) => quantity === quantities[0]) ? quantities[0] : ''}
                    aria-label={t('canvas.nest.quantityAll')}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber
                      setForm({ ...form, quantities: parts.map(() => value) })
                    }}
                  />
                </label>
              </div>
              {/* A toggle, not <details>: the list must shrink to the window, and
                  WebKit does not lay out a <details> as a flex container. */}
              <div className="canvas-workflow-panel__parts">
                <button
                  type="button"
                  className="canvas-workflow-panel__parts-toggle"
                  aria-expanded={partsOpen}
                  aria-controls={partsListId}
                  onClick={() => setPartsOpen(!partsOpen)}
                >
                  {t('canvas.nest.partsList', { count: parts.length })}
                </button>
                {partsOpen && (
                  <div className="canvas-workflow-panel__parts-list" id={partsListId}>
                    {parts.map((part, index) => (
                      <label className="canvas-workflow-panel__field" key={part.featureIds[0]}>
                        <span>{part.name}</span>
                        {quantityInput(index, t('canvas.nest.quantityFor', { name: part.name }))}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="canvas-workflow-panel__grid">
            {parts.length === 1 && (
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.nest.quantity')}</span>
                {quantityInput(0, t('canvas.nest.quantity'))}
              </label>
            )}
            <label className="canvas-workflow-panel__field">
              <span>{t('canvas.nest.gap', { units })}</span>
              <input
                className="canvas-workflow-panel__count-input"
                type="number"
                inputMode="decimal"
                step="any"
                min={subject.gapFloor ?? 0}
                value={form.gap ?? ''}
                aria-label={t('canvas.nest.gap', { units })}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber
                  setForm({ ...form, gap: Number.isFinite(value) ? value : null })
                }}
              />
            </label>
            <label className="canvas-workflow-panel__field">
              <span>{t('canvas.nest.rotation')}</span>
              <select
                value={form.rotation}
                aria-label={t('canvas.nest.rotation')}
                onChange={(event) => setForm({ ...form, rotation: event.currentTarget.value as NestRotationPreset })}
              >
                {(Object.keys(NEST_ROTATIONS) as NestRotationPreset[]).map((preset) => {
                  const fixed = FIXED_ROTATION_KEYS[preset]
                  return (
                    <option key={preset} value={preset}>
                      {fixed ? t(fixed) : t('canvas.nest.rotation.step', { step: stepOfPreset(preset) ?? 0 })}
                    </option>
                  )
                })}
              </select>
            </label>
          </div>
          <div className="canvas-workflow-panel__meta">
            <label className="canvas-workflow-panel__check">
              <input
                type="checkbox"
                checked={form.keepOriginals}
                onChange={(event) => setForm({ ...form, keepOriginals: event.currentTarget.checked })}
              />
              <span>{t('canvas.nest.keepOriginals')}</span>
            </label>
          </div>
          <p className="canvas-workflow-panel__hint">
            {subject.gapFloor !== null
              ? t('canvas.nest.gapFromTool', { gap: subject.gapFloor.toFixed(units === 'inch' ? 4 : 2), units })
              : t('canvas.nest.gapNoTool')}
          </p>
          {formError && <p className="canvas-workflow-panel__warning" role="alert">{t(FORM_ERROR_KEYS[formError])}</p>}
          {run.state === 'done' && (
            <p className="canvas-workflow-panel__summary" role="status">
              {run.missing.length === 0
                ? t('canvas.nest.result.all', { placed: run.placed })
                : t('canvas.nest.result.partial', {
                  placed: run.placed,
                  requested: run.requested,
                  missing: run.requested - run.placed,
                })}
              {run.missing.length > 0 && parts.length > 1 && (
                <> {t('canvas.nest.result.missing', { list: run.missing.map((entry) => `${entry.name} ×${entry.count}`).join(', ') })}</>
              )}
              {run.placed > 0 && project.tabs.length > 0 && <> {t('canvas.nest.result.tabs')}</>}
            </p>
          )}
          {improve && <NestImproveStatus improve={improve} />}
          {run.state === 'failed' && <p className="canvas-workflow-panel__warning" role="alert">{run.message}</p>}
          <div className="canvas-workflow-panel__picking-actions canvas-workflow-panel__nest-actions">
            {busy ? (
              <CanvasWorkflowAction label={t('canvas.nest.stop')} variant="cancel" onClick={() => abortRef.current?.abort()} />
            ) : subject.replaceNest ? (
              <>
                <CanvasWorkflowAction label={t('canvas.nest.renest')} onClick={() => { void startNest() }} disabled={!canNest} />
                <CanvasWorkflowAction label={t('canvas.nest.improve')} onClick={() => { void startImprove() }} />
                <CanvasWorkflowAction label={t('canvas.nest.discard')} variant="cancel" onClick={discard} />
                <CanvasWorkflowAction label={t('canvas.nest.accept')} variant="confirm" onClick={accept} />
              </>
            ) : (
              <CanvasWorkflowAction label={t('canvas.nest.run')} variant="confirm" onClick={() => { void startNest() }} disabled={!canNest} />
            )}
          </div>
        </>
      )}
    </CanvasWorkflowPanel>
  )
}

function NestImproveStatus({ improve }: { improve: NestImprove }) {
  const { t, tPlural } = useI18n()
  const { first, best } = improve
  let gain = t('canvas.nest.improve.none')
  if (first && best && best !== first) {
    const more = best.placements.length - first.placements.length
    gain = more > 0
      ? tPlural(more, 'canvas.nest.improve.more.one', 'canvas.nest.improve.more.other')
      : t('canvas.nest.improve.gain', { percent: (100 * (1 - best.usedArea / first.usedArea)).toFixed(1) })
  }
  return (
    <p className="canvas-workflow-panel__summary" role="status" aria-live="polite">
      {tPlural(improve.evaluated, 'canvas.nest.improve.tried.one', 'canvas.nest.improve.tried.other')} {gain}
      {improve.ended === 'stalled' && <> {t('canvas.nest.improve.stalled')}</>}
      {improve.ended === 'changed' && <> {t('canvas.nest.improve.changed')}</>}
    </p>
  )
}
