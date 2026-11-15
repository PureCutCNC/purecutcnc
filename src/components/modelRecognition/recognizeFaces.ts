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
 * Find pockets and holes on more than one face (issue #1206 slice 4).
 *
 * One run per face, one after the other, never two workers at once. The look
 * from below is the same mesh with Z negated, and its result is mapped back to
 * stock space before the candidates are made, so every shape this returns is
 * already in the coordinates it will be drawn in. Progress stays one bar: with
 * two faces the first run is 0..0.5 and the second 0.5..1.
 *
 * `markAlreadyDrawn` is still the dialog's job, on the combined candidates: it
 * is a question about the project, not about the mesh.
 */

import {
  candidatesFromResult,
  combineFaces,
  meshSeenFromBelow,
  resultFromBelowToStock,
  type CombinedRecognition,
  type FaceRun,
  type RecognitionMesh,
} from '../../engine/modelRecognition'
import type { FlatFace } from '../../types/project'
import { runModelRecognition, type RunRecognitionOptions } from './recognitionClient'

/**
 * Searches `faces` — `['top']`, or `['top', 'bottom']` — and returns the one
 * list the dialog shows. A cancel during either run rejects with
 * `RecognitionCancelledError` and starts nothing further.
 */
export async function recognizeModelFaces(
  mesh: RecognitionMesh,
  faces: readonly FlatFace[],
  units: 'mm' | 'inch',
  options: RunRecognitionOptions = {},
): Promise<CombinedRecognition> {
  const runs: FaceRun[] = []
  const share = 1 / Math.max(faces.length, 1)
  const heard = options.onProgress

  for (const face of faces) {
    const start = runs.length * share
    const onProgress = heard ? (fraction: number): void => heard(start + fraction * share) : undefined
    const input = face === 'bottom' ? meshSeenFromBelow(mesh) : mesh
    const result = await runModelRecognition(input, { ...options, onProgress })
    // The Bottom run was made in the turned frame; its spans are not.
    const stockSpace = face === 'bottom' ? resultFromBelowToStock(result) : result
    runs.push({
      candidates: candidatesFromResult(stockSpace, face, units, face === 'bottom' ? 'b-' : ''),
      skipped: stockSpace.skipped,
      skippedSolids: stockSpace.skippedSolids,
      meshOpen: stockSpace.meshOpen,
      levelsTruncated: stockSpace.levelsTruncated,
    })
  }

  const topRun = runs[faces.indexOf('top')] ?? runs[0]
  const bottomIndex = faces.indexOf('bottom')
  return combineFaces(topRun, bottomIndex < 0 ? null : runs[bottomIndex])
}
