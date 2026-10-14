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
 * Download-manifest gate for the desktop deploy workflows (issue #1000).
 *
 * Each desktop deploy writes downloads/{channel}/{platform}.json to the pages
 * repo. The public downloads page and the desktop "Check for Updates" both read
 * that file. This decides whether a dispatched version may replace the one
 * published there: only the same version or a newer one, by the same
 * `compareVersions` the app's update check uses. A tester build with a
 * deliberately low version (`0.0.0-release-0.6.0-preview.1`), or an old version
 * dispatched by mistake, still builds; it just leaves the manifest alone.
 *
 * It fails closed. A manifest that is missing is the first release for that
 * platform and channel and is written, but anything that cannot be judged — no
 * pages checkout, a manifest that does not parse or carries no version — is an
 * error, never a silent "publish".
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from '../../src/utils/versionCompare.ts'

export type GatePlatform = 'macos' | 'windows' | 'linux'
export type GateChannel = 'stable' | 'snapshot'

export const GATE_PLATFORMS: readonly GatePlatform[] = ['macos', 'windows', 'linux']

/** A situation the gate refuses to decide; the deploy step fails. */
export class GateError extends Error {}

export interface GateDecision {
  /** Whether the deploy writes and pushes the manifest. */
  publish: boolean
  channel: GateChannel
  /** The manifest file that was (or would have been) read. */
  file: string
  /** The version published there, or null when there is no manifest yet. */
  published: string | null
}

/**
 * The channel folder a version deploys to. The deploy workflows compute the
 * same thing for their `RELEASE_CHANNEL`: a prerelease tag means `snapshot`.
 */
export function channelForVersion(version: string): GateChannel {
  return version.includes('-') ? 'snapshot' : 'stable'
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

/** The published version in a manifest file; throws when it cannot be read. */
function publishedVersion(file: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new GateError(`${file} cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined
  if (typeof version !== 'string' || version.trim() === '') {
    throw new GateError(`${file} has no version`)
  }
  return version
}

export function decideManifestPublish(args: { pagesDir: string; platform: string; version: string }): GateDecision {
  const { pagesDir, platform } = args
  const version = args.version.trim()
  if (!GATE_PLATFORMS.includes(platform as GatePlatform)) {
    throw new GateError(`unknown platform "${platform}" (expected ${GATE_PLATFORMS.join(', ')})`)
  }
  if (version === '') {
    throw new GateError('no version given')
  }
  // Without this, a wrong path would look exactly like "no manifest yet" and
  // every build, tester builds included, would publish.
  const downloads = join(pagesDir, 'downloads')
  if (!isDirectory(downloads)) {
    throw new GateError(`${downloads} not found: the pages repo must be checked out to ${pagesDir} before the gate runs`)
  }

  const channel = channelForVersion(version)
  const file = join(downloads, channel, `${platform}.json`)
  if (!existsSync(file)) {
    return { publish: true, channel, file, published: null }
  }
  const published = publishedVersion(file)
  return { publish: compareVersions(version, published) >= 0, channel, file, published }
}
