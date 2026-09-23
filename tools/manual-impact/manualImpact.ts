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
 * The `Manual impact` section of a PR description (issue #818).
 *
 * The PR author writes it, because only the author knows whether a change is
 * visible in the user manual — a behaviour change can touch nothing but engine
 * code (#816). The merge workflow reads the section from the *final* PR body and
 * opens the docs-repo issue from it, so the issue records what actually merged,
 * not what the PR looked like when it was opened.
 *
 * The section sits between two marker comments:
 *
 *   <!-- manual-impact:start -->
 *   ### Manual impact
 *   Pages: guide/cam-setup/tabs, guide/operations/pocket
 *   Changed: automatic tabs now snap to feature edges
 *   Re-shoot: cam-setup/tabs/auto-tabs.png
 *   <!-- manual-impact:end -->
 *
 * or with the single line `None` in place of the three fields.
 */

export const START_MARKER = '<!-- manual-impact:start -->'
export const END_MARKER = '<!-- manual-impact:end -->'

export type ManualImpact =
  | { kind: 'missing' }
  | { kind: 'malformed'; reason: string }
  | { kind: 'none' }
  | { kind: 'impact'; pages: string[]; changed: string; reshoot: string[] }

type FieldName = 'pages' | 'changed' | 'reshoot'

const FIELD_PATTERN = /^(pages|changed|re-?shoot)\s*:\s*(.*)$/i
const HEADING_PATTERN = /^#{1,6}\s*manual impact\s*$/i
const NONE_PATTERN = /^none\.?$/i

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function fieldName(raw: string): FieldName {
  const lower = raw.toLowerCase()
  if (lower === 'pages') return 'pages'
  if (lower === 'changed') return 'changed'
  return 'reshoot'
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

export function parseManualImpact(body: string | null | undefined): ManualImpact {
  // GitHub stores an edited body with CRLF; trimming each line below drops the \r.
  const text = body ?? ''
  const starts = countOccurrences(text, START_MARKER)
  const ends = countOccurrences(text, END_MARKER)
  if (starts === 0 && ends === 0) return { kind: 'missing' }
  if (starts !== 1 || ends !== 1) {
    return { kind: 'malformed', reason: `expected one start and one end marker, found ${starts} and ${ends}` }
  }

  const startIndex = text.indexOf(START_MARKER)
  const endIndex = text.indexOf(END_MARKER)
  if (endIndex < startIndex) return { kind: 'malformed', reason: 'the end marker comes before the start marker' }

  const lines = text
    .slice(startIndex + START_MARKER.length, endIndex)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !HEADING_PATTERN.test(line))

  if (lines.length === 0) return { kind: 'malformed', reason: 'the section is empty; write `None` or the Pages and Changed fields' }
  if (lines.length === 1 && NONE_PATTERN.test(lines[0])) return { kind: 'none' }

  const fields: Record<FieldName, string[]> = { pages: [], changed: [], reshoot: [] }
  const seen = new Set<FieldName>()
  let current: FieldName | null = null
  for (const line of lines) {
    const match = FIELD_PATTERN.exec(line)
    if (match) {
      current = fieldName(match[1])
      if (seen.has(current)) return { kind: 'malformed', reason: `the ${match[1]} field appears twice` }
      seen.add(current)
      if (match[2].trim().length > 0) fields[current].push(match[2].trim())
      continue
    }
    if (NONE_PATTERN.test(line)) {
      return { kind: 'malformed', reason: '`None` must be the only line in the section' }
    }
    if (current === null) {
      return { kind: 'malformed', reason: `unexpected text before the first field: "${line}"` }
    }
    // A continuation line belongs to the field above it.
    fields[current].push(line)
  }

  const pages = fields.pages.flatMap(splitList)
  const changed = fields.changed.join('\n')
  if (pages.length === 0) return { kind: 'malformed', reason: 'the Pages field is missing or empty' }
  if (changed.length === 0) return { kind: 'malformed', reason: 'the Changed field is missing or empty' }
  return { kind: 'impact', pages, changed, reshoot: fields.reshoot.flatMap(splitList) }
}

export interface MergedPullRequest {
  repository: string
  number: number
  title: string
  url: string
  body: string
  mergeCommitSha: string
}

/** Hidden marker the workflow searches for, so a re-run never opens a second issue. */
export function sourceMarker(repository: string, number: number): string {
  return `<!-- manual-impact-source: ${repository}#${number} -->`
}

const CLOSING_KEYWORD_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi

export function closedIssueNumbers(body: string): number[] {
  const numbers = new Set<number>()
  for (const match of body.matchAll(CLOSING_KEYWORD_PATTERN)) numbers.add(Number(match[1]))
  return [...numbers]
}

export function renderDocsIssue(
  pr: MergedPullRequest,
  impact: Extract<ManualImpact, { kind: 'impact' }>,
): { title: string; body: string } {
  const shortSha = pr.mergeCommitSha.slice(0, 7)
  const issues = closedIssueNumbers(pr.body).map((number) => `${pr.repository}#${number}`)
  const lines = [
    sourceMarker(pr.repository, pr.number),
    `The app changed in a way the manual may show. Opened automatically when ${pr.repository}#${pr.number} merged.`,
    '',
    `- **PR:** ${pr.url} — ${pr.title}`,
    `- **Merge commit:** \`${pr.mergeCommitSha}\` (captures whose \`appCommit\` in \`media.json\` predates it show the old app)`,
  ]
  if (issues.length > 0) lines.push(`- **App issue:** ${issues.join(', ')}`)
  lines.push(
    '',
    '### Pages',
    ...impact.pages.map((page) => `- \`${page}\``),
    '',
    '### What changed',
    impact.changed,
  )
  if (impact.reshoot.length > 0) {
    lines.push('', '### Screenshots to re-shoot', ...impact.reshoot.map((shot) => `- \`${shot}\``))
  }
  lines.push('', `_Written by the PR author in the Manual impact section, as merged at ${shortSha}._`)
  // Qualified, because a bare `#N` in the docs repo means one of *its* issues.
  const repositoryName = pr.repository.split('/').pop() ?? pr.repository
  return { title: `App change: ${pr.title} (${repositoryName}#${pr.number})`, body: lines.join('\n') }
}
