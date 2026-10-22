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
import { isDeepStrictEqual } from 'node:util'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { isRoundStock, roundStockCentre } from '../../types/project'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'
import { resolveFinishModelSurface } from './finishModelSurface'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import { generateRotaryFinish, generateRotaryRough, rotaryAlongRange, sampleRotaryModel } from './rotaryModel'

for (const axis of ['x', 'y'] as const) {
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const project = rotaryOperationFixture(axis, kind)
    const operation = project.operations[0]
    const stock = project.stock
    assert.ok(isRoundStock(stock))
    const tool = normalizeToolForProject(project.tools[0], project)
    const mesh = resolveFinishModelSurface(project, resolveFeatureInstances(project, ['model']))!.mesh
    const range = rotaryAlongRange(stock, project.clamps, { min: 3, max: 27 }, tool, { chuckEnd: 0, tailEnd: 0 })!
    assert.deepEqual(range, { start: 3, end: 27 })
    const envelope = computeOperationToolpath(project, operation, { trace: true })!
    assert.equal(envelope.raw, null, 'rotary bypasses the flat trace/wrapping pipeline')
    assert.ok(envelope.result.moves.length > 0, `${axis} ${kind} produces moves`)
    const generator = kind === 'rotary_rough' ? generateRotaryRough : generateRotaryFinish
    const expected = generator(operation.id, mesh, stock, tool, {
      stepover: operation.stepover * tool.diameter, stepdown: operation.stepdown,
      sampleSpacing: kind === 'rotary_finish' ? tool.radius / 4 : tool.radius / 2,
      stockToLeave: operation.stockToLeaveRadial,
      requestedCellSize: Math.min(tool.radius / 3, operation.stepover * tool.diameter * 0.5),
      alongStart: range.start, alongEnd: range.end, safeRadius: project.meta.maxTravelZ - stock.thickness / 2,
    }, {})
    assert.ok(isDeepStrictEqual(envelope.result.moves, expected.moves), 'dispatch returns the already wrapped moves unchanged, with every operation parameter')
    const along = (point: { x: number; y: number }) => axis === 'x' ? point.x : point.y
    for (const move of envelope.result.moves) for (const point of [move.from, move.to]) {
      assert.ok(point.a !== undefined, 'every endpoint carries A')
      assert.equal(axis === 'x' ? point.y : point.x, roundStockCentre(stock), 'across stays on the centreline')
      assert.ok(along(point) >= range.start && along(point) <= range.end, 'every endpoint respects the along range')
    }
    // Independent samples at cutting endpoints, including an odd return pass.
    // The comparison is against the model-only sample, whose height-map grid is
    // aligned to the model while the generator's is aligned to the bar (the
    // retained-bar stubs extend it to both bar ends). A cell centre can move by
    // one cell, and the fixture's top face rises 1 mm over 24 mm, so 0.02 mm
    // covers the 0.333 mm cell's shift plus Float32 values and point merging --
    // far below the gouge this guards against.
    const CELL_SHIFT = 0.02
    const cuts = envelope.result.moves.filter((move) => move.kind === 'cut' && move.from.a === move.to.a && along(move.from) !== along(move.to))
    for (const move of [cuts[0], cuts[Math.floor(cuts.length / 2)], cuts.at(-1)!]) {
      const point = move.to
      const s = operation.stockToLeaveRadial
      const row = sampleRotaryModel(mesh, stock, { ...tool, radius: tool.radius + s, diameter: tool.diameter + 2 * s }, {
        anglesDeg: [point.a!], along: [along(point)], requestedCellSize: Math.min(tool.radius / 3, operation.stepover * tool.diameter * 0.5),
      }, []).tipRadius[0]
      const tip = Number.isFinite(row[0]) ? Math.max(0, Math.min(stock.thickness / 2, row[0] + s)) : 0
      assert.ok(point.z >= stock.thickness / 2 + tip - CELL_SHIFT, 'no endpoint cuts below the model plus normal stock')
    }
    const supported = computeOperationToolpath(project, { ...operation, rotaryChuckSupport: 9, rotaryTailSupport: 6 })!.result
    assert.ok(supported.moves.length > 0)
    assert.ok(supported.moves.every((move) => [move.from, move.to].every((point) => along(point) >= 9 && along(point) <= 24)), 'support fields reach the generated path')
    assert.notDeepEqual(supported.moves, envelope.result.moves)
    const bare = { ...operation, rotaryChuckSupport: undefined, rotaryTailSupport: undefined }
    assert.deepEqual(computeOperationToolpath(project, bare)!.result.moves, envelope.result.moves, 'missing supports read as zero')
    const noStock = computeOperationToolpath(project, { ...operation, stockToLeaveRadial: 0 })!.result
    assert.notDeepEqual(noStock.moves, envelope.result.moves, 'radial stock changes the output')
    if (kind === 'rotary_finish') {
      // The first cut sample sits at the bar's surface whatever the stock: the
      // retained bar holds the cutter above it at the model's own end. The
      // stock is normal to the surface, so on a vertical wall it barely moves
      // Z; take the largest per-move offset over the whole path.
      const stockOffsets = envelope.result.moves.flatMap((move, index) =>
        move.kind === 'cut' && move.from.a === move.to.a && along(move.from) !== along(move.to)
          ? [move.to.z - noStock.moves[index].to.z] : [])
      assert.ok(Math.max(...stockOffsets) > 0.3, 'normal stock is physically left on the cut faces')
    }
    const noRoom = computeOperationToolpath(project, { ...operation, rotaryChuckSupport: 30 })!.result
    assert.equal(noRoom.moves.length, 0)
    assert.equal(noRoom.warnings[0].code, 'rotaryNoRoom')
    const top = computeOperationToolpath(project, { ...operation, setupId: project.setups[0].id })!.result
    assert.equal(top.moves.length, 0, 'rotary on Top produces no motion')
    assert.equal(top.warnings[0].code, 'aroundStockMismatch')
    const missing = computeOperationToolpath(project, { ...operation, target: { source: 'features', featureIds: [] } })!.result
    assert.equal(missing.warnings[0].code, 'finishNeedsModel')
    const unsupported = computeOperationToolpath({ ...project, tools: [{ ...project.tools[0], type: 'v_bit' }] }, operation)!.result
    assert.equal(unsupported.warnings[0].code, 'rotaryToolUnsupported')
    assert.equal(unsupported.moves.length, 0)
    const lowRapid = computeOperationToolpath({ ...project, meta: { ...project.meta, maxTravelZ: 5 } }, operation)!.result
    assert.equal(lowRapid.moves[0].to.z, stock.thickness + tool.diameter, 'low saved rapid height falls back above the bar')
  }
}
// All targeted model meshes are joined, including transformed instances.
const unionProject = rotaryOperationFixture()
const second = { ...unionProject.features[0], id: 'second', transform: { ...unionProject.features[0].transform, f: 0.5 } }
unionProject.features.push(second)
const one = resolveFinishModelSurface(unionProject, resolveFeatureInstances(unionProject, ['model']))!.mesh
const two = resolveFinishModelSurface(unionProject, resolveFeatureInstances(unionProject, ['model', 'second']))!.mesh
assert.equal(two.positions.length, 2 * one.positions.length)
const op = unionProject.operations[0]
const singlePath = computeOperationToolpath(unionProject, op)!.result
const combinedPath = computeOperationToolpath(unionProject, { ...op, target: { source: 'features', featureIds: ['model', 'second'] } })!.result
assert.notDeepEqual(combinedPath.moves, singlePath.moves, 'every targeted transformed model reaches rotary sampling')

