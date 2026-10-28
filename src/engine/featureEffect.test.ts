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

/// <reference types="node" />

/**
 * The "no effect" verdict (issue #1112 slice N, decision 12).
 *
 * These assertions pin the decision, not a recorded result:
 * - a fully covered earlier feature warns; a partially covered one does not
 * - a later feature that is shallower does not erase material, so no warning
 * - a later feature of the same type does not erase the contribution
 * - a model (and therefore a Turn/Polygon model) never warns and never covers
 * - a later feature's outer outline is cover regardless of its own holes /
 *   islands; a hole or island never stands in for an outer outline
 * - an edit rechecks only the earlier features its box overlaps, through the
 *   real cache, and the warning moves with the edit
 *
 * Mutations checked against these assertions (one at a time):
 * - reporting any overlap as full cover: the partial-cover test fails
 * - dropping the Z-span containment check: the shallower test fails
 * - never invalidating a cache entry on an edit: the edit test fails
 * - running coverage at the default Clipper scale: the inch-strip test fails
 *   (the surviving strip rounds away and the Add is wrongly reported covered)
 * - taking a non-empty coarse remainder as conclusive: the collinear-vertex
 *   test is missed (the coarse pass rounds the vertex off the cover edge)
 * - dropping the confirmation-scale range check: the large-magnitude strip
 *   test warns (the 4e8 coordinate lands on a half count and rounds away)
 *
 * Run with: npx tsx src/engine/featureEffect.test.ts
 */

import { FeatureEffectAnalyzer, type FeatureEffectFeature, type FeatureEffectShape } from './featureEffect'
import { rectProfile, type FeatureOperation, type Point, type SetupFace } from '../types/project'

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  operation: FeatureOperation,
): FeatureEffectShape {
  return { profile: rectProfile(x, y, width, height), operation }
}

/** A closed polygon through the given points, in order. */
function polygon(points: Point[], operation: FeatureOperation): FeatureEffectShape {
  const [start, ...rest] = points
  return {
    profile: {
      start,
      segments: rest.map((point) => ({ type: 'line' as const, to: point })),
      closed: true,
    },
    operation,
  }
}

interface FeatureOptions {
  zTop?: number
  zBottom?: number
  face?: SetupFace
  visible?: boolean
}

function feature(
  id: string,
  operation: FeatureOperation,
  shapes: FeatureEffectShape[],
  options: FeatureOptions = {},
): FeatureEffectFeature {
  return {
    id,
    operation,
    face: options.face ?? 'top',
    zTop: options.zTop ?? 10,
    zBottom: options.zBottom ?? 0,
    visible: options.visible ?? true,
    shapes,
  }
}

function warningsOf(analyzer: FeatureEffectAnalyzer, features: FeatureEffectFeature[]): string[] {
  return [...analyzer.analyze(features)].sort()
}

// A later Subtract exactly covering the earlier Add erases it.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')]),
  ]
  assertEqual(warningsOf(analyzer, features).join(','), 'island', 'fully covered feature warns')
}

// A strip that survives quantization is never rounded away into a warning.
// The same geometry in inch and millimetre units must agree.
{
  // 10 in Add, 9.99996 in Subtract: a 0.00004 in strip survives on the right.
  const analyzer = new FeatureEffectAnalyzer()
  const inch = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('pocket', 'subtract', [rect(0, 0, 9.99996, 10, 'subtract')]),
  ]
  assertEqual(warningsOf(analyzer, inch).join(','), '', 'a surviving inch strip does not warn')

  // The same geometry in millimetres: 254 vs 253.998984.
  const mmAnalyzer = new FeatureEffectAnalyzer()
  const mm = [
    feature('island', 'add', [rect(0, 0, 254, 254, 'add')]),
    feature('pocket', 'subtract', [rect(0, 0, 253.998984, 254, 'subtract')]),
  ]
  assertEqual(warningsOf(mmAnalyzer, mm).join(','), '', 'a surviving mm strip does not warn')

  // A just-covered case must still warn: the cover removes the whole outline,
  // so there is no surviving region to protect.
  const exactAnalyzer = new FeatureEffectAnalyzer()
  const exact = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('pocket', 'subtract', [rect(0, 0, 10, 10, 'subtract')]),
  ]
  assertEqual(warningsOf(exactAnalyzer, exact).join(','), 'island', 'an exact cover still warns')
}

