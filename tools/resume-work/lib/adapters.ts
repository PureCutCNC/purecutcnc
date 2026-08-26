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

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import { expandHome } from './config.ts'
import { isRecord, normalizeEvents, oneLine, textParts } from './text.ts'
import type { Adapter, Agent, ResumeConfig, SessionCandidate, SessionTranscript, TranscriptEvent } from './types.ts'

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024
const MAX_SESSION_META_BYTES = 64 * 1024

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void }
  exec(sql: string): void
  close(): void
}

let _DatabaseSync: DatabaseSyncCtor | null | undefined
function getDatabaseSync(): DatabaseSyncCtor | null {
  if (_DatabaseSync === undefined) {
    try {
      const require = createRequire(import.meta.url)
      _DatabaseSync = require('node:sqlite').DatabaseSync as DatabaseSyncCtor
    } catch {
      _DatabaseSync = null
    }
  }
  return _DatabaseSync
}

type ZstdDecompressSync = (data: Uint8Array, options?: { maxOutputLength?: number }) => Uint8Array

let _zstdDecompressSync: ZstdDecompressSync | null | undefined
function getZstdDecompressSync(): ZstdDecompressSync | null {
  if (_zstdDecompressSync === undefined) {
    try {
      const require = createRequire(import.meta.url)
      const zlib = require('node:zlib') as { zstdDecompressSync?: ZstdDecompressSync }
      _zstdDecompressSync = zlib.zstdDecompressSync ?? null
    } catch {
      _zstdDecompressSync = null
    }
  }
  return _zstdDecompressSync
}

function safeStat(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function candidatesFromFiles(agent: Agent, paths: string[]): SessionCandidate[] {
  return paths.map((path) => ({
    agent,
    id: basename(path, extname(path)),
    path,
    updatedAtMs: safeStat(path),
  })).sort((left, right) => right.updatedAtMs - left.updatedAtMs)
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return []
    try {
      const value: unknown = JSON.parse(line)
      return isRecord(value) ? [value] : []
    } catch {
      return []
    }
  })
}

