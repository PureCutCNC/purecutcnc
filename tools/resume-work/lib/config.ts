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

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { isRecord } from './text.ts'
import type { Agent, ResumeConfig } from './types.ts'

const DEFAULT_STORES: Record<Agent, string> = {
  dsh: '~/.dsh/sessions',
  'claude-code': '~/.claude/projects',
  codex: '~/.codex/sessions',
  opencode: '~/.local/share/opencode',
}

const DEFAULT_CONFIG: ResumeConfig = {
  stores: DEFAULT_STORES,
  worktreeBase: '~/Projects/worktrees',
  branchIssuePattern: 'issue-(\\d+)',
  maxToolCalls: 20,
  maxEventChars: 480,
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
}

export function loadConfig(toolDirectory: string): ResumeConfig {
  const configPath = resolve(toolDirectory, 'config.json')
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`resume-work: cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error(`resume-work: ${configPath} must contain a JSON object`)

  const stores = { ...DEFAULT_CONFIG.stores }
  if (isRecord(parsed.stores)) {
    for (const agent of Object.keys(stores) as Agent[]) {
      if (typeof parsed.stores[agent] === 'string') stores[agent] = parsed.stores[agent]
    }
  }
  const branchIssuePattern = typeof parsed.branchIssuePattern === 'string'
    ? parsed.branchIssuePattern
    : DEFAULT_CONFIG.branchIssuePattern
  try {
    new RegExp(branchIssuePattern)
  } catch {
    throw new Error(`resume-work: branchIssuePattern is not a valid regular expression`)
  }
  return {
    stores,
    worktreeBase: typeof parsed.worktreeBase === 'string' ? parsed.worktreeBase : DEFAULT_CONFIG.worktreeBase,
    branchIssuePattern,
    maxToolCalls: positiveInteger(parsed.maxToolCalls, DEFAULT_CONFIG.maxToolCalls),
    maxEventChars: positiveInteger(parsed.maxEventChars, DEFAULT_CONFIG.maxEventChars),
  }
}
