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
 * Entry point for the `download-manifest-gate` action (issue #1000), run by
 * the desktop deploy workflows after the pages repo is checked out.
 *
 * Prints the decision as a notice and writes `publish=true|false` to
 * $GITHUB_OUTPUT. Exits 1 when the gate cannot decide (see `gate.ts`), so a
 * broken path or manifest stops the manifest update instead of publishing.
 *
 * Usage: npx tsx tools/download-manifest-gate/cli.ts <macos|windows|linux> <version> [pages-repo dir]
 */

import { appendFileSync } from 'node:fs'
import { GateError, decideManifestPublish } from './gate.ts'

const [platform = '', rawVersion = '', pagesDir = 'pages-repo'] = process.argv.slice(2)
const version = rawVersion.trim()

try {
  const decision = decideManifestPublish({ pagesDir, platform, version })
  const name = `${decision.channel}/${platform}.json`
  if (decision.publish) {
    console.log(`::notice::${name}: published ${decision.published ?? 'nothing yet'}, dispatched ${version} — the manifest will be written`)
  } else {
    console.log(`::notice::${name}: published ${decision.published} is newer than dispatched ${version} — the manifest is left as it is`)
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${decision.publish}\n`)
  }
} catch (error) {
  if (!(error instanceof GateError)) throw error
  console.log(`::error::download manifest gate: ${error.message}`)
  process.exit(1)
}
