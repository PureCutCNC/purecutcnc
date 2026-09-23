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
 * Manual impact section parser and docs-issue renderer (issue #818).
 *
 * The parser is what stands between a PR description and an issue opened in
 * another repository, so the malformed cases matter as much as the good ones:
 * a section that half-parses must fail the PR check, not open an issue with an
 * empty page list at merge.
 *
 * Run with: npx tsx tools/manual-impact/manualImpact.test.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  END_MARKER,
  START_MARKER,
  closedIssueNumbers,
  parseManualImpact,
  renderDocsIssue,
  sourceMarker,
} from './manualImpact.ts'

function section(...lines: string[]): string {
  return ['## Summary', 'Did a thing.', '', START_MARKER, ...lines, END_MARKER, '', 'Closes #816'].join('\n')
}

// ── Parsing: the accepted forms ───────────────────────────────────────

assert.deepEqual(parseManualImpact('## Summary\nNo section here.'), { kind: 'missing' })
assert.deepEqual(parseManualImpact(null), { kind: 'missing' })
assert.deepEqual(parseManualImpact(section('### Manual impact', 'None')), { kind: 'none' })
assert.deepEqual(parseManualImpact(section('none.')), { kind: 'none' }, 'None is case-insensitive and takes a full stop')
assert.deepEqual(
  parseManualImpact(section('### Manual impact', 'None').replace(/\n/g, '\r\n')),
  { kind: 'none' },
  'GitHub stores edited bodies with CRLF line endings',
)

assert.deepEqual(
  parseManualImpact(section(
    '### Manual impact',
    'Pages: guide/cam-setup/tabs, guide/operations/pocket ,',
    'Changed: automatic tabs now snap to feature edges',
    'instead of spacing evenly along the path',
    'Re-shoot: cam-setup/tabs/auto-tabs.png',
  )),
  {
    kind: 'impact',
    pages: ['guide/cam-setup/tabs', 'guide/operations/pocket'],
    changed: 'automatic tabs now snap to feature edges\ninstead of spacing evenly along the path',
    reshoot: ['cam-setup/tabs/auto-tabs.png'],
  },
  'a continuation line belongs to the field above it, and list fields drop empty entries',
)

assert.deepEqual(
  parseManualImpact(section('pages: guide/design/text', 'CHANGED: new option', 'Reshoot:')),
  { kind: 'impact', pages: ['guide/design/text'], changed: 'new option', reshoot: [] },
  'field names are case-insensitive and Re-shoot is optional',
)

assert.deepEqual(
  parseManualImpact(section('Pages:', 'guide/design/text', 'Changed: x')),
  { kind: 'impact', pages: ['guide/design/text'], changed: 'x', reshoot: [] },
  'a field may start on the line after its name',
)

// ── Parsing: every malformed form fails, and says why ─────────────────

function assertMalformed(body: string, reasonPattern: RegExp, label: string): void {
  const result = parseManualImpact(body)
  assert.equal(result.kind, 'malformed', `${label}: expected malformed, got ${result.kind}`)
  if (result.kind === 'malformed') assert.match(result.reason, reasonPattern, label)
}

assertMalformed(`${START_MARKER}\nNone`, /one start and one end/, 'unterminated section')
assertMalformed(`${section('None')}\n${section('None')}`, /one start and one end/, 'two sections')
assertMalformed(`${END_MARKER}\nNone\n${START_MARKER}`, /before the start/, 'markers reversed')
assertMalformed(section('### Manual impact'), /empty/, 'heading only')
assertMalformed(section('None', 'Pages: guide/design/text', 'Changed: x'), /only line/, 'None mixed with fields')
assertMalformed(section('Pages: a', 'Changed: x', 'Pages: b'), /appears twice/, 'duplicate field')
assertMalformed(section('Some prose', 'Pages: a', 'Changed: x'), /before the first field/, 'prose before a field')
assertMalformed(section('Changed: x'), /Pages/, 'no Pages')
assertMalformed(section('Pages: , ,', 'Changed: x'), /Pages/, 'Pages with only separators')
assertMalformed(section('Pages: a'), /Changed/, 'no Changed')
assertMalformed(section('Pages: a', 'Changed:'), /Changed/, 'empty Changed')

// ── Closing references ───────────────────────────────────────────────

assert.deepEqual(closedIssueNumbers('Closes #818. Fixes #12, resolved #7; see #99'), [818, 12, 7])
assert.deepEqual(closedIssueNumbers('Closes #818 and closes #818'), [818], 'duplicates collapse')

// ── The docs issue ───────────────────────────────────────────────────

