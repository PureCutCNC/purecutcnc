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
 * Locale source-format guard (issue #506).
 *
 * Reviewing a locale change correctly means parsing key/value pairs and
 * comparing dictionaries, because a rendered diff can hide an invisible
 * character substitution — a worker once swapped one space for U+00A0 inside an
 * unrelated pre-existing French string and nobody could see it. Three drifts
 * made that review harder than it needed to be:
 *
 *   - `fr/*` packed hundreds of keys onto a handful of lines, so every French
 *     change rendered as a whole-line rewrite that hid its neighbours;
 *   - `es/*` used double quotes where every other locale used single, so a
 *     review parser written for single quotes returned zero keys from the
 *     Spanish files and reported them clean (issue #498);
 *   - non-ASCII whitespace sat in values as raw invisible bytes.
 *
 * The canonical form is one entry per line, single-quoted keys, single-quoted
 * values (double only to avoid escaping an apostrophe), a trailing comma, and
 * the same key order as the English catalog. Section comments and blank-line
 * grouping are preserved — they are the only structure these files have.
 *
 * Non-ASCII whitespace is **escaped, not banned**. French typography genuinely
 * needs U+00A0 before `;` `:` `!` `?` `»` and inside digit groups (500 000),
 * so a ban would fail the build on correct text. Written as a Unicode escape
 * the character keeps its runtime meaning but becomes visible, greppable and
 * reviewable: an accidental one now shows up in `git diff` as a changed escape
 * instead of nothing at all.
 *
 * (This file is linted by `no-irregular-whitespace`, the same idea one layer up,
 * so the characters above are named rather than pasted.)
 *
 * Parsing goes through the TypeScript AST rather than a regex, so the check
 * cannot be fooled by the quote style that fooled the #498 review parser.
 *
 * Usage:
 *   npx tsx scripts/check-i18n-format.ts          # verify (build gate)
 *   npx tsx scripts/check-i18n-format.ts --fix    # rewrite into canonical form
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dirname, '..')
const LOCALES_DIR = join(ROOT, 'src', 'i18n', 'locales')

/** The catalog every other locale is ordered and key-checked against. */
const REFERENCE_LOCALE = 'en'

/** Aggregator modules hold spreads, not message entries. */
const SKIPPED_MODULES = new Set(['index'])

const INDENT = '  '

/**
 * Whitespace and invisible formatting characters that must appear as escapes.
 * Ordinary non-ASCII text (é, ü, „ ", « », 中) is left literal — only
 * characters a reader cannot see are escaped.
 */
const INVISIBLE = new Set([
  0x0009, // tab
  0x00a0, // no-break space
  0x1680, // ogham space mark
  0x180e, // mongolian vowel separator
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, // en/em/thin/hair spaces
  0x200b, 0x200c, 0x200d, // zero-width space / non-joiner / joiner
  0x200e, 0x200f, // LTR/RTL marks
  0x2028, 0x2029, // line/paragraph separators
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embedding/override
  0x202f, // narrow no-break space
  0x205f, // medium mathematical space
  0x2060, // word joiner
  0x3000, // ideographic space
  0xfeff, // zero-width no-break space / BOM
])

interface Entry {
  key: string
  value: string
  /** Comment and blank lines that introduce this entry, already trimmed. */
  prefix: string[]
  /** Source text of the value literal, quotes included, as written. */
  raw: string
  line: number
}

interface ParsedFile {
  /** Everything up to and including the `… = {` line. */
  head: string
  entries: Entry[]
  /** Comment lines between the last entry and the closing brace. */
  tail: string[]
  /** Everything from the closing brace onward. */
  foot: string
  duplicates: string[]
  /** Non-entry members, which this format does not support. */
  unsupported: string[]
  /** Set when the module imports the English catalog as a value, not a type. */
  valueImport: string | null
}

class LocaleParseError extends Error {}

/** `'…'` unless the value has an apostrophe and no double quote. */
function chooseQuote(value: string): "'" | '"' {
  return value.includes("'") && !value.includes('"') ? '"' : "'"
}

function escapeValue(value: string, quote: "'" | '"'): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === '\\') out += '\\\\'
    else if (char === quote) out += '\\' + quote
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (INVISIBLE.has(code) || code < 0x20 || code === 0x7f) {
      out += '\\u' + code.toString(16).toUpperCase().padStart(4, '0')
    } else out += char
  }
  return out
}

