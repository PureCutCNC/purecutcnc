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
 * User-initiated update check for the desktop (Tauri) build.
 *
 * The desktop deploy workflows publish a per-platform, per-channel manifest to
 * the project pages site (e.g. downloads/snapshot/macos.json). This module
 * fetches that manifest, compares its version against the running app, and
 * classifies the result. Nothing here runs automatically — it is only invoked
 * when the user picks "Check for Updates…" from the native menu.
 *
 * The web build does not use this: the browser always loads the freshly
 * deployed bundle, so there is nothing to check.
 */

import { readFromStorage, writeToStorage } from '../hooks/useLocalStorageState'

export type UpdateChannel = 'stable' | 'snapshot'

/** Manifest platform key, matching the deploy workflows' output filenames. */
export type UpdatePlatform = 'macos' | 'windows' | 'linux'

/** Default channel — stable; snapshot is opt-in for testers (via the update channel menu). */
export const DEFAULT_CHANNEL: UpdateChannel = 'stable'

const CHANNEL_STORAGE_KEY = 'purecutcnc.updateChannel'

const DOWNLOADS_BASE = 'https://purecutcnc.github.io/downloads'
const RELEASES_PAGE = 'https://github.com/PureCutCNC/purecutcnc/releases'

/** Shape of downloads/{channel}/{platform}.json written by the deploy CI. */
export interface DownloadAsset {
  name: string
  label?: string
  kind?: string
  url: string
}

export interface DownloadManifest {
  platform?: string
  channel?: string
  version?: string
  tag?: string
  releaseUrl?: string
  updatedAt?: string
  assets?: DownloadAsset[]
}

export type UpdateResult =
  | { kind: 'up-to-date'; current: string; latest: string }
  | { kind: 'update-available'; current: string; latest: string; url: string }
  | { kind: 'no-release'; channel: UpdateChannel }
  | { kind: 'error'; message: string }

// ---------------------------------------------------------------------------
// Channel preference (persisted in localStorage)
// ---------------------------------------------------------------------------

export function loadChannel(): UpdateChannel {
  const storage = typeof window === 'undefined' ? null : window.localStorage
  return readFromStorage(storage, CHANNEL_STORAGE_KEY, DEFAULT_CHANNEL, {
    deserialize: (raw) => {
      if (raw === 'stable' || raw === 'snapshot') return raw
      throw new Error('invalid channel')
    },
  })
}

export function saveChannel(channel: UpdateChannel): void {
  // Storage may be unavailable (private mode); writeToStorage swallows the error
  // so the in-session menu state still reflects the choice, it just won't persist.
  const storage = typeof window === 'undefined' ? null : window.localStorage
  writeToStorage(storage, CHANNEL_STORAGE_KEY, channel, { serialize: (c) => c })
}

// ---------------------------------------------------------------------------
// Semver comparison
// ---------------------------------------------------------------------------

interface ParsedVersion {
  nums: [number, number, number]
  pre: string[]
}

function parseVersion(input: string): ParsedVersion {
  const cleaned = String(input).trim().replace(/^v/i, '')
  const dash = cleaned.indexOf('-')
  const core = dash < 0 ? cleaned : cleaned.slice(0, dash)
  const preStr = dash < 0 ? '' : cleaned.slice(dash + 1)

  const parts = core.split('.')
  const nums: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const n = Number.parseInt(parts[i] ?? '0', 10)
    nums[i] = Number.isFinite(n) ? n : 0
  }
  const pre = preStr.length > 0 ? preStr.split('.') : []
  return { nums, pre }
}

/**
 * Compare two semver-ish strings. Returns 1 if `a` is newer than `b`, -1 if
 * older, 0 if equal. Tolerates a leading `v` and malformed input (missing parts
 * are treated as 0). Prerelease precedence follows semver: a version without a
 * prerelease tag outranks the same core version with one
 * (`1.0.0` > `1.0.0-rc.1`), and numeric identifiers compare numerically.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)

  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }

  // Equal core. Absence of a prerelease tag ranks higher than presence.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1

  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // shorter prerelease list ranks lower
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (xNum) {
      return -1 // numeric identifiers rank lower than alphanumeric
    } else if (yNum) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// Classification + fetch
// ---------------------------------------------------------------------------

/**
 * Pure classification of a fetched manifest against the running version.
 * A null/blank manifest means no release exists yet for that channel/platform.
 */
export function classifyManifest(
  currentVersion: string,
  manifest: DownloadManifest | null,
  channel: UpdateChannel
): UpdateResult {
  if (!manifest || !manifest.version) {
    return { kind: 'no-release', channel }
  }
  const latest = manifest.version
  if (compareVersions(latest, currentVersion) > 0) {
    const url = manifest.releaseUrl ?? manifest.assets?.[0]?.url ?? RELEASES_PAGE
    return { kind: 'update-available', current: currentVersion, latest, url }
  }
  return { kind: 'up-to-date', current: currentVersion, latest }
}

/** Map a webview userAgent to a manifest platform key. */
export function detectPlatform(
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''
): UpdatePlatform | null {
  if (/Mac/i.test(userAgent)) return 'macos'
  if (/Win/i.test(userAgent)) return 'windows'
  if (/Linux|X11/i.test(userAgent)) return 'linux'
  return null
}

export interface DesktopUpdateDeps {
  /** Running app version, e.g. from Tauri getVersion(). */
  currentVersion: string
  /** Override platform detection (defaults to navigator.userAgent). */
  platform?: UpdatePlatform | null
  /** Override fetch (for tests). */
  fetchFn?: typeof fetch
}

export function manifestUrl(channel: UpdateChannel, platform: UpdatePlatform): string {
  return `${DOWNLOADS_BASE}/${channel}/${platform}.json`
}

/**
 * Fetch the channel/platform manifest and classify it against the running
 * version. Never throws — network/parse failures resolve to an `error` (or
 * `no-release` for a missing manifest) so the caller can show a friendly note.
 */
export async function checkDesktopUpdate(
  channel: UpdateChannel,
  deps: DesktopUpdateDeps
): Promise<UpdateResult> {
  const platform = deps.platform ?? detectPlatform()
  if (!platform) {
    return { kind: 'error', message: 'Unsupported platform for update checks.' }
  }
  const fetchFn = deps.fetchFn ?? fetch
  try {
    const res = await fetchFn(manifestUrl(channel, platform), { cache: 'no-store' })
    if (res.status === 404) {
      return { kind: 'no-release', channel }
    }
    if (!res.ok) {
      return { kind: 'error', message: `Update server returned ${res.status}.` }
    }
    const manifest = (await res.json()) as DownloadManifest
    return classifyManifest(deps.currentVersion, manifest, channel)
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : 'Could not reach the update server.',
    }
  }
}
