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
 * Reproduce: half circles of Circle 4 cut by Cutter Circle
 * Verify clipperContourToProfilePreserving produces correct results.
 */
import { polygonProfile } from '../types/project'
import type { SketchFeature, SketchProfile, Point } from '../types/project'
import {
  flattenFeatureToClipperPath,
  executeClipTree,
  getClipperChildren,
  type ClipperPolyNode,
} from './helpers/clipping'
import {
  buildSegmentAnnotations,
  clipperContourToProfile,
  clipperContourToProfilePreserving,
} from '../engine/toolpaths/arcReconstruction'
import { flattenProfile } from '../engine/toolpaths/geometry'
import { splitClosedByOpen } from './helpers/polygonSplit'

function fakeFeature(profile: SketchProfile, name: string): SketchFeature {
  return { id: name, name, kind: 'polygon', folderId: null, locked: false, operation: 'add',
    sketch: { profile, constraints: [], dimensions: [], origin: { x: 0, y: 0 } },
    z_top: 0.75, z_bottom: 0 } as any
}

function signedArea(pts: Point[]): number {
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

const circle4Profile: SketchProfile = {
  start: { x: 2.5077822185373186, y: 1.5 },
  segments: [{ type: 'circle', center: { x: 1.5, y: 1.5 }, to: { x: 2.5077822185373186, y: 1.5 }, clockwise: true }],
  closed: true,
}

const polyline3Profile: SketchProfile = {
  start: { x: 0.25, y: 1.5 },
  segments: [{ type: 'line', to: { x: 3, y: 1.5 } }],
  closed: false,
}

const cutterCircleProfile: SketchProfile = {
  start: { x: 4, y: 1.5 },
  segments: [{ type: 'circle', center: { x: 3, y: 1.5 }, to: { x: 4, y: 1.5 }, clockwise: true }],
  closed: true,
}

const splitResult = splitClosedByOpen(circle4Profile, polyline3Profile)!
const piece0 = splitResult.pieces[0], piece1 = splitResult.pieces[1]
const bottomHalfPts = Math.min(...piece0.map(p => p.y)) < 1.49 ? piece0 : piece1
const topHalfPts = bottomHalfPts === piece0 ? piece1 : piece0

const bottomHalfFeat = fakeFeature(polygonProfile(bottomHalfPts), 'Bottom half (cartesian)')
const topHalfFeat = fakeFeature(polygonProfile(topHalfPts), 'Top half (cartesian, visually bottom)')
const cutterFeat = fakeFeature(cutterCircleProfile, 'Cutter Circle')

let allPassed = true

for (const [label, halfFeat] of [['BOTTOM (cartesian)', bottomHalfFeat], ['TOP (cartesian, visually bottom)', topHalfFeat]] as const) {
  console.log(`\n=== Cutting ${label} half ===`)
  const sourceFeatures = [cutterFeat, halfFeat]
  const segAnnotations = buildSegmentAnnotations(sourceFeatures)

  const subjectPath = flattenFeatureToClipperPath(halfFeat)
  const clipPath = flattenFeatureToClipperPath(cutterFeat)
  const polyTree = executeClipTree([subjectPath], [clipPath], 2)

  function check(node: ClipperPolyNode, depth = 0) {
    const contour = node.Contour()
    if (contour.length > 0) {
      const profile = clipperContourToProfilePreserving(contour, sourceFeatures, segAnnotations)
      if (profile) {
        const flat = flattenProfile(profile)
        const area = signedArea(flat.points)
        const segTypes = profile.segments.map(s => s.type)
        const arcCount = segTypes.filter(t => t === 'arc').length
        const lineCount = segTypes.filter(t => t === 'line').length

        console.log(`  Profile: ${profile.segments.length} segments (${lineCount} lines, ${arcCount} arcs)`)
        console.log(`  Signed area: ${area.toFixed(6)}`)

        // Validate arcs
        let cur = profile.start
        for (let i = 0; i < profile.segments.length; i++) {
          const seg = profile.segments[i]
          if (seg.type === 'arc') {
            const rStart = Math.hypot(cur.x - seg.center.x, cur.y - seg.center.y)
            const rEnd = Math.hypot(seg.to.x - seg.center.x, seg.to.y - seg.center.y)
            const rDiff = Math.abs(rStart - rEnd)
            console.log(`  Arc[${i}]: r_start=${rStart.toFixed(4)} r_end=${rEnd.toFixed(4)} diff=${rDiff.toFixed(6)} center=(${seg.center.x},${seg.center.y}) cw=${seg.clockwise}`)
            if (rDiff > 0.01) {
              console.log(`  *** ARC RADIUS MISMATCH! ***`)
              allPassed = false
            }
          }
          // Check for zero-length segments
          if (Math.abs(cur.x - seg.to.x) < 1e-9 && Math.abs(cur.y - seg.to.y) < 1e-9) {
            console.log(`  *** ZERO-LENGTH SEGMENT at [${i}]: (${cur.x.toFixed(3)}, ${cur.y.toFixed(3)}) ***`)
          }
          cur = seg.to
        }

        if (area <= 0) {
          console.log(`  *** NEGATIVE AREA — polygon inverted! ***`)
          allPassed = false
        }

        // Compare with plain fallback
        const plainProfile = clipperContourToProfile(contour)
        if (plainProfile) {
          const plainFlat = flattenProfile(plainProfile)
          const plainArea = signedArea(plainFlat.points)
          const areaDiff = Math.abs(area - plainArea)
          console.log(`  Plain fallback area: ${plainArea.toFixed(6)}, diff from preserving: ${areaDiff.toFixed(6)}`)
          if (areaDiff > 0.05) {
            console.log(`  *** LARGE AREA DIFFERENCE from fallback ***`)
            allPassed = false
          }
        }
      } else {
        console.log(`  clipperContourToProfilePreserving returned null`)
      }
    }
    for (const child of getClipperChildren(node)) {
      check(child, depth + 1)
    }
  }

  check(polyTree)
}

if (!allPassed) throw new Error('SOME CHECKS FAILED')
console.log('\nAll checks PASSED')
