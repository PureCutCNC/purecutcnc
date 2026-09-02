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
import { buildSurfaceSlopeDomain, createSurfaceDomainLinkCheck, surfaceSlopeRange } from './finishSurfaceSlope'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { pointInClipperPaths } from './modelProtection'
import { DEFAULT_CLIPPER_SCALE, getOperationSafeZ } from './geometry'
import type { HeightMap } from './finishSurfaceParallel'
import { rectProfile, type Operation, type SketchFeature } from '../../types/project'
import { asSketchFeature, replaceProjectFeatures, resolvedFeature } from '../../test/projectFixtures'
import type { ToolpathWarning } from './warningCodes'
import { mixedSlopeHeight, slopeTestMesh, surfaceTestProject } from '../../test/surfaceSlopeFixtures'
import { convertProjectUnits } from '../../utils/units'

const fixture = () => surfaceTestProject(slopeTestMesh(mixedSlopeHeight))
const op = fixture().operation
function planeMap(degrees: number, rotation = 0, scale = 1): HeightMap {
  const data = new Float32Array(20 * 16), cellSize = scale
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 20; x += 1) {
    data[y * 20 + x] = ((x + 0.5) * Math.cos(rotation) + (y + 0.5) * Math.sin(rotation)) * cellSize * Math.tan(degrees * Math.PI / 180)
  }
  return { width: 20, height: 16, cellSize, originX: 0, originY: 0, data }
}
const sample = (map: HeightMap) => (x: number, y: number) => map.data[Math.floor(y / map.cellSize) * map.width + Math.floor(x / map.cellSize)]

test('bounds are opt-in, one-sided, finite and ordered; bad saved data never generates cuts', () => {
  assert.equal(surfaceSlopeRange(op), null)
  assert.deepEqual(surfaceSlopeRange({ ...op, finishSlopeMin: 20 }), { min: 20, max: 90 })
  assert.deepEqual(surfaceSlopeRange({ ...op, finishSlopeMax: 30 }), { min: 0, max: 30 })
  for (const patch of [{finishSlopeMin: -1}, {finishSlopeMax: 91}, {finishSlopeMin: 40, finishSlopeMax: 30},
    {finishSlopeMax: NaN}, {finishSlopeMin: Infinity}, {finishSlopeMax: null}, {finishSlopeMin: '30'}]) {
    const invalid = { ...op, ...patch } as Operation
    const result = generateFinishSurfaceToolpath(fixture().project, invalid)
    assert.equal(result.moves.length, 0)
    assert.deepEqual(result.warnings, [{ code: 'finishSlopeInvalid' }])
  }
})

test('analytic planes classify correctly at every angle and rotation, in mm and inch', () => {
  for (const scale of [1, 1 / 25.4]) for (const rotation of [0, Math.PI / 4, Math.PI / 2]) {
    for (const degrees of [0, 10, 25, 45, 80]) {
      const map = planeMap(degrees, rotation, scale)
      const warnings: ToolpathWarning[] = []
      const shallow = buildSurfaceSlopeDomain({ ...op, finishSlopeMax: 30 }, map, sample(map), warnings)!
      assert.equal(pointInClipperPaths(shallow, { x: 8 * scale, y: 8 * scale }), degrees < 30)
      const narrow = buildSurfaceSlopeDomain({ ...op, finishSlopeMin: 24, finishSlopeMax: 26 }, map, sample(map), [])!
      assert.equal(pointInClipperPaths(narrow, { x: 8 * scale, y: 8 * scale }), degrees === 25)
      const full = buildSurfaceSlopeDomain({ ...op, finishSlopeMin: 0, finishSlopeMax: 90 }, map, sample(map), [])!
      assert(pointInClipperPaths(full, { x: 8 * scale, y: 8 * scale }))
    }
  }
})

