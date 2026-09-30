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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { newProject } from '../../types/project'
import { drawOperationSnapshot } from './operationSnapshot'

/** A 2D context that accepts every call and counts `lineTo`. */
function countingContext(): { ctx: CanvasRenderingContext2D; lineTo: () => number } {
  let lineTo = 0
  const noop = (): void => undefined
  const target: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(target, {
    get(object, property) {
      if (property === 'lineTo') return () => { lineTo += 1 }
      if (property === 'measureText') return () => ({ width: 0 })
      if (property in object) return object[property]
      return noop
    },
    set(object, property, value) {
      object[property] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, lineTo: () => lineTo }
}

/** A dense raster: many connected same-feed cuts shorter than a canvas pixel at
 *  overview scale, like a surface finish densified to its height-map cells. */
function denseRaster(operationId: string, rows: number, stepsPerRow: number): ToolpathResult {
  const moves: ToolpathMove[] = []
  for (let row = 0; row < rows; row += 1) {
    const y = 1 + row * 0.02
    for (let step = 0; step < stepsPerRow; step += 1) {
      const x0 = 1 + (step / stepsPerRow) * 10
      const x1 = 1 + ((step + 1) / stepsPerRow) * 10
      moves.push({ kind: 'cut', from: { x: x0, y, z: -0.1 }, to: { x: x1, y, z: -0.1 } })
    }
  }
  return { operationId, moves, warnings: [], bounds: null }
}

test('the booklet snapshot draws a dense toolpath simplified, not move by move (#924)', () => {
  const project = newProject('Snapshot', 'inch')
  const operation = defaultOperationForTarget(project, 'pocket', 'rough', { source: 'stock' }, 0)
  const toolpath = denseRaster(operation.id, 10, 4000)

  const withToolpath = countingContext()
  drawOperationSnapshot(withToolpath.ctx, 1200, 760, 1, project, operation, toolpath)
  const empty = countingContext()
  drawOperationSnapshot(empty.ctx, 1200, 760, 1, project, operation, null)

  const toolpathLines = withToolpath.lineTo() - empty.lineTo()
  // 40,000 moves of 0.0025 in: well under a pixel each at overview scale, so
  // the display merge joins many of them into each stroke. Measured on
  // LP-carved-top.camj's 287,049-move finish: 70,895 strokes at 1x.
  assert(toolpathLines > 0, 'the toolpath must be drawn')
  assert(toolpathLines < toolpath.moves.length / 4, `${toolpathLines} line segments for ${toolpath.moves.length} moves`)
})
