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
 * Several part types in one nest (issue #855, step 4 of #741): how a selection
 * splits into parts, per-part quantities, gaps measured on the resolved world
 * geometry of a mixed nest, and loading a prototype-shaped record.
 *
 * Run with: npx tsx src/store/nestingMultipart.test.ts
 */

import ClipperLib from 'clipper-lib'
import { flattenProfileWithin, nest } from '../engine/nesting'
import { NEST_SCALE, ringToPath } from '../engine/nesting/clipperOps'
import { projectWithFeatures } from '../test/projectFixtures'
import {
  circleProfile,
  defaultStock,
  newProject,
  rectProfile,
  type LocalConstraint,
  type Point,
  type Project,
  type SketchFeature,
} from '../types/project'
import { createTextFeatureAt } from './helpers/naming'
import { buildNestRequest, resolveNestParts } from './helpers/nestPart'
import { normalizeProject, type ProjectFormatInput } from './helpers/projectFormat'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const GAP = 5

function row(id: string, operation: SketchFeature['operation'], profile: SketchFeature['sketch']['profile'], extra: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id, name: id, kind: 'rect', operation, visible: true, locked: false, z_top: 10, z_bottom: operation === 'subtract' ? 5 : 0,
    folderId: null, text: null, stl: null,
    sketch: { origin: { ...profile.start }, orientationAngle: 0, dimensions: [], constraints: [], profile },
    ...extra,
  }
}

function makeProject(bConstraint?: LocalConstraint): Project {
  const base = newProject()
  base.meta = { ...base.meta, units: 'mm' }
  base.stock = defaultStock(300, 200, 12, 'mm')
  const b = row('b', 'add', rectProfile(80, 10, 20, 40))
  if (bConstraint) b.sketch = { ...b.sketch, constraints: [bConstraint] }
  const project = projectWithFeatures(base, [
    row('a', 'add', rectProfile(10, 10, 40, 30)),
    row('a-hole', 'subtract', circleProfile(30, 25, 6)),
    b,
    // Two overlapping strokes make one letter-like part.
    row('c1', 'add', rectProfile(150, 10, 10, 40)),
    row('c2', 'add', rectProfile(150, 40, 30, 10)),
  ])
  return normalizeProject(JSON.parse(JSON.stringify(project)) as ProjectFormatInput)
}

function resetStore(project: Project): void {
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null }, dirty: false })
}

function testSplitting(): void {
  const project = makeProject()
  const resolution = resolveNestParts(project, ['a', 'b', 'c1', 'c2'])
  assert(resolution.ok, 'selection resolves')
  const parts = resolution.parts.map((part) => part.featureIds.join('+'))
  assert(parts.join(' | ') === 'a+a-hole | b | c1+c2', `parts: ${parts.join(' | ')}`)
  assert(resolution.parts.map((part) => part.name).join() === 'a,b,c1', 'parts are named after their largest feature (c1 is 10×40, c2 30×10)')

  const withText = makeProject()
  const text = createTextFeatureAt(withText, { text: 'AB', style: 'outline', fontId: 'helvetiker_bold', size: 30, operation: 'add', layout: null }, { x: 20, y: 120 })
  assert(text, 'text feature builds')
  resetStore(withText)
  useProjectStore.getState().addFeature({ ...text, operation: 'add' })
  const textProject = useProjectStore.getState().project
  const textId = textProject.features.at(-1)!.id
  const textParts = resolveNestParts(textProject, [textId, 'b'])
  assert(textParts.ok && textParts.parts.length === 2, 'a two-glyph text run is one part, b another')
  assert(textParts.parts.some((part) => part.featureIds.join() === textId && part.footprint.length >= 2), 'the text part keeps both glyph outlines')

  const crossPart = resolveNestParts(makeProject({ id: 'c', type: 'fixed_distance', segment_ids: ['a'], reference_feature_id: 'a', value: 5 }), ['a', 'b'])
  assert(!crossPart.ok && crossPart.refusal === 'external-constraint' && crossPart.featureId === 'b', 'a constraint across parts is refused')
  console.log('splitting a selection into parts: PASSED')
}

function worldRing(project: Project, id: string): Point[] {
  const feature = resolveFeatureInstance(project, id)
  assert(feature, `${id} resolves`)
  return flattenProfileWithin(feature.sketch.profile, 0.001)
}

function overlapArea(a: Point[], b: Point[]): number {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths([ringToPath(a)], ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths([ringToPath(b)], ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return solution.reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)), 0) / NEST_SCALE ** 2
}