// A surviving strip at large magnitude is not rounded away at either scale.
// 400000000 vs 399999999.99999994 is a 5.96e-8 strip, one double step; at the
// confirmation scale that coordinate is 4e15, where the double product lands
// on a half count and Math.round erases the strip. The range check declines to
// confirm rather than report coverage.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('island', 'add', [rect(0, 0, 400000000, 10, 'add')]),
    feature('pocket', 'subtract', [rect(0, 0, 399999999.99999994, 10, 'subtract')]),
  ]
  assertEqual(
    warningsOf(analyzer, features).join(','),
    '',
    'a surviving strip at large magnitude does not warn',
  )
}

// Exact coverage where the subject has an extra collinear vertex on its
// hypotenuse. At the coarse scale (.03125, .96875) rounds to (313, 9688),
// one count off the cover's edge, so the coarse difference is a quantization
// artefact; the confirmation scale must decide that the cover is exact.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('subject', 'add', [
      polygon(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0.03125, y: 0.96875 },
          { x: 0, y: 1 },
        ],
        'add',
      ),
    ]),
    feature('cover', 'subtract', [
      polygon(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
        'subtract',
      ),
    ]),
  ]
  assertEqual(
    warningsOf(analyzer, features).join(','),
    'subject',
    'a collinear vertex does not hide an exact cover',
  )
}

// Covering only part of the outline leaves material standing.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('pocket', 'subtract', [rect(0, 0, 6, 10, 'subtract')]),
  ]
  assertEqual(warningsOf(analyzer, features).join(','), '', 'partial cover does not warn')
}

// A shallower later Subtract removes its own depth but leaves the rest.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')], { zTop: 10, zBottom: 0 }),
    feature('pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')], { zTop: 10, zBottom: 5 }),
  ]
  assertEqual(warningsOf(analyzer, features).join(','), '', 'later feature shallower does not warn')
}

// Same type adds nothing on top of the same material.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('first', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('second', 'add', [rect(-1, -1, 12, 12, 'add')]),
  ]
  assertEqual(warningsOf(analyzer, features).join(','), '', 'same-type later feature does not warn')
}

// Hidden features are not in the fold, so they neither warn nor cover.
{
  const analyzer = new FeatureEffectAnalyzer()
  const visible = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')]),
  ]
  assertEqual(warningsOf(analyzer, visible).join(','), 'island', 'visible fixture warns')
  assertEqual(
    warningsOf(analyzer, [
      visible[0],
      feature('pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')], { visible: false }),
    ]).join(','),
    '',
    'a hidden coverer does not erase anything',
  )
  assertEqual(
    warningsOf(analyzer, [
      feature('island', 'add', [rect(0, 0, 10, 10, 'add')], { visible: false }),
      visible[1],
    ]).join(','),
    '',
    'a hidden feature is not warned about',
  )
}

// A model is not a flat feature: it never warns and never covers.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('model', 'model', [rect(-1, -1, 12, 12, 'model')]),
  ]
  assertEqual(warningsOf(analyzer, features).join(','), '', 'a model does not cover a flat feature')
  assertEqual(
    warningsOf(analyzer, [
      feature('model', 'model', [rect(0, 0, 10, 10, 'model')]),
      feature('pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')]),
    ]).join(','),
    '',
    'a model is never warned about',
  )
}

// A flat feature on Bottom shares the stock plan with Top.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('top-island', 'add', [rect(0, 0, 10, 10, 'add')], { face: 'top' }),
    feature('bottom-pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')], { face: 'bottom' }),
  ]
  assertEqual(warningsOf(analyzer, features).join(','), 'top-island', 'Top and Bottom share one fold')
}

// Around compares only with Around, in the unrolled sheet.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('sheet-island', 'add', [rect(0, 0, 10, 10, 'add')], { face: 'around' }),
    feature('flat-pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')], { face: 'top' }),
  ]
  assertEqual(warningsOf(analyzer, features).join(','), '', 'flat geometry does not cover the sheet')
}

