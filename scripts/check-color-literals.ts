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
 * Colour-literal guard (issue #341).
 *
 * The theme system only works if UI code reads tokens instead of repeating
 * colour values. This check fails the build when a colour literal appears
 * outside the places that are allowed to define one, so the partial-adoption
 * problem that motivated #341 cannot silently return.
 *
 * Allowed to contain literals:
 *   - the built-in theme definitions (`src/index.css`, `src/theme/*`);
 *   - the print/export palette (document output is deliberately
 *     theme-independent — printed paper has no dark mode);
 *   - any line marked `theme-exempt: <reason>` (developer-only diagnostics).
 *
 * Everything else must use `var(--token)` in CSS or a palette field in TS.
 *
 * Usage: npx tsx scripts/check-color-literals.ts [--list]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

/** Files permitted to define raw colour values. */
const ALLOWED_FILES = new Set([
  'src/index.css',
  'src/theme/palette.ts',
  'src/theme/registry.ts',
  'src/engine/designPrint/printPalette.ts',
])

/** Per-line opt-out marker for developer-only diagnostics. */
const EXEMPT_MARKER = 'theme-exempt'

/**
 * Colour literals. 3-digit hex must contain a letter so issue references
 * such as `#341` are not mistaken for colours.
 */
const COLOR_PATTERNS: readonly RegExp[] = [
  /#[0-9a-fA-F]{8}\b/g,
  /#[0-9a-fA-F]{6}\b/g,
  /#(?=[0-9]*[a-fA-F])[0-9a-fA-F]{3}\b/g,
  /\brgba?\(\s*[0-9.]+\s*,/g,
  /\b0x[0-9a-fA-F]{6}\b/g,
]

interface Violation {
  file: string
  line: number
  text: string
  literal: string
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (/\.(ts|tsx|css)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function findLiterals(line: string): string[] {
  const found: string[] = []
  for (const pattern of COLOR_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of line.matchAll(pattern)) found.push(match[0])
  }
  return found
}

function collectViolations(): Violation[] {
  const violations: Violation[] = []
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file)
    if (ALLOWED_FILES.has(rel)) continue

    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (line.includes(EXEMPT_MARKER)) return
      // A block can be exempted by marking the line above it.
      if (index > 0 && lines[index - 1].includes(EXEMPT_MARKER)) return
      for (const literal of findLiterals(line)) {
        violations.push({ file: rel, line: index + 1, text: line.trim(), literal })
      }
    })
  }
  return violations
}

const violations = collectViolations()

if (violations.length === 0) {
  console.log('check-color-literals: OK (no colour literals outside the theme and print palettes)')
  process.exit(0)
}

const byFile = new Map<string, Violation[]>()
for (const violation of violations) {
  const list = byFile.get(violation.file) ?? []
  list.push(violation)
  byFile.set(violation.file, list)
}

console.error(`check-color-literals: FAILED — ${violations.length} colour literal(s) outside the allowed files\n`)
for (const [file, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  ${file} (${list.length})`)
  for (const violation of list.slice(0, 8)) {
    console.error(`    ${violation.line}: ${violation.literal}  —  ${violation.text.slice(0, 90)}`)
  }
  if (list.length > 8) console.error(`    … ${list.length - 8} more`)
}
console.error(
  '\nUse a theme token instead: var(--token) in CSS, or a palette field in TS.'
  + `\nFor developer-only diagnostics, mark the line with "${EXEMPT_MARKER}: <reason>".`,
)
process.exit(1)
