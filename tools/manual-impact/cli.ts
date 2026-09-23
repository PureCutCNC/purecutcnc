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
 * Entry point for `.github/workflows/manual-impact.yml` (issue #818).
 *
 * Everything comes in through environment variables, never through the command
 * line: the PR body is untrusted text and must not pass through shell
 * interpolation on its way here.
 *
 *   check   PR_BODY → prints the verdict, writes `impact=true|false` to
 *           $GITHUB_OUTPUT, exits 1 when the section is missing or malformed.
 *   render  PR_JSON (a file holding the REST pull request object), REPOSITORY,
 *           OUT_DIR → refuses a PR that is not merged, then writes the docs issue
 *           to OUT_DIR/{title.txt,body.md,marker.txt} when the section declares
 *           impact, and `impact=true|false` to $GITHUB_OUTPUT; exits 1 when the
 *           section is missing or malformed.
 *
 * Usage: npx tsx tools/manual-impact/cli.ts check|render
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { END_MARKER, START_MARKER, parseManualImpact, renderDocsIssue, sourceMarker } from './manualImpact.ts'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`manual-impact: ${name} is not set`)
  return value
}

function writeOutput(key: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) appendFileSync(outputPath, `${key}=${value}\n`)
}

function fail(message: string): never {
  console.log(`::error title=Manual impact::${message}`)
  console.log(
    `Add a Manual impact section to the PR description between ${START_MARKER} and ${END_MARKER}: `
    + 'either `None`, or `Pages:` and `Changed:` fields. See .agents/skills/manual-impact/SKILL.md.',
  )
  process.exit(1)
}

/** The fields of GitHub's REST pull request object this tool reads. */
interface PullRequestJson {
  number: number
  title: string
  html_url: string
  body: string | null
  merged: boolean
  merge_commit_sha: string | null
}

function main(): void {
  const mode = process.argv[2]
  if (mode !== 'check' && mode !== 'render') {
    console.error('Usage: npx tsx tools/manual-impact/cli.ts check|render')
    process.exit(2)
  }

  const pr = mode === 'render'
    ? JSON.parse(readFileSync(requireEnv('PR_JSON'), 'utf8')) as PullRequestJson
    : null
  if (pr && (!pr.merged || !pr.merge_commit_sha)) {
    console.log(`::error title=Manual impact::#${pr.number} is not merged; the docs issue records what merged`)
    process.exit(1)
  }
  const body = pr ? pr.body ?? '' : process.env.PR_BODY ?? ''
  const impact = parseManualImpact(body)
  if (impact.kind === 'missing') fail('the PR description has no Manual impact section')
  if (impact.kind === 'malformed') fail(`the Manual impact section is malformed: ${impact.reason}`)

  writeOutput('impact', impact.kind === 'impact' ? 'true' : 'false')
  if (impact.kind === 'none') {
    console.log('Manual impact: none declared.')
    return
  }
  console.log(`Manual impact: ${impact.pages.join(', ')}`)
  if (mode === 'check') return

  if (!pr?.merge_commit_sha) return

  const repository = requireEnv('REPOSITORY')
  const issue = renderDocsIssue(
    { repository, number: pr.number, title: pr.title, url: pr.html_url, body, mergeCommitSha: pr.merge_commit_sha },
    impact,
  )
  const outDir = requireEnv('OUT_DIR')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'title.txt'), issue.title)
  writeFileSync(join(outDir, 'body.md'), issue.body)
  writeFileSync(join(outDir, 'marker.txt'), sourceMarker(repository, pr.number))
}

main()
