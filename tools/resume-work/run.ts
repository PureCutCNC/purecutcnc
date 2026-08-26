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

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENTS, type Agent, type LedgerClaim, type ResumeConfig, type SessionCandidate, type SessionTranscript } from './lib/types.ts'
import { expandHome, loadConfig } from './lib/config.ts'
import { detectCycle, appendClaim, readLedger } from './lib/ledger.ts'
import { issueFromBranch, readGitState } from './lib/git.ts'
import { locateSessions, readSession } from './lib/adapters.ts'

interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  config: ResumeConfig
}

interface ParsedArguments {
  from: Agent | null
}

function usage(): string {
  return 'Usage: npx tsx tools/resume-work/run.ts [--from dsh|claude-code|codex|opencode]'
}

function parseArguments(args: string[]): ParsedArguments {
  if (args.length === 0) return { from: null }
  if (args.length === 2 && args[0] === '--from' && (AGENTS as readonly string[]).includes(args[1])) {
    return { from: args[1] as Agent }
  }
  throw new Error(usage())
}

function agentFromEnvironment(env: NodeJS.ProcessEnv): Agent | null {
  if (env.DSH_SESSION_ID !== undefined) return 'dsh'
  if (env.CLAUDE_SESSION_ID !== undefined || env.CLAUDECODE !== undefined) return 'claude-code'
  if (env.CODEX_THREAD_ID !== undefined || env.CODEX_SESSION_ID !== undefined) return 'codex'
  if (env.OPENCODE_SESSION_ID !== undefined) return 'opencode'
  return null
}

function candidateForIncomingAgent(candidates: SessionCandidate[], env: NodeJS.ProcessEnv): SessionCandidate | null {
  const agent = agentFromEnvironment(env)
  if (agent === null) return candidates[0] ?? null
  const requestedId = agent === 'dsh' ? env.DSH_SESSION_ID
    : agent === 'claude-code' ? env.CLAUDE_SESSION_ID
      : agent === 'codex' ? env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID
        : env.OPENCODE_SESSION_ID
  return candidates.find((candidate) => candidate.agent === agent && candidate.id === requestedId)
    ?? candidates.find((candidate) => candidate.agent === agent)
    ?? null
}

function previousCandidate(claim: LedgerClaim | undefined, candidates: SessionCandidate[]): SessionCandidate | null {
  if (claim === undefined || claim.agent === 'unknown') return null
  return candidates.find((candidate) => candidate.agent === claim.agent && candidate.id === claim.session) ?? null
}

function renderEvents(title: string, events: SessionTranscript['events']): string[] {
  if (events.length === 0) return [`${title}: none captured.`]
  return [title, ...events.map((event) => `- ${event.text}`)]
}

function renderBriefing(
  claims: LedgerClaim[],
  previous: Pick<LedgerClaim, 'agent' | 'session'> | undefined,
  transcript: SessionTranscript | null,
  gitState: ReturnType<typeof readGitState>,
  fallback: boolean,
  override: Agent | null,
  config: ResumeConfig,
  cwd: string,
): string {
  const lines = ['# Resume briefing', '']
  if (previous === undefined) {
    lines.push('Previous session: no ledger predecessor; using the latest matching transcript as a documented first-run fallback.')
  } else {
    lines.push(`Previous session: ${previous.agent} / ${previous.session}`)
  }
  if (override !== null) lines.push(`Attribution note: --from ${override} overrides the ledger for this briefing.`)
  if (fallback) lines.push('Attribution note: the selected transcript came from the first-run fallback, not file modification time in a ledger chain.')
  lines.push('', '## Handoff chain')
  lines.push(...(claims.length === 0 ? ['- none'] : claims.map((claim) => `- ${claim.agent} / ${claim.session} @ ${claim.head}`)))
  const cycle = detectCycle(claims)
  if (cycle !== null) {
    lines.push('', `Warning: handoff loop without a commit: ${cycle.map((claim) => claim.agent).join(' → ')} at ${cycle[0].head}.`)
  }
  const worktreeBase = resolve(expandHome(config.worktreeBase))
  lines.push('', '## Worktree', `- CWD: ${cwd}`, `- Configured base: ${worktreeBase}`)
  if (!resolve(cwd).startsWith(`${worktreeBase}/`)) {
    lines.push('- Note: this worktree is outside the configured base; transcript lookup still uses its exact CWD.')
  }
  if (transcript !== null) {
    const users = transcript.events.filter((event) => event.kind === 'user')
    const assistant = transcript.events.filter((event) => event.kind === 'assistant').slice(-6)
    const tools = transcript.events.filter((event) => event.kind === 'tool').slice(-config.maxToolCalls)
    lines.push('', ...renderEvents('## User intent', users), '', ...renderEvents('## Recent assistant context', assistant), '', ...renderEvents('## Last tool calls', tools))
    if (transcript.todos.length > 0) lines.push('', '## OpenCode todo list', ...transcript.todos.map((todo) => `- ${todo}`))
  } else {
    lines.push('', 'Transcript: the selected predecessor artifact is unavailable; inspect the ledger session id manually.')
  }
  lines.push('', '## Git state', `- Branch: ${gitState.branch}`, `- HEAD: ${gitState.head}`)
  lines.push(`- Status: ${gitState.status === '' ? 'clean' : gitState.status.replaceAll('\n', '; ')}`)
  lines.push(`- Diff stat vs merge-base: ${gitState.diffStat === '' ? 'none' : gitState.diffStat.replaceAll('\n', '; ')}`)
  return `${lines.join('\n')}\n`
}

export function runResumeWork(options: RunOptions, args: string[]): string {
  const parsed = parseArguments(args)
  const candidates = locateSessions(options.cwd, options.config)
  const incoming = candidateForIncomingAgent(candidates, options.env)
  const gitState = readGitState(options.cwd)
  appendClaim(options.cwd, {
    ts: new Date().toISOString(),
    agent: incoming?.agent ?? 'unknown',
    session: incoming?.id ?? 'unresolved',
    branch: gitState.branch,
    issue: issueFromBranch(gitState.branch, options.config.branchIssuePattern),
    head: gitState.head,
  })

  const claims = readLedger(options.cwd)
  const ledgerPrevious = claims.at(-2)
  const requested = parsed.from === null
    ? previousCandidate(ledgerPrevious, candidates)
    : candidates.find((candidate) => candidate.agent === parsed.from) ?? null
  const fallback = requested === null
  const selected = requested ?? candidates.find((candidate) => candidate !== incoming) ?? candidates[0] ?? null
  const transcript = selected === null ? null : readSession(selected, options.config)
  const attributed = parsed.from === null || selected === null
    ? ledgerPrevious
    : { ...ledgerPrevious, agent: selected.agent, session: selected.id }
  return renderBriefing(claims, attributed, transcript, gitState, fallback, parsed.from, options.config, options.cwd)
}

function main(): void {
  const toolDirectory = dirname(fileURLToPath(import.meta.url))
  const config = loadConfig(toolDirectory)
  process.stdout.write(runResumeWork({ cwd: process.cwd(), env: process.env, config }, process.argv.slice(2)))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
