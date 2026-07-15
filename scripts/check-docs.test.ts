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

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  extractMarkdownLinkTargets,
  normalizeLocalLinkTarget,
  parseFrontmatter,
  validateAgentEntrypoint,
  validateDocumentLinks,
  validatePlanningMetadata,
} from './docs-check-core'

function testFrontmatterParsing(): void {
  const metadata = parseFrontmatter(`---
status: current
authoritative-for: test contract
last-verified: 2026-07-15
---
# Test`)

  assert.deepEqual(metadata, {
    status: 'current',
    'authoritative-for': 'test contract',
    'last-verified': '2026-07-15',
  })
  assert.equal(parseFrontmatter('# No metadata'), null)
}

function testPlanningMetadataValidation(): void {
  const valid = `---
status: proposed
authoritative-for: toolbar interaction design
last-verified: 2026-07-15
---`
  assert.deepEqual(validatePlanningMetadata('planning/valid.md', valid), [])

  const invalid = `---
status: Backlog
authoritative-for:
last-verified: 2026-02-30
---`
  assert.deepEqual(
    validatePlanningMetadata('planning/invalid.md', invalid).map((problem) => problem.message),
    [
      'invalid planning status "Backlog"; use current or proposed',
      'missing planning metadata: authoritative-for',
      'last-verified is not a valid calendar date',
    ],
  )
}

function testMarkdownLinkExtractionAndNormalization(): void {
  const links = extractMarkdownLinkTargets(`
[local](../src/file.ts:42)
![image](<assets/image one.png>)
[web](https://example.com/page)
[reference]: ./reference.md#section
`)
  assert.deepEqual(links, [
    '../src/file.ts:42',
    '<assets/image one.png>',
    'https://example.com/page',
    './reference.md#section',
  ])
  assert.equal(normalizeLocalLinkTarget('../src/file.ts:42'), '../src/file.ts')
  assert.equal(normalizeLocalLinkTarget('<assets/image one.png> "title"'), 'assets/image one.png')
  assert.equal(normalizeLocalLinkTarget('https://example.com/page'), null)
  assert.equal(normalizeLocalLinkTarget('#section'), null)
}

function testDocumentLinkValidation(): void {
  const root = resolve('/repo')
  const document = resolve(root, 'planning', 'design.md')
  const existing = new Set([resolve(root, 'src', 'engine.ts')])
  const problems = validateDocumentLinks(
    document,
    '[good](../src/engine.ts:10) [bad](missing.md) [outside](../../secret.md) [absolute](/tmp/file.md)',
    root,
    (path) => existing.has(path),
  )

  assert.deepEqual(
    problems.map((problem) => problem.message),
    [
      'broken local link: missing.md',
      'link escapes repository: ../../secret.md',
      'non-portable absolute link: /tmp/file.md',
    ],
  )
}

function testAgentEntrypointValidation(): void {
  const valid = 'INDEX.md PROJECT.md AGENTS.md GitHub issue durable design'
  assert.deepEqual(validateAgentEntrypoint('CLAUDE.md', valid), [])
  assert.deepEqual(
    validateAgentEntrypoint('CLAUDE.md', 'INDEX.md').map((problem) => problem.message),
    [
      'agent entrypoint is missing PROJECT.md',
      'agent entrypoint is missing AGENTS.md',
      'agent entrypoint is missing GitHub issue',
      'agent entrypoint is missing durable design',
    ],
  )
}

testFrontmatterParsing()
testPlanningMetadataValidation()
testMarkdownLinkExtractionAndNormalization()
testDocumentLinkValidation()
testAgentEntrypointValidation()

console.log('docs-check tests: OK')
