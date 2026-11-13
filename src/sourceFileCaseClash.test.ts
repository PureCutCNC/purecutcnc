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
 * No two source modules in one folder may differ only in letter case (#1196).
 *
 * On Windows and macOS, file names are case-insensitive, so an import of
 * `./OperationCuts` resolved to `operationCuts.ts` instead of
 * `OperationCuts.tsx`, and the desktop builds failed. Linux CI is
 * case-sensitive and never saw it, so this test is the guard.
 *
 * Run with: npx tsx src/sourceFileCaseClash.test.ts
 */

import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css'])

/** Module paths without extension, grouped by their lower-case spelling. */
export function caseClashes(files: readonly string[]): string[][] {
  const byLower = new Map<string, Set<string>>()
  for (const file of files) {
    const extension = extname(file)
    if (!MODULE_EXTENSIONS.has(extension)) continue
    const stem = file.slice(0, -extension.length)
    const key = stem.toLowerCase()
    const spellings = byLower.get(key) ?? new Set<string>()
    spellings.add(stem)
    byLower.set(key, spellings)
  }
  return [...byLower.values()].filter((spellings) => spellings.size > 1).map((spellings) => [...spellings].sort())
}

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

// The rule itself: different stems that only differ in case clash; the same
// stem with two extensions (a component and its stylesheet) does not.
assert.deepEqual(
  caseClashes(['cam/OperationCuts.tsx', 'cam/operationCuts.ts', 'cam/operationCuts.test.ts']),
  [['cam/OperationCuts', 'cam/operationCuts']],
  'a component and a helper whose names differ only in case clash',
)
assert.deepEqual(caseClashes(['cam/Panel.tsx', 'cam/Panel.css']), [], 'one stem with two extensions is fine')
assert.deepEqual(caseClashes(['a/Thing.ts', 'b/thing.ts']), [], 'files in different folders do not clash')

const sourceRoot = fileURLToPath(new URL('.', import.meta.url))
const clashes = caseClashes(listFiles(sourceRoot).map((path) => path.slice(sourceRoot.length)))
assert.deepEqual(clashes, [], `source files that differ only in case: ${JSON.stringify(clashes)}`)

console.log('source file case clash test passed')
