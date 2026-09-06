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
 * The worker's transitive import graph (issue #675).
 *
 * A worker has no `window`, no `document` and no React. Nothing in the graph
 * may need them at module scope, because that failure arrives as a worker that
 * dies on startup with a message pointing at a file nobody expected to be
 * involved — and it arrives at whichever user's browser first loads it, not in
 * CI.
 *
 * Checking the *graph* rather than the worker's own file is the point. The
 * engine's own sources are DOM-free, but a single convenience import through a
 * barrel is enough to drag the store singleton or a React module in behind
 * them, and nothing else in the build would notice.
 *
 * This is a static check: it follows relative imports from `toolpath.worker.ts`
 * and reports the first path that reaches something forbidden, so a violation
 * names the chain that introduced it rather than just the offender.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../..')
const ENTRY = resolve(HERE, 'toolpath.worker.ts')

/**
 * Forbidden *source* areas, by path prefix relative to `src/`. These own the
 * things a worker does not have: React components, the project store's module
 * singletons, and browser-only view code.
 */
const FORBIDDEN_PREFIXES = ['components/', 'app/'] as const

/** Modules within a forbidden area that are nonetheless safe, with the reason. */
const ALLOWED_EXCEPTIONS = new Map<string, string>([
  ['app/toolpathGeneration/toolpath.worker.ts', 'the entry point itself'],
  ['app/toolpathGeneration/protocol.ts', 'type-only at runtime; its helpers are pure predicates'],
  ['app/toolpathGeneration/types.ts', 'types only'],
])

/** Bare package specifiers a worker must never pull in. */
const FORBIDDEN_PACKAGES = ['react', 'react-dom', 'zustand', '@tauri-apps/api', '@tauri-apps/plugin-fs']

/**
 * Strip comments and string literals before scanning for imports, so a path
 * mentioned in prose — this file's own doc comments included — is not mistaken
 * for a dependency.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Static import/export specifiers, excluding `import type` (erased at build). */
function importsOf(source: string): string[] {
  const found: string[] = []
  const stripped = code(source)
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([\s\S]*?)from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stripped)) !== null) {
    // `import { type A, b }` still imports `b`; `import { type A }` does not,
    // but treating it as a runtime edge only ever over-reports, which is the
    // safe direction for a guard.
    found.push(match[2])
  }
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  while ((match = bare.exec(stripped)) !== null) found.push(match[1])
  return found
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        readFileSync(candidate, 'utf8')
        return candidate
      } catch { /* a directory — keep looking */ }
    }
  }
  return null
}

interface Walk {
  files: Set<string>
  packages: Map<string, string[]>
  chains: Map<string, string[]>
}

function walk(entry: string): Walk {
  const files = new Set<string>()
  const packages = new Map<string, string[]>()
  const chains = new Map<string, string[]>()
  const queue: { file: string; chain: string[] }[] = [{ file: entry, chain: [entry] }]

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!
    if (files.has(file)) continue
    files.add(file)
    chains.set(file, chain)

    const source = readFileSync(file, 'utf8')
    for (const specifier of importsOf(source)) {
      const resolved = resolveSpecifier(file, specifier)
      if (resolved) {
        if (!files.has(resolved)) queue.push({ file: resolved, chain: [...chain, resolved] })
      } else if (!specifier.startsWith('.') && !packages.has(specifier)) {
        packages.set(specifier, chain)
      }
    }
  }
  return { files, packages, chains }
}

function short(file: string): string {
  return relative(SRC, file)
}

console.log('\nWorker import graph')

const graph = walk(ENTRY)

test(`the graph resolves (${graph.files.size} modules, ${graph.packages.size} packages)`, () => {
  if (graph.files.size < 5) throw new Error('the walk found almost nothing — the parser is probably broken')
})

test('no React, store singleton or native-shell package is reachable', () => {
  for (const forbidden of FORBIDDEN_PACKAGES) {
    const chain = graph.packages.get(forbidden)
    if (chain) {
      throw new Error(`${forbidden} is reachable via ${chain.map(short).join(' → ')}`)
    }
  }
})

test('no component or app-layer module is reachable', () => {
  for (const file of graph.files) {
    const rel = short(file)
    if (ALLOWED_EXCEPTIONS.has(rel)) continue
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (rel.startsWith(prefix)) {
        throw new Error(`${rel} is reachable via ${(graph.chains.get(file) ?? []).map(short).join(' → ')}`)
      }
    }
  }
})

test('no module in the graph touches window, document or localStorage unguarded', () => {
  // `typeof window !== 'undefined'` is fine — that is the guard the imported-mesh
  // base64 helpers already use. An *unguarded* reference is what kills a worker.
  const offenders: string[] = []
  for (const file of graph.files) {
    const source = code(readFileSync(file, 'utf8'))
    const guarded = /typeof\s+(window|document|localStorage)\s*[!=]==?\s*['"]undefined['"]/.test(source)
    if (guarded) continue
    if (/(?<![.\w])(window|document|localStorage)\s*\./.test(source)) offenders.push(short(file))
  }
  if (offenders.length > 0) {
    throw new Error(`unguarded browser globals in: ${offenders.join(', ')}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
