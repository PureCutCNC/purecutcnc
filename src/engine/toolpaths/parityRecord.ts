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
 * Shape of one golden record in the issue #675 parity baseline, plus the
 * canonicalisation both the capture script and the parity test must use.
 *
 * Split out from `parityCorpus.ts` so the test and the capture script agree on
 * the encoding by construction: a hash is only a parity proof if both sides
 * serialise identically.
 */

import type { ToolpathResult } from './types'

export interface ParityRecord {
  /** sha256 of the canonicalised final `ToolpathResult`. The real gate. */
  resultHash: string
  /** sha256 of the canonicalised pre-optimization raw result. */
  rawHash: string
  /** sha256 of the posted G-code, with the corpus's frozen machine and options. */
  gcodeHash: string
  // Everything below is diagnostic only: a hash mismatch says *that* something
  // moved, these say *what*, without needing the baseline recaptured to debug.
  moves: number
  rawMoves: number
  gcodeLines: number
  /** Warning codes in emitted order — order is part of the contract. */
  warnings: string[]
  bounds: string
  drillCycles: number
  collidingClampIds: string[]
  collidingMoveIndices: number
}

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * Key order is not semantics, and hashing raw `JSON.stringify` output would
 * turn a harmless change in property construction order into a false parity
 * failure. Sorting compares values, which is what parity actually means.
 *
 * Numbers go through `JSON.stringify`'s own double formatting, which
 * round-trips IEEE-754 exactly — so this is a full-precision comparison, not a
 * rounded one.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) sorted[key] = sortKeys(source[key])
  }
  return sorted
}

/** The diagnostic half of a record — derived, never the assertion itself. */
export function summarize(
  result: ToolpathResult,
  raw: ToolpathResult,
  gcode: string,
): Omit<ParityRecord, 'resultHash' | 'rawHash' | 'gcodeHash'> {
  return {
    moves: result.moves.length,
    rawMoves: raw.moves.length,
    gcodeLines: gcode.split('\n').length,
    warnings: result.warnings.map((warning) => warning.code),
    bounds: result.bounds
      ? `${result.bounds.minX},${result.bounds.minY},${result.bounds.minZ}`
        + `:${result.bounds.maxX},${result.bounds.maxY},${result.bounds.maxZ}`
      : 'null',
    drillCycles: result.drillCycles?.length ?? 0,
    collidingClampIds: [...(result.collidingClampIds ?? [])].sort(),
    collidingMoveIndices: result.collidingMoveIndices?.length ?? 0,
  }
}
