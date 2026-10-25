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
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { normalizeProject } from '../../store/projectStore'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { optimizeLinearMoves } from './linearMoveOptimization'
import { normalizeToolForProject } from './geometry'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition, type MachineDefinition } from '../gcode/types'
import type { Project } from '../../types/project'

// Captured BEFORE #702's generator changes at c2354aa618a45d4eba147d2d33123a5147958de7.
// Compared with the prior 31b36db capture, only #704's three flat-top waterline rows changed.
//
// One row has moved since, deliberately. #711 stopped the height-map strategies
// machining a flat pass at the depth limit where there is no surface to cut, and
// `model-in-pocket.camj` is exactly that shape: a flat-topped block inside a
// pocket whose subtract floors the finish at Z 0.5. Its cutter-location surface
// has only two levels — 0.750 on 16.3 % of cells (the model top) and 0.300 on
// 83.7 % (its base) — and **zero cells between them**, so nothing on that model
// is reachable between the floor and the top. The parallel row therefore drops
// 4,852 -> 786 moves: 4,041 moves and 126.71 of 164.32 length were a flat pass
// at Z 0.500 over ground the pocket had already cleared, and the rest were the
// ramps into and out of it. The real Z 0.750 machining is untouched and in fact
// grows slightly, 752 -> 777 moves and 23.50 -> 24.79 of length, because the
// pass is now split at the boundary. The waterline row is byte-identical, since
// waterline never takes this path.
//
// Six more rows have moved since, deliberately, all from #938's cliff
// refinement: a surface-following pass no longer takes a straight move across
// a cliff between two of its vertices. Measured against each model's own mesh
// under the cutter footprint:
// - `3d-imported-block-test3.camj` parallel (both ops): 3,915 -> 3,990 moves.
//   Main cut up to 0.167" into the block's walls at 128 sampled points; now
//   none.
// - The same file's waterline (both ops): 3,321 -> 3,323 moves. Main cut
//   0.019" in at 4 points; now none.
// - `issue-401-cone-finish.camj` waterline (both ops): 5,415 -> 5,481 moves.
//   The ball's deepest dip is unchanged at 0.0125", at fewer points (2,723 ->
//   2,625).
// Its parallel rows and every `model-in-pocket.camj` row are byte-identical.
// Both the raw toolpath result and posted program must remain byte-identical.
// The `gcode` hashes were re-captured for #1057 slice F: every posted program
// here writes a tool change, and a tool change now carries one restart block
// (`G90 G94 G17`, the units word, a safe-Z rapid and the start plane). The
// `motion` hashes did not move — the generated toolpaths are unchanged.
// #1050 re-captures six rows on the two mesh fixtures and both model-in-pocket
// rows: the height map now raises the cells a triangle-with-no-cell-centre
// overlaps to its clipped maximum, so thin/off-lattice triangles add surface
// height the centre samples missed. `3d-imported-block-test3.camj` parallel
// 3990 -> 3989 and waterline 3323 -> 3320 (both operations); `model-in-pocket`
// parallel 786 -> 794 and waterline 3836 -> 3964. `issue-401-cone-finish.camj`
// is byte-identical. The maximum height-map and emitted-tip changes on these
// fixtures are measured and reported in the #1050 PR.
const baseline: Record<string, {moves: number; motion: string; gcode: string}> = {
  "3d-imported-block-test3.camj/op6792424/parallel": {
    "moves": 3989,
    "motion": "b58421690f0f37fce1da777d0f38b96d697fcdc8e3f6d5f7ca74e97aae0fbb4e",
    "gcode": "f82ea47b966efa60e8a5e21ed98f80d516598c389bfbccde3013e0e08809c505"
  },
  "3d-imported-block-test3.camj/op6792424/waterline": {
    "moves": 3320,
    "motion": "e16e9b1040b0af20d325d5cbe324daaed3c52c5d1e5299fb4440e345cb3263e1",
    "gcode": "4c279a67b4743df97a4824abe7603f47c2de736a32794c30234b9768bb745f56"
  },
  "3d-imported-block-test3.camj/op6792425/parallel": {
    "moves": 3989,
    "motion": "a6bd146c39df22714fb90a5c33b248a32b19db02c132d639230f09751df6f716",
    "gcode": "bbac4da1fa1cf19c384832f7b2dd54ece2467d7ede0ffd130acf2a3ca106a14f"
  },
  "3d-imported-block-test3.camj/op6792425/waterline": {
    "moves": 3320,
    "motion": "fafcde5e2eca99cbbd99616f412cd1472279bf3834e2dc7bb7ab37508854a23f",
    "gcode": "613fdb54453a4317571650a87203f5398c8880f2331820071ba47ccad6cbdac5"
  },
  "issue-401-cone-finish.camj/op0925/parallel": {
    "moves": 28245,
    "motion": "90f269ecedd76071d76daf03757c4f2da1dbff9556f2a03e74b6ddf75715acc9",
    "gcode": "fe2674e6c5daafdf0df08bf16ae5782ad80c203c9a5a93d662cdc71f8c459d6f"
  },
  "issue-401-cone-finish.camj/op0925/waterline": {
    "moves": 5481,
    "motion": "dd0cbac54abc863f4207409e1ed3332d6ee75b308d255e5008c385b04d1ff802",
    "gcode": "fa8f344e63ceb01036bc1263ec50cf52bc22c1a13d3e46ec5a0289be08b6e86a"
  },
  "issue-401-cone-finish.camj/op0927/parallel": {
    "moves": 28245,
    "motion": "3ece4d1b531592a575d1fbc131afcc332798c22b80ed578ef71303dda4f9de96",
    "gcode": "b5b99d4d41720991a941bccc33b3f0988028f6d8b58ccf70c9f3c2fd1b38e7b7"
  },
  "issue-401-cone-finish.camj/op0927/waterline": {
    "moves": 5481,
    "motion": "4a7e468fa7ef48412313d79cd46fdc2d424aa8760e4774b0d6c42925a1ff55ab",
    "gcode": "aa5559d91531f8cccc95f0c26eb7a15c0d3b53ee58cf22e0d8326569b695bd7e"
  },
  "model-in-pocket.camj/op6792442/parallel": {
    "moves": 794,
    "motion": "c8464da06323d0890cf2a50fc12d72d6d9fcc6bee330d8dfeb4148905abfe62a",
    "gcode": "e246749c6d010e20d4bc0104ea59e77ff9f1199d0cbeb0ae00d7e5021a735d90"
  },
  "model-in-pocket.camj/op6792442/waterline": {
    "moves": 3964,
    "motion": "154bf083f83c2f286eb2e341261c57a3375af679e3f6de2bee170bfde1c24be6",
    "gcode": "e0c603e2671e129dc7d5e60d2d3eb7018f31d1894bbce44a94eae4ac9757d158"
  }
}

function testMachineDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test',
    name: 'Test',
    description: 'Test controller',
    builtin: false,
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: {
      decimalPlaces: { mm: 3, inch: 4 },
      trailingZeros: false,
      leadingZero: true,
    },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: {
      header: ['; {programName}'],
      footer: [],
      commentPrefix: ';',
      commentSuffix: '',
      lineNumbers: false,
      lineNumberIncrement: 10,
    },
    workCoordinates: { selectCommand: null },
    motion: {
      rapidCommand: 'G0',
      linearCommand: 'G1',
      cwArcCommand: 'G2',
      ccwArcCommand: 'G3',
      arcFormat: 'ij',
      modalMotion: true,
    },
    feedSpeed: {
      feedCommand: 'F',
      rpmCommand: 'S',
      spindleOnCW: 'M3',
      spindleOnCCW: 'M4',
      spindleOff: 'M5',
      inlineWithMotion: true,
      modalFeedSpeed: true,
    },
    toolChange: {
      commands: ['M0 ; Tool change: {toolName}'],
      stopSpindleFirst: true,
      pauseAfterChange: false,
      pauseCommand: 'M0',
    },
    cannedCycles: null,
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}


const sha = (s: string) => createHash('sha256').update(s).digest('hex')
for (const name of ['3d-imported-block-test3.camj', 'issue-401-cone-finish.camj', 'model-in-pocket.camj']) {
  test(`${name}: omitted slope and scallop settings preserve pre-change moves and G-code`, () => {
    const serialized = readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), 'utf8')
    const rawProject = JSON.parse(serialized) as Project
    for (const operation of rawProject.operations) {
      assert(!('finishScallopHeight' in operation), `${name}/${operation.id} unexpectedly stores the new field`)
    }
    const project = normalizeProject(rawProject)
    const candidates = project.operations.filter(o => o.kind === 'finish_surface' || o.kind === 'finish_surface_cleanup')
    for (const original of candidates) for (const pocketPattern of ['parallel', 'waterline'] as const) {
      const operation = { ...original, kind: 'finish_surface' as const, pocketPattern }
      const result = generateFinishSurfaceToolpath(project, operation)
      const expected = baseline[`${name}/${original.id}/${pocketPattern}`]
      assert.equal(result.moves.length, expected.moves)
      assert.equal(sha(JSON.stringify(result)), expected.motion)
      const tool = normalizeToolForProject(project.tools.find(t => t.id === operation.toolRef)!, project)
      const post = runPostProcessor({ project, definition: testMachineDefinition(),
        operations: [{ operation, tool, toolpath: optimizeLinearMoves(result) }],
        options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
      })
      assert.equal(sha(post.gcode), expected.gcode)
      const cleared = generateFinishSurfaceToolpath(project, { ...operation, finishSlopeMin: undefined, finishSlopeMax: undefined })
      assert.equal(sha(JSON.stringify(cleared)), expected.motion)
    }
  })
}
