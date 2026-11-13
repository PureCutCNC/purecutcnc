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

import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/i18nContext'

/** Shared keyboard, focus and scrolling boundary for setup dialogs. */
export function SetupDialogShell({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ReactNode; footer: ReactNode
}) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    const node = dialog.current
    node?.querySelector<HTMLElement>('button, input, select, textarea')?.focus()
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key !== 'Tab' || !node) return
      const items = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', keydown)
    return () => { window.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [onClose])
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div ref={dialog} className="dialog dialog--setup" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header"><h2 className="dialog-title">{title}</h2><button type="button" className="dialog-close" aria-label={t('dialogs.common.close')} onClick={onClose}>✕</button></div>
        <div className="dialog-body setup-dialog-body">{children}</div>
        <div className="dialog-footer">{footer}</div>
      </div>
    </div>, document.body,
  )
}
