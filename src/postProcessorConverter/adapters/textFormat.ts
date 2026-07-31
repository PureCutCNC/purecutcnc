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
 * Small text-scanning primitives shared by the declarative adapters
 * (Visual Mill, Vectric/Estlcam, ArtCAM). Each vendor format is a distinct
 * grammar of `KEY = value` assignments and `[TOKEN]`-style template
 * placeholders; these helpers cover the parts that are genuinely identical
 * across all three, not a universal parser.
 */

/** Normalizes CRLF/CR line endings to LF. Vendor post files are frequently
 *  Windows-authored, and every block/line regex in these adapters assumes `\n`. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export interface Assignment {
  key: string
  /** Quotes stripped, `[13][10]`-style escapes left as-is for the caller. */
  value: string
  line: number
}

/** Removes any line whose first non-whitespace character starts `commentPrefix`. */
export function stripLineComments(text: string, commentPrefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.trimStart().startsWith(commentPrefix) ? '' : line))
    .join('\n')
}

const ASSIGNMENT_LINE = /^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/

/**
 * Parses `KEY = value` / `KEY = "value"` lines. Returns every match in
 * source order — callers decide whether a repeated key builds an array
 * (ArtCAM's repeated `START =`) or whether only the last write wins.
 * 1-indexed `line` matches the source file for report locations.
 */
export function parseAssignments(text: string): Assignment[] {
  const assignments: Assignment[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = ASSIGNMENT_LINE.exec(lines[i].trim())
    if (!match) {
      continue
    }
    const [, key, rawValue] = match
    const trimmed = rawValue.trim()
    const unquoted =
      trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1)
        : trimmed
    assignments.push({ key, value: unquoted, line: i + 1 })
  }
  return assignments
}

/**
 * Returns the first non-empty literal fragment in a single-line template —
 * the bare G/M-code word a motion-command template wraps around its
 * placeholders, e.g. `"G2[X][Y][Z] R[Radius]"` -> `"G2"`. Splits on every
 * `[TOKEN]` and takes the first non-blank piece, which handles both a
 * leading structural token before the command word (`"[N]G00[X][Y]"` -> the
 * empty fragment before `[N]`'s match is skipped, landing on `"G00"`) and a
 * register letter written literally *between* tokens (that trailing ` R`
 * before `[Radius]` is source syntax, not part of the command word, and
 * isn't the first fragment so it's never picked up). Deliberately distinct
 * from stripping every bracket (below), which is for "does this line
 * contain X anywhere" scans, not "what is this line's leading command word".
 */
export function leadingLiteral(line: string): string {
  for (const fragment of line.split(/\[[A-Za-z0-9_]+\]/)) {
    const trimmed = fragment.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/** Finds every `[TOKEN]` placeholder in a template string, in order, with duplicates. */
export function extractBracketTokens(template: string): string[] {
  const tokens: string[] = []
  const pattern = /\[([A-Za-z0-9_]+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(template)) !== null) {
    tokens.push(match[1])
  }
  return tokens
}

export interface TokenTranslation {
  text: string
  /** Source tokens found in the template that had no entry in the token map. */
  unmapped: string[]
}

/**
 * Rewrites `[SRC_TOKEN]` placeholders into PureCutCNC's `{targetToken}` form
 * using `tokenMap`. A token mapped to `''` is dropped (its brackets removed)
 * — used for source tokens with no PureCutCNC equivalent that are safe to
 * omit (e.g. a delimiter marker). Tokens absent from `tokenMap` are left as
 * literal bracket text and also reported back via `unmapped` so the caller
 * can raise a finding rather than silently emit the source's own syntax.
 */
export function translateTokens(template: string, tokenMap: Record<string, string>): TokenTranslation {
  const unmapped: string[] = []
  const text = template.replace(/\[([A-Za-z0-9_]+)\]/g, (whole, token: string) => {
    if (!(token in tokenMap)) {
      unmapped.push(token)
      return whole
    }
    const replacement = tokenMap[token]
    return replacement === '' ? '' : `{${replacement}}`
  })
  return { text, unmapped: [...new Set(unmapped)] }
}
