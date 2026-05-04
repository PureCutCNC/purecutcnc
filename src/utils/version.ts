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

interface VersionInfo {
  version: string
  name?: string
  date?: string
  url?: string
}

/**
 * Fetches version.json from the app root.
 * Returns the version string, or "dev" if the file is absent (local dev).
 */
export async function loadVersion(): Promise<string> {
  try {
    const res = await fetch('./version.json', { cache: 'no-store' })
    if (!res.ok) return 'dev'
    const data: VersionInfo = await res.json()
    return data.version ?? 'dev'
  } catch {
    return 'dev'
  }
}

/**
 * Fetches version.json and updates document.title to include the version.
 * Call once at app startup.
 */
export async function applyVersionToTitle(appName = 'PureCutCNC'): Promise<void> {
  const version = await loadVersion()
  document.title = `${appName} ${version}`
}
