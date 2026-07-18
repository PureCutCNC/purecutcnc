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

import { translate } from '../i18n/store'

export function formatError(error: unknown, info?: string): string {
  const parts: string[] = []
  if (error instanceof Error) {
    parts.push(`${error.name}: ${error.message}`)
    if (error.stack) {
      const frames = error.stack.split('\n').slice(0, 4).join('\n')
      parts.push(frames)
    }
  } else if (typeof error === 'string') {
    parts.push(error)
  } else if (error) {
    try {
      parts.push(JSON.stringify(error))
    } catch {
      parts.push(String(error))
    }
  }
  if (info) parts.push(info)
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
  parts.push(`${translate('viewport.error.userAgent')} ${ua}`)
  parts.push(`${translate('viewport.error.timestamp')} ${new Date().toISOString()}`)
  return parts.join('\n\n')
}

export function renderErrorHTML(error: unknown, info?: string): string {
  const details = formatError(error, info)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `
    <main class="app-error-shell">
      <div class="app-error-card">
        <div class="app-error-eyebrow">${translate('viewport.error.eyebrow')}</div>
        <h1>${translate('viewport.error.title')}</h1>
        <p>${translate('viewport.error.body')}</p>
        <details class="app-error-details">
          <summary>${translate('viewport.error.showDetails')}</summary>
          <pre>${details}</pre>
        </details>
        <div class="app-error-actions">
          <button type="button" onclick="window.location.reload()">${translate('viewport.error.reload')}</button>
          <a href="https://purecutcnc.github.io/downloads.html">${translate('viewport.error.desktopDownloads')}</a>
          <a href="https://purecutcnc.github.io/">${translate('viewport.error.projectWebsite')}</a>
        </div>
      </div>
    </main>
  `
}
