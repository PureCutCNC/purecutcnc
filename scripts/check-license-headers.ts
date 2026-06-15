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
 * Enforce the Apache 2.0 license header on every `src/**` TypeScript source
 * file (see AGENTS.md). Runs inside `npm test` (and therefore `npm run build`),
 * so a missing header fails the build gate instead of depending on reviewer or
 * agent diligence. Dependency-free — Node fs only, executed via tsx.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src'
const EXTENSIONS = ['.ts', '.tsx']
/** Stable substring of the Apache header block, tolerant of year/name edits. */
const HEADER_MARKER = 'Licensed under the Apache License, Version 2.0'
/** Only the file head can carry the banner; avoid reading whole large files. */
const HEAD_BYTES = 2048

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    if (statSync(fullPath).isDirectory()) {
      collectSourceFiles(fullPath, out)
    } else if (EXTENSIONS.some((ext) => fullPath.endsWith(ext))) {
      out.push(fullPath)
    }
  }
}

function main(): void {
  const files: string[] = []
  collectSourceFiles(ROOT, files)

  const missing = files
    .filter((file) => !readFileSync(file, 'utf8').slice(0, HEAD_BYTES).includes(HEADER_MARKER))
    .sort()

  if (missing.length > 0) {
    console.error(`license-headers: FAIL — ${missing.length} src file(s) missing the Apache 2.0 header:`)
    for (const file of missing) {
      console.error(`  ${file}`)
    }
    console.error('Every src/**/*.ts(x) file must start with the Apache 2.0 header (see AGENTS.md).')
    process.exit(1)
  }

  console.log(`license-headers: OK (${files.length} src .ts/.tsx files)`)
}

main()
