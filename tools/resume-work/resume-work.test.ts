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
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADAPTERS, formatCommonEvents, locateSessions, sessionDirSlug } from './lib/adapters.ts'
import { appendClaim, detectCycle, readLedger } from './lib/ledger.ts'
import { runResumeWork } from './run.ts'
import type { ResumeConfig, SessionCandidate } from './lib/types.ts'

let DatabaseSync: (new (path: string, options?: { readOnly?: boolean }) => {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void }
  exec(sql: string): void
  close(): void
}) | null = null
let hasSqlite = false
let zstdCompressSync: ((data: Uint8Array) => Buffer) | null = null
try {
  const require = createRequire(import.meta.url)
  DatabaseSync = require('node:sqlite').DatabaseSync
  hasSqlite = true
} catch { /* node:sqlite unavailable (Node < 22.5) */ }

try {
  const require = createRequire(import.meta.url)
  const zlib = require('node:zlib') as { zstdCompressSync?: (data: Uint8Array) => Buffer }
  zstdCompressSync = zlib.zstdCompressSync ?? null
} catch { /* Zstandard compression unavailable */ }

const hasZstdCli = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const projectRoot = resolve(here, '../..')
// os.tmpdir() rather than a hardcoded /tmp: POSIX-only, and Node on Windows (portable-exempt: comment explains the pre-#649 bug)
// resolves `/tmp` to a drive-root `\tmp` that does not exist (ENOENT).
const root = mkdtempSync(join(tmpdir(), 'resume-work-test-'))
const cwd = join(root, 'worktree')
mkdirSync(cwd)

const config: ResumeConfig = {
  stores: {
    dsh: join(root, 'dsh'),
    'claude-code': join(root, 'claude'),
    codex: join(root, 'codex'),
    opencode: join(root, 'opencode'),
  },
  worktreeBase: join(root, 'worktrees'),
  branchIssuePattern: 'issue-(\\d+)',
  maxToolCalls: 20,
  maxEventChars: 200,
}

function candidate(agent: SessionCandidate['agent'], path: string): SessionCandidate {
  return { agent, id: `${agent}-fixture`, path, updatedAtMs: 0 }
}

