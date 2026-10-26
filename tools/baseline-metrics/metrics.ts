/**
 * Copyright 2026 Maik Rolf
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
 * Pure metric helpers for the WP0 baseline. They intentionally know nothing
 * about the store or the app runtime: the CLI feeds them parsed `.camj` JSON,
 * and the numbers stay reproducible from the file on disk.
 */

export interface ProjectMetrics {
  jsonBytes: number
  featureCount: number
  definitionCount: number
  operationCount: number
  toolCount: number
  annotationCount: number
  embeddedAssetBytes: number
  embeddedAssetCount: number
  largestStringBytes: number
}

export interface SerializationMetrics {
  parseMs: number
  stringifyMs: number
  cloneMs: number
  snapshotBytes: number
  /** Serialized-size projection, not a measurement of V8 heap usage. */
  history100Bytes: number
}

export interface FixtureMetrics extends ProjectMetrics, SerializationMetrics {
  fileName: string
  fileBytes: number
}

export interface CommandSourceMetrics {
  file: string
  labels: number
  ids: number
  activations: number
  shortcuts: number
  commandTypes: number
}

export interface CommandInventory {
  files: CommandSourceMetrics[]
  totals: Omit<CommandSourceMetrics, 'file'>
}

export interface BaselineReport {
  schemaVersion: 1
  generatedAt: string
  node: string
  platform: string
  fixtureCount: number
  fixtures: FixtureMetrics[]
  commandInventory: CommandInventory
  notes: string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function objectKeyCount(value: unknown): number {
  const record = asRecord(value)
  return record ? Object.keys(record).length : 0
}

function visitStrings(value: unknown, visitor: (value: string) => void): void {
  if (typeof value === 'string') {
    visitor(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visitor)
    return
  }
  const record = asRecord(value)
  if (record) {
    for (const item of Object.values(record)) visitStrings(item, visitor)
  }
}

function decodeBase64Bytes(value: string): number | null {
  const payload = value.startsWith('data:')
    ? value.slice(value.indexOf(',') + 1)
    : value
  if (payload.length < 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

export function summarizeProject(project: unknown, jsonBytes: number): ProjectMetrics {
  const record = asRecord(project)
  let embeddedAssetBytes = 0
  let embeddedAssetCount = 0
  let largestStringBytes = 0

  visitStrings(record, (value) => {
    const bytes = byteLength(value)
    if (bytes > largestStringBytes) largestStringBytes = bytes
    const decoded = decodeBase64Bytes(value)
    if (decoded !== null) {
      embeddedAssetBytes += decoded
      embeddedAssetCount += 1
    }
  })

  return {
    jsonBytes,
    featureCount: arrayLength(record?.features),
    definitionCount: objectKeyCount(record?.featureDefinitions),
    operationCount: arrayLength(record?.operations),
    toolCount: arrayLength(record?.tools),
    annotationCount: arrayLength(record?.annotations),
    embeddedAssetBytes,
    embeddedAssetCount,
    largestStringBytes,
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }
  return sorted[middle]
}

function timeMs(action: () => void): number {
  const start = process.hrtime.bigint()
  action()
  return Number(process.hrtime.bigint() - start) / 1e6
}

export function measureSerialization(project: unknown, iterations = 3): SerializationMetrics {
  const json = JSON.stringify(project)
  const snapshotBytes = byteLength(json)
  const parseTimes: number[] = []
  const stringifyTimes: number[] = []
  const cloneTimes: number[] = []
  const canClone = typeof globalThis.structuredClone === 'function'

  for (let index = 0; index < iterations; index += 1) {
    parseTimes.push(timeMs(() => { JSON.parse(json) }))
    stringifyTimes.push(timeMs(() => { JSON.stringify(project) }))
    if (canClone) {
      cloneTimes.push(timeMs(() => { globalThis.structuredClone(project) }))
    }
  }

  return {
    parseMs: median(parseTimes),
    stringifyMs: median(stringifyTimes),
    cloneMs: median(cloneTimes),
    snapshotBytes,
    history100Bytes: snapshotBytes * 100,
  }
}

export function countCommandPatterns(source: string): Omit<CommandSourceMetrics, 'file'> {
  const count = (pattern: RegExp): number => (source.match(pattern) ?? []).length
  return {
    labels: count(/\blabel\s*:/g),
    ids: count(/\bid\s*:/g),
    activations: count(/\bonActivate\s*:/g),
    shortcuts: count(/\bshortcut\s*:/g),
    commandTypes: count(/\b(?:CommandDescriptor|CommandSpec|CreationShapeCommand)\b/g),
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
