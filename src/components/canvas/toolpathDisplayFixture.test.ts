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
import { readFileSync } from 'node:fs'
import { normalizeProject } from '../../store/projectStore'
import { generateFollowLineToolpath } from '../../engine/toolpaths/carving'
import { generateEdgeRouteToolpath } from '../../engine/toolpaths/edge'
import { toolpathLayerBuckets } from '../viewport3d/toolpathOverlay'
import { toolpathDisplayGeometry } from './toolpathDisplay'

// Real generated workloads, not a synthetic straight-line speed fixture.
// Independently measure source vertices against their replacement chords.
for (const [file, scale, expectedMoves] of [
  ['trochoidal-249k.camj', 195, 249663],
  ['trochoidal-raster.camj', 780 / 220, 882899],
] as const) {
  const project = normalizeProject(JSON.parse(readFileSync(new URL('../../engine/test-fixtures/' + file, import.meta.url), 'utf8')))
  const operation = project.operations[0]
  const toolpath = (operation.kind === 'follow_line' ? generateFollowLineToolpath : generateEdgeRouteToolpath)(project, operation)
  assert.equal(toolpath.moves.length, expectedMoves)
  assert.deepEqual(toolpath.warnings, [])
  const original = toolpath.moves
  const cuts = toolpathLayerBuckets(toolpath).cuts
  const display = toolpathDisplayGeometry(toolpath, scale).layers.cuts.segments
  assert(display.length < cuts.length, 'fit-to-view fixture must benefit')
  let index = 0
  let maxError = 0
  for (const segment of display) {
    assert.equal(cuts[index].from.x * scale, segment.fromX)
    assert.equal(cuts[index].from.y * scale, segment.fromY)
    const dx = segment.toX - segment.fromX, dy = segment.toY - segment.fromY
    const lengthSquared = dx * dx + dy * dy
    while (index < cuts.length) {
      const point = cuts[index++].to
      const x = point.x * scale, y = point.y * scale
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - segment.fromX) * dx + (y - segment.fromY) * dy) / lengthSquared))
      maxError = Math.max(maxError, Math.hypot(x - segment.fromX - t * dx, y - segment.fromY - t * dy))
      if (x === segment.toX && y === segment.toY) break
    }
  }
  assert.equal(index, cuts.length, 'all original cutting vertices were checked')
  assert(maxError < 0.25, file + ': measured displacement must stay below a quarter canvas pixel')
  assert.equal(toolpathDisplayGeometry(toolpath, scale * 2).layers.cuts.segments.length, cuts.length, 'closer zoom restores all cut segments')
  assert.equal(toolpath.moves, original, 'display must retain the original machining record')
  console.log(file + ': display geometry and visual error checks passed')
}