function readTranscriptText(path: string): string {
  const size = statSync(path).size
  if (!path.endsWith('.zstd')) {
    if (size <= MAX_TRANSCRIPT_BYTES) return readFileSync(path, 'utf8')
    const descriptor = openSync(path, 'r')
    try {
      const bytes = Buffer.alloc(MAX_TRANSCRIPT_BYTES)
      readSync(descriptor, bytes, 0, bytes.length, size - bytes.length)
      return bytes.toString('utf8')
    } finally {
      closeSync(descriptor)
    }
  }
  if (size > MAX_TRANSCRIPT_BYTES) throw new Error(`resume-work: compressed transcript exceeds ${MAX_TRANSCRIPT_BYTES} byte safety limit: ${path}`)
  const bytes = readFileSync(path)
  const cli = spawnSync('zstd', ['-q', '-dc', path], { encoding: 'buffer', maxBuffer: MAX_TRANSCRIPT_BYTES })
  if (cli.error === undefined && cli.status === 0) return cli.stdout.toString('utf8')
  const zstdDecompressSync = getZstdDecompressSync()
  if (zstdDecompressSync === null) throw new Error(`resume-work: cannot decompress ${path}: zstd is unavailable`)
  try {
    return Buffer.from(zstdDecompressSync(bytes, { maxOutputLength: MAX_TRANSCRIPT_BYTES })).toString('utf8')
  } catch (error) {
    throw new Error(`resume-work: cannot decompress ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readFirstLine(path: string): string {
  const descriptor = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(MAX_SESSION_META_BYTES)
    const read = readSync(descriptor, bytes, 0, bytes.length, 0)
    return bytes.subarray(0, read).toString('utf8').split('\n', 1)[0]
  } finally {
    closeSync(descriptor)
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return textParts(value).join(' ')
  return textParts(value.content ?? value.text).join(' ')
}

function messageContent(record: Record<string, unknown>): unknown {
  const data = isRecord(record.data) ? record.data : record
  const message = isRecord(data.message) ? data.message : data
  return message.content ?? message.text
}

function dshEvents(records: Record<string, unknown>[], maxChars: number): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const seq = typeof record.seq === 'number' ? record.seq : index + 1
    const data = isRecord(record.data) ? record.data : {}
    if (record.type === 'user/message') {
      const source = isRecord(data.source) ? data.source : null
      if (source !== null && source.kind !== 'user') continue
      events.push({ seq, kind: 'user', text: contentText(messageContent(record)) })
    } else if (record.type === 'assistant/message') {
      events.push({ seq, kind: 'assistant', text: contentText(messageContent(record)) })
    } else if (record.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : 'unknown'
      events.push({ seq, kind: 'tool', text: `${name} ${oneLine(data.arguments ?? '', maxChars)}` })
    } else if (record.type === 'tool/result') {
      events.push({ seq, kind: 'tool-result', text: contentText(messageContent(record)) })
    }
  }
  return normalizeEvents(events, maxChars)
}

function claudeEvents(records: Record<string, unknown>[], maxChars: number): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const message = isRecord(record.message) ? record.message : {}
    const content = message.content
    const seq = index + 1
    if (record.type === 'user') {
      const blocks = Array.isArray(content) ? content : []
      const toolResults = blocks.filter((block) => isRecord(block) && block.type === 'tool_result')
      if (toolResults.length > 0) {
        for (const block of toolResults) events.push({ seq, kind: 'tool-result', text: contentText(block) })
      } else {
        events.push({ seq, kind: 'user', text: contentText(content) })
      }
    } else if (record.type === 'assistant') {
      for (const block of Array.isArray(content) ? content : [content]) {
        if (!isRecord(block)) continue
        if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'unknown'
          events.push({ seq, kind: 'tool', text: `${name} ${oneLine(block.input ?? '', maxChars)}` })
        } else {
          events.push({ seq, kind: 'assistant', text: contentText(block) })
        }
      }
    }
  }
  return normalizeEvents(events, maxChars)
}

function codexEvents(records: Record<string, unknown>[], maxChars: number): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const payload = isRecord(record.payload) ? record.payload : {}
    const seq = index + 1
    if (record.type === 'event_msg' && payload.type === 'user_message') {
      events.push({ seq, kind: 'user', text: contentText(payload.message) })
    } else if (record.type === 'event_msg' && payload.type === 'agent_message') {
      events.push({ seq, kind: 'assistant', text: contentText(payload.message) })
    } else if (record.type === 'response_item' && payload.type === 'message') {
      const role = payload.role
      if (role === 'user') events.push({ seq, kind: 'user', text: contentText(payload.content) })
      if (role === 'assistant') events.push({ seq, kind: 'assistant', text: contentText(payload.content) })
    } else if (record.type === 'response_item' && payload.type === 'function_call') {
      const name = typeof payload.name === 'string' ? payload.name : 'unknown'
      events.push({ seq, kind: 'tool', text: `${name} ${oneLine(payload.arguments ?? '', maxChars)}` })
    } else if (record.type === 'response_item' && payload.type === 'function_call_output') {
      events.push({ seq, kind: 'tool-result', text: contentText(payload.output) })
    }
  }
  return normalizeEvents(events, maxChars)
}

interface OpenCodePartRow {
  partData: string
  messageData: string
}

function openCodeEvents(rows: OpenCodePartRow[], maxChars: number): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (let index = 0; index < rows.length; index += 1) {
    let data: unknown
    let message: unknown
    try {
      data = JSON.parse(rows[index].partData) as unknown
      message = JSON.parse(rows[index].messageData) as unknown
    } catch {
      continue
    }
    if (!isRecord(data)) continue
    const role = isRecord(message) && message.role === 'user' ? 'user' : 'assistant'
    const seq = index + 1
    if (data.type === 'tool' || data.type === 'tool_call') {
      const name = typeof data.name === 'string' ? data.name : 'unknown'
      events.push({ seq, kind: 'tool', text: `${name} ${oneLine(data.input ?? data.arguments ?? '', maxChars)}` })
    } else if (data.type === 'tool_result') {
      events.push({ seq, kind: 'tool-result', text: contentText(data) })
    } else if (data.type === 'text' || typeof data.text === 'string') {
      events.push({ seq, kind: role, text: contentText(data) })
    }
  }
  return normalizeEvents(events, maxChars)
}

function findJsonlFiles(root: string, depth: number): string[] {
  if (depth < 0 || !existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return findJsonlFiles(path, depth - 1)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  })
}

const dshAdapter: Adapter = {
  agent: 'dsh',
  locate(cwd, config) {
    const encoded = `--${resolve(cwd).slice(1).replaceAll('/', '-')}--`
    const root = join(expandHome(config.stores.dsh), encoded)
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true }).flatMap<SessionCandidate>((entry) => {
      if (!entry.isDirectory()) return []
      const path = join(root, entry.name, 'session.jsonl.zstd')
      return existsSync(path) ? [{ agent: 'dsh' as const, id: entry.name, path, updatedAtMs: safeStat(path) }] : []
    }).sort((left, right) => right.updatedAtMs - left.updatedAtMs)
  },
  read(candidate, config) {
    return { candidate, events: dshEvents(jsonLines(readTranscriptText(candidate.path)), config.maxEventChars), todos: [] }
  },
}

const claudeAdapter: Adapter = {
  agent: 'claude-code',
  locate(cwd, config) {
    const encoded = `-${resolve(cwd).slice(1).replaceAll('/', '-')}`
    const root = join(expandHome(config.stores['claude-code']), encoded)
    if (!existsSync(root)) return []
    return candidatesFromFiles('claude-code', readdirSync(root)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(root, name)))
  },
  read(candidate, config) {
    return { candidate, events: claudeEvents(jsonLines(readTranscriptText(candidate.path)), config.maxEventChars), todos: [] }
  },
}

const codexAdapter: Adapter = {
  agent: 'codex',
  locate(cwd, config) {
    return findJsonlFiles(expandHome(config.stores.codex), 3).flatMap((path) => {
      try {
        const first = readFirstLine(path)
        const record: unknown = JSON.parse(first)
        if (!isRecord(record)) return []
        const payload = isRecord(record.payload) ? record.payload : {}
        if (record.type !== 'session_meta' || payload.cwd !== resolve(cwd)) return []
        return [{
          agent: 'codex' as const,
          id: typeof payload.id === 'string' ? payload.id : basename(path, '.jsonl'),
          path,
          updatedAtMs: safeStat(path),
        }]
      } catch {
        return []
      }
    }).sort((left, right) => right.updatedAtMs - left.updatedAtMs)
  },
  read(candidate, config) {
    return { candidate, events: codexEvents(jsonLines(readTranscriptText(candidate.path)), config.maxEventChars), todos: [] }
  },
}

const openCodeAdapter: Adapter = {
  agent: 'opencode',
  locate(cwd, config) {
    const DatabaseSync = getDatabaseSync()
    if (!DatabaseSync) return []
    const path = join(expandHome(config.stores.opencode), 'opencode.db')
    if (!existsSync(path)) return []
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = database.prepare(`
        SELECT DISTINCT session.id AS id, session.time_updated AS updated
        FROM session
        JOIN project ON project.id = session.project_id
        LEFT JOIN project_directory ON project_directory.project_id = project.id
        WHERE project.worktree = ? OR session.directory = ? OR project_directory.directory = ?
      `).all(resolve(cwd), resolve(cwd), resolve(cwd)) as { id: string, updated: number }[]
      return rows.map((row) => ({ agent: 'opencode' as const, id: row.id, path, updatedAtMs: Number(row.updated) || 0 }))
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    } finally {
      database.close()
    }
  },
  read(candidate, config) {
    const DatabaseSync = getDatabaseSync()
    if (!DatabaseSync) throw new Error('resume-work: opencode adapter requires node:sqlite (Node >= 22.5)')
    const database = new DatabaseSync(candidate.path, { readOnly: true })
    try {
      const parts = database.prepare(`
        SELECT part.data AS partData, message.data AS messageData
        FROM part
        JOIN message ON message.id = part.message_id
        WHERE part.session_id = ?
        ORDER BY part.time_created, part.id
      `).all(candidate.id) as unknown as OpenCodePartRow[]
      const todos = database.prepare("SELECT content FROM todo WHERE session_id = ? AND status != 'completed' ORDER BY position")
        .all(candidate.id) as { content: string }[]
      return { candidate, events: openCodeEvents(parts, config.maxEventChars), todos: todos.map((todo) => todo.content) }
    } finally {
      database.close()
    }
  },
}

export const ADAPTERS: Record<Agent, Adapter> = {
  dsh: dshAdapter,
  'claude-code': claudeAdapter,
  codex: codexAdapter,
  opencode: openCodeAdapter,
}

export function formatCommonEvents(events: TranscriptEvent[]): string[] {
  return events.map((event) => `${event.seq}\t${event.kind}\t${event.text}`)
}

export function locateSessions(cwd: string, config: ResumeConfig): SessionCandidate[] {
  return Object.values(ADAPTERS).flatMap((adapter) => adapter.locate(cwd, config))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
}

export function readSession(candidate: SessionCandidate, config: ResumeConfig): SessionTranscript {
  return ADAPTERS[candidate.agent].read(candidate, config)
}
