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
 * A follow-line operation's "targets missing" warning resolves targets the way
 * the cut does (issue #1112, slice rt4-d).
 *
 * The warning used to compare the number of expanded geometries against the
 * number of selected targets, so every canned pattern with more than one child
 * — the four Flutes lines of the maintainer's thread-on-turn file, or any text
 * run with several glyphs — reported its target as missing while the operation
 * generated the toolpath correctly. A target that resolves is never missing; a
 * target that resolves but expands into nothing says so with its own message.
 *
 * Run with: npx tsx src/engine/toolpaths/followLineTargets.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, roundStock } from '../../types/project'
import type { Operation, Project } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import type { SelectionState } from '../../store/types'
import { computeOperationToolpath } from './generateOperation'
import type { ToolpathWarningCode } from './warningCodes'

const store = () => useProjectStore.getState()

const EMPTY_SELECTION: SelectionState = {
  mode: 'feature',
  selectedFeatureId: null,
  selectedFeatureIds: [],
  selectedTabIds: [],
  selectedClampIds: [],
  selectedNode: null,
  hoveredFeatureId: null,
  sketchEditTool: null,
  activeControl: null,
  groupFolderId: null,
}

/**
 * A round 40 x 200 bar, with or without a Turn model covering it. The Turn is
 * the maintainer's "on a Turn" case: the canned pattern then measures its depth
 * from the turned surface instead of the raw bar, and generation runs against
 * the turned project rather than plain stock.
 */
function barProject(options: { turn: boolean }): Project {
  const base = newProject('follow-line targets', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x')
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 2, maxCutDepth: 25 }]
  if (!options.turn) return base
  const planned = planRotarySolid(base, EMPTY_SELECTION, { kind: 'turn', start: 0, length: 200, diameter: 40 })
  assert.ok(planned.ok, `the Turn model must be created (${planned.ok ? '' : planned.reason})`)
  return planned.project
}

interface EngraveCase {
  project: Project
  operation: Operation
  targetId: string
}

/**
 * Create the canned pattern on the Around sheet through the same store action
 * the panel uses, target it with a follow-line operation, and return the
 * project the Properties panel would read.
 */
function engraveOn(kind: 'flutes' | 'thread', options: { turn: boolean }): EngraveCase {
  store().loadProject(barProject(options))
  assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available on a round bar')
  const created = store().addRotaryPattern(kind === 'flutes'
    ? { kind: 'flutes', start: 10, length: 20, count: 4, twist: 1, depth: 1 }
    : { kind: 'thread', start: 10, length: 20, pitch: 2, starts: 1, depth: 0.8 })
  assert.ok(created.ok, `the ${kind} pattern must be created (${created.ok ? '' : created.reason})`)
  const target = { source: 'features' as const, featureIds: [created.featureId] }
  const operationId = store().addOperation('follow_line', 'finish', target)
  assert.ok(operationId, `the follow-line operation must be accepted on the ${kind}`)
  store().updateOperation(operationId, { toolRef: 't1', carveDepth: 0.5, stepdown: 0.5 })
  const project = store().project
  const operation = project.operations.find((row) => row.id === operationId)
  assert.ok(operation, 'the operation is in the project')
  return { project, operation, targetId: created.featureId }
}

function withOperation(project: Project, operation: Operation): Project {
  return { ...project, operations: project.operations.map((row) => (row.id === operation.id ? operation : row)) }
}

function warningCodes(project: Project, operation: Operation): ToolpathWarningCode[] {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'follow_line is a kind the dispatch handles')
  return envelope.result.warnings.map((warning) => warning.code)
}

function moveCount(project: Project, operation: Operation): number {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'follow_line is a kind the dispatch handles')
  return envelope.result.moves.length
}

// ---------------------------------------------------------------------------
// A target that exists and generates is never reported missing
// ---------------------------------------------------------------------------

// The file that filed this: Engrave 3 on a Flutes target over a Turn. Flutes
// expands into one geometry per flute line (four here), Thread into one, and
// both are cut — neither may warn that its target is missing.
for (const kind of ['flutes', 'thread'] as const) {
  for (const turn of [true, false] as const) {
    const label = `${kind} on ${turn ? 'a Turn' : 'plain bar stock'}`
    const { project, operation } = engraveOn(kind, { turn })
    const codes = warningCodes(project, operation)
    assert.ok(
      !codes.includes('targetsMissing'),
      `${label}: a target that generates must not be reported missing, got [${codes.join(', ')}]`,
    )
    assert.ok(
      !codes.includes('targetsNoGeometry'),
      `${label}: a target that generates has geometry, got [${codes.join(', ')}]`,
    )
    assert.ok(moveCount(project, operation) > 0, `${label}: the toolpath must be generated`)
  }
}

// ---------------------------------------------------------------------------
// A target that is really gone still warns
// ---------------------------------------------------------------------------

{
  const { project, operation } = engraveOn('flutes', { turn: true })
  const patched: Operation = { ...operation, target: { source: 'features', featureIds: ['deleted-target'] } }
  const deleted = withOperation(project, patched)
  const codes = warningCodes(deleted, patched)
  assert.ok(codes.includes('targetsMissing'), `a deleted target must still be reported missing, got [${codes.join(', ')}]`)
  assert.ok(
    !codes.includes('targetsNoGeometry'),
    `a deleted target is missing, not geometry-less, got [${codes.join(', ')}]`,
  )
  assert.equal(moveCount(deleted, patched), 0, 'nothing is cut for a target that does not exist')
}

// ---------------------------------------------------------------------------
// A target that exists but yields no geometry says that instead
// ---------------------------------------------------------------------------

{
  // A stored canned shape whose parameters no longer normalize (an edited or
  // hand-loaded file) resolves as a feature but expands into no outline.
  const { project, operation, targetId } = engraveOn('flutes', { turn: true })
  const broken = structuredClone(project)
  const instance = broken.features.find((row) => row.id === targetId)
  assert.ok(instance, 'the target instance is in the project')
  const definition = broken.featureDefinitions[instance.definitionId]
  assert.ok(definition?.canned, 'the target definition carries canned parameters')
  broken.featureDefinitions[instance.definitionId] = {
    ...definition,
    canned: { ...definition.canned, params: { ...definition.canned.params, length: 0 } },
  }
  const codes = warningCodes(broken, operation)
  assert.ok(
    codes.includes('targetsNoGeometry'),
    `a target with no geometry must say so, got [${codes.join(', ')}]`,
  )
  assert.ok(
    !codes.includes('targetsMissing'),
    `a target that exists is not missing, got [${codes.join(', ')}]`,
  )
  assert.equal(moveCount(broken, operation), 0, 'a geometry-less target cuts nothing')
}

console.log('follow-line target warning tests passed')
