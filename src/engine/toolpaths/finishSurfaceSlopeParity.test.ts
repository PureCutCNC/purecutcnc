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
const baseline: Record<string, {moves: number; motion: string; gcode: string}> = {
  "3d-imported-block-test3.camj/op6792424/parallel": {
    "moves": 3990,
    "motion": "6da5830f50426c7f9ff513b39403c867f41d373f0ce2c08d1a2ba42f75834929",
    "gcode": "87e86b2241c884ef5fd53de00370d1b1aa1c8edd3185b203d652de12407ee21f"
  },
  "3d-imported-block-test3.camj/op6792424/waterline": {
    "moves": 3323,
    "motion": "0e082c29859152dec78d32443feb592b3a4256abeb87ece9167a1848857dec0b",
    "gcode": "f50842293b2674c166b49c7c35b99a491a010f8d0da668538317182bc10c128b"
  },
  "3d-imported-block-test3.camj/op6792425/parallel": {
    "moves": 3990,
    "motion": "a92478eeb03c84cb5a2d005c3a3ed349aa39aaee43de7e1cda73a16976d22a7d",
    "gcode": "83a731b9eebd46929b488663fc2da719078ce5464fd95426b4b3587959a292d8"
  },
  "3d-imported-block-test3.camj/op6792425/waterline": {
    "moves": 3323,
    "motion": "dd1417225749dffb93f8116706437a5826204538ff14c239f146e7ed2f240292",
    "gcode": "2b7c1a34d9365b2035df3f6223b69fac354682b9573e3df6636a8793ab4baa4d"
  },
  "issue-401-cone-finish.camj/op0925/parallel": {
    "moves": 28245,
    "motion": "90f269ecedd76071d76daf03757c4f2da1dbff9556f2a03e74b6ddf75715acc9",
    "gcode": "132a41b34125066dc5563cc43d5e3b775f83eef9276a5df32719f30367b56b66"
  },
  "issue-401-cone-finish.camj/op0925/waterline": {
    "moves": 5481,
    "motion": "dd0cbac54abc863f4207409e1ed3332d6ee75b308d255e5008c385b04d1ff802",
    "gcode": "9f9ca0bde7d3cffd040842328d65d90546fec53ff7f1ebb30fa738e2af7c016a"
  },
  "issue-401-cone-finish.camj/op0927/parallel": {
    "moves": 28245,
    "motion": "3ece4d1b531592a575d1fbc131afcc332798c22b80ed578ef71303dda4f9de96",
    "gcode": "99ca7dc8d150e01d14910249813c7de3d7cc04aac0a34aeca6567e5b74ea1295"
  },
  "issue-401-cone-finish.camj/op0927/waterline": {
    "moves": 5481,
    "motion": "4a7e468fa7ef48412313d79cd46fdc2d424aa8760e4774b0d6c42925a1ff55ab",
    "gcode": "386e8ead771625abe60b1ad21211715971d8af52c13feaa1991f47b55516d87b"
  },
  "model-in-pocket.camj/op6792442/parallel": {
    "moves": 786,
    "motion": "b7172e3a6f328fd188198a366eaf384b4ff74a2b12c1f204d2a468e3a3c6d6fc",
    "gcode": "97d9c2a6b3b1da8f5d6c5cafc270868eec5e7fbc9b2c02a1a4be861a606c98a9"
  },
  "model-in-pocket.camj/op6792442/waterline": {
    "moves": 3836,
    "motion": "e31625615929fefa03233a3dd1eb3554ecdcd27beb0578724958c5ddaa706a22",
    "gcode": "eae4febf8d8c3abc5dafc52b40ea4526cf7fff4a0a9e9f8c877cb858179c873d"
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
