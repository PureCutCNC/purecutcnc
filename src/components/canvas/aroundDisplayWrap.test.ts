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
 * Folding drawn geometry into the Around sheet (issue #1112 slice L, decision
 * 8.13): a shape or toolpath crossing the seam draws as two pieces at the
 * right x, a multi-turn thread becomes stripes inside the sheet, and a
 * computed toolpath is never changed — only its drawing.
 *
 * Mutations checked one at a time against these assertions:
 * - the seam split removed → the crossing assertions fail (one piece, and the
 *   end still at 120, outside the sheet);
 * - the shift applied to the stored geometry instead of the drawn copy → the
 *   "the source path is untouched" assertions fail;
 * - a hand-drawn sketch folded like a canned one → "a hand-drawn sketch is
 *   drawn as it was drawn" fails;
 * - the inside fast path removed → the identity assertions fail (a new object
 *   every frame);
 * - the fold cache removed → "the folded display path is the same object
 *   between frames" fails.
 *
 * Run with: npx tsx src/components/canvas/aroundDisplayWrap.test.ts
 */

import type { SketchFeature, SketchProfile } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { rotaryPatternCannedData } from '../../store/helpers/rotaryPatterns'
import type { RotaryPatternFrame } from '../../engine/rotaryPatterns'
import { featureDisplayProfiles } from './aroundFeatureDisplay'
import {
  foldProfileToSheet,
  foldToolpathForDisplay,
  foldToolpathToSheet,
} from './aroundDisplayWrap'
import type { AroundWrapWindow } from './aroundDisplayWrap'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function near(actual: number, expected: number, message: string, epsilon = 1e-9): void {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`)
}

// A 100-unit circumference with the sheet running 0..100 across. The numbers
// are chosen so every seam crossing lands on a round coordinate.
const X_SHEET: AroundWrapWindow = { axis: 'x', sheetStart: 0, circumference: 100 }
const Y_SHEET: AroundWrapWindow = { axis: 'y', sheetStart: 0, circumference: 100 }

function lineProfile(
  from: { x: number; y: number },
  to: { x: number; y: number },
): SketchProfile {
  return {
    start: from,
    segments: [{ type: 'line', to }],
    closed: false,
  }
}

function profilePoints(profile: SketchProfile): { x: number; y: number }[] {
  return [profile.start, ...profile.segments.map((segment) => segment.to)]
}

function acrossOf(sheet: AroundWrapWindow, point: { x: number; y: number }): number {
  return sheet.axis === 'x' ? point.y : point.x
}

// ── A shape crossing the seam draws as two pieces ────────────

{
  const profile = lineProfile({ x: 10, y: 80 }, { x: 30, y: 120 })
  const pieces = foldProfileToSheet(profile, X_SHEET)
  assert(pieces.length === 2, `a shape crossing the seam is two pieces (${pieces.length})`)

  // The first piece stops on the sheet's far edge; the second resumes at its
  // near edge, both at the along coordinate the seam crossing lands on.
  const first = profilePoints(pieces[0])
  const second = profilePoints(pieces[1])
  assert(JSON.stringify(first[0]) === JSON.stringify({ x: 10, y: 80 }), `first piece starts where drawn: ${JSON.stringify(first[0])}`)
  near(first[1].x, 20, 'the first piece hits the seam halfway along')
  near(first[1].y, 100, "the first piece ends on the sheet's far edge")
  assert(JSON.stringify(second[0]) === JSON.stringify({ x: 20, y: 0 }), `second piece starts on the near edge: ${JSON.stringify(second[0])}`)
  assert(JSON.stringify(second[1]) === JSON.stringify({ x: 30, y: 20 }), `second piece ends where drawn, folded: ${JSON.stringify(second[1])}`)
}

{
  // The same crossing on a Y bar is folded across X, never Y.
  const profile = lineProfile({ x: 80, y: 10 }, { x: 120, y: 30 })
  const pieces = foldProfileToSheet(profile, Y_SHEET)
  assert(pieces.length === 2, `a Y bar shape crossing the seam is two pieces (${pieces.length})`)
  const first = profilePoints(pieces[0])
  const second = profilePoints(pieces[1])
  near(first[1].y, 20, 'a Y bar keeps the along coordinate')
  near(first[1].x, 100, "a Y bar ends on the sheet's far edge (X)")
  near(second[0].x, 0, 'a Y bar resumes on the near edge (X)')
  near(second[1].y, 30, 'a Y bar keeps the along end')
}

// ── A 20-turn thread is stripes inside the sheet ─────────────

{
  const profile = lineProfile({ x: 0, y: 0 }, { x: 2000, y: 2000 })
  const pieces = foldProfileToSheet(profile, X_SHEET)
  assert(pieces.length === 20, `a 20-circumference line is 20 stripes (${pieces.length})`)
  for (const [index, piece] of pieces.entries()) {
    for (const point of profilePoints(piece)) {
      const across = acrossOf(X_SHEET, point)
      assert(
        across >= X_SHEET.sheetStart - 1e-9 && across <= X_SHEET.sheetStart + X_SHEET.circumference + 1e-9,
        `stripe ${index} stays inside the sheet: ${across}`,
      )
    }
  }
}

// ── A shape already on the sheet is not changed ──────────────

{
  const profile = lineProfile({ x: 10, y: 40 }, { x: 30, y: 60 })
  const pieces = foldProfileToSheet(profile, X_SHEET)
  assert(pieces.length === 1 && pieces[0] === profile, 'a shape inside the sheet is returned untouched')
}

// ── A toolpath crossing the seam draws as two pieces ─────────

{
  const source: ToolpathResult = {
    operationId: 'op',
    moves: [{ kind: 'cut', from: { x: 10, y: 80, z: 5 }, to: { x: 30, y: 120, z: 5 } }],
    warnings: [],
    bounds: null,
  }
  const folded = foldToolpathToSheet(source, X_SHEET)
  assert(folded !== source, 'a folded toolpath is a new drawing')
  assert(folded.moves.length === 2, `a path crossing the seam is two pieces (${folded.moves.length})`)
  near(folded.moves[0].to.x, 20, 'the first move hits the seam halfway along')
  near(folded.moves[0].to.y, 100, "the first move ends on the sheet's far edge")
  near(folded.moves[1].from.x, 20, 'the second move resumes at the same along coordinate')
  near(folded.moves[1].from.y, 0, 'the second move resumes on the near edge')
  near(folded.moves[1].to.y, 20, 'the second move ends where drawn, folded')

  // Only the drawing changed: the generated/stored path keeps its coordinates.
  // A fold that wrote the shifted coordinate back into the source fails here.
  near(source.moves[0].to.y, 120, 'the source path keeps its own across coordinate')
  near(source.moves[0].from.y, 80, 'the source path keeps its own start')
}

{
  // A path wholly inside the sheet is the very same object, so the renderers'
  // identity caches are not churned.
  const source: ToolpathResult = {
    operationId: 'op',
    moves: [{ kind: 'cut', from: { x: 10, y: 40, z: 5 }, to: { x: 30, y: 60, z: 5 } }],
    warnings: [],
    bounds: null,
  }
  assert(foldToolpathToSheet(source, X_SHEET) === source, 'a toolpath inside the sheet is returned untouched')
  assert(foldToolpathForDisplay(source, X_SHEET) === source, 'the display fold keeps an inside path identical')
}

// ── The display fold is cached per frame ────────────────────

{
  const source: ToolpathResult = {
    operationId: 'op',
    moves: [{ kind: 'cut', from: { x: 10, y: 80, z: 5 }, to: { x: 30, y: 120, z: 5 } }],
    warnings: [],
    bounds: null,
  }
  const first = foldToolpathForDisplay(source, X_SHEET)
  assert(foldToolpathForDisplay(source, X_SHEET) === first, 'the folded display path is the same object between frames')
}

// ── Hand-drawn sketches stay as drawn ───────────────────────

function plainFeature(profile: SketchProfile): SketchFeature {
  return {
    id: 'plain',
    name: 'Hand drawn',
    kind: 'composite',
    stl: null,
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'line',
    authoringFace: 'around',
    z_top: 10,
    z_bottom: 9,
    visible: true,
    locked: false,
  }
}

{
  const profile = lineProfile({ x: 0, y: 0 }, { x: 2000, y: 2000 })
  const feature = plainFeature(profile)
  const drawn = featureDisplayProfiles(feature, X_SHEET)
  assert(drawn.length === 1 && drawn[0] === profile, 'a hand-drawn sketch is drawn as it was drawn')
}

// ── A canned shape is drawn folded ──────────────────────────

{
  const frame: RotaryPatternFrame = {
    axis: 'x',
    zero: 0,
    circumference: X_SHEET.circumference,
    radius: 10,
    alongOrigin: 0,
    alongDirection: 1,
  }
  const canned = rotaryPatternCannedData(frame, {
    kind: 'thread',
    start: 0,
    length: 200,
    pitch: 10,
    starts: 1,
    depth: 1,
    hand: 'right',
  })
  assert(canned !== null, 'the thread test fixture builds')
  const feature: SketchFeature = {
    ...plainFeature(lineProfile({ x: 0, y: 0 }, { x: 200, y: 2000 })),
    name: 'Thread',
    canned,
  }
  const drawn = featureDisplayProfiles(feature, X_SHEET)
  assert(drawn.length === 20, `a 20-turn canned thread draws 20 stripes (${drawn.length})`)
  for (const profile of drawn) {
    for (const point of profilePoints(profile)) {
      const across = acrossOf(X_SHEET, point)
      assert(across >= -1e-9 && across <= X_SHEET.circumference + 1e-9, `canned stripe stays inside the sheet: ${across}`)
    }
  }
  // The stored feature is untouched: the drawing is a fold, not a second
  // geometry. Its generated outline still runs past the sheet.
  const generated = featureDisplayProfiles(feature, null)
  assert(generated.length === 1, 'the canned shape still generates one continuous line')
}

console.log('aroundDisplayWrap: all assertions passed')
