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

import { useI18n } from '../i18n/i18nContext'
import { formatError } from './errorFormat'

interface ErrorScreenProps {
  error: unknown
  info?: string
}

export function ErrorScreen({ error, info }: ErrorScreenProps) {
  const { t } = useI18n()
  const details = formatError(error, info)
  return (
    <main className="app-error-shell">
      <div className="app-error-card">
        <div className="app-error-eyebrow">{t('viewport.error.eyebrow')}</div>
        <h1>{t('viewport.error.title')}</h1>
        <p>{t('viewport.error.body')}</p>
        <details className="app-error-details">
          <summary>{t('viewport.error.showDetails')}</summary>
          <pre>{details}</pre>
        </details>
        <div className="app-error-actions">
          <button type="button" onClick={() => window.location.reload()}>
            {t('viewport.error.reload')}
          </button>
          <a href="https://purecutcnc.github.io/downloads.html">{t('viewport.error.desktopDownloads')}</a>
          <a href="https://purecutcnc.github.io/">{t('viewport.error.projectWebsite')}</a>
        </div>
      </div>
    </main>
  )
}
