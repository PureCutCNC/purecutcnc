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
 * The STEP importer's error contract and worker messages (issue #784).
 *
 * Failures carry a code, not a sentence: tessellation runs in a worker with no
 * locale, and the import dialog owns the wording. The payload is what crosses
 * `postMessage`; `StepImportError` is what the main thread throws.
 */

/**
 * - `invalid-tolerance` — the surface tolerance is not a positive, finite number.
 * - `file-too-large` — over the byte cap, checked before any work starts.
 * - `runtime-unavailable` — the worker could not fetch or instantiate Open CASCADE.
 * - `unreadable` — Open CASCADE could not read or transfer the file.
 * - `no-geometry` — the file read, but nothing in it produced a triangle.
 * - `too-many-triangles` — over the triangle cap after tessellation.
 * - `out-of-memory` — the runtime ran out of memory.
 * - `tessellation-failed` — Open CASCADE failed for any other reason.
 * - `worker-failed` — the worker crashed or answered with something malformed.
 * - `cancelled` — the import was abandoned, normally because its dialog closed.
 */
export type StepImportErrorCode =
  | 'invalid-tolerance'
  | 'file-too-large'
  | 'runtime-unavailable'
  | 'unreadable'
  | 'no-geometry'
  | 'too-many-triangles'
  | 'out-of-memory'
  | 'tessellation-failed'
  | 'worker-failed'
  | 'cancelled'

const STEP_IMPORT_ERROR_CODES: ReadonlySet<string> = new Set<StepImportErrorCode>([
  'invalid-tolerance',
  'file-too-large',
  'runtime-unavailable',
  'unreadable',
  'no-geometry',
  'too-many-triangles',
  'out-of-memory',
  'tessellation-failed',
  'worker-failed',
  'cancelled',
])

export interface StepImportErrorPayload {
  code: StepImportErrorCode
  /** Runtime diagnostic (OCCT's parse message, an exception text), when there is one. */
  detail?: string
  /** The cap an over-limit error refers to: bytes or triangles. */
  limit?: number
}

export class StepImportError extends Error {
  readonly code: StepImportErrorCode
  readonly detail: string | undefined
  readonly limit: number | undefined

  constructor(payload: StepImportErrorPayload) {
    super(payload.detail
      ? `STEP import failed (${payload.code}): ${payload.detail}`
      : `STEP import failed (${payload.code})`)
    this.name = 'StepImportError'
    this.code = payload.code
    this.detail = payload.detail
    this.limit = payload.limit
  }

  toPayload(): StepImportErrorPayload {
    return { code: this.code, detail: this.detail, limit: this.limit }
  }
}

/** Unit of the tessellated numbers — the unit Open CASCADE is asked to emit. */
export type StepOutputUnit = 'mm' | 'inch'

export interface StepTessellateRequest {
  kind: 'tessellate'
  bytes: ArrayBuffer
  outputUnit: StepOutputUnit
  /** Absolute chordal deflection, in `outputUnit`. */
  linearDeflection: number
  maxTriangles: number
}

export interface StepTessellationBody {
  /** The solid's name in the file; empty when the file names none. */
  name: string
  positions: Float32Array<ArrayBuffer>
  index: Uint32Array<ArrayBuffer>
}

export type StepWorkerResponse =
  | { kind: 'completed', bodies: StepTessellationBody[] }
  | { kind: 'failed', error: StepImportErrorPayload }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isStepTessellateRequest(value: unknown): value is StepTessellateRequest {
  return isRecord(value)
    && value.kind === 'tessellate'
    && value.bytes instanceof ArrayBuffer
    && (value.outputUnit === 'mm' || value.outputUnit === 'inch')
    && typeof value.linearDeflection === 'number'
    && typeof value.maxTriangles === 'number'
}

function isErrorPayload(value: unknown): value is StepImportErrorPayload {
  return isRecord(value)
    && typeof value.code === 'string'
    && STEP_IMPORT_ERROR_CODES.has(value.code)
    && (value.detail === undefined || typeof value.detail === 'string')
    && (value.limit === undefined || typeof value.limit === 'number')
}

function isBody(value: unknown): value is StepTessellationBody {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.positions instanceof Float32Array
    && value.index instanceof Uint32Array
}

export function isStepWorkerResponse(value: unknown): value is StepWorkerResponse {
  if (!isRecord(value)) return false
  if (value.kind === 'failed') return isErrorPayload(value.error)
  return value.kind === 'completed' && Array.isArray(value.bodies) && value.bodies.every(isBody)
}
