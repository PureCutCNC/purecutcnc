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
import { buildGuitarMesh } from '../../test/guitarTopFixture'
import { surfaceTestProject } from '../../test/surfaceSlopeFixtures'
import { asSketchFeature, resolvedFeature } from '../../test/projectFixtures'
import { loadSTLTransformedGeometry } from '../csg'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { chooseHeightMapCellSize, computeXYBounds, getCachedHeightMap, safeToolTipZAt, type FinishSurfaceParallelCacheHost } from './finishSurfaceParallel'
import { getOperationSafeZ, normalizeToolForProject } from './geometry'
import type { ToolpathMove } from './types'

test('original #697 guitar top: 0–30 degree filter excludes steep CL cells, including segment interiors', () => {
  // The exact 332 x 470 mm, 1 mm mesh and 6 mm ball used for #697.
  // This is its procedural carved-top model, not an independently sourced CAD file.
  const {project,operation} = surfaceTestProject(buildGuitarMesh({ cell: 1 }), 6)
  operation.stepover = 2 * Math.sqrt(2 * 3 * 0.02 - 0.02 ** 2) / 6
  const mesh = loadSTLTransformedGeometry(asSketchFeature(resolvedFeature(project, 'hills-model')), project)!
  const tool = normalizeToolForProject(project.tools[0], project)
  const bbox = computeXYBounds(mesh.positions)
  const pitch = chooseHeightMapCellSize(bbox, Math.min(tool.radius / 3, operation.stepover * tool.diameter / 2), [])
  const map = getCachedHeightMap(mesh as FinishSurfaceParallelCacheHost, mesh.positions, mesh.index, bbox, pitch)
  const cachedZ = new Float64Array(map.width * map.height).fill(NaN)
  const cachedSlope = new Float64Array(cachedZ.length).fill(NaN)
  const z = (c: number, r: number): number => {
    if (c < 0 || r < 0 || c >= map.width || r >= map.height) return NaN
    const at = r * map.width + c
    if (Number.isNaN(cachedZ[at])) cachedZ[at] = safeToolTipZAt(map.originX + (c + 0.5) * pitch, map.originY + (r + 0.5) * pitch, map, tool)
    return cachedZ[at]
  }
  // Independent centred-difference oracle: it does not call the slope-domain
  // builder or test against its polygons. One grid cell of XY uncertainty is
  // allowed at the raster boundary, matching the published resolution contract.
  const slope = (c: number, r: number): number => {
    if (c < 0 || r < 0 || c >= map.width || r >= map.height) return Infinity
    const at = r * map.width + c
    if (Number.isNaN(cachedSlope[at])) {
      const left = Math.max(0, c - 1), right = Math.min(map.width - 1, c + 1)
      const down = Math.max(0, r - 1), up = Math.min(map.height - 1, r + 1)
      const dx = (z(right,r) - z(left,r)) / ((right-left)*pitch)
      const dy = (z(c,up) - z(c,down)) / ((up-down)*pitch)
      cachedSlope[at] = Math.atan(Math.hypot(dx,dy)) * 180 / Math.PI
    }
    return cachedSlope[at]
  }
  const inShallowBand = (x: number, y: number): boolean => {
    const col = Math.floor((x - map.originX) / pitch), row = Math.floor((y - map.originY) / pitch)
    for (let r = row - 1; r <= row + 1; r += 1) for (let c = col - 1; c <= col + 1; c += 1) {
      if (slope(c,r) <= 30 + 1e-6) return true
    }
    return false
  }
  function measure(moves: ToolpathMove[]) {
    let samples = 0, rejected = 0, cutting = 0, rapid = 0
    for (const move of moves) {
      const dx=move.to.x-move.from.x, dy=move.to.y-move.from.y, dz=move.to.z-move.from.z
      if (move.kind === 'rapid') rapid += Math.hypot(dx,dy,dz)
      if (move.kind !== 'cut') continue
      cutting += Math.hypot(dx,dy,dz)
      const n = Math.max(1, Math.ceil(Math.hypot(dx,dy)/(pitch/2)))
      for (let i = 0; i <= n; i += 1) {
        samples += 1
        if (!inShallowBand(move.from.x+dx*i/n,move.from.y+dy*i/n)) rejected += 1
      }
    }
    return { samples, rejected, cutting, rapid }
  }
  const baseline = measure(generateFinishSurfaceToolpath(project,operation).moves)
  assert(baseline.rejected > 0, 'fixture must contain steep material actually traversed without filtering')
  const result = generateFinishSurfaceToolpath(project,{...operation,finishSlopeMin:0,finishSlopeMax:30})
  const filtered = measure(result.moves)
  assert(filtered.samples > 0)
  assert.equal(filtered.rejected,0)
  const safeZ = getOperationSafeZ(project)
  for (const move of result.moves) if (move.kind === 'rapid' && Math.hypot(move.to.x-move.from.x,move.to.y-move.from.y) > 1e-6) {
    assert.equal(move.from.z,safeZ); assert.equal(move.to.z,safeZ)
  }
  console.log(JSON.stringify({fixture:'issue-697-guitar',pitch,baseline,filtered,warnings:result.warnings}))
})
