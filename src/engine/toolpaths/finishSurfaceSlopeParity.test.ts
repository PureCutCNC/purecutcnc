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

// Captured BEFORE #702's generator changes at c2354aa618a45d4eba147d2d33123a5147958de7.
// Compared with the prior 31b36db capture, only #704's three flat-top waterline rows changed.
// Both the raw toolpath result and posted program must remain byte-identical.
const baseline: Record<string, {moves: number; motion: string; gcode: string}> = {
  "3d-imported-block-test3.camj/op6792424/parallel": {
    "moves": 3915,
    "motion": "24336cbc8f719d4f7742fbfa1b97617a88337fa36067e97ce26ba8619704dbcc",
    "gcode": "4bdc3fd0790fc22797aecfa1acd4db4ca09e0089fcaa12fa0313ef2dd8ff1500"
  },
  "3d-imported-block-test3.camj/op6792424/waterline": {
    "moves": 3321,
    "motion": "03443fc401d29e3da124f57af6c6378839f289a2b5187ee823180ed66e4209de",
    "gcode": "23a929748dd41929ad79bed98e6861ae9762771d4f23cfe9a77022485c76177c"
  },
  "3d-imported-block-test3.camj/op6792425/parallel": {
    "moves": 3915,
    "motion": "ad1152a5ebb65c08d0fc79af8877fa8c04b4c0591b5cf0d584e36da4d2517246",
    "gcode": "11756942fc4e249272cf0f8ca4870fe08a1a5fae749a160b78a66e0be5accbbe"
  },
  "3d-imported-block-test3.camj/op6792425/waterline": {
    "moves": 3321,
    "motion": "29a74a1af1be28985a6b3cec25a15e25cd670aa7ab3a71cef7a3a9ec92b2d19c",
    "gcode": "21c1732f2a990faa154dd82b09080e63c4467c274f983228f693ad8032050aab"
  },
  "issue-401-cone-finish.camj/op0925/parallel": {
    "moves": 28245,
    "motion": "90f269ecedd76071d76daf03757c4f2da1dbff9556f2a03e74b6ddf75715acc9",
    "gcode": "132a41b34125066dc5563cc43d5e3b775f83eef9276a5df32719f30367b56b66"
  },
  "issue-401-cone-finish.camj/op0925/waterline": {
    "moves": 5415,
    "motion": "c7f5400ed2ae38429727a7221eabdbf3cb81624a0790d6ec43cae3a4dd3b1ff7",
    "gcode": "d82c4a4b4de24321889ecd60f2cd3a8f3e1da28235f5e8d552b407c907a76bc0"
  },
  "issue-401-cone-finish.camj/op0927/parallel": {
    "moves": 28245,
    "motion": "3ece4d1b531592a575d1fbc131afcc332798c22b80ed578ef71303dda4f9de96",
    "gcode": "99ca7dc8d150e01d14910249813c7de3d7cc04aac0a34aeca6567e5b74ea1295"
  },
  "issue-401-cone-finish.camj/op0927/waterline": {
    "moves": 5415,
    "motion": "e822baf0d9779f9ab8c3a807284bc8db3b8dd3d55fca86330a75692dde74cbf2",
    "gcode": "877d04d11e8b6343e48ff06b4d10f11768c053ea513a2024094e55637518e7e0"
  },
  "model-in-pocket.camj/op6792442/parallel": {
    "moves": 4852,
    "motion": "51a62f12b731df863a4b88119ac7c445a665dc042f4a657b443be6d7f968c736",
    "gcode": "5df9b0905683601f9e16dacdb780cef8f3f6c2f2e5f5e63117cf890c7af4e52d"
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
  test(`${name}: omitted slope settings preserve pre-change moves and G-code`, () => {
    const project = normalizeProject(JSON.parse(readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), 'utf8')))
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
