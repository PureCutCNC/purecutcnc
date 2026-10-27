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
import { rotaryMultiModelFixture, rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { isRoundStock, roundStockCentre, type Operation, type Project } from '../../types/project'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'
import { resolveFinishModelSurface } from './finishModelSurface'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import { generateRotaryFinish, generateRotaryRough, rotaryAlongRange, sampleRotaryModel } from './rotaryModel'
import {
  rotaryFinishWithoutRough,
  rotaryPrecedingRoughs,
  rotaryTargetModelIds,
  rotaryTargetRegions,
  rotaryUncoveredModelIds,
} from './rotaryOperation'

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

// 2026-10-22 decision: a finish emits only its model-following motion, and the
// operation list changes only its advisory warning. An enabled rotary rough on
// the same model earlier in the same setup suppresses `rotaryFinishWithoutRough`
// (the rough left at most one of its stepdowns); a disabled rough, a rough on
// another model, a rough in another setup, a rough later in the list and no
// rough at all keep it.
{
  const fixture = rotaryOperationFixture('x', 'rotary_finish')
  const finish = fixture.operations[0]
  const rough = { ...finish, id: 'rough', name: 'rough', kind: 'rotary_rough' as const, pass: 'rough' as const }
  const warning = (result: { warnings: Array<{ code: string; params?: Record<string, string | number | readonly string[]> }> }) =>
    result.warnings.filter((entry) => entry.code === 'rotaryFinishWithoutRough')
  const alone = computeOperationToolpath(fixture, finish)!.result
  assert.deepEqual(alone.warnings, [{
    code: 'rotaryFinishWithoutRough', params: { operation: 'Rotary finish', model: ['Model'] },
  }], 'a bare along finish is warned that it cuts to full depth in one pass, naming the uncovered model')
  assert.ok(alone.moves.length > 0, 'and it still follows the model and cuts')
  const withRough = computeOperationToolpath({ ...fixture, operations: [rough, finish] }, finish)!.result
  assert.deepEqual(warning(withRough), [], 'an enabled rough before the finish suppresses the warning')
  assert.deepEqual(withRough.moves, alone.moves,
    'an earlier rough does not change the finish motion')
  // A rough on another tool is still a rough on this model, so it suppresses
  // the advisory; only the model, the setup and the order matter.
  const otherTool = { ...fixture.tools[0], id: 't2', diameter: 6, defaultStepdown: 0.3 }
  const otherRough = { ...rough, id: 'rough2', toolRef: 't2', stepdown: 0.3 }
  const foreign = computeOperationToolpath({
    ...fixture, tools: [...fixture.tools, otherTool], operations: [otherRough, finish],
  }, finish)!.result
  assert.deepEqual(warning(foreign), [], 'a rough on another tool but the same model suppresses the warning')
  assert.deepEqual(foreign.moves, alone.moves, 'and does not change the finish motion')
  const later = computeOperationToolpath({ ...fixture, operations: [finish, rough] }, finish)!.result
  assert.deepEqual(warning(later).length, 1, 'a rough after the finish does not count')
  assert.deepEqual(later.moves, alone.moves, 'and does not change the finish motion')
  const disabled = computeOperationToolpath({
    ...fixture,
    operations: [rough, finish].map((operation) => operation.id === rough.id ? { ...operation, enabled: false } : operation),
  }, finish)!.result
  assert.deepEqual(warning(disabled).length, 1, 'a disabled rough does not count')
  assert.deepEqual(disabled.moves, alone.moves, 'and does not change the finish motion')
  const anotherModel = computeOperationToolpath({
    ...fixture, operations: [{ ...rough, target: { source: 'features', featureIds: ['other-model'] } }, finish],
  }, finish)!.result
  assert.deepEqual(warning(anotherModel).length, 1, 'a rough on another model does not count')
  const anotherSetup = computeOperationToolpath({
    ...fixture,
    setups: [...fixture.setups, { ...fixture.setups[0], id: 'other-setup', name: 'Other' }],
    operations: [{ ...rough, setupId: 'other-setup' }, finish],
  }, finish)!.result
  assert.deepEqual(warning(anotherSetup).length, 1, 'a rough in another setup does not count')
  // A zero saved stepdown is a finish field the generator no longer reads: the
  // finish still follows the model, and the advisory is about the operation
  // order, not about a rough's depth.
  const zeroDepth = computeOperationToolpath({
    ...fixture, operations: [{ ...rough, stepdown: 0 }, { ...finish, stepdown: 0 }],
  }, { ...finish, stepdown: 0 })!.result
  assert.deepEqual(zeroDepth.warnings, [], 'a zero saved stepdown does not refuse or warn the finish')
  assert.deepEqual(zeroDepth.moves, alone.moves, 'the finish ignores the saved stepdown entirely')
}

// #1045 slice V / #1096: the advisory is per STL model **and per region**. A
// finish cutting A and B is unprotected while either model has no enabled
// rough before it in the setup; a rough covers a finish's area only when the
// rough has no region (the whole bar) or carries the finish's own region ids.
// A Region id is never a model, and a model id is never a region.
{
  const project = rotaryMultiModelFixture('x', 'rotary_finish')
  const finish = {
    ...project.operations[0],
    target: { source: 'features' as const, featureIds: ['model', 'second'] },
  }
  const withRegion = {
    ...finish,
    target: { source: 'features' as const, featureIds: ['model', 'second', 'region'] },
  }
  const rough = (id: string, featureIds: string[]) => ({
    ...finish, id, name: id, kind: 'rotary_rough' as const, pass: 'rough' as const,
    target: { source: 'features' as const, featureIds },
  })
  const regionFeature = project.features.find((feature) => feature.id === 'region')!
  const otherRegionProject = {
    ...project,
    features: [...project.features, { ...regionFeature, id: 'region-2', name: 'Region 2' }],
  }
  const withOtherRegion = {
    ...finish,
    target: { source: 'features' as const, featureIds: ['model', 'second', 'region-2'] },
  }
  const targets = rotaryTargetModelIds(project, finish)
  assert.deepEqual(targets, ['model', 'second'], 'only the two STL targets are models')
  assert.deepEqual(
    rotaryTargetModelIds(project, withRegion), ['model', 'second'],
    'a region id in the target is not a model',
  )
  assert.deepEqual(
    rotaryTargetRegions(project, finish),
    { includeIds: [], excludeIds: [], entries: [] },
    'a finish without a region filters nothing',
  )
  assert.deepEqual(
    rotaryTargetRegions(project, withRegion),
    { includeIds: ['region'], excludeIds: [], entries: [{ id: 'region', mode: 'include' }] },
    'the region id and its include mode are the finish filter, in composition order',
  )
  // The rule the adapter and the cache share: build the dependency list the
  // real helper consumes, then decide.
  const decide = (
    projectForDecide: Project,
    operations: Operation[],
    target: Operation,
  ): boolean => rotaryFinishWithoutRough(
    rotaryPrecedingRoughs({ ...projectForDecide, operations: [...operations, target] }, target),
    rotaryTargetModelIds(projectForDecide, target),
    rotaryTargetRegions(projectForDecide, target),
  )
  assert.equal(
    decide(project, [rough('b', ['second'])], finish), true,
    'a rough on B only leaves A unprotected',
  )
  assert.equal(
    decide(project, [rough('ab', ['model', 'second'])], finish), false,
    'one rough on both models protects both',
  )
  assert.equal(
    decide(project, [rough('a', ['model']), rough('b', ['second'])], finish), false,
    'separate roughs on each model protect both',
  )
  assert.equal(
    decide(project, [rough('region', ['region'])], withRegion), true,
    'a shared region id does not stand in for a model',
  )
  assert.equal(
    decide(project, [rough('all', ['model', 'second', 'region'])], withRegion), false,
    'a rough on both models plus the same region protects both',
  )
  // #1096: the region half of the rule.
  assert.equal(
    decide(project, [rough('ab', ['model', 'second'])], withRegion), false,
    'a rough with no region cuts the whole bar, so it covers a finish region too',
  )
  assert.equal(
    decide(project, [rough('ab', ['model', 'second', 'region'])], finish), true,
    'a rough with a region does not cover a finish with none: the whole bar is not prepared',
  )
  assert.equal(
    decide(project, [rough('ab', ['model', 'second']), rough('region', ['region'])], withRegion), false,
    'either a whole-bar rough or a same-region rough covers the finish',
  )
  assert.equal(
    decide(otherRegionProject, [rough('ab-other', ['model', 'second', 'region-2'])], withRegion), true,
    'a different region is not the same region, even on the same models',
  )
  assert.equal(
    decide(otherRegionProject, [rough('ab-other', ['model', 'second', 'region-2'])], withOtherRegion), false,
    'the same other region does cover that finish',
  )
  // #1096 review (P2): an exclude suppresses cutting in every layer, so it is
  // part of the mask comparison too. A rough that excludes E does not prepare E
  // for a finish that cuts it, even when both carry the same include region.
  const excludeProject = {
    ...project,
    featureDefinitions: {
      ...project.featureDefinitions,
      exclude: {
        ...project.featureDefinitions[regionFeature.definitionId],
        id: 'exclude',
        regionMaskMode: 'exclude' as const,
      },
    },
    features: [...project.features, {
      ...regionFeature, id: 'exclude', name: 'Exclude', definitionId: 'exclude',
    }],
  }
  const finishWithExclude = {
    ...finish,
    target: { source: 'features' as const, featureIds: ['model', 'second', 'region', 'exclude'] },
  }
  assert.equal(
    decide(excludeProject, [rough('ab-rxe', ['model', 'second', 'region', 'exclude'])], withRegion), true,
    'a rough that adds an exclude the finish does not have leaves that area unroughed: warn',
  )
  assert.equal(
    decide(excludeProject, [rough('ab-rxe', ['model', 'second', 'region', 'exclude'])], finishWithExclude), false,
    'the same include set and no extra excludes covers the finish: stay quiet',
  )
  assert.equal(
    decide(excludeProject, [rough('ab-r', ['model', 'second', 'region'])], finishWithExclude), false,
    'a rough with the same include and fewer excludes covers a finish that excludes more',
  )
  assert.equal(
    decide(excludeProject, [rough('ab-e', ['model', 'second', 'exclude'])], withRegion), true,
    'an exclude-only rough is not the same include set as an include-region finish',
  )
  // #1096 re-review (P2): the mask order decides, so the same ids in the other
  // order are not the same coverage. `exclude E` before `include R` leaves the
  // finish cutting everything outside E, including area outside R that a rough
  // on R alone never touched; `include R` before `exclude E` cuts only R.
  const excludeFeature = excludeProject.features.find((feature) => feature.id === 'exclude')!
  const excludeFirstProject = {
    ...excludeProject,
    features: [
      ...excludeProject.features.filter((feature) => feature.id !== 'region' && feature.id !== 'exclude'),
      excludeFeature,
      regionFeature,
    ],
  }
  assert.deepEqual(
    rotaryTargetRegions(excludeFirstProject, finishWithExclude),
    {
      includeIds: ['region'],
      excludeIds: ['exclude'],
      entries: [{ id: 'exclude', mode: 'exclude' }, { id: 'region', mode: 'include' }],
    },
    'the filter keeps the project-feature order the mask is composed in',
  )
  assert.equal(
    decide(excludeFirstProject, [rough('ab-r', ['model', 'second', 'region'])], finishWithExclude), true,
    'an exclude before the include lets the finish cut outside R: warn despite the same id sets',
  )
  assert.equal(
    decide(excludeProject, [rough('ab-r', ['model', 'second', 'region'])], finishWithExclude), false,
    'the same ids with the include first cut only R: stay quiet',
  )
  // #1096 re-review (P2): coverage is containment, not set equality. A rough on
  // R + S covers a finish on R alone; the exact-set rule warned here.
  assert.equal(
    decide(otherRegionProject, [rough('ab-rs', ['model', 'second', 'region', 'region-2'])], withRegion), false,
    'a rough on R and S covers a finish on R: a superset of includes is covered',
  )
  assert.equal(
    decide(otherRegionProject, [rough('ab-s', ['model', 'second', 'region-2'])], withRegion), true,
    'a rough on S alone does not cover a finish on R',
  )
  const warned = (operations: Operation[], target: Operation = finish) => computeOperationToolpath({
    ...project, operations: [...operations, target],
  }, target)!.result.warnings.filter((warning) => warning.code === 'rotaryFinishWithoutRough')
  assert.equal(warned([rough('b', ['second'])]).length, 1,
    'the adapter warns when only one of two targeted models has a preceding rough')
  assert.deepEqual(warned([rough('b', ['second'])])[0].params,
    { operation: finish.name, model: ['Model'] },
    'the advisory names the one uncovered model, not "this model"')
  assert.deepEqual(rotaryUncoveredModelIds(
    rotaryPrecedingRoughs({ ...project, operations: [rough('b', ['second']), finish] }, finish),
    rotaryTargetModelIds(project, finish),
    rotaryTargetRegions(project, finish),
  ), ['model'], 'the uncovered-model helper lists only the model without a rough, in target order')
  assert.deepEqual(rotaryUncoveredModelIds(
    rotaryPrecedingRoughs({ ...project, operations: [finish] }, finish),
    rotaryTargetModelIds(project, finish),
    rotaryTargetRegions(project, finish),
  ), ['model', 'second'], 'and lists every uncovered model, in target order')
  assert.deepEqual(warned([])[0].params,
    { operation: finish.name, model: ['Model', 'Second'] },
    'the advisory names every uncovered model when there is no rough at all')
  assert.deepEqual(warned([rough('ab', ['model', 'second'])]), [],
    'the adapter stays quiet when both targeted models have one')
  assert.deepEqual(warned([rough('ab', ['model', 'second'])], withRegion), [],
    'the adapter stays quiet when a whole-bar rough precedes a region finish')
  assert.equal(warned([rough('region', ['region'])], withRegion).length, 1,
    'the adapter warns when the preceding rough covers only its own region')
  // The adapter's own input path must read the exclude mode, not just the id.
  const warnedWithExclude = computeOperationToolpath({
    ...excludeProject, operations: [rough('ab-rxe', ['model', 'second', 'region', 'exclude']), withRegion],
  }, withRegion)!.result.warnings.filter((warning) => warning.code === 'rotaryFinishWithoutRough')
  assert.equal(warnedWithExclude.length, 1,
    'the adapter warns when the rough excludes an area the finish still cuts')
}
console.log('rotaryOperation integration tests passed')