test('missing samples and sharp ridges cannot be mistaken for flat surface', () => {
  const map = planeMap(0)
  map.data[8 * map.width + 8] = -Infinity
  const domain = buildSurfaceSlopeDomain({ ...op, finishSlopeMax: 30 }, map, sample(map), [])!
  assert(!pointInClipperPaths(domain, { x: 8.5, y: 8.5 }))
  assert(pointInClipperPaths(domain, { x: 3.5, y: 3.5 }))
  const ridge = buildSurfaceSlopeDomain({ ...op, finishSlopeMax: 30 }, planeMap(0), (x) => -Math.abs(x - 8.5), [])!
  assert(!pointInClipperPaths(ridge, { x: 8.5, y: 8.5 }), 'opposite gradients must not cancel')
  const empty = buildSurfaceSlopeDomain({ ...op, finishSlopeMin: 80 }, planeMap(0), () => 0, [])!
  assert.equal(empty.length, 0)
})

test('links reject holes and gaps even when contour winding is lost', () => {
  const rect = (x: number, y: number, w: number, h: number) =>
    [[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(([X,Y]) => ({X:Math.round(X*DEFAULT_CLIPPER_SCALE),Y:Math.round(Y*DEFAULT_CLIPPER_SCALE)}))
  const sameWindingHole = createSurfaceDomainLinkCheck([rect(0,0,10,10), rect(4.001,4,0.002,2)])
  assert(!sameWindingHole({x:1,y:5}, {x:9,y:5}), 'thin interior hole crossed')
  assert(sameWindingHole({x:1,y:2}, {x:9,y:2}), 'clear link inside outer contour')
  const disjoint = createSurfaceDomainLinkCheck([rect(0,0,3,3), rect(7,0,3,3)])
  assert(!disjoint({x:1,y:1}, {x:9,y:1}), 'gap between disjoint islands crossed')
})

const slopePatternCases = [
  { pattern: 'parallel', adaptive: false },
  { pattern: 'parallel', adaptive: true },
  { pattern: 'waterline', adaptive: false },
  { pattern: 'waterline', adaptive: true },
  { pattern: 'constant_scallop', adaptive: false },
] as const

for (const { pattern, adaptive } of slopePatternCases) {
  test(`${pattern}, adaptive ${adaptive}: cuts and links stay on shallow bands; crossings travel at safe Z`, () => {
    const { project, operation } = fixture()
    const filtered = { ...operation, pocketPattern: pattern, waterlineAdaptiveRefinement: adaptive, finishSlopeMin: 0, finishSlopeMax: 30 }
    const result = generateFinishSurfaceToolpath(project, filtered)
    // At the upper kink a radius-1 ball reaches 30 degrees at x=40-r*sin(30)=39.5.
    // The filter follows CL slope, not the raw mesh's kink at x=40.
    const cuts = result.moves.filter(m => m.kind === 'cut')
    assert(cuts.some(m => m.to.x < 15), 'left shallow surface cut')
    assert(cuts.some(m => m.to.x > 45), 'right shallow surface cut')
    for (const m of cuts) {
      for (let i = 0; i <= 10; i += 1) {
        const x = m.from.x + (m.to.x - m.from.x) * i / 10
        assert(x <= 20 || x >= 39.5, `cut crosses 45-degree band at x=${x}`)
      }
    }
    const crossings = result.moves.filter(m => Math.min(m.from.x,m.to.x) < 23 && Math.max(m.from.x,m.to.x) > 38)
    assert(crossings.length > 0, 'both disconnected pieces require travel')
    const safeZ = getOperationSafeZ(project)
    for (const m of crossings) {
      assert.equal(m.kind, 'rapid'); assert.equal(m.from.z, safeZ); assert.equal(m.to.z, safeZ)
    }
    const empty = generateFinishSurfaceToolpath(project, { ...filtered, finishSlopeMin: 89, finishSlopeMax: 90 })
    assert.equal(empty.moves.length, 0)
  })
}

test('unit conversion preserves the selected slope band on generated paths', () => {
  for (const pattern of ['parallel', 'constant_scallop'] as const) {
    const {project,operation} = fixture()
    operation.finishSlopeMax = 30
    operation.pocketPattern = pattern
    for (const units of ['mm','inch'] as const) {
      const converted = units === 'mm' ? project : convertProjectUnits(project, units)
      const result = generateFinishSurfaceToolpath(converted, converted.operations[0])
      assert(result.moves.some(m => m.kind === 'cut'))
      for (const m of result.moves.filter(m => m.kind === 'cut')) {
        const x = (m.from.x + m.to.x) / 2 * (units === 'mm' ? 1 : 25.4)
        assert(x <= 20 || x >= 39.5)
      }
    }
  }
})


test('slope, ordered regions, tabs and clamps compose before both generators', () => {
  const region = (id: string, x: number, y: number, w: number, h: number, mode: 'include' | 'exclude'): SketchFeature => ({
    id, name: id, kind: 'rect', folderId: null, operation: 'region', regionMaskMode: mode,
    sketch: { profile: rectProfile(x,y,w,h), origin:{x:0,y:0}, orientationAngle:0, dimensions:[], constraints:[] },
    z_top: 30, z_bottom: 0, visible: true, locked: false,
  })
  for (const pattern of ['parallel','waterline','constant_scallop'] as const) {
    const {project,operation} = fixture()
    const model = asSketchFeature(resolvedFeature(project,'hills-model'))
    const regions = [region('include',2,2,56,20,'include'),region('exclude',8,0,2,24,'exclude')]
    replaceProjectFeatures(project,[model,...regions])
    project.tabs = [{id:'tab',name:'tab',x:14,y:4,w:4,h:16,z_top:15,z_bottom:0,visible:true}]
    project.clamps = [{id:'clamp',name:'clamp',type:'step_clamp',x:44,y:4,w:4,h:16,height:40,visible:true}]
    const configured = {...operation,pocketPattern:pattern,finishSlopeMax:30,
      target:{source:'features' as const,featureIds:['hills-model','include','exclude']}}
    const result = generateFinishSurfaceToolpath(project,configured)
    const cuts=result.moves.filter(m=>m.kind==='cut')
    assert(cuts.length>0)
    for(const move of cuts) for(const point of [move.from,move.to]) {
      assert(point.x <= 7 || point.x >= 11, `${pattern} enters the region exclusion at ${point.x}`)
      assert(point.x <= 43 || point.x >= 49, `${pattern} enters clamp clearance at ${point.x}`)
      if(point.x>=13 && point.x<=19 && point.y>=3 && point.y<=21) assert(point.z>=15-1e-8)
    }
    const safe=getOperationSafeZ(project)
    for(const move of result.moves) if(move.kind==='rapid' && Math.hypot(move.to.x-move.from.x,move.to.y-move.from.y)>1e-6) {
      assert.equal(move.from.z,safe);assert.equal(move.to.z,safe)
    }
  }
})

test('an eligible mask emptied by region composition warns for both generators', () => {
  const exclude = (id: string, x: number, w: number): SketchFeature => ({
    id, name: id, kind: 'rect', folderId: null, operation: 'region', regionMaskMode: 'exclude',
    sketch: { profile: rectProfile(x,0,w,24), origin:{x:0,y:0}, orientationAngle:0, dimensions:[], constraints:[] },
    z_top: 30, z_bottom: 0, visible: true, locked: false,
  })
  for (const pattern of ['parallel','waterline','constant_scallop'] as const) {
    const { project, operation } = fixture()
    const model = asSketchFeature(resolvedFeature(project,'hills-model'))
    const regions = [exclude('exclude-left',0,20), exclude('exclude-right',40,20)]
    replaceProjectFeatures(project,[model,...regions])
    const result = generateFinishSurfaceToolpath(project, {
      ...operation, pocketPattern: pattern, finishSlopeMax: 30,
      target:{source:'features',featureIds:['hills-model',...regions.map((region) => region.id)]},
    })
    assert.equal(result.moves.length,0)
    const expectedWarning = pattern === 'constant_scallop' ? 'constantScallopEmpty' : 'finishSlopeEmpty'
    assert(result.warnings.some((warning) => warning.code === expectedWarning), `${pattern} must explain the empty result`)
  }
})
