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

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export interface DocumentationProblem {
  file: string
  message: string
}

export interface Frontmatter {
  [key: string]: string
}

export const AGENT_ENTRYPOINTS = [
  'CLAUDE.md',
  'GEMINI.md',
  'CONVENTIONS.md',
  '.cursorrules',
  '.clinerules',
  '.clauderules',
  '.github/copilot-instructions.md',
] as const

const REQUIRED_AGENT_MARKERS = [
  'INDEX.md',
  'PROJECT.md',
  'AGENTS.md',
  'GitHub issue',
  'durable design',
] as const

const ALLOWED_PLANNING_STATUSES = new Set(['current', 'proposed'])
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const SOURCE_LINE_SUFFIX = /:\d+(?:-\d+)?(?:,\s*\d+)*$/

export function parseFrontmatter(content: string): Frontmatter | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') return null

  const closingIndex = lines.indexOf('---', 1)
  if (closingIndex < 0) return null

  const values: Frontmatter = {}
  for (const line of lines.slice(1, closingIndex)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const separatorIndex = line.indexOf(':')
    if (separatorIndex < 1) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    values[key] = value.replace(/^(['"])(.*)\1$/, '$2')
  }

  return values
}

export function extractMarkdownLinkTargets(content: string): string[] {
  const targets: string[] = []
  const inlineLink = /!?\[[^\]]*\]\(([^)\n]+)\)/g
  const referenceLink = /^\s*\[[^\]]+\]:\s*(\S+)/gm

  for (const match of content.matchAll(inlineLink)) {
    if (match[1]) targets.push(match[1])
  }
  for (const match of content.matchAll(referenceLink)) {
    if (match[1]) targets.push(match[1])
  }

  return targets
}

export function normalizeLocalLinkTarget(rawTarget: string): string | null {
  let target = rawTarget.trim()
  if (target.startsWith('<')) {
    const closingAngle = target.indexOf('>')
    if (closingAngle > 0) target = target.slice(1, closingAngle)
  } else {
    target = target.split(/\s+/u, 1)[0] ?? ''
  }

  if (target === '' || target.startsWith('#') || EXTERNAL_SCHEME.test(target)) {
    return null
  }

  const fragmentIndex = target.indexOf('#')
  if (fragmentIndex >= 0) target = target.slice(0, fragmentIndex)
  const queryIndex = target.indexOf('?')
  if (queryIndex >= 0) target = target.slice(0, queryIndex)
  if (target === '') return null

  try {
    target = decodeURIComponent(target)
  } catch {
    // Keep the original target so the missing-path error remains actionable.
  }

  return target.replace(SOURCE_LINE_SUFFIX, '')
}

export function validateDocumentLinks(
  filePath: string,
  content: string,
  repositoryRoot: string,
  pathExists: (path: string) => boolean = existsSync,
): DocumentationProblem[] {
  const problems: DocumentationProblem[] = []
  const checkedTargets = new Set<string>()

  for (const rawTarget of extractMarkdownLinkTargets(content)) {
    const target = normalizeLocalLinkTarget(rawTarget)
    if (target === null || checkedTargets.has(target)) continue
    checkedTargets.add(target)

    if (isAbsolute(target)) {
      problems.push({
        file: relative(repositoryRoot, filePath),
        message: `non-portable absolute link: ${target}`,
      })
      continue
    }

    const resolvedTarget = resolve(dirname(filePath), target)
    const repositoryRelative = relative(repositoryRoot, resolvedTarget)
    if (repositoryRelative.startsWith('..') || isAbsolute(repositoryRelative)) {
      problems.push({
        file: relative(repositoryRoot, filePath),
        message: `link escapes repository: ${target}`,
      })
      continue
    }

    if (!pathExists(resolvedTarget)) {
      problems.push({
        file: relative(repositoryRoot, filePath),
        message: `broken local link: ${target}`,
      })
    }
  }

  return problems
}

export function validatePlanningMetadata(
  file: string,
  content: string,
): DocumentationProblem[] {
  const metadata = parseFrontmatter(content)
  if (metadata === null) {
    return [{ file, message: 'missing planning frontmatter' }]
  }

  const problems: DocumentationProblem[] = []
  const status = metadata.status
  if (!status) {
    problems.push({ file, message: 'missing planning metadata: status' })
  } else if (!ALLOWED_PLANNING_STATUSES.has(status)) {
    problems.push({
      file,
      message: `invalid planning status "${status}"; use current or proposed`,
    })
  }

  const authority = metadata['authoritative-for']
  if (!authority || authority.includes('<')) {
    problems.push({ file, message: 'missing planning metadata: authoritative-for' })
  }

  const verified = metadata['last-verified']
  if (!verified || !/^\d{4}-\d{2}-\d{2}$/.test(verified)) {
    problems.push({
      file,
      message: 'last-verified must use YYYY-MM-DD',
    })
  } else {
    const parsedDate = new Date(`${verified}T00:00:00Z`)
    if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== verified) {
      problems.push({ file, message: 'last-verified is not a valid calendar date' })
    }
  }

  return problems
}

export function validateAgentEntrypoint(
  file: string,
  content: string,
): DocumentationProblem[] {
  return REQUIRED_AGENT_MARKERS
    .filter((marker) => !content.includes(marker))
    .map((marker) => ({ file, message: `agent entrypoint is missing ${marker}` }))
}
