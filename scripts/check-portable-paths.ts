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
 * Portable-path guard (issue #655).
 *
 * The only Windows CI in the repo is the manually-dispatched desktop build, so
 * Windows-incompatible path code used to surface at release time instead of
 * PR time. Four such failures landed in one week (issues #647, #649, #651,
 * #652), all from a small set of POSIX-only patterns:
 *
 *   - a hardcoded absolute path (`'/tmp/...'`) — Node on Windows resolves it
 *     to a drive-root `\tmp` that does not exist (#649);
 *   - path surgery on a `path` API result (`resolve(cwd).slice(1)`) — assumes
 *     a leading `/` and no drive letter (#651);
 *   - replacing `/` as the only separator (`replaceAll('/', '-')`) — Windows
 *     paths use `\` and carry a drive prefix (#651).
 *
 * This check runs inside `npm run build`, so it fires on every developer
 * machine and every CI OS on every build, not only when the Windows desktop
 * job is dispatched. It scans source for those three static signatures; the
 * runtime-only Windows differences (e.g. `process.cpuUsage()` millisecond
 * rounding, #652) are out of scope for a static scan.
 *
 * Scope: `src/`, `tools/`, `scripts/` — everything that runs under the build,
 * the test suite, or CI on all platforms. Deliberately POSIX-only paths in a
 * dev-only diagnostic are marked with `portable-exempt: <reason>` on the line
 * above or the line itself, mirroring `theme-exempt` in check-color-literals.
 *
 * Usage: npx tsx scripts/check-portable-paths.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'tools', 'scripts']

/** Per-line opt-out marker for deliberately POSIX-only code. */
const EXEMPT_MARKER = 'portable-exempt'

/**
 * Class A — a string or template literal that opens a POSIX-only absolute
 * root. Matches `'/tmp/...'`, `'/usr/...'`, and so on, at the start of the
 * literal (quote, `/`, root, `/` or end of literal).
 */
const POSIX_ROOT = /['"`]\/(?:tmp|usr|var|dev|etc|bin|opt|srv|home)(?:\/|['"`])/

/**
 * Class B1 — a `path` API result sliced as if it had a leading `/` and no
 * drive letter. `join` is included with the rest: in this codebase the path
 * `join` is imported bare from `node:path`, and an array `join(...)` chained
 * straight to `.slice(` is not a shape that appears.
 */
const PATH_SLICE = /\b(?:resolve|join|dirname|basename|extname|normalize)\([^)\n]*\)\s*\.slice\(/

/**
 * Class B2 — `/`-only separator surgery on a line that names a path. The
 * variable guard keeps URL-ish and unrelated replacements out.
 */
const SEPARATOR_REPLACE = /replaceAll\(\s*['"]\/['"]|replace\(\s*\/\\\//
const PATH_NAMED = /\b(?:cwd|dir|root|path|file|worktree)\w*\b/i

interface Violation {
  file: string
  line: number
  text: string
  message: string
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

function classify(line: string): string | null {
  const classA = line.match(POSIX_ROOT)
  if (classA) {
    return `hardcoded POSIX-only path '${classA[0].replace(/^['"`]/, '')}' — Node on Windows resolves it to a `
      + 'drive-root path that does not exist; use os.tmpdir(), an environment variable, or a project-relative path'
  }
  if (PATH_SLICE.test(line)) {
    return 'path surgery: slicing the result of a path API assumes POSIX drive layout — '
      + 'handle both separators and the drive prefix explicitly'
  }
  if (SEPARATOR_REPLACE.test(line) && PATH_NAMED.test(line)) {
    return "replacing '/' as the only separator is POSIX-only — use a regex such as /[\\\\/]/ to match both separators"
  }
  return null
}

function collectViolations(): Violation[] {
  const violations: Violation[] = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      if (file.endsWith('check-portable-paths.ts')) continue
      const rel = relative(ROOT, file).replaceAll('\\', '/')
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (line.includes(EXEMPT_MARKER)) return
        // A block can be exempted by marking the line above it.
        if (index > 0 && lines[index - 1].includes(EXEMPT_MARKER)) return
        const message = classify(line)
        if (message) violations.push({ file: rel, line: index + 1, text: line.trim(), message })
      })
    }
  }
  return violations
}

const violations = collectViolations()

if (violations.length === 0) {
  console.log('check-portable-paths: OK (no POSIX-only path patterns in src/, tools/, scripts/)')
  process.exit(0)
}

const byFile = new Map<string, Violation[]>()
for (const violation of violations) {
  const list = byFile.get(violation.file) ?? []
  list.push(violation)
  byFile.set(violation.file, list)
}

console.error(`check-portable-paths: FAILED — ${violations.length} POSIX-only path pattern(s)\n`)
for (const [file, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  ${file} (${list.length})`)
  for (const violation of list.slice(0, 8)) {
    console.error(`    ${violation.line}: ${violation.message}`)
    console.error(`      ${violation.text.slice(0, 90)}`)
  }
  if (list.length > 8) console.error(`    … ${list.length - 8} more`)
}
console.error(
  '\nWrite paths so they work on Windows (os.tmpdir(), both separators, no drive-layout assumptions).'
  + `\nFor deliberately POSIX-only code, mark the line with "${EXEMPT_MARKER}: <reason>".`,
)
process.exit(1)