function distance(a: Point[], b: Point[]): number {
  if (overlapArea(a, b) > 0) return 0
  let best = Infinity
  for (const [from, to] of [[a, b], [b, a]]) {
    for (const p of from) {
      for (let i = 0; i < to.length; i += 1) {
        const s = to[i]
        const e = to[(i + 1) % to.length]
        const dx = e.x - s.x
        const dy = e.y - s.y
        const t = Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / (dx * dx + dy * dy || 1)))
        best = Math.min(best, Math.hypot(p.x - (s.x + t * dx), p.y - (s.y + t * dy)))
      }
    }
  }
  return best
}

function testMixedNest(): void {
  const before = makeProject()
  resetStore(before)
  const resolution = resolveNestParts(before, ['a', 'b', 'c1', 'c2'])
  assert(resolution.ok, 'resolves')
  const quantities = [3, 2, 4]
  const settings = { rotations: [0, 90, 180, 270], minimumGap: GAP, keepOriginals: false }
  const request = buildNestRequest(before, resolution.parts, quantities, settings)
  assert(request, 'request builds')
  const result = nest(request)
  assert(result.unplaced.length === 0, `everything fits: ${JSON.stringify(result.unplaced)}`)
  const nestId = useProjectStore.getState().applyNest({
    parts: resolution.parts.map((part, index) => ({ featureIds: part.featureIds, quantity: quantities[index] })),
    placements: result.placements,
    settings,
  })
  assert(nestId, 'applied')
  const project = useProjectStore.getState().project
  const count = (id: string) => {
    const definitionId = project.features.find((feature) => feature.id === id)!.definitionId
    return project.features.filter((feature) => feature.definitionId === definitionId).length
  }
  assert(count('a') === 3 && count('a-hole') === 3 && count('b') === 2 && count('c1') === 4 && count('c2') === 4, 'per-part quantities honoured, members travel together')
  const record = project.nests!.find((entry) => entry.id === nestId)!
  assert(record.parts.map((part) => part.quantity).join() === '3,2,4', 'quantities recorded per part')
  assert(record.movedOriginals.length === 5, "every part's originals moved")

  // Measured on the world geometry of every placed part: each part is the
  // union of its outer outlines, so compare the solid members across parts.
  const solids = (id: string) => {
    const definitionId = project.features.find((feature) => feature.id === id)!.definitionId
    return project.features.filter((feature) => feature.definitionId === definitionId).map((feature) => feature.id)
  }
  const partOf = new Map<string, string>()
  const groupsByPlacement: string[][] = []
  for (const ids of [solids('a'), solids('b')]) ids.forEach((id) => groupsByPlacement.push([id]))
  // c1/c2 copies pair up by placement order.
  const c1 = solids('c1')
  const c2 = solids('c2')
  c1.forEach((id, index) => groupsByPlacement.push([id, c2[index]]))
  groupsByPlacement.forEach((group, index) => group.forEach((id) => partOf.set(id, String(index))))
  const all = [...partOf.keys()]
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (partOf.get(all[i]) === partOf.get(all[j])) continue
      const gap = distance(worldRing(project, all[i]), worldRing(project, all[j]))
      assert(gap >= GAP - 1e-6, `${all[i]} and ${all[j]} are ${gap} apart, need ${GAP}`)
    }
  }
  // The two strokes of each letter stayed joined.
  c1.forEach((id, index) => assert(overlapArea(worldRing(project, id), worldRing(project, c2[index])) > 0, `stroke pair ${index} still overlaps`))

  useProjectStore.getState().discardNest(nestId)
  assert(JSON.stringify(useProjectStore.getState().project.features) === JSON.stringify(before.features), 'discard restores the design')
  console.log('mixed nest: PASSED')
}

function testLegacyRecordLoads(): void {
  const project = makeProject()
  const legacy = {
    ...JSON.parse(JSON.stringify(project)),
    nests: [{
      id: 'nest-old', name: 'Nest 1', folderId: null, sourceIds: ['a', 'a-hole'], copyIds: [], movedOriginals: [],
      settings: { quantity: 4, rotations: [0, 180], minimumGap: 6, keepOriginals: false },
    }],
  }
  const loaded = normalizeProject(legacy as ProjectFormatInput)
  const record = loaded.nests?.[0]
  assert(record && record.parts.length === 1, 'a prototype record loads as one part')
  assert(record.parts[0].sourceIds.join() === 'a,a-hole' && record.parts[0].quantity === 4, 'its sources and quantity carry over')
  assert(!('quantity' in record.settings), 'the settings lose the per-part field')
  console.log('legacy nest record: PASSED')
}

testSplitting()
testMixedNest()
testLegacyRecordLoads()
console.log('All multipart nesting tests passed')
