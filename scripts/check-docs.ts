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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_ENTRYPOINTS,
  type DocumentationProblem,
  validateAgentEntrypoint,
  validateDocumentLinks,
  validatePlanningMetadata,
} from './docs-check-core'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RECURSIVE_DOC_ROOTS = ['src', 'scripts', 'e2e', '.github'] as const

function collectMarkdownFiles(directory: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      collectMarkdownFiles(fullPath, output)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      output.push(fullPath)
    }
  }
}

function collectActiveDocuments(): string[] {
  const documents = readdirSync(REPOSITORY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(REPOSITORY_ROOT, entry.name))

  const planningRoot = join(REPOSITORY_ROOT, 'planning')
  documents.push(
    ...readdirSync(planningRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => join(planningRoot, entry.name)),
  )

  for (const root of RECURSIVE_DOC_ROOTS) {
    collectMarkdownFiles(join(REPOSITORY_ROOT, root), documents)
  }

  return [...new Set(documents)].sort()
}

function main(): void {
  const documents = collectActiveDocuments()
  const problems: DocumentationProblem[] = []

  for (const document of documents) {
    const content = readFileSync(document, 'utf8')
    problems.push(...validateDocumentLinks(document, content, REPOSITORY_ROOT))
  }

  const planningDocuments = documents.filter((document) => {
    return dirname(document) === join(REPOSITORY_ROOT, 'planning')
      && document !== join(REPOSITORY_ROOT, 'planning', 'INDEX.md')
  })
  for (const document of planningDocuments) {
    const file = relative(REPOSITORY_ROOT, document)
    problems.push(...validatePlanningMetadata(file, readFileSync(document, 'utf8')))
  }

  for (const file of AGENT_ENTRYPOINTS) {
    const path = join(REPOSITORY_ROOT, file)
    problems.push(...validateAgentEntrypoint(file, readFileSync(path, 'utf8')))
  }

  problems.sort((left, right) => {
    return left.file.localeCompare(right.file) || left.message.localeCompare(right.message)
  })

  if (problems.length > 0) {
    console.error(`docs-check: FAIL — ${problems.length} problem(s)`)
    for (const problem of problems) {
      console.error(`  ${problem.file}: ${problem.message}`)
    }
    process.exitCode = 1
    return
  }

  console.log(
    `docs-check: OK (${documents.length} active docs, ${planningDocuments.length} planning references, ${AGENT_ENTRYPOINTS.length} agent entrypoints)`,
  )
}

main()
