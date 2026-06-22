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

import type { Point, SketchProfile } from '../../types/project'
import {
  applyLineCornerChamfer,
  applyLineCornerFillet,
  buildArcSegmentFromThreePoints,
  closeOpenProfile,
  deleteAnchorFromProfile,
  deleteSegmentFromProfile,
  disconnectProfileAtAnchor,
  insertPointIntoProfile,
  splitBezierSegment,
} from './profileEdit'

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function assertClose(actual: number, expected: number, msg: string): void {
  assert(Math.abs(actual - expected) <= 1e-9, `${msg}: expected ${expected}, got ${actual}`)
}

function assertPointClose(actual: Point, expected: Point, msg: string): void {
  assertClose(actual.x, expected.x, `${msg}.x`)
  assertClose(actual.y, expected.y, `${msg}.y`)
}

function assertDeepEqual(actual: unknown, expected: unknown, msg: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  assert(actualJson === expectedJson, `${msg}: expected ${expectedJson}, got ${actualJson}`)
}

function squareProfile(): SketchProfile {
  return {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 10, y: 0 } },
      { type: 'line', to: { x: 10, y: 10 } },
      { type: 'line', to: { x: 0, y: 10 } },
      { type: 'line', to: { x: 0, y: 0 } },
    ],
    closed: true,
  }
}

function testInsertPointIntoProfile(): void {
  const profile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'line', to: { x: 10, y: 0 } }],
    closed: false,
  }

  const result = insertPointIntoProfile(profile, {
    kind: 'segment',
    segmentIndex: 0,
    point: { x: 4, y: 0 },
    t: 0.4,
  })

  assertDeepEqual(
    result,
    {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 4, y: 0 } },
        { type: 'line', to: { x: 10, y: 0 } },
      ],
      closed: false,
    },
    'insertPointIntoProfile splits a line segment',
  )
}

function testSplitBezierSegment(): void {
  const [left, right] = splitBezierSegment(
    { x: 0, y: 0 },
    {
      type: 'bezier',
      control1: { x: 0, y: 6 },
      control2: { x: 6, y: 6 },
      to: { x: 6, y: 0 },
    },
    0.5,
  )

  assertDeepEqual(
    [left, right],
    [
      {
        type: 'bezier',
        control1: { x: 0, y: 3 },
        control2: { x: 1.5, y: 4.5 },
        to: { x: 3, y: 4.5 },
      },
      {
        type: 'bezier',
        control1: { x: 4.5, y: 4.5 },
        control2: { x: 6, y: 3 },
        to: { x: 6, y: 0 },
      },
    ],
    'splitBezierSegment returns the De Casteljau halves',
  )
}

function testCloseOpenProfile(): void {
  const result = closeOpenProfile({
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 3, y: 0 } },
      { type: 'line', to: { x: 3, y: 2 } },
    ],
    closed: false,
  })

  assertDeepEqual(
    result,
    {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 3, y: 0 } },
        { type: 'line', to: { x: 3, y: 2 } },
        { type: 'line', to: { x: 0, y: 0 } },
      ],
      closed: true,
    },
    'closeOpenProfile appends a closing line',
  )
}

function testApplyLineCornerFillet(): void {
  const result = applyLineCornerFillet(
    {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 10, y: 0 } },
        { type: 'line', to: { x: 10, y: 10 } },
      ],
      closed: false,
    },
    1,
    2,
  )

  assert(result !== null, 'applyLineCornerFillet returns a profile')
  assertDeepEqual(result!.start, { x: 0, y: 0 }, 'fillet preserves open profile start')
  assert(result!.segments.length === 3, `fillet should create 3 segments, got ${result!.segments.length}`)
  assertDeepEqual(result!.segments[0], { type: 'line', to: { x: 8, y: 0 } }, 'fillet trims the incoming line')
  const arc = result!.segments[1]
  assert(arc.type === 'arc', 'fillet inserts an arc')
  assertPointClose(arc.center, { x: 8, y: 2 }, 'fillet arc center')
  assertPointClose(arc.to, { x: 10, y: 2 }, 'fillet arc endpoint')
  assert(!arc.clockwise, 'fillet arc direction')
  assertDeepEqual(result!.segments[2], { type: 'line', to: { x: 10, y: 10 } }, 'fillet keeps outgoing line')
}

