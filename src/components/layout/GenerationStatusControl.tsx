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
 * Generation status, Stop/Resume/Retry, and the execution-backend choice
 * (issue #675, slice 4).
 *
 * Small on purpose. The CAM panel is not redesigned here; this is one status
 * bar control that answers "is it working, and can I stop it" — questions the
 * application previously could not answer at all, because generation blocked
 * the thread that would have had to draw the answer.
 *
 * Two pieces of honesty are built into the copy rather than left to a release
 * note. The backend menu says plainly that the main-thread option cannot keep
 * the window responsive, and Stop is **disabled** under that backend rather
 * than offered and quietly ineffective: a running generator holds the only
 * thread, so nothing can observe a cancel until it returns on its own.
 */

import { useId, useRef, useState } from 'react'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useI18n } from '../../i18n/i18nContext'
import type { ExecutorKind, GenerationStatusSnapshot } from '../../app/toolpathGeneration/types'

export interface GenerationStatusControlProps {
  status: GenerationStatusSnapshot
  executor: ExecutorKind
  onExecutorChange: (kind: ExecutorKind) => void
  /** False when the runtime has no Worker at all; the option is then not offered. */
  workerAvailable: boolean
  /** True when the active backend can actually interrupt work in progress. */
  canStop: boolean
  onStop: () => void
  onResume: () => void
  onRetry: () => void
}

export function GenerationStatusControl({
  status,
  executor,
  onExecutorChange,
  workerAvailable,
  canStop,
  onStop,
  onResume,
  onRetry,
}: GenerationStatusControlProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  useOutsideDismiss({ open, refs: hostRef, onDismiss: () => setOpen(false) })

  const busy = status.activeOperationId !== null || status.queuedCount > 0
  const failed = status.executorFailure !== null
    || [...status.operations.values()].some((value) => value === 'failed')

  // One line, in priority order: a failure is the thing to say even while other
  // work continues, and a pause is worth saying even when nothing is queued.
  const summary = failed
    ? t('appShell.generation.failed')
    : status.automaticPaused
      ? t('appShell.generation.paused')
      : busy
        ? t('appShell.generation.working', { count: status.queuedCount + (status.activeOperationId ? 1 : 0) })
        : t('appShell.generation.ready')

  const chooseBackend = (kind: ExecutorKind): void => {
    onExecutorChange(kind)
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="appearance-control generation-status" ref={hostRef}>
      {/*
        Polite, not assertive: generation status changes often while the user is
        doing something else, and an assertive region would interrupt them for
        information they did not ask for.
      */}
      <span className="generation-status__summary" role="status" aria-live="polite">
        {summary}
      </span>

      {status.automaticPaused ? (
        <button className="statusbar-toggle" type="button" onClick={onResume}>
          {t('appShell.generation.resume')}
        </button>
      ) : (
        <button
          className="statusbar-toggle"
          type="button"
          onClick={onStop}
          disabled={!busy || !canStop}
          title={canStop ? undefined : t('appShell.generation.stopUnavailable')}
        >
          {t('appShell.generation.stop')}
        </button>
      )}

      {failed && (
        <button className="statusbar-toggle" type="button" onClick={onRetry}>
          {t('appShell.generation.retry')}
        </button>
      )}

      {workerAvailable && (
        <div className="toolbar-action">
          <button
            ref={triggerRef}
            className="statusbar-toggle generation-status__trigger"
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            {t('appShell.generation.backend')}
          </button>
          {open && (
            <div className="appearance-menu" id={menuId} role="menu" aria-label={t('appShell.generation.menuAria')}>
              <div className="appearance-menu__heading">{t('appShell.generation.backend')}</div>
              <div className="appearance-menu__options">
                {(['inline', 'worker'] as const).map((kind) => (
                  <button
                    key={kind}
                    className={`appearance-menu__option ${executor === kind ? 'appearance-menu__option--selected' : ''}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={executor === kind}
                    onClick={() => chooseBackend(kind)}
                  >
                    <span className="appearance-menu__option-label">
                      {kind === 'inline'
                        ? t('appShell.generation.backendInline')
                        : t('appShell.generation.backendWorker')}
                    </span>
                    <span className="appearance-menu__option-detail">
                      {kind === 'inline'
                        ? t('appShell.generation.backendInlineDetail')
                        : t('appShell.generation.backendWorkerDetail')}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