try {
  const codexSkill = readFileSync(join(projectRoot, '.agents/skills/resume-work/SKILL.md'), 'utf8')
  const claudeSkill = readFileSync(join(projectRoot, '.claude/skills/resume-work/SKILL.md'), 'utf8')
  const openCodeCommand = readFileSync(join(projectRoot, '.opencode/command/resume-work.md'), 'utf8')
  for (const entryPoint of [codexSkill, claudeSkill, openCodeCommand]) {
    assert.match(entryPoint, /npx tsx tools\/resume-work\/run\.ts/)
  }
  assert.match(codexSkill, /\$resume-work/)
  assert.match(claudeSkill, /name: resume-work/)
  assert.match(openCodeCommand, /description:/)

  const dsh = ADAPTERS.dsh.read(candidate('dsh', join(fixtures, 'dsh.jsonl')), config)
  assert.deepEqual(formatCommonEvents(dsh.events), [
    '1\tuser\tKeep the emitted path fail-closed.',
    '2\tassistant\tI will inspect the existing guard.',
    '3\ttool\texec_command {"cmd":"npm test"}',
    '4\ttool-result\ttests passed',
  ])

  const dshWithInjectedContext = join(root, 'dsh-with-injected-context.jsonl')
  writeFileSync(dshWithInjectedContext, [
    JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the actual user intent.' }] } }),
    JSON.stringify({ type: 'user/message', seq: 2, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'Ignore injected instruction context.' }] } }),
  ].join('\n'))
  const filteredDsh = ADAPTERS.dsh.read(candidate('dsh', dshWithInjectedContext), config)
  assert.deepEqual(formatCommonEvents(filteredDsh.events), ['1\tuser\tKeep the actual user intent.'])

  if (zstdCompressSync !== null && hasZstdCli) {
    const concatenated = join(root, 'dsh-concatenated.jsonl.zstd')
    const session = JSON.stringify({ type: 'session', version: 0 }) + '\n'
    const user = JSON.stringify({
      type: 'user/message',
      seq: 2,
      data: { content: [{ type: 'text', text: 'Continue the handoff.' }] },
    }) + '\n'
    writeFileSync(concatenated, Buffer.concat([zstdCompressSync(Buffer.from(session)), zstdCompressSync(Buffer.from(user))]))
    const concatenatedDsh = ADAPTERS.dsh.read(candidate('dsh', concatenated), config)
    assert.deepEqual(formatCommonEvents(concatenatedDsh.events), ['2\tuser\tContinue the handoff.'])
  }

  const claude = ADAPTERS['claude-code'].read(candidate('claude-code', join(fixtures, 'claude-code.jsonl')), config)
  assert.deepEqual(formatCommonEvents(claude.events), [
    '1\tuser\tDo not reopen the approved design.',
    '2\tassistant\tImplementing the agreed path.',
    '2\ttool\tRead {"file_path":"AGENTS.md"}',
    '3\ttool-result\tagent instructions loaded',
  ])

  const codex = ADAPTERS.codex.read(candidate('codex', join(fixtures, 'codex.jsonl')), config)
  assert.deepEqual(formatCommonEvents(codex.events), [
    '2\tuser\tRun the focused test before build.',
    '3\tassistant\tI will run the narrow test.',
    '4\ttool\texec_command {"cmd":"npm test"}',
    '5\ttool-result\ttests passed',
  ])

  if (hasSqlite && DatabaseSync) {
    const openCodePath = join(root, 'opencode-fixture.db')
    const database = new DatabaseSync(openCodePath)
    database.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)')
    database.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
    database.exec('CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, position INTEGER)')
    const openCodeFixture = JSON.parse(readFileSync(join(fixtures, 'opencode.json'), 'utf8')) as {
      parts: { id: string, time: number, data: Record<string, unknown> }[]
      todos: string[]
    }
    for (const part of openCodeFixture.parts) {
      const messageId = `message-${part.id}`
      const role = part.data.role === 'user' ? 'user' : 'assistant'
      database.prepare('INSERT INTO message VALUES (?, ?, ?)').run(messageId, 'opencode-fixture', JSON.stringify({ role }))
      database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(part.id, messageId, 'opencode-fixture', part.time, JSON.stringify(part.data))
    }
    for (const [position, content] of openCodeFixture.todos.entries()) {
      database.prepare('INSERT INTO todo VALUES (?, ?, ?, ?)').run('opencode-fixture', content, 'pending', position)
    }
    database.close()
    const openCode = ADAPTERS.opencode.read({ agent: 'opencode', id: 'opencode-fixture', path: openCodePath, updatedAtMs: 0 }, config)
    assert.deepEqual(formatCommonEvents(openCode.events), [
      '1\tuser\tUse the issue as the plan.',
      '2\ttool\tRead {"file":"AGENTS.md"}',
    ])
    assert.deepEqual(openCode.todos, ['Run build'])
  }

  const dshArtifact = join(config.stores.dsh, `--${sessionDirSlug(cwd)}--`, 'session-fixture')
  mkdirSync(dshArtifact, { recursive: true })
  cpSync(join(fixtures, 'dsh.jsonl'), join(dshArtifact, 'session.jsonl.zstd'))
  const claudeDirectory = join(config.stores['claude-code'], `-${sessionDirSlug(cwd)}`)
  mkdirSync(claudeDirectory, { recursive: true })
  cpSync(join(fixtures, 'claude-code.jsonl'), join(claudeDirectory, 'claude-fixture.jsonl'))
  const codexDirectory = join(config.stores.codex, '2026', '08', '26')
  mkdirSync(codexDirectory, { recursive: true })
  writeFileSync(join(codexDirectory, 'rollout-fixture.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-locator', cwd } })}\n`)
  writeFileSync(join(codexDirectory, 'rollout-corrupt.jsonl'), 'not json\n')
  const expectedAgents = new Set(['dsh', 'claude-code', 'codex'])
  if (hasSqlite && DatabaseSync) {
    mkdirSync(config.stores.opencode, { recursive: true })
    const locatorDatabase = new DatabaseSync(join(config.stores.opencode, 'opencode.db'))
    locatorDatabase.exec('CREATE TABLE project (id TEXT, worktree TEXT)')
    locatorDatabase.exec('CREATE TABLE project_directory (project_id TEXT, directory TEXT)')
    locatorDatabase.exec('CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, time_updated INTEGER)')
    locatorDatabase.prepare('INSERT INTO project VALUES (?, ?)').run('project', cwd)
    locatorDatabase.prepare('INSERT INTO project_directory VALUES (?, ?)').run('project', cwd)
    locatorDatabase.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('opencode-locator', 'project', cwd, 1)
    locatorDatabase.close()
    expectedAgents.add('opencode')
  }
  const located = locateSessions(cwd, config)
  assert.deepEqual(new Set(located.map((session) => session.agent)), expectedAgents)

  appendClaim(cwd, { ts: '2026-08-26T12:00:00Z', agent: 'dsh', session: 'a', branch: 'feat/issue-640-handoff', issue: 640, head: '(unknown)' })
  appendClaim(cwd, { ts: '2026-08-26T12:01:00Z', agent: 'codex', session: 'b', branch: 'feat/issue-640-handoff', issue: 640, head: '(unknown)' })
  appendClaim(cwd, { ts: '2026-08-26T12:02:00Z', agent: 'dsh', session: 'c', branch: 'feat/issue-640-handoff', issue: 640, head: '(unknown)' })
  const ledger = readLedger(cwd)
  assert.equal(detectCycle(ledger)?.map((claim) => claim.agent).join('→'), 'dsh→codex→dsh')
  assert.equal(detectCycle([
    { ts: '2026-08-26T12:03:00Z', agent: 'unknown', session: 'x', branch: 'branch', issue: null, head: 'head' },
    { ts: '2026-08-26T12:04:00Z', agent: 'unknown', session: 'y', branch: 'branch', issue: null, head: 'head' },
    { ts: '2026-08-26T12:05:00Z', agent: 'unknown', session: 'z', branch: 'branch', issue: null, head: 'head' },
  ]), null)

  const briefing = runResumeWork({ cwd, env: { CODEX_THREAD_ID: 'codex-locator' }, config }, ['--from', 'codex'])
  assert.match(briefing, /Previous session: codex \/ codex-locator/)
  assert.match(briefing, /--from codex overrides the ledger/)
  assert.match(briefing, /## User intent: none captured\./)
  assert.match(briefing, /handoff loop without a commit/i)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('resume-work tests passed')
