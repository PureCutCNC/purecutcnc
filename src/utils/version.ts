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

export interface VersionInfo {
  version: string
  name?: string
  date?: string
  url?: string
}

const DEV_VERSION: VersionInfo = { version: 'dev' }

let cachedInfo: VersionInfo | null = null
let inFlight: Promise<VersionInfo> | null = null

/**
 * Fetches version.json from the app root and caches the result for the lifetime
 * of the page. version.json is written by the deploy workflow; in local dev it
 * is absent, so this resolves to `{ version: 'dev' }`.
 */
export async function loadVersionInfo(): Promise<VersionInfo> {
  if (cachedInfo) return cachedInfo
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const res = await fetch('./version.json', { cache: 'no-store' })
        if (!res.ok) return DEV_VERSION
        const data = (await res.json()) as VersionInfo
        return data?.version ? data : DEV_VERSION
      } catch {
        return DEV_VERSION
      }
    })().then((info) => {
      cachedInfo = info
      return info
    })
  }
  return inFlight
}

/**
 * The version.json value captured earlier this session, or null if it has not
 * been loaded yet. Synchronous — for callers that already triggered a load.
 */
export function getCachedVersionInfo(): VersionInfo | null {
  return cachedInfo
}

/**
 * Fetches version.json from the app root.
 * Returns the version string, or "dev" if the file is absent (local dev).
 */
export async function loadVersion(): Promise<string> {
  return (await loadVersionInfo()).version ?? 'dev'
}

/**
 * Fetches version.json and updates document.title to include the version.
 * Call once at app startup.
 */
export async function applyVersionToTitle(appName = 'PureCutCNC'): Promise<void> {
  const version = await loadVersion()
  document.title = `${appName} ${version}`
}
