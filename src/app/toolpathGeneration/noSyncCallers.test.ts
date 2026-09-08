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
 * The application generates only through the service (issue #675, slice 3).
 *
 * This is the slice's acceptance condition expressed as a check rather than a
 * claim. Every consumer — preview, export, simulation, booklet, exported-motion
 * debug — was migrated onto the asynchronous contract; the value of that
 * migration is entirely in it being *complete*, because one surviving
 * synchronous caller is one place the UI still freezes and one place a worker
 * result can be bypassed.
 *
 * It is also the check that stops the migration quietly unravelling. Calling
 * `computeOperationToolpath` directly is the convenient thing to do when adding
 * a feature, it works, and nothing else would notice.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../..')

/**
 * The only modules allowed to call generation directly. Both are execution
 * backends: that is what an executor *is*.
 */
const EXECUTORS = new Set([
  'app/toolpathGeneration/inlineExecutor.ts',
  'app/toolpathGeneration/toolpath.worker.ts',
])

/** Application areas, as opposed to the engine that owns the computation. */
const APPLICATION_DIRS = ['app', 'components', 'store', 'hooks']

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Strip comments so a mention in prose is not read as a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The composition root lives at `src/App.tsx`, not inside any of the
 * directories above — and it is the consumer most likely to reach for a
 * synchronous call, because it is where everything is wired together. An
 * earlier version of this check walked only the subdirectories and silently
 * scanned neither it nor its siblings.
 */
function rootModules(): string[] {
  return readdirSync(SRC)
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
    .map((entry) => join(SRC, entry))
    .filter((file) => statSync(file).isFile())
}

const files = [
  ...rootModules(),
  ...APPLICATION_DIRS.flatMap((dir) => {
    try {
      return walk(join(SRC, dir))
    } catch {
      return []
    }
  }),
]

console.log(`\nApplication generates only through the service (${files.length} modules)`)

test('the scan found the application sources', () => {
  if (files.length < 50) throw new Error(`only ${files.length} modules scanned — the walk is probably wrong`)
})

test('only the executors call computeOperationToolpath', () => {
  const offenders: string[] = []
  for (const file of files) {
    const rel = relative(SRC, file)
    if (EXECUTORS.has(rel)) continue
    if (/\bcomputeOperationToolpath\s*\(/.test(code(readFileSync(file, 'utf8')))) offenders.push(rel)
  }
  if (offenders.length > 0) {
    throw new Error(
      `${offenders.join(', ')} calls generation directly. Go through the generation service `
      + 'so the work can run off the main thread and be cancelled.',
    )
  }
})

test('no application module calls a per-kind generator directly', () => {
  // The barrel exports every generator, so bypassing the dispatch is one import
  // away. Only the engine and the parity corpus may name these.
  const generators = /\bgenerate(Pocket|EdgeRoute|VCarve|VCarveMedial|SurfaceClean|RoughSurface|FinishSurface|FinishSurfaceCleanup|FollowLine|Drilling)Toolpath\s*\(/
  const offenders: string[] = []
  for (const file of files) {
    const rel = relative(SRC, file)
    if (EXECUTORS.has(rel)) continue
    if (generators.test(code(readFileSync(file, 'utf8')))) offenders.push(rel)
  }
  if (offenders.length > 0) {
    throw new Error(`${offenders.join(', ')} calls a generator directly, bypassing the dispatch`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
