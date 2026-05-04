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
  parts.push(`User agent: ${ua}`)
  parts.push(`Timestamp: ${new Date().toISOString()}`)
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
        <div class="app-error-eyebrow">Something went wrong</div>
        <h1>Sorry &mdash; PureCutCNC couldn't start on this device.</h1>
        <p>
          This usually means your browser or operating system doesn't support
          the 3D graphics features the app needs. Try a current version of
          Chrome, Edge, or Firefox on a reasonably recent desktop or tablet, or
          use one of our desktop builds.
        </p>
        <details class="app-error-details">
          <summary>Show technical details</summary>
          <pre>${details}</pre>
        </details>
        <div class="app-error-actions">
          <button type="button" onclick="window.location.reload()">Reload</button>
          <a href="https://purecutcnc.github.io/downloads.html">Desktop Downloads</a>
          <a href="https://purecutcnc.github.io/">Project Website</a>
        </div>
      </div>
    </main>
  `
}