function formatEntry(entry: Entry): string {
  const quote = chooseQuote(entry.value)
  return `${INDENT}'${entry.key}': ${quote}${escapeValue(entry.value, quote)}${quote},`
}

/**
 * Comment and blank lines sitting between the previous entry and this one.
 * Leading blanks are dropped, runs of blanks collapse to one, and comments are
 * re-indented; anything else in the trivia is whitespace and is discarded.
 */
function readPrefix(trivia: string): string[] {
  const lines = trivia.split('\n')
  // First segment is the tail of the previous entry's line, last is this
  // entry's indentation. Only what sits between them can carry comments.
  const middle = lines.slice(1, -1).map(line => line.trim())
  const prefix: string[] = []
  for (const line of middle) {
    if (line === '') {
      // A blank *leads* a section break (blank, then the section comment), so
      // it must survive here; `render` drops the one directly under the brace.
      if (prefix[prefix.length - 1] !== '') prefix.push('')
      continue
    }
    if (!line.startsWith('//')) {
      throw new LocaleParseError(`unsupported trivia between entries: ${line.slice(0, 60)}`)
    }
    prefix.push(line)
  }
  while (prefix.length > 0 && prefix[prefix.length - 1] === '') prefix.pop()
  return prefix
}

function parseFile(path: string): ParsedFile {
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

  let valueImport: string | null = null
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
    if (specifier.startsWith(`../${REFERENCE_LOCALE}`) && !statement.importClause?.isTypeOnly) {
      valueImport = specifier
    }
  }

  let objectLiteral: ts.ObjectLiteralExpression | null = null
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      let initializer = declaration.initializer
      while (
        initializer
        && (ts.isAsExpression(initializer)
          || ts.isSatisfiesExpression(initializer)
          || ts.isParenthesizedExpression(initializer))
      ) {
        initializer = initializer.expression
      }
      if (initializer && ts.isObjectLiteralExpression(initializer)) objectLiteral = initializer
    }
  }
  if (!objectLiteral) throw new LocaleParseError('no catalog object literal found')

  const entries: Entry[] = []
  const seen = new Set<string>()
  const duplicates: string[] = []
  const unsupported: string[] = []

  for (const property of objectLiteral.properties) {
    const line = source.getLineAndCharacterOfPosition(property.getStart()).line + 1
    if (!ts.isPropertyAssignment(property)) {
      unsupported.push(`line ${line}: ${ts.SyntaxKind[property.kind]}`)
      continue
    }
    const name = property.name
    if (!ts.isStringLiteral(name) && !ts.isIdentifier(name)) {
      unsupported.push(`line ${line}: computed or numeric key`)
      continue
    }
    const initializer = property.initializer
    if (!ts.isStringLiteral(initializer) && !ts.isNoSubstitutionTemplateLiteral(initializer)) {
      unsupported.push(`line ${line}: ${name.text} is not a string literal`)
      continue
    }
    if (seen.has(name.text)) duplicates.push(name.text)
    seen.add(name.text)
    entries.push({
      key: name.text,
      value: initializer.text,
      prefix: readPrefix(text.slice(property.getFullStart(), property.getStart())),
      raw: text.slice(initializer.getStart(), initializer.getEnd()),
      line,
    })
  }

  const openBrace = objectLiteral.getStart()
  const headEnd = text.indexOf('\n', openBrace)
  if (headEnd === -1) throw new LocaleParseError('catalog object is not multi-line')
  const head = text.slice(0, headEnd + 1)

  const closeBrace = objectLiteral.getEnd() - 1
  const foot = text.slice(closeBrace)

  // Comments after the final entry but before the closing brace.
  const lastEnd = objectLiteral.properties.length > 0
    ? objectLiteral.properties[objectLiteral.properties.length - 1].getEnd()
    : openBrace + 1
  const tail = text
    .slice(lastEnd, closeBrace)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('//'))

  return { head, entries, tail, foot, duplicates, unsupported, valueImport }
}

