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
 * Visible reason for a refused command that has no control to hover
 * (issue #1112 A2). Rendered by the app shell, auto-dismissed; a repeated
 * reason gets a new `nonce`, so the live region announces it again.
 */

import { useEffect } from 'react'
import { useI18n } from '../../i18n/i18nContext'
import { useNoticeStore } from '../../store/noticeStore'

const DISMISS_MS = 5000

export function CommandNoticeToast() {
  const { t } = useI18n()
  const notice = useNoticeStore((state) => state.notice)
  const clearNotice = useNoticeStore((state) => state.clearNotice)

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(clearNotice, DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [notice, clearNotice])

  if (!notice) return null

  return (
    <div
      key={notice.nonce}
      className="command-notice"
      role="status"
      aria-live="polite"
      data-testid="command-notice"
    >
      {t(notice.messageKey)}
    </div>
  )
}
