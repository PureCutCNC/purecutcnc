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

export const AGENTS = ['dsh', 'claude-code', 'codex', 'opencode'] as const

export type Agent = typeof AGENTS[number]
export type EventKind = 'user' | 'assistant' | 'tool' | 'tool-result'

export interface TranscriptEvent {
  seq: number
  kind: EventKind
  text: string
}

export interface SessionCandidate {
  agent: Agent
  id: string
  path: string
  updatedAtMs: number
}

export interface SessionTranscript {
  candidate: SessionCandidate
  events: TranscriptEvent[]
  todos: string[]
}

export interface LedgerClaim {
  ts: string
  agent: Agent | 'unknown'
  session: string
  branch: string
  issue: number | null
  head: string
}

export interface ResumeConfig {
  stores: Record<Agent, string>
  worktreeBase: string
  branchIssuePattern: string
  maxToolCalls: number
  maxEventChars: number
}

export interface Adapter {
  agent: Agent
  locate(cwd: string, config: ResumeConfig): SessionCandidate[]
  read(candidate: SessionCandidate, config: ResumeConfig): SessionTranscript
}
