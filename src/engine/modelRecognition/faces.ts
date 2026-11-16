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
 * The look from below, and the one report two looks add up to (issue #1206
 * slice 4).
 *
 * Top and Bottom share one plan and one stock space, so the look from below
 * needs no setup frame, no mirror and no flip axis: it is the same stock-space
 * mesh with every Z negated, run through the unchanged detector. XY stays in
 * stock coordinates, so outlines, circles and arc directions come back already
 * correct; only the spans need converting back — a span `zBottom..zTop` seen
 * from below is the stock span `-zTop..-zBottom`.
 *
 * `combineFaces` then makes the two runs one list, because the same plate is
 * seen from both sides. It applies the rules in this order:
 *
 * 1. **Top wins a tie.** A Bottom candidate with no parent that is the same
 *    shape as a Top one — same operation, span and outline — is dropped with
 *    its islands. That is the through hole, the plate itself, and the bolt
 *    hole of a counterbore, each found from both sides.
 * 2. **What one face draws, the other does not report.** A `skipped` (or
 *    `skippedSolids`) entry is dropped when a kept candidate from the other
 *    face has its span and outline. From below, a pocket that opens upward is
 *    a void covered by material; it must not be listed as covered when Top
 *    draws it.
 * 3. **One report per void.** A Bottom `skipped` entry that matches a kept Top
 *    one in the same list is dropped. The reasons may differ between the
 *    faces; Top's is kept.
 * 4. `meshOpen` and `levelsTruncated` are true when either face's is.
 * 5. Order: all Top candidates in their order, then the kept Bottom ones.
 *
 * "Same span and outline" is the comparison `markAlreadyDrawn` makes, so both
 * read the same two helpers in `candidates.ts` and there is one tolerance.
 */

import { polygonProfile, type SketchProfile } from '../../types/project'
import { sameOutline, sameSpan, type RecognitionCandidate } from './candidates'
import type {
  ModelRecognitionResult,
  RecognitionMesh,
  RecognizedCavity,
  SkippedCavity,
} from './types'

/** One face's run, as the detector found it in stock space. */
export interface FaceRun {
  candidates: RecognitionCandidate[]
  skipped: SkippedCavity[]
  skippedSolids: SkippedCavity[]
  meshOpen: boolean
  levelsTruncated: boolean
}

/** Both faces' runs, made one list. */
export interface CombinedRecognition {
  candidates: RecognitionCandidate[]
  skipped: SkippedCavity[]
  skippedSolids: SkippedCavity[]
  meshOpen: boolean
  levelsTruncated: boolean
}

/**
 * The same part seen from below: every Z negated. The input mesh is not
 * touched.
 *
 * The winding is reversed as well, because negating Z mirrors the mesh: the
 * cross product the detector reads its normals from keeps its Z sign under a Z
 * reflection, so without the swap every outward face would point inward and no
 * floor would ever be found. A mirrored mesh with reversed winding is the same
 * part turned over, which is exactly what the look from below is.
 */
export function meshSeenFromBelow(mesh: RecognitionMesh): RecognitionMesh {
  const positions = new Float32Array(mesh.positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i]
    positions[i + 1] = mesh.positions[i + 1]
    const z = mesh.positions[i + 2]
    // Keep 0 rather than -0, which would show up in a saved value as "-0".
    positions[i + 2] = z === 0 ? 0 : -z
  }
  const index = new Uint32Array(mesh.index.length)
  for (let i = 0; i + 2 < index.length; i += 3) {
    index[i] = mesh.index[i]
    index[i + 1] = mesh.index[i + 2]
    index[i + 2] = mesh.index[i + 1]
  }
  return { positions, index }
}

/** A span seen from below, as the stock span it really is. */
function flippedSpan<T extends { zBottom: number; zTop: number }>(entry: T): T {
  return { ...entry, zBottom: -entry.zTop, zTop: -entry.zBottom }
}

/**
 * A detector result seen from below, in stock space: every `zBottom`/`zTop`
 * pair on cavities, their islands, solids, `skipped` and `skippedSolids`
 * becomes `{ zBottom: -zTop, zTop: -zBottom }`. Everything else is kept.
 *
 * What the words mean afterwards: for a Bottom cavity, `bottom: 'flat'` still
 * means "its walls end on a flat floor as the tool sees it", and that floor is
 * now at the stock `zTop` of the span.
 */
