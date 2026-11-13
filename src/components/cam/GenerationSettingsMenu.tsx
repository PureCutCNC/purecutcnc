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
 * Toolpath generation controls, in the CAM panel header (issue #675).
 *
 * These started in the status bar and moved here on the maintainer's call: this
 * is where generation is *visible* — the operations that are generating are
 * listed directly below — so it is where the controls to stop it and to see how
 * it is running belong.
 *
 * Everything lives behind one gear rather than split across two places, and
 * since issue #1102 slice D1 that includes the sketch's GPU/Canvas switch and
 * its fallback notice. There is no backend choice any more: generation always
 * uses the worker when the runtime has one, and the gear reports the automatic
 * fallback to the main thread exactly as before.
 *
 * The gear carries its own state, because a menu hides what is inside it: it
 * marks itself when generation is paused or has failed, or when either backend
 * fell back, so a stopped pipeline or a Canvas-only sketch cannot be a mystery
 * the user has to go looking for. The per-operation pause badges in the tree
 * below say the same thing at the row level.
 */

import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { usePortalPosition } from '../../hooks/usePortalPosition'
import { useI18n } from '../../i18n/i18nContext'
import { Icon } from '../Icon'
import { useToolpathRendererStore } from '../../store/toolpathRendererStore'
import { gearFlagged, rendererNotice } from './generationGearState'
import type { GenerationStatusSnapshot } from '../../app/toolpathGeneration/types'

export interface GenerationSettingsMenuProps {
  status: GenerationStatusSnapshot
  /** True when the active backend can actually interrupt work in progress. */
  canStop: boolean
  onStop: () => void
  onResume: () => void
  onRetry: () => void
}

export function GenerationSettingsMenu({
  status,
  canStop,
  onStop,
  onResume,
  onRetry,
}: GenerationSettingsMenuProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  // Published by the sketch canvas, which stays mounted on every centre tab,
  // so the Display section shows whenever a project is open; it switches the
  // sketch's toolpath renderer and is harmless to offer from 3D or Simulation.
  const renderer = useToolpathRendererStore(state => state.renderer)

  const busy = status.activeOperationId !== null || status.queuedCount > 0
  const failed = status.executorFailure !== null
    || [...status.operations.values()].some((value) => value === 'failed')
  const paused = status.automaticPaused
  // A worker that could not start is not a failure the user has to clear: this
  // session moved to the main thread and the work still runs. It is reported
  // separately so it cannot be mistaken for either state (issue #1087).
  const fallback = status.executorFallback
  const rendererState = rendererNotice(renderer?.status ?? null)
  const rendererFallback = rendererState === 'fallback'
  const flagged = gearFlagged({
    paused,
    failed,
    workerFallback: fallback !== null,
    rendererFallback,
  })

  // Portalled and clamped: the CAM panel scrolls and has its own stacking
  // context, so an in-flow menu would be clipped by the panel it hangs off.
  const coords = usePortalPosition(triggerRef, menuRef, open, (anchor, floating) => {
    const margin = 8
    const left = Math.max(
      margin,
      Math.min(anchor.right - floating.width, window.innerWidth - floating.width - margin),
    )
    const below = anchor.bottom + 6
    // Prefer dropping below the gear; flip above when that would run off the
    // bottom, which happens when the panel is short or the window is small.
    const top = below + floating.height + margin <= window.innerHeight
      ? below
      : Math.max(margin, anchor.top - floating.height - 6)
    return { top, left }
  })

  useOutsideDismiss({ open, refs: [triggerRef, menuRef], onDismiss: () => setOpen(false) })

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  // The reason rides along with the label so it reaches the tooltip and the
  // accessible name, not just the opened menu: a failure the user has to go
  // looking for is a failure they will read as the app being broken.
  const failureDetail = status.executorFailure?.message
  const statusLabel = failed
    ? (failureDetail ? `${t('appShell.generation.failed')}: ${failureDetail}` : t('appShell.generation.failed'))
    : paused
      ? t('appShell.generation.paused')
      : busy
        ? t('appShell.generation.working', { count: status.queuedCount + (status.activeOperationId ? 1 : 0) })
        : t('appShell.generation.ready')
  // A fallback is appended, not substituted: generation keeps working, so the
  // gear must still be able to say it is up to date while naming where it ran.
  const generationNotice = fallback
    ? `${statusLabel} — ${t('appShell.generation.workerFallback')}`
    : statusLabel
  // The renderer fallback is appended only to the gear's own name and tooltip.
  // The menu states it once, in the Display section beside its Retry button,
  // rather than twice in a menu the user is already looking at.
  const statusNotice = rendererFallback
    ? `${generationNotice} — ${t('appShell.toolpath.rendererFallback')}`
    : generationNotice

  return (
    <>
      <button
        ref={triggerRef}
        className={`tree-action-btn cam-generation-gear${flagged ? ' cam-generation-gear--flagged' : ''}`}
        type="button"
        title={`${t('appShell.generation.backend')} — ${statusNotice}`}
        aria-label={`${t('appShell.generation.menuAria')} — ${statusNotice}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon id="gear" />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="appearance-menu cam-generation-menu"
          id={menuId}
          role="menu"
          aria-label={t('appShell.generation.menuAria')}
          style={{
            position: 'fixed',
            top: coords?.top ?? -9999,
            left: coords?.left ?? -9999,
            visibility: coords ? 'visible' : 'hidden',
          }}
        >
          {/*
            Status first: it is the reason someone opens this menu, and it is
            the thing the gear alone cannot spell out.
          */}
          <div className="cam-generation-menu__status" role="status" aria-live="polite">
            {generationNotice}
            {/*
              A failure with no stated reason leaves the user with nothing to
              act on — and no way to tell "this operation's geometry is bad"
              from "the worker could not start".
            */}
            {status.executorFailure && (
              <span className="cam-generation-menu__failure">
                {status.executorFailure.message}
              </span>
            )}
            {/* The fallback keeps the operation running, so it is a notice with
                its reason rather than a failure to clear (issue #1087). */}
            {fallback && (
              <span className="cam-generation-menu__fallback">
                {fallback.message}
              </span>
            )}
          </div>

          <div className="cam-generation-menu__actions">
            {paused ? (
              <button
                className="cam-header-action"
                type="button"
                onClick={() => { onResume(); close() }}
              >
                <Icon id="play" />
                {t('appShell.generation.resume')}
              </button>
            ) : (
              <button
                className="cam-header-action"
                type="button"
                disabled={!busy || !canStop}
                title={canStop ? undefined : t('appShell.generation.stopUnavailable')}
                onClick={() => { onStop(); close() }}
              >
                <Icon id="pause" />
                {t('appShell.generation.stop')}
              </button>
            )}
            {failed && (
              <button
                className="cam-header-action"
                type="button"
                onClick={() => { onRetry(); close() }}
              >
                <Icon id="refresh" />
                {t('appShell.generation.retry')}
              </button>
            )}
          </div>

          {/*
            The renderer switch and its fallback moved here from the toolpath
            legend (issue #1102 slice D1): the legend is about what is drawn and
            the gear is about how, and the fallback sentence used to wrap the
            legend onto two rows.
          */}
          {renderer && (
            <>
              <div className="appearance-menu__heading">{t('appShell.generation.display')}</div>
              <div className="cam-generation-menu__renderer">
                <span className="cam-generation-menu__renderer-label">
                  {t('appShell.toolpath.renderer')}
                </span>
                <span className="cam-generation-menu__renderer-options">
                  <button
                    type="button"
                    aria-pressed={renderer.choice === 'gpu'}
                    onClick={() => renderer.setChoice('gpu')}
                  >
                    {t('appShell.toolpath.rendererGpu')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={renderer.choice === 'canvas'}
                    onClick={() => renderer.setChoice('canvas')}
                  >
                    {t('appShell.toolpath.rendererCanvas')}
                  </button>
                </span>
                {rendererState === 'loading' && (
                  <span className="cam-generation-menu__renderer-note" role="status">
                    {t('appShell.toolpath.rendererLoading')}
                  </span>
                )}
                {rendererFallback && (
                  <span className="cam-generation-menu__renderer-note cam-generation-menu__renderer-note--fallback" role="status">
                    {t('appShell.toolpath.rendererFallback')}
                    <button type="button" onClick={() => renderer.retry()}>
                      {t('appShell.toolpath.rendererRetry')}
                    </button>
                  </span>
                )}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