function testApplyLineCornerChamfer(): void {
  const result = applyLineCornerChamfer(
    {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 10, y: 0 } },
        { type: 'line', to: { x: 10, y: 10 } },
      ],
      closed: false,
    },
    1,
    2,
  )

  assert(result !== null, 'applyLineCornerChamfer returns a profile')
  assertDeepEqual(result!.start, { x: 0, y: 0 }, 'chamfer preserves open profile start')
  assert(result!.segments.length === 3, `chamfer should create 3 segments, got ${result!.segments.length}`)
  assertDeepEqual(result!.segments[0], { type: 'line', to: { x: 8, y: 0 } }, 'chamfer trims the incoming line')
  assertDeepEqual(result!.segments[1], { type: 'line', to: { x: 10, y: 2 } }, 'chamfer inserts bevel line')
  assertDeepEqual(result!.segments[2], { type: 'line', to: { x: 10, y: 10 } }, 'chamfer keeps outgoing line')

  const closedAtStart = applyLineCornerChamfer(
    {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 10, y: 0 } },
        { type: 'line', to: { x: 10, y: 10 } },
        { type: 'line', to: { x: 0, y: 10 } },
        { type: 'line', to: { x: 0, y: 0 } },
      ],
      closed: true,
    },
    0,
    2,
  )
  assert(closedAtStart !== null, 'chamfer supports the closing anchor')
  assertDeepEqual(closedAtStart!.start, { x: 0, y: 2 }, 'chamfer moves closed profile start to the incoming trim point')
  assertDeepEqual(closedAtStart!.segments[0], { type: 'line', to: { x: 2, y: 0 } }, 'chamfer inserts the closing-anchor bevel')

  const angled = applyLineCornerChamfer(
    {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 10, y: 0 } },
        { type: 'line', to: { x: 15, y: 10 } },
      ],
      closed: false,
    },
    1,
    2,
  )
  assert(angled !== null, 'chamfer supports non-orthogonal line corners')
  assertPointClose(angled!.segments[0].to, { x: 8, y: 0 }, 'angled chamfer trims the incoming line')
  assertPointClose(angled!.segments[1].to, { x: 10 + (2 / Math.sqrt(5)), y: 4 / Math.sqrt(5) }, 'angled chamfer trims the outgoing line by the same distance')

  const arcNeighbor = applyLineCornerChamfer(
    {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 10, y: 0 } },
        { type: 'arc', center: { x: 10, y: 5 }, to: { x: 10, y: 10 }, clockwise: false },
      ],
      closed: false,
    },
    1,
    2,
  )
  assert(arcNeighbor === null, 'chamfer rejects non-line corner geometry')

  assert(applyLineCornerChamfer(result!, 0, 1) === null, 'chamfer rejects open-profile terminal anchors')
  assert(applyLineCornerChamfer(result!, 1, 0) === null, 'chamfer rejects zero distance')
  assert(applyLineCornerChamfer(result!, 1, 8) === null, 'chamfer rejects a distance that consumes an adjacent segment')
}

function testDeleteAnchorFromProfile(): void {
  const result = deleteAnchorFromProfile(squareProfile(), 1)
  assertDeepEqual(
    result,
    {
      start: { x: 0, y: 0 },
      segments: [
        { type: 'line', to: { x: 10, y: 10 } },
        { type: 'line', to: { x: 0, y: 10 } },
        { type: 'line', to: { x: 0, y: 0 } },
      ],
      closed: true,
    },
    'deleteAnchorFromProfile bridges across a closed-profile anchor',
  )
}

function testDeleteSegmentFromProfile(): void {
  const result = deleteSegmentFromProfile(squareProfile(), 1)
  assertDeepEqual(
    result,
    {
      profile: {
        start: { x: 10, y: 10 },
        segments: [
          { type: 'line', to: { x: 0, y: 10 } },
          { type: 'line', to: { x: 0, y: 0 } },
          { type: 'line', to: { x: 10, y: 0 } },
        ],
        closed: false,
      },
      splitProfile: null,
    },
    'deleteSegmentFromProfile opens a closed profile at the removed segment',
  )
}

function testDisconnectProfileAtAnchor(): void {
  const result = disconnectProfileAtAnchor(squareProfile(), 2)
  assertDeepEqual(
    result,
    {
      profile: {
        start: { x: 10, y: 10 },
        segments: [
          { type: 'line', to: { x: 0, y: 10 } },
          { type: 'line', to: { x: 0, y: 0 } },
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 10, y: 10 } },
        ],
        closed: false,
      },
      splitProfile: null,
    },
    'disconnectProfileAtAnchor opens a closed profile at the anchor',
  )
}

function testBuildArcSegmentFromThreePoints(): void {
  const segment = buildArcSegmentFromThreePoints(
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  )

  assert(segment !== null, 'buildArcSegmentFromThreePoints returns an arc')
  assert(segment!.type === 'arc', 'buildArcSegmentFromThreePoints segment type')
  assertPointClose(segment!.center, { x: 0, y: 0 }, 'three-point arc center')
  assertPointClose(segment!.to, { x: 0, y: 1 }, 'three-point arc endpoint')
  assert(!segment!.clockwise, 'three-point arc direction')
}

const tests: Array<() => void> = [
  testInsertPointIntoProfile,
  testSplitBezierSegment,
  testCloseOpenProfile,
  testApplyLineCornerFillet,
  testApplyLineCornerChamfer,
  testDeleteAnchorFromProfile,
  testDeleteSegmentFromProfile,
  testDisconnectProfileAtAnchor,
  testBuildArcSegmentFromThreePoints,
]

for (const test of tests) {
  test()
}

console.log('profileEdit.test PASS')
