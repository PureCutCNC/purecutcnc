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

import type { TranscriptEvent } from './types.ts'

export function oneLine(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  const normalized = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}

export function textParts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part]
    if (!isRecord(part)) return []
    if (typeof part.text === 'string') return [part.text]
    if (typeof part.content === 'string') return [part.content]
    return []
  })
}

export function normalizeEvents(events: TranscriptEvent[], maxChars: number): TranscriptEvent[] {
  return events
    .map((event) => ({ ...event, text: oneLine(event.text, maxChars) }))
    .filter((event) => event.text.length > 0)
    .sort((left, right) => left.seq - right.seq)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