// #1045 slice R2: an along finish reads the raw stock only. An earlier rough,
// its settings, its enabled flag and its position in the list are all
// irrelevant to the finish's motion, so a rough that is disabled, excluded from
// the export, in another program or simply not run cannot leave the finish
// unprotected.
{
  const fixture = rotaryOperationFixture('x', 'rotary_finish')
  const finish = fixture.operations[0]
  const rough = { ...finish, id: 'rough', name: 'rough', kind: 'rotary_rough' as const, pass: 'rough' as const }
  const alone = computeOperationToolpath(fixture, finish)!.result
  assert.deepEqual(alone.warnings, [], 'a bare along finish warns about nothing')
  assert.ok(alone.moves.length > 0, 'a bare along finish clears its own blank and cuts')
  const withRough = computeOperationToolpath({ ...fixture, operations: [rough, finish] }, finish)!.result
  assert.deepEqual(withRough.moves, alone.moves,
    'an earlier rough does not change the along finish, even though it clears material the finish re-cuts')
  // A rough on another tool, with another stepdown, is still not read.
  const otherTool = { ...fixture.tools[0], id: 't2', diameter: 6, defaultStepdown: 0.3 }
  const otherRough = { ...rough, id: 'rough2', toolRef: 't2', stepdown: 0.3 }
  const foreign = computeOperationToolpath({
    ...fixture, tools: [...fixture.tools, otherTool], operations: [otherRough, finish],
  }, finish)!.result
  assert.deepEqual(foreign.moves, alone.moves, 'a rough on another tool does not change the finish')
  const later = computeOperationToolpath({ ...fixture, operations: [finish, rough] }, finish)!.result
  assert.deepEqual(later.moves, alone.moves, 'a rough after the finish does not change it')
  const disabled = computeOperationToolpath({
    ...fixture,
    operations: [rough, finish].map((operation) => operation.id === rough.id ? { ...operation, enabled: false } : operation),
  }, finish)!.result
  assert.deepEqual(disabled.moves, alone.moves, 'a disabled rough does not change the finish')

  // #1045 slice R2: no usable depth on the operation or the tool refuses with
  // the around finish's code instead of generating an unprotected finish.
  const noDepthTool = { ...fixture.tools[0], defaultStepdown: 0 }
  const refused = computeOperationToolpath({
    ...fixture,
    tools: [noDepthTool],
    operations: [{ ...finish, stepdown: 0 }],
  }, { ...finish, stepdown: 0 })!.result
  assert.deepEqual(refused.moves, [], 'a no-stepdown along finish emits no motion')
  assert.deepEqual(refused.warnings.map((warning) => warning.code), ['stepdownPositive'],
    'a no-stepdown along finish refuses')
}
console.log('rotaryOperation integration tests passed')
