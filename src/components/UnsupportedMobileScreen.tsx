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

export function UnsupportedMobileScreen() {
  return (
    <main className="unsupported-mobile-shell">
      <div className="unsupported-mobile-card">
        <div className="unsupported-mobile-eyebrow">Desktop Browser Only</div>
        <h1>PureCutCNC is not supported on phones.</h1>
        <p>
          The browser app is designed for a desktop-sized workspace and does not
          behave well on phone screens. Use a desktop browser or install a
          desktop build for macOS, Windows, or Linux.
        </p>
        <div className="unsupported-mobile-actions">
          <a href="https://purecutcnc.github.io/downloads.html">Desktop Downloads</a>
          <a href="https://purecutcnc.github.io/">Project Website</a>
        </div>
      </div>
    </main>
  )
}