const mergedBody = section('Pages: guide/cam-setup/tabs', 'Changed: tabs snap to edges', 'Re-shoot: cam-setup/tabs/auto-tabs.png')
const impact = parseManualImpact(mergedBody)
assert.equal(impact.kind, 'impact')
if (impact.kind === 'impact') {
  const issue = renderDocsIssue(
    {
      repository: 'PureCutCNC/purecutcnc',
      number: 816,
      title: 'Anchor automatic tabs to feature edges',
      url: 'https://github.com/PureCutCNC/purecutcnc/pull/816',
      body: mergedBody,
      mergeCommitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    impact,
  )
  assert.equal(
    issue.title,
    'App change: Anchor automatic tabs to feature edges (purecutcnc#816)',
    'the title qualifies the number: a bare #816 would mean an issue in the docs repo',
  )
  assert.ok(issue.body.startsWith(sourceMarker('PureCutCNC/purecutcnc', 816)), 'the idempotency marker leads the body')
  assert.match(issue.body, /`0123456789abcdef0123456789abcdef01234567`/, 'the full merge SHA, to compare against appCommit')
  assert.match(issue.body, /https:\/\/github\.com\/PureCutCNC\/purecutcnc\/pull\/816/)
  assert.match(issue.body, /\*\*App issue:\*\* PureCutCNC\/purecutcnc#816/)
  assert.match(issue.body, /### Pages\n- `guide\/cam-setup\/tabs`/)
  assert.match(issue.body, /### What changed\ntabs snap to edges/)
  assert.match(issue.body, /### Screenshots to re-shoot\n- `cam-setup\/tabs\/auto-tabs\.png`/)

  const withoutReshoot = renderDocsIssue(
    { repository: 'o/r', number: 1, title: 't', url: 'u', body: '', mergeCommitSha: 'abc' },
    { ...impact, reshoot: [] },
  )
  assert.doesNotMatch(withoutReshoot.body, /re-shoot/i, 'no empty re-shoot heading')
  assert.doesNotMatch(withoutReshoot.body, /App issue/, 'no app-issue line when the PR closes nothing')
}

// ── The CLI the workflow calls ───────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
const scratch = mkdtempSync(join(tmpdir(), 'manual-impact-test-'))

function runCli(mode: string, env: Record<string, string>): { status: number | null; stdout: string; output: string } {
  const outputFile = join(scratch, `github-output-${mode}-${Math.random().toString(36).slice(2)}`)
  const result = spawnSync(process.execPath, [tsxCli, join(here, 'cli.ts'), mode], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: outputFile, ...env },
  })
  let output = ''
  try { output = readFileSync(outputFile, 'utf8') } catch { /* nothing written */ }
  return { status: result.status, stdout: result.stdout, output }
}

try {
  const missing = runCli('check', { PR_BODY: 'no section' })
  assert.equal(missing.status, 1, 'a missing section fails the check')
  assert.match(missing.stdout, /::error title=Manual impact::/)

  const malformed = runCli('check', { PR_BODY: section('Pages: a') })
  assert.equal(malformed.status, 1, 'a malformed section fails the check')

  const none = runCli('check', { PR_BODY: section('None') })
  assert.equal(none.status, 0)
  assert.equal(none.output, 'impact=false\n')

  const declared = runCli('check', { PR_BODY: mergedBody })
  assert.equal(declared.status, 0)
  assert.equal(declared.output, 'impact=true\n')

  const pullRequest = {
    number: 816,
    title: 'Anchor automatic tabs to feature edges',
    html_url: 'https://github.com/PureCutCNC/purecutcnc/pull/816',
    body: mergedBody,
    merged: true,
    merge_commit_sha: 'abc1234',
  }
  function render(pr: object, outDir: string): ReturnType<typeof runCli> {
    const prJson = join(scratch, `pr-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(prJson, JSON.stringify(pr))
    return runCli('render', { PR_JSON: prJson, REPOSITORY: 'PureCutCNC/purecutcnc', OUT_DIR: outDir })
  }

  const unmerged = render({ ...pullRequest, merged: false, merge_commit_sha: null }, join(scratch, 'unmerged'))
  assert.equal(unmerged.status, 1, 'an unmerged PR never produces a docs issue')
  assert.match(unmerged.stdout, /not merged/)

  const noneMerged = render({ ...pullRequest, body: section('None') }, join(scratch, 'none'))
  assert.equal(noneMerged.status, 0)
  assert.equal(noneMerged.output, 'impact=false\n')
  assert.throws(() => readFileSync(join(scratch, 'none', 'title.txt')), 'a None section writes no issue')

  const outDir = join(scratch, 'issue')
  const rendered = render(pullRequest, outDir)
  assert.equal(rendered.status, 0, rendered.stdout)
  assert.equal(rendered.output, 'impact=true\n')
  assert.equal(readFileSync(join(outDir, 'title.txt'), 'utf8'), 'App change: Anchor automatic tabs to feature edges (purecutcnc#816)')
  assert.equal(readFileSync(join(outDir, 'marker.txt'), 'utf8'), sourceMarker('PureCutCNC/purecutcnc', 816))
  assert.match(readFileSync(join(outDir, 'body.md'), 'utf8'), /`abc1234`/)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('manual-impact: all assertions passed')
