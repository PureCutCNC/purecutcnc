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
 * Arc fitting over real trochoidal output (issue #448).
 *
 * Trochoidal roughing is the densest thing this exporter emits: overlapping
 * orbits sampled to the design's chord and sagitta bounds produce tens of
 * thousands of linear moves per operation. Arc output is the only lever that
 * keeps that exportable — measured here, a 30 mm square drops from ~159 KB to
 * ~52 KB — so if fitting ever silently stops applying to this geometry the
 * practical consequence is a multi-megabyte file per operation, not a subtly
 * wrong path.
 *
 * The other suites cover the fitter in isolation on hand-built chords. This one
 * covers it end to end on generated trochoidal geometry, which is where the
 * small radii and seam closures actually occur.
 *
 * Run with: npx tsx src/engine/gcode/trochoidalArcExport.test.ts
 */

import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generateEdgeRouteToolpath } from '../toolpaths/edge'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathResult } from '../toolpaths/types'
import { runPostProcessor } from './postprocessor'
import { BUNDLED_DEFINITIONS } from './definitions'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const SIZE = 30

function fixture(): { project: Project; operation: Operation; tool: Tool } {
  const tool: Tool = { ...defaultTool('mm', 1), id: 't1', name: 'em6', diameter: 6, defaultStepdown: 2 }
  const target: SketchFeature = {
    id: 'target',
    name: 'target',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, SIZE, SIZE),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 0,
    z_bottom: -2,
    visible: true,
    locked: false,
  }
  const project = projectWithFeatures({ ...newProject('trochoidal arcs', 'mm'), tools: [tool] }, [target])
  const operation: Operation = {
    id: 'op1',
    name: 'op',
    kind: 'edge_route_outside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['target'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    edgeStrategy: 'trochoidal',
    trochoidalCutWidth: 9,
    trochoidalAdvance: 0.1,
    entryStrategy: 'helix',
    entryRampAngle: 5,
  }
  return { project, operation, tool }
}

function machine(id: string) {
  const definition = BUNDLED_DEFINITIONS.find((entry) => entry.id === id)
  assert(definition !== undefined, `bundled machine definition "${id}" not found`)
  return definition
}

function exportGcode(
  project: Project,
  operation: Operation,
  tool: Tool,
  toolpath: ToolpathResult,
  arcFittingEnabled: boolean,
): { gcode: string; warnings: string[] } {
  const result = runPostProcessor({
    project,
    definition: machine('grbl'),
    operations: [{
      operation: { ...operation, arcFittingEnabled },
      toolpath,
      tool: normalizeToolForProject(tool, project),
    }],
    options: { emitToolChanges: false, emitCoolant: false, programName: 'trochoidal-arcs' },
  })
  return { gcode: result.gcode, warnings: result.warnings.map((warning) => warning.code) }
}

/** G-code is modal, so arcs are counted by their required I/J words. */
function arcCount(gcode: string): number {
  return gcode.split('\n').filter((line) => /(^|\s)[IJ]-?\d/.test(line)).length
}

function testTrochoidalExportFitsArcs(): void {
  console.log('Testing arc fitting applies to generated trochoidal output...')
  const { project, operation, tool } = fixture()
  const toolpath = generateEdgeRouteToolpath(project, operation)
  assert(
    toolpath.warnings.length === 0,
    `fixture produced warnings: ${toolpath.warnings.map((w) => w.code).join(', ')}`,
  )
  assert(toolpath.moves.length > 5000, `expected dense trochoidal output, got ${toolpath.moves.length} moves`)

  const linear = exportGcode(project, operation, tool, toolpath, false)
  const fitted = exportGcode(project, operation, tool, toolpath, true)

  assert(arcCount(linear.gcode) === 0, 'arc fitting disabled must emit no arcs')
  assert(arcCount(fitted.gcode) > 100, `expected trochoidal loops to fit many arcs, got ${arcCount(fitted.gcode)}`)

  const linearLines = linear.gcode.split('\n').length
  const fittedLines = fitted.gcode.split('\n').length
  assert(
    fittedLines * 3 < linearLines,
    `arc fitting must materially shrink trochoidal output, got ${linearLines} -> ${fittedLines} lines`,
  )
  // The byte ratio is 2.5x, not 3x, and the difference is the input not the
  // fitter. Issue #660 replaced the 36-step orbit floor with the sagitta bound
  // the design actually contracts for, so the same orbits arrive as a third
  // fewer, longer chords:
  //
  //   before #660   9554 lines / 237,505 B  ->  1699 lines / 51,598 B (1572 arcs)
  //   after  #660   6410 lines / 159,304 B  ->  1699 lines / 51,577 B (1570 arcs)
  //
  // Fitting is unchanged — same arcs, same output, from less input — but the
  // achievable compression fell from 4.6x to 3.1x, leaving the old 3x threshold
  // 2.9% of headroom. That is a tripwire, not a guard. At 2.5x the headroom is
  // 19% and a fitting failure (which collapses the ratio toward 1x) is still
  // caught with room to spare.
  assert(
    fitted.gcode.length * 2.5 < linear.gcode.length,
    `arc fitting must materially shrink the exported bytes, got ${linear.gcode.length} -> ${fitted.gcode.length}`,
  )

  console.log(
    `  ${linearLines} lines / ${linear.gcode.length} B  ->  `
      + `${fittedLines} lines / ${fitted.gcode.length} B (${arcCount(fitted.gcode)} arcs)`,
  )
}

function testFittedTrochoidalExportRaisesNoArcWarnings(): void {
  console.log('Testing fitted trochoidal export raises no arc warnings on an arc-capable machine...')
  const { project, operation, tool } = fixture()
  const toolpath = generateEdgeRouteToolpath(project, operation)
  const fitted = exportGcode(project, operation, tool, toolpath, true)

  assert(
    !fitted.warnings.includes('postArcNoCapability'),
    'GRBL declares arc interpolation, so no capability warning is expected',
  )
  // A fallback means the fitter produced an arc the formatter then rejected —
  // exactly the issue #447 failure mode, on the geometry that triggered it.
  assert(
    !fitted.warnings.includes('postArcFallbackLinear'),
    'fitted trochoidal arcs must survive endpoint projection and formatting; '
      + `got warnings [${fitted.warnings.join(', ')}]`,
  )
}

function testMachineWithoutArcsStillExportsLinear(): void {
  console.log('Testing a machine without arc interpolation still exports trochoidal linearly...')
  const { project, operation, tool } = fixture()
  const toolpath = generateEdgeRouteToolpath(project, operation)
  const definition = machine('grbl')
  const noArcs = { ...definition, motion: { ...definition.motion, arcInterpolation: false } }

  const result = runPostProcessor({
    project,
    definition: noArcs,
    operations: [{
      operation: { ...operation, arcFittingEnabled: true },
      toolpath,
      tool: normalizeToolForProject(tool, project),
    }],
    options: { emitToolChanges: false, emitCoolant: false, programName: 'trochoidal-no-arcs' },
  })

  assert(arcCount(result.gcode) === 0, 'a machine without arc interpolation must not receive arcs')
  assert(result.gcode.split('\n').length > 5000, 'linear fallback must still emit the full path')
}

testTrochoidalExportFitsArcs()
testFittedTrochoidalExportRaisesNoArcWarnings()
testMachineWithoutArcsStillExportsLinear()

console.log('trochoidal arc export tests passed')