// The cache: one edit rechecks only the earlier rows whose box it overlaps.
{
  const analyzer = new FeatureEffectAnalyzer()
  const first = [
    feature('left', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('right', 'add', [rect(100, 0, 10, 10, 'add')]),
    feature('far', 'add', [rect(1000, 0, 10, 10, 'add')]),
    feature('cut', 'subtract', [rect(-1, -1, 12, 12, 'subtract')]),
  ]
  const firstEvaluated: string[] = []
  const firstWarnings = analyzer.analyze(first, { onEvaluate: (id) => firstEvaluated.push(id) })
  assertEqual(firstEvaluated.join(','), 'left,right,far,cut', 'the first pass evaluates every row')
  assertEqual([...firstWarnings].join(','), 'left', 'the first pass warns the covered row')

  // The edit grows the cut into the right-hand row; the far row is untouched.
  const grownCut = feature('cut', 'subtract', [rect(-1, -1, 112, 12, 'subtract')])
  const second = [first[0], first[1], first[2], grownCut]
  const secondEvaluated: string[] = []
  const secondWarnings = analyzer.analyze(second, { onEvaluate: (id) => secondEvaluated.push(id) })
  assertEqual(secondEvaluated.join(','), 'left,right,cut', 'only the overlapped earlier rows and the edit recheck')
  assertEqual([...secondWarnings].join(','), 'left,right', 'the warning follows the edit')
}

// The cache survives an unrelated edit: a row far away re-evaluates nothing.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('left', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('right', 'add', [rect(100, 0, 10, 10, 'add')]),
    feature('cut', 'subtract', [rect(-1, -1, 12, 12, 'subtract')]),
  ]
  analyzer.analyze(features)
  const evaluated: string[] = []
  analyzer.analyze(
    [features[0], feature('right', 'add', [rect(100, 0, 10, 10, 'add')], { zTop: 11 }), features[2]],
    { onEvaluate: (id) => evaluated.push(id) },
  )
  assertEqual(evaluated.join(','), 'right', 'an edit rechecks itself, not a disjoint earlier row')
}

// Once a verdict is cached, an unchanged tree reuses every entry.
{
  const analyzer = new FeatureEffectAnalyzer()
  const features = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')]),
  ]
  analyzer.analyze(features)
  const evaluated: string[] = []
  const warnings = analyzer.analyze(features, { onEvaluate: (id) => evaluated.push(id) })
  assertEqual(evaluated.length, 0, 'an unchanged tree evaluates nothing')
  assertEqual([...warnings].join(','), 'island', 'the cached warning is still returned')
}

// A face change between the flat and Around domains invalidates the earlier
// flat warning even though the edited row is now in the other domain.
{
  const analyzer = new FeatureEffectAnalyzer()
  const first = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')], { face: 'top' }),
    feature('pocket', 'subtract', [rect(-1, -1, 12, 12, 'subtract')], { face: 'top' }),
  ]
  assertEqual([...analyzer.analyze(first)].join(','), 'island', 'flat coverage warns before the face change')
  const second = [first[0], { ...first[1], face: 'around' as const }]
  const evaluated: string[] = []
  const warnings = analyzer.analyze(second, { onEvaluate: (id) => evaluated.push(id) })
  assertEqual(evaluated.join(','), 'island,pocket', 'the earlier flat row and the changed row recheck')
  assertEqual([...warnings].join(','), '', 'Around no longer covers the flat row')
}

// A later feature's hole does not weaken its outer outline: its outer piece
// normalises the material before the hole/island pieces apply. Only the
// matching-operation outer outlines are cover, never a hole or an island.
{
  const analyzer = new FeatureEffectAnalyzer()
  const covered = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('holed', 'subtract', [
      rect(-1, -1, 12, 12, 'subtract'),
      rect(4, 4, 2, 2, 'add'),
    ]),
  ]
  assertEqual(warningsOf(analyzer, covered).join(','), 'island', 'the outer part of a holed feature is cover')

  const outerTooSmall = [
    feature('island', 'add', [rect(0, 0, 10, 10, 'add')]),
    feature('holed', 'subtract', [
      rect(0, 0, 4, 4, 'subtract'),
      rect(0, 0, 10, 10, 'add'),
    ]),
  ]
  assertEqual(
    warningsOf(analyzer, outerTooSmall).join(','),
    '',
    'a hole/island piece does not stand in for an outer outline that does not cover',
  )
}

console.log('featureEffect.test.ts: all assertions passed')
