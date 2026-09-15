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
 * STEP tessellation core (issue #784): an Open CASCADE read → named triangle bodies.
 *
 * Pure apart from the OCCT module it is handed, so the same code runs in the
 * import worker and in Node tests against the real WASM. It imports nothing
 * from the mesh engine, which keeps three.js out of the worker bundle; bounds
 * are computed on the main thread.
 *
 * **One body per OCCT mesh.** OCCT emits a mesh per solid, then per shell that
 * is not inside a solid, then one for loose faces, with assembly placements
 * already applied. That is the file's own body identity, so nothing here
 * re-derives bodies from connectivity: connectivity splits a solid with an
 * internal void and can merge parts that touch.
 *
 * Vertices stay per B-rep face, as OCCT emits them. They are not welded, for
 * the same reason STL imports keep a vertex per face normal: the stored index
 * is what the viewport shades from.
 */

import type { OcctImportModule, OcctImportParams, OcctImportResult, OcctMesh } from 'occt-import-js'
import {
  StepImportError,
  type StepOutputUnit,
  type StepTessellationBody,
} from './stepProtocol'

export interface StepTessellationOptions {
  outputUnit: StepOutputUnit
  /** Absolute chordal deflection, in `outputUnit`. */
  linearDeflection: number
  maxTriangles: number
}

export function occtImportParams(options: StepTessellationOptions): OcctImportParams {
  return {
    linearUnit: options.outputUnit === 'inch' ? 'inch' : 'millimeter',
    // OCCT's default deflection is 0.1% of the average bounding-box side, so the
    // chord error would grow with the part. Machining needs it as a length.
    // Angular deflection keeps OCCT's default.
    linearDeflectionType: 'absolute_value',
    linearDeflection: options.linearDeflection,
  }
}

/**
 * OCCT explains a failed read only on its console, in lines like
 * `**** ERR StepFile : Undefined Parsing: Line 2: Incorrect syntax ... ****`.
 * The last error line is the most specific one.
 */
export function occtDiagnostic(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!/\bERR\b/.test(lines[i])) continue
    const text = lines[i]
      .replace(/\*{2,}/g, ' ')
      .replace(/^\s*ERR\s+StepFile\s*:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) return text
  }
  return undefined
}

function runtimeFailure(error: unknown): StepImportError {
  const message = error instanceof Error ? error.message : String(error)
  // Emscripten aborts an allocation failure with "Aborted(OOM)" or "Cannot
  // enlarge memory arrays"; anything else is a failure inside OCCT itself.
  const code = /\bOOM\b|memory/i.test(message) ? 'out-of-memory' : 'tessellation-failed'
  return new StepImportError({ code, detail: message })
}

function malformedMesh(): StepImportError {
  return new StepImportError({ code: 'tessellation-failed', detail: 'Open CASCADE returned a malformed mesh' })
}

function meshToBody(mesh: OcctMesh): StepTessellationBody {
  const sourcePositions = mesh.attributes?.position?.array ?? []
  const sourceIndex = mesh.index.array
  if (sourcePositions.length === 0 || sourcePositions.length % 3 !== 0 || sourceIndex.length % 3 !== 0) {
    throw malformedMesh()
  }

  const vertexCount = sourcePositions.length / 3
  const positions = new Float32Array(sourcePositions.length)
  for (let i = 0; i < sourcePositions.length; i += 1) {
    const value = sourcePositions[i]
    if (!Number.isFinite(value)) throw malformedMesh()
    positions[i] = value
  }

  const index = new Uint32Array(sourceIndex.length)
  for (let i = 0; i < sourceIndex.length; i += 1) {
    const vertex = sourceIndex[i]
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount) throw malformedMesh()
    index[i] = vertex
  }

  return { name: typeof mesh.name === 'string' ? mesh.name.trim() : '', positions, index }
}

/**
 * Read and tessellate a STEP file. `diagnostics` must be the array the module's
 * `print`/`printErr` hooks push into; it is cleared first so a failure reports
 * this read's reason, not an earlier one.
 */
export function tessellateStep(
  occt: OcctImportModule,
  bytes: Uint8Array,
  options: StepTessellationOptions,
  diagnostics: string[] = [],
): StepTessellationBody[] {
  if (!Number.isFinite(options.linearDeflection) || options.linearDeflection <= 0) {
    throw new StepImportError({ code: 'invalid-tolerance' })
  }

  diagnostics.length = 0
  let result: OcctImportResult
  try {
    result = occt.ReadStepFile(bytes, occtImportParams(options))
  } catch (error: unknown) {
    throw runtimeFailure(error)
  }
  if (!result.success) {
    throw new StepImportError({ code: 'unreadable', detail: occtDiagnostic(diagnostics) })
  }

  const bodies: StepTessellationBody[] = []
  let triangles = 0
  for (const mesh of result.meshes ?? []) {
    const triangleCount = Math.floor((mesh.index?.array?.length ?? 0) / 3)
    if (triangleCount === 0) continue
    triangles += triangleCount
    // Checked before converting, so an over-cap model is refused without also
    // allocating its typed arrays.
    if (triangles > options.maxTriangles) {
      throw new StepImportError({ code: 'too-many-triangles', limit: options.maxTriangles })
    }
    bodies.push(meshToBody(mesh))
  }

  if (bodies.length === 0) throw new StepImportError({ code: 'no-geometry' })
  return bodies
}
