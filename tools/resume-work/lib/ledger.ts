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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from './text.ts'
import type { Agent, LedgerClaim } from './types.ts'

const LEDGER_DIRECTORY = '.handoff'
const LEDGER_FILE = 'ledger.jsonl'

function validAgent(value: unknown): value is Agent | 'unknown' {
  return value === 'dsh' || value === 'claude-code' || value === 'codex' || value === 'opencode' || value === 'unknown'
}

function parseClaim(line: string): LedgerClaim | null {
  try {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value)
      || typeof value.ts !== 'string'
      || !validAgent(value.agent)
      || typeof value.session !== 'string'
      || typeof value.branch !== 'string'
      || (typeof value.issue !== 'number' && value.issue !== null)
      || typeof value.head !== 'string') return null
    return {
      ts: value.ts,
      agent: value.agent,
      session: value.session,
      branch: value.branch,
      issue: value.issue,
      head: value.head,
    }
  } catch {
    return null
  }
}

export function ledgerPath(cwd: string): string {
  return join(cwd, LEDGER_DIRECTORY, LEDGER_FILE)
}

export function readLedger(cwd: string): LedgerClaim[] {
  const path = ledgerPath(cwd)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    const claim = parseClaim(line)
    return claim === null ? [] : [claim]
  })
}

export function appendClaim(cwd: string, claim: LedgerClaim): void {
  mkdirSync(join(cwd, LEDGER_DIRECTORY), { recursive: true })
  appendFileSync(ledgerPath(cwd), `${JSON.stringify(claim)}\n`, 'utf8')
}

export function detectCycle(claims: LedgerClaim[]): LedgerClaim[] | null {
  if (claims.length < 3) return null
  const [first, second, third] = claims.slice(-3)
  return first.agent === third.agent && first.head === second.head && second.head === third.head
    ? [first, second, third]
    : null
}