export function resultFromBelowToStock(result: ModelRecognitionResult): ModelRecognitionResult {
  return {
    cavities: result.cavities.map((cavity: RecognizedCavity) => ({
      ...flippedSpan(cavity),
      islands: cavity.islands.map(flippedSpan),
    })),
    skipped: result.skipped.map(flippedSpan),
    solids: result.solids.map(flippedSpan),
    skippedSolids: result.skippedSolids.map(flippedSpan),
    levelsTruncated: result.levelsTruncated,
    meshOpen: result.meshOpen,
  }
}

/** What the two comparisons need of a found shape. */
interface FoundShape {
  zTop: number
  zBottom: number
  profile: SketchProfile
}

/** A skipped entry as a shape: its outline as a closed line profile. */
function skippedShape(entry: SkippedCavity): FoundShape {
  return { zTop: entry.zTop, zBottom: entry.zBottom, profile: polygonProfile(entry.outline) }
}

function sameFoundShape(a: FoundShape, b: FoundShape): boolean {
  return sameSpan(a, b) && sameOutline(a.profile, b.profile)
}

/**
 * The two faces' runs as one list of what to draw and what to report. `bottom`
 * is null when only Top was searched, and the result is then exactly Top's.
 */
export function combineFaces(top: FaceRun, bottom: FaceRun | null): CombinedRecognition {
  if (!bottom) {
    return {
      candidates: [...top.candidates],
      skipped: [...top.skipped],
      skippedSolids: [...top.skippedSolids],
      meshOpen: top.meshOpen,
      levelsTruncated: top.levelsTruncated,
    }
  }

  // 1. Top wins a tie: a shape already drawn from above is not drawn again,
  //    and an island goes with the cavity it stands in.
  const topParents = top.candidates.filter((candidate) => candidate.parentId === null)
  const keptBottom: RecognitionCandidate[] = []
  const keptBottomParents = new Set<string>()
  for (const candidate of bottom.candidates) {
    if (candidate.parentId !== null) {
      if (keptBottomParents.has(candidate.parentId)) keptBottom.push(candidate)
      continue
    }
    const drawnFromTop = topParents.some((other) => (
      other.operation === candidate.operation && sameFoundShape(other, candidate)
    ))
    if (drawnFromTop) continue
    keptBottomParents.add(candidate.id)
    keptBottom.push(candidate)
  }

  // 2. A void one face draws is not reported as not drawn by the other.
  const keepTopSkipped = (entry: SkippedCavity): boolean => (
    !keptBottom.some((candidate) => sameFoundShape(candidate, skippedShape(entry)))
  )
  const keepBottomSkipped = (entry: SkippedCavity): boolean => (
    !top.candidates.some((candidate) => sameFoundShape(candidate, skippedShape(entry)))
  )
  const topSkipped = top.skipped.filter(keepTopSkipped)
  const topSkippedSolids = top.skippedSolids.filter(keepTopSkipped)
  const bottomSkipped = bottom.skipped.filter(keepBottomSkipped)
  const bottomSkippedSolids = bottom.skippedSolids.filter(keepBottomSkipped)

  // 3. One report per void; Top's reason is the one kept.
  const onlyOnce = (fromBottom: SkippedCavity[], fromTop: SkippedCavity[]): SkippedCavity[] => (
    fromBottom.filter((entry) => (
      !fromTop.some((kept) => sameFoundShape(skippedShape(kept), skippedShape(entry)))
    ))
  )
  const skipped = [...topSkipped, ...onlyOnce(bottomSkipped, topSkipped)]
  const skippedSolids = [...topSkippedSolids, ...onlyOnce(bottomSkippedSolids, topSkippedSolids)]

  return {
    // 5. Top's rows first, then the Bottom ones that survived.
    candidates: [...top.candidates, ...keptBottom],
    skipped,
    skippedSolids,
    // 4. Either face's warning stands for both.
    meshOpen: top.meshOpen || bottom.meshOpen,
    levelsTruncated: top.levelsTruncated || bottom.levelsTruncated,
  }
}
