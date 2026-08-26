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

import { execFileSync } from 'node:child_process'

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export interface GitState {
  branch: string
  head: string
  status: string
  diffStat: string
}

export function readGitState(cwd: string): GitState {
  const branch = git(cwd, ['branch', '--show-current']) || '(detached)'
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']) || '(unknown)'
  const mergeBase = git(cwd, ['merge-base', 'origin/main', 'HEAD'])
  return {
    branch,
    head,
    status: git(cwd, ['status', '--short']),
    diffStat: mergeBase === '' ? '' : git(cwd, ['diff', '--stat', mergeBase]),
  }
}

export function issueFromBranch(branch: string, pattern: string): number | null {
  const match = new RegExp(pattern).exec(branch)
  return match === null ? null : Number.parseInt(match[1], 10)
}
