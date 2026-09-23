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
// one `applyNest` history step.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { buildNestJob } from '../../store/helpers/nestPart'
import { useProjectStore } from '../../store/projectStore'
import type { MessageKey } from '../../i18n/locales/en'
import { useI18n } from '../../i18n/i18nContext'
import { CanvasWorkflowAction, CanvasWorkflowCancel, CanvasWorkflowConfirm } from '../canvas/CanvasWorkflowAction'
import { CanvasWorkflowPanel } from '../canvas/CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from '../canvas/useCanvasWorkflowPanel'
import {
  initialNestForm,
  nestSettingsFromForm,
  nestSubject,
  validateNestForm,
  type NestForm,
  type NestFormError,
  type NestRotationPreset,
} from './nestForm'
import { NestCancelledError, runNestJob } from './nestWorkerClient'

interface NestPanelHostProps {
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
}

type NestRun =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; placed: number; requested: number }
  | { state: 'failed'; message: string }

const REFUSAL_KEYS: Record<string, MessageKey> = {
  empty: 'canvas.nest.refusal.empty',
  locked: 'canvas.nest.refusal.locked',
  model: 'canvas.nest.refusal.model',
  'external-constraint': 'canvas.nest.refusal.externalConstraint',
  'no-closed-geometry': 'canvas.nest.refusal.noClosedGeometry',
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
  const units = project.meta.units

  // After a nest is applied the selection's rows belong to it, so the same
  // panel now targets that nest: Nest replaces it, Discard removes it.
  const subject = useMemo(() => nestSubject(project, sourceIds), [project, sourceIds])
  const [form, setForm] = useState<NestForm>(() => initialNestForm(subject))
  const [run, setRun] = useState<NestRun>({ state: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])

  const formError = subject.part.ok ? validateNestForm(form, subject.gapFloor) : null
  const canNest = subject.part.ok && formError === null && run.state !== 'running'

  async function startNest() {
    if (!subject.part.ok || formError) return
    const settings = nestSettingsFromForm(form)
    const job = buildNestJob(subject.base, subject.part, settings)
    if (!job) {
      setRun({ state: 'failed', message: t('canvas.nest.error.noStock') })
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setRun({ state: 'running' })
    try {
      const result = await runNestJob(job, { signal: controller.signal })
      const requested = job.parts[0]?.quantity ?? 0
      if (result.placements.length === 0) {
        setRun({ state: 'done', placed: 0, requested })
        return
      }
      applyNest({
        featureIds: subject.part.featureIds,
        placements: result.placements,
        settings,
        replaceNestId: subject.replaceNest?.id,
      })
      setRun({ state: 'done', placed: result.placements.length, requested })
    } catch (error: unknown) {
      if (error instanceof NestCancelledError) setRun({ state: 'idle' })
      else setRun({ state: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally {
      abortRef.current = null
    }
  }

  function close() {
    abortRef.current?.abort()
    cancelNest()
  }

  const step = run.state === 'running' ? t('canvas.nest.step.running') : t('canvas.nest.step.configure')
  const offset = form.keepOriginals ? 1 : 0

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
      actions={(
        <>
          {run.state === 'running' ? (
            <CanvasWorkflowCancel label={t('canvas.nest.stop')} onClick={() => abortRef.current?.abort()} />
          ) : (
            <CanvasWorkflowConfirm
              label={subject.replaceNest ? t('canvas.nest.renest') : t('canvas.nest.run')}
              onClick={() => { void startNest() }}
              disabled={!canNest}
            />
          )}
          <CanvasWorkflowCancel label={t('canvas.common.done')} onClick={close} />
        </>
      )}
    >
      {!subject.part.ok ? (
        <p className="canvas-workflow-panel__warning" role="alert">{t(REFUSAL_KEYS[subject.part.refusal])}</p>
      ) : (
        <>
          <p className="canvas-workflow-panel__summary">
            {tPlural(subject.part.featureIds.length, 'canvas.nest.part.one', 'canvas.nest.part.other')}
            {subject.replaceNest && <> · {t('canvas.nest.existing', { name: subject.replaceNest.name })}</>}
          </p>
          <div className="canvas-workflow-panel__grid">
            <label className="canvas-workflow-panel__field">
              <span>{t('canvas.nest.quantity')}</span>
              <input
                className="canvas-workflow-panel__count-input"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={form.quantity}
                aria-label={t('canvas.nest.quantity')}
                onChange={(event) => setForm({ ...form, quantity: event.currentTarget.valueAsNumber })}
              />
            </label>
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
                <option value="quarter">{t('canvas.nest.rotation.quarter')}</option>
                <option value="grain">{t('canvas.nest.rotation.grain')}</option>
                <option value="none">{t('canvas.nest.rotation.none')}</option>
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
              {run.placed === run.requested
                ? t('canvas.nest.result.all', { placed: run.placed + offset })
                : t('canvas.nest.result.partial', {
                  placed: run.placed + offset,
                  requested: run.requested + offset,
                  missing: run.requested - run.placed,
                })}
              {run.placed > 0 && project.tabs.length > 0 && <> {t('canvas.nest.result.tabs')}</>}
            </p>
          )}
          {run.state === 'failed' && <p className="canvas-workflow-panel__warning" role="alert">{run.message}</p>}
          {subject.replaceNest && run.state !== 'running' && (
            <div className="canvas-workflow-panel__picking-actions">
              <CanvasWorkflowAction
                label={t('canvas.nest.discard')}
                variant="cancel"
                onClick={() => {
                  discardNest(subject.replaceNest!.id)
                  setRun({ state: 'idle' })
                }}
              />
            </div>
          )}
        </>
      )}
    </CanvasWorkflowPanel>
  )
}
