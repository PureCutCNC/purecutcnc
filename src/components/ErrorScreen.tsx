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

import { formatError } from './errorFormat'

interface ErrorScreenProps {
  error: unknown
  info?: string
}

export function ErrorScreen({ error, info }: ErrorScreenProps) {
  const details = formatError(error, info)
  return (
    <main className="app-error-shell">
      <div className="app-error-card">
        <div className="app-error-eyebrow">Something went wrong</div>
        <h1>Sorry &mdash; PureCut CNC couldn't start on this device.</h1>
        <p>
          This usually means your browser or operating system doesn't support
          the 3D graphics features the app needs. Try a current version of
          Chrome, Edge, or Firefox on a reasonably recent desktop or tablet, or
          use one of our desktop builds.
        </p>
        <details className="app-error-details">
          <summary>Show technical details</summary>
          <pre>{details}</pre>
        </details>
        <div className="app-error-actions">
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <a href="https://purecutcnc.github.io/downloads.html">Desktop Downloads</a>
          <a href="https://purecutcnc.github.io/">Project Website</a>
        </div>
      </div>
    </main>
  )
}
