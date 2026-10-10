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
 * that file, so it must only ever move forward. This asks the app's own update
 * rule (`manifestAcceptsVersion`) whether the dispatched version may replace
 * the published one, and reports the answer as the `publish` step output. A
 * tester build with a deliberately low version, or an old version dispatched by
 * mistake, still builds and uploads its installer; it just leaves the manifest
 * alone.
 *
 * Usage: npx tsx scripts/download-manifest-gate.ts <macos|windows|linux> <version> [pages-repo dir]
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { manifestAcceptsVersion, type DownloadManifest, type UpdatePlatform } from '../src/utils/updateCheck'

const PLATFORMS: readonly UpdatePlatform[] = ['macos', 'windows', 'linux']

function readManifest(file: string): DownloadManifest | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DownloadManifest
  } catch {
    // An unreadable manifest serves nobody: let this deploy replace it.
    console.log(`::warning::${file} is not valid JSON; it will be replaced`)
    return null
  }
}

function main(): void {
  const [platform, version, pagesDir = 'pages-repo'] = process.argv.slice(2)
  if (!PLATFORMS.includes(platform as UpdatePlatform) || !version) {
    console.error('Usage: download-manifest-gate.ts <macos|windows|linux> <version> [pages-repo dir]')
    process.exit(2)
  }

  // The same rule the deploy workflows use to pick the channel folder.
  const channel = version.includes('-') ? 'snapshot' : 'stable'
  const file = join(pagesDir, 'downloads', channel, `${platform}.json`)
  const manifest = readManifest(file)
  const publish = manifestAcceptsVersion(manifest, version)
  const published = manifest?.version ?? 'none'

  console.log(publish
    ? `::notice::${channel}/${platform}.json: published ${published}, dispatched ${version} — writing the manifest`
    : `::notice::${channel}/${platform}.json: published ${published} is newer than dispatched ${version} — manifest left as is; the installer is still uploaded to the release`)

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`)
  }
}

main()
