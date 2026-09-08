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
 * listed directly below — so it is where the controls to stop it and to choose
 * how it runs belong.
 *
 * Everything lives behind one gear rather than split across two places. A
 * backend picker in the CAM panel and a Stop button in the status bar would be
 * two homes for one concern, which is worse than either alone.
 *
 * The gear carries its own state, because a menu hides what is inside it: it
 * marks itself when generation is paused or has failed, so a stopped pipeline
 * cannot be a mystery the user has to go looking for. The per-operation pause
 * badges in the tree below say the same thing at the row level.
 */

import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { usePortalPosition } from '../../hooks/usePortalPosition'
import { useI18n } from '../../i18n/i18nContext'
import { Icon } from '../Icon'
import type { ExecutorKind, GenerationStatusSnapshot } from '../../app/toolpathGeneration/types'

export interface GenerationSettingsMenuProps {
  status: GenerationStatusSnapshot
  executor: ExecutorKind
  onExecutorChange: (kind: ExecutorKind) => void
  /** False when the runtime has no Worker at all; the choice is then not offered. */
  workerAvailable: boolean
  /** True when the active backend can actually interrupt work in progress. */
  canStop: boolean
  onStop: () => void
  onResume: () => void
  onRetry: () => void
}

export function GenerationSettingsMenu({
  status,
  executor,
  onExecutorChange,
  workerAvailable,
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

  const busy = status.activeOperationId !== null || status.queuedCount > 0
  const failed = status.executorFailure !== null
    || [...status.operations.values()].some((value) => value === 'failed')
  const paused = status.automaticPaused

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

  const statusLabel = failed
    ? t('appShell.generation.failed')
    : paused
      ? t('appShell.generation.paused')
      : busy
        ? t('appShell.generation.working', { count: status.queuedCount + (status.activeOperationId ? 1 : 0) })
        : t('appShell.generation.ready')

  return (
    <>
      <button
        ref={triggerRef}
        className={`tree-action-btn cam-generation-gear${paused || failed ? ' cam-generation-gear--flagged' : ''}`}
        type="button"
        title={`${t('appShell.generation.backend')} — ${statusLabel}`}
        aria-label={`${t('appShell.generation.menuAria')} — ${statusLabel}`}
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
            {statusLabel}
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

          {workerAvailable && (
            <>
              <div className="appearance-menu__heading">{t('appShell.generation.backend')}</div>
              <div className="appearance-menu__options">
                {(['inline', 'worker'] as const).map((kind) => (
                  <button
                    key={kind}
                    className={`appearance-menu__option ${executor === kind ? 'appearance-menu__option--selected' : ''}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={executor === kind}
                    onClick={() => { onExecutorChange(kind); close() }}
                  >
                    <span className="appearance-menu__copy">
                      <span className="appearance-menu__label">
                        {kind === 'inline'
                          ? t('appShell.generation.backendInline')
                          : t('appShell.generation.backendWorker')}
                      </span>
                      <span className="appearance-menu__detail">
                        {kind === 'inline'
                          ? t('appShell.generation.backendInlineDetail')
                          : t('appShell.generation.backendWorkerDetail')}
                      </span>
                    </span>
                    <span className="appearance-menu__check" aria-hidden="true">
                      {executor === kind ? '✓' : ''}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