/** Render the canonical source for a file, with entries in `order`. */
function render(parsed: ParsedFile, order: string[]): string {
  const byKey = new Map(parsed.entries.map(entry => [entry.key, entry]))
  const lines: string[] = []
  for (const key of order) {
    const entry = byKey.get(key)
    if (!entry) continue
    for (const prefixLine of entry.prefix) {
      lines.push(prefixLine === '' ? '' : INDENT + prefixLine)
    }
    lines.push(formatEntry(entry))
  }
  for (const tailLine of parsed.tail) lines.push(INDENT + tailLine)
  // A leading blank directly under the opening brace is never meaningful.
  while (lines.length > 0 && lines[0] === '') lines.shift()
  return parsed.head + lines.join('\n') + '\n' + parsed.foot
}

/** `import { camEn }` → `import type { camEn }` for the reference catalog. */
function canonicalizeImport(text: string, specifier: string): string {
  const pattern = new RegExp(`^import \\{([^}]*)\\} from '${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'm')
  return text.replace(pattern, (_match, clause: string) => `import type {${clause}} from '${specifier}'`)
}

interface Problem {
  file: string
  message: string
}

function codepointLabel(char: string): string {
  return 'U+' + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * Report literal invisible characters with their codepoint and surrounding text.
 *
 * The generic "this line is not canonical" message is useless here: the whole
 * problem is that the character cannot be seen, so echoing the line back renders
 * it invisibly a second time and the reader concludes the line looks fine. Every
 * invisible character is replaced by its ⟪U+XXXX⟫ marker in the excerpt.
 */
function invisibleCharProblems(entry: Entry): string[] {
  const hits = [...entry.raw].filter(char => INVISIBLE.has(char.codePointAt(0)!))
  if (hits.length === 0) return []

  const marked = [...entry.raw]
    .map(char => (INVISIBLE.has(char.codePointAt(0)!) ? `⟪${codepointLabel(char)}⟫` : char))
    .join('')
  const names = [...new Set(hits.map(codepointLabel))].join(', ')

  return [
    `line ${entry.line}: '${entry.key}' contains ${hits.length} literal invisible character(s) (${names})`,
    `    ${marked.length > 160 ? marked.slice(0, 160) + '…' : marked}`,
    `    write them as escapes (e.g. \\u00A0) so they cannot hide in a diff`,
  ]
}

function localeDirs(): string[] {
  return readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

function moduleNames(locale: string): string[] {
  return readdirSync(join(LOCALES_DIR, locale))
    .filter(name => name.endsWith('.ts'))
    .map(name => name.replace(/\.ts$/, ''))
    .filter(name => !SKIPPED_MODULES.has(name))
    .sort()
}

function run(fix: boolean): number {
  const locales = localeDirs()
  if (!locales.includes(REFERENCE_LOCALE)) {
    console.error(`check-i18n-format: FAILED — no ${REFERENCE_LOCALE}/ reference locale`)
    return 1
  }

  const problems: Problem[] = []
  let fixedCount = 0

  // The reference locale defines both the key set and the key order.
  const referenceOrder = new Map<string, string[]>()
  for (const module of moduleNames(REFERENCE_LOCALE)) {
    const path = join(LOCALES_DIR, REFERENCE_LOCALE, `${module}.ts`)
    try {
      referenceOrder.set(module, parseFile(path).entries.map(entry => entry.key))
    } catch (error) {
      problems.push({
        file: relative(ROOT, path),
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const locale of locales) {
    const modules = moduleNames(locale)
    const referenceModules = moduleNames(REFERENCE_LOCALE)

    for (const module of referenceModules) {
      if (!modules.includes(module)) {
        problems.push({ file: `${locale}/${module}.ts`, message: 'module is missing from this locale' })
      }
    }

    for (const module of modules) {
      const rel = `src/i18n/locales/${locale}/${module}.ts`
      const path = join(LOCALES_DIR, locale, `${module}.ts`)
      const order = referenceOrder.get(module)
      if (!order) {
        problems.push({ file: rel, message: `no ${REFERENCE_LOCALE}/${module}.ts to order and key-check against` })
        continue
      }

      let parsed: ParsedFile
      try {
        parsed = parseFile(path)
      } catch (error) {
        problems.push({ file: rel, message: error instanceof Error ? error.message : String(error) })
        continue
      }

      for (const duplicate of parsed.duplicates) {
        problems.push({ file: rel, message: `duplicate key '${duplicate}'` })
      }
      for (const item of parsed.unsupported) {
        problems.push({ file: rel, message: `unsupported catalog member — ${item}` })
      }
      if (parsed.duplicates.length > 0 || parsed.unsupported.length > 0) continue

      const keys = parsed.entries.map(entry => entry.key)
      const missing = order.filter(key => !keys.includes(key))
      const extra = keys.filter(key => !order.includes(key))
      for (const key of missing.slice(0, 5)) {
        problems.push({ file: rel, message: `missing key '${key}' (present in ${REFERENCE_LOCALE}/${module}.ts)` })
      }
      if (missing.length > 5) problems.push({ file: rel, message: `… and ${missing.length - 5} more missing keys` })
      for (const key of extra.slice(0, 5)) {
        problems.push({ file: rel, message: `unknown key '${key}' (absent from ${REFERENCE_LOCALE}/${module}.ts)` })
      }
      if (extra.length > 5) problems.push({ file: rel, message: `… and ${extra.length - 5} more unknown keys` })
      if (missing.length > 0 || extra.length > 0) continue

      const original = readFileSync(path, 'utf8')
      let canonical = render(parsed, order)
      if (parsed.valueImport) {
        canonical = canonicalizeImport(canonical, parsed.valueImport)
      }

      if (canonical === original) continue

      if (fix) {
        writeFileSync(path, canonical, 'utf8')
        fixedCount++
        continue
      }

      // Name the specific drift so the failure is actionable, then fall back to
      // a generic message when the difference is only whitespace or ordering.
      const details: string[] = []
      if (parsed.valueImport) {
        details.push(`imports '${parsed.valueImport}' as a value; use \`import type\``)
      }
      // Report invisible characters first and by name — a line-based message
      // would print them invisibly and read as a false positive.
      for (const entry of parsed.entries) details.push(...invisibleCharProblems(entry))
      const firstOrderDiff = keys.findIndex((key, index) => key !== order[index])
      if (firstOrderDiff !== -1) {
        details.push(
          `key order differs from ${REFERENCE_LOCALE}/${module}.ts at index ${firstOrderDiff}`
          + ` (found '${keys[firstOrderDiff]}', expected '${order[firstOrderDiff]}')`,
        )
      }
      const canonicalLines = new Set(canonical.split('\n'))
      const offending = original
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.trim() !== '' && !canonicalLines.has(line))
        // Already reported by name above; echoing them here would print the
        // offending character invisibly.
        .filter(({ line }) => ![...line].some(char => INVISIBLE.has(char.codePointAt(0)!)))
      for (const { line, number } of offending.slice(0, 3)) {
        details.push(`line ${number}: ${line.trim().slice(0, 88)}`)
      }
      if (offending.length > 3) details.push(`… and ${offending.length - 3} more non-canonical lines`)
      if (details.length === 0) details.push('formatting differs from canonical form')
      for (const detail of details) problems.push({ file: rel, message: detail })
    }
  }

  if (fix) {
    console.log(`check-i18n-format: rewrote ${fixedCount} file(s) into canonical form`)
    if (problems.length === 0) return 0
  }

  if (problems.length === 0) {
    console.log('check-i18n-format: OK (locale catalogs share one canonical source format)')
    return 0
  }

  const byFile = new Map<string, string[]>()
  for (const problem of problems) {
    const list = byFile.get(problem.file) ?? []
    list.push(problem.message)
    byFile.set(problem.file, list)
  }

  console.error(`check-i18n-format: FAILED — ${problems.length} problem(s) in ${byFile.size} file(s)\n`)
  for (const [file, messages] of byFile) {
    console.error(`  ${file}`)
    for (const message of messages) console.error(`    ${message}`)
  }
  console.error(
    '\nCanonical form: one entry per line, \'key\': \'value\', trailing comma,'
    + `\n${REFERENCE_LOCALE} key order, \`import type\` for the ${REFERENCE_LOCALE} catalog, and`
    + '\nnon-ASCII whitespace written as \\uXXXX so it cannot hide in a diff.'
    + '\n\nRun: npm run check:i18n -- --fix',
  )
  return 1
}

process.exit(run(process.argv.includes('--fix')))
