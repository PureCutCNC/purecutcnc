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
 * Finds the pockets and holes of a mesh that a 2.5D operation can cut
 * (issue #1206): enclosed voids with vertical walls, open to the tool.
 *
 * The mesh is cut into slabs at its candidate levels (`levels.ts`) and each
 * slab is sectioned near its bottom and near its top.
 *
 * 1. **Bands.** A hole loop that is the same at both ends of a slab has
 *    vertical walls through that slab.
 * 2. **Tracks.** Bands that continue across a level, with the same loop on
 *    both sides, are one cavity. A track's outline is that loop.
 * 3. **Bottom.** A track that reaches the lowest slab is a through hole, and so
 *    is one with nothing under its outline all the way down (a hole through a
 *    plate that stands on feet).
 *    Otherwise it stands on a flat floor, or the void carries on below it
 *    narrower (a cone, a fillet) or wider (an undercut).
 * 4. **Top.** Above its straight walls a cavity runs on up through any band
 *    that is not vertical (a chamfered rim) and stops at the level where it
 *    opens into a wider cavity that is itself drawn, or into the open. So a
 *    counterbore is two cavities stacked, and a chamfered hole is one cavity
 *    reaching the surface.
 * 5. **Reach.** Nothing may cover the outline anywhere above it. What is
 *    covered is an undercut and is reported, not returned.
 *
 * A solid is the same walk on the other kind of loop: a top-level **material**
 * loop of a section instead of a hole. Its bands, tracks and stacked steps
 * mirror the cavity's, with two differences. It ends where its straight walls
 * end (no carrying the top up through a flare), and it is returned only when it
 * stands on something — the mesh's underside or material covering its whole
 * outline just below — so a body hanging over empty space is reported as an
 * undercut. A material loop inside a hole is an island, not a solid.
 *
 * Everything is measured in the mesh's own size: the tolerances are a fixed
 * fraction of its bounding diagonal, so a part in inches and the same part in
 * millimetres give the same answer.
 */

import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE } from '../clipperScale'
import type { ClipperPath } from '../toolpaths/types'
import { buildMeshSliceIndex } from '../toolpaths/meshSlicing'
import { fitOutline } from './fit'
import { collectFloorTriangles, collectLevels, meshBounds } from './levels'
import {
  differenceArea,
  fromPath,
  intersectionArea,
  intersectionPaths,
  loopsMatch,
  sectionAt,
  unionRegion,
  type Section,
  type SectionLoop,
} from './sections'
import type {
  CavityBottom,
  ModelRecognitionResult,
  RecognitionMesh,
  RecognizedCavity,
  RecognizedIsland,
  RecognizedSolid,
  SkippedCavity,
} from './types'

/** Plan and height tolerance as a fraction of the mesh's bounding diagonal. */
const TOLERANCE_FRACTION = 1e-4
/** The plan tolerance never drops below this many Clipper counts. */
const MIN_TOLERANCE_COUNTS = 4
/** A section is taken this many height tolerances inside a slab's end. */
const SAMPLE_INSET_TOLERANCES = 3
/** A loop smaller than a square this many tolerances wide is slicing noise. */
const MIN_LOOP_SIZE_TOLERANCES = 20
/** Most never-vertical loops compared with each other when grouping them. */
const MAX_TAPER_LOOPS = 400

interface Band {
  slab: number
  loLoop: number
  hiLoop: number
  next: Band | null
  hasPrevious: boolean
}

interface Slab {
  lo: Section
  hi: Section
  bands: Band[]
  /** Per `lo` loop: its band in this slab, or null. */
  loBand: Array<Band | null>
  /** Per `hi` loop: true when a band ends on it. */
  hiBanded: boolean[]
  /**
   * The same three for solid loops, kept apart from the hole bands: the cavity
   * code reads `bands`, `loBand` and `hiBanded`, and must see holes only.
   */
  solidBands: Band[]
  solidLoBand: Array<Band | null>
  solidHiBanded: boolean[]
}

/** A loop no band carried across a slab boundary, and the group it belongs to. */
interface UnbandedLoop {
  slab: number
  loop: SectionLoop
  group: number
}

interface TrackSummary {
  path: ClipperPath
  area: number
  bottomSlab: number
  topSlab: number
  bottom: CavityBottom
}

function ccwOutline(path: ClipperPath): Point[] {
  const points = fromPath(path)
  let twiceArea = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    twiceArea += a.x * b.y - b.x * a.y
  }
  return twiceArea < 0 ? points.reverse() : points
}

function emptyResult(): ModelRecognitionResult {
  return { cavities: [], skipped: [], solids: [], skippedSolids: [], levelsTruncated: false, meshOpen: false }
}

/**
 * Groups the loops a band did not carry across a slab boundary into the bodies
 * they are. Two loops are the same body when they are on the same or a
 * neighbouring slab and cover more than half of the smaller one — a wall whose
 * pitch is not vertical enough to band still leaves nearly the same section on
 * both sides of one level.
 *
 * Widest first, so a group's first member is its body at its widest, and capped
 * so a surface with hundreds of facets cannot take the detector down. Each loop
 * belongs to at most one group.
 */
function groupUnbandedLoops(loops: UnbandedLoop[]): UnbandedLoop[][] {
  loops.sort((a, b) => b.loop.area - a.loop.area)
  loops.length = Math.min(loops.length, MAX_TAPER_LOOPS)

  const sameBody = (a: UnbandedLoop, b: UnbandedLoop): boolean => (
    Math.abs(a.slab - b.slab) <= 1
    && intersectionArea([a.loop.path], [b.loop.path]) > Math.min(a.loop.area, b.loop.area) / 2
  )
  let groupCount = 0
  for (const seed of loops) {
    if (seed.group >= 0) continue
    seed.group = groupCount
    const queue = [seed]
    while (queue.length > 0) {
      const current = queue.pop()!
      for (const other of loops) {
        if (other.group >= 0 || !sameBody(current, other)) continue
        other.group = seed.group
        queue.push(other)
      }
    }
    groupCount += 1
  }

  const groups: UnbandedLoop[][] = []
  for (let group = 0; group < groupCount; group += 1) {
    groups.push(loops.filter((member) => member.group === group))
  }
  return groups
}

export interface RecognitionOptions {
  /**
   * Hears how far the sectioning has got, 0..1, once per slab. Sectioning is
   * nearly all of the work, so this is the whole progress of a run.
   */
  onProgress?: (fraction: number) => void
}

export function recognizeCavities(mesh: RecognitionMesh, options: RecognitionOptions = {}): ModelRecognitionResult {
  const bounds = meshBounds(mesh)
  const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ)
  if (!Number.isFinite(diagonal) || !(diagonal > 0) || !(bounds.maxZ > bounds.minZ)) return emptyResult()

  const zTol = diagonal * TOLERANCE_FRACTION
  const xyTol = Math.max(diagonal * TOLERANCE_FRACTION, MIN_TOLERANCE_COUNTS / DEFAULT_CLIPPER_SCALE)
  const minLoopArea = (xyTol * MIN_LOOP_SIZE_TOLERANCES) ** 2

  const { levels, truncated } = collectLevels(mesh, bounds, zTol)
  const sliceIndex = buildMeshSliceIndex(mesh.positions, mesh.index)
  const isCandidate = (loop: SectionLoop): boolean => loop.hole && loop.area >= minLoopArea
  // A solid loop is a top-level material loop. Material inside a hole is an
  // island standing in a cavity, not a body of its own.
  const isSolidLoop = (loop: SectionLoop): boolean => !loop.hole && loop.parent === -1 && loop.area >= minLoopArea

  // ── Slabs and bands ────────────────────────────────────────────────────────
  const slabs: Slab[] = []
  for (let i = 0; i + 1 < levels.length; i += 1) {
    const inset = Math.min(zTol * SAMPLE_INSET_TOLERANCES, (levels[i + 1] - levels[i]) / 4)
    const lo = sectionAt(sliceIndex, levels[i] + inset, xyTol / 4)
    const hi = sectionAt(sliceIndex, levels[i + 1] - inset, xyTol / 4)
    const slab: Slab = {
      lo,
      hi,
      bands: [],
      loBand: lo.loops.map(() => null),
      hiBanded: hi.loops.map(() => false),
      solidBands: [],
      solidLoBand: lo.loops.map(() => null),
      solidHiBanded: hi.loops.map(() => false),
    }
    lo.loops.forEach((loop, loLoop) => {
      if (!isCandidate(loop)) return
      const hiLoop = hi.loops.findIndex((other, otherIndex) => (
        !slab.hiBanded[otherIndex] && loopsMatch(loop, other, xyTol)
      ))
      if (hiLoop < 0) return
      const band: Band = { slab: i, loLoop, hiLoop, next: null, hasPrevious: false }
      slab.bands.push(band)
      slab.loBand[loLoop] = band
      slab.hiBanded[hiLoop] = true
    })
    lo.loops.forEach((loop, loLoop) => {
      if (!isSolidLoop(loop)) return
      const hiLoop = hi.loops.findIndex((other, otherIndex) => (
        !slab.solidHiBanded[otherIndex] && isSolidLoop(other) && loopsMatch(loop, other, xyTol)
      ))
      if (hiLoop < 0) return
      const band: Band = { slab: i, loLoop, hiLoop, next: null, hasPrevious: false }
      slab.solidBands.push(band)
      slab.solidLoBand[loLoop] = band
      slab.solidHiBanded[hiLoop] = true
    })
    slabs.push(slab)
    options.onProgress?.((i + 1) / (levels.length - 1))
  }

  // ── Tracks ─────────────────────────────────────────────────────────────────
  for (let i = 0; i + 1 < slabs.length; i += 1) {
    const above = slabs[i + 1]
    for (const band of slabs[i].bands) {
      const loop = slabs[i].hi.loops[band.hiLoop]
      const next = above.bands.find((candidate) => (
        !candidate.hasPrevious && loopsMatch(loop, above.lo.loops[candidate.loLoop], xyTol)
      ))
      if (!next) continue
      band.next = next
      next.hasPrevious = true
    }
    for (const band of slabs[i].solidBands) {
      const loop = slabs[i].hi.loops[band.hiLoop]
      const next = above.solidBands.find((candidate) => (
        !candidate.hasPrevious && loopsMatch(loop, above.lo.loops[candidate.loLoop], xyTol)
      ))
      if (!next) continue
      band.next = next
      next.hasPrevious = true
    }
  }

  const floorTriangles = collectFloorTriangles(mesh, levels, zTol)
  const floorRegions = new Map<number, ClipperPath[]>()
  const floorRegion = (level: number): ClipperPath[] => {
    let region = floorRegions.get(level)
    if (!region) {
      region = unionRegion(floorTriangles[level])
      floorRegions.set(level, region)
    }
    return region
  }

  const cavities: RecognizedCavity[] = []
  const skipped: SkippedCavity[] = []
  const tracks: TrackSummary[] = []
  const topLevel = levels[levels.length - 1]

  for (const slab of slabs) {
    for (const first of slab.bands) {
      if (first.hasPrevious) continue
      let last = first
      while (last.next) last = last.next
      const bottomSlab = first.slab
      const topSlab = last.slab

      const loop = slabs[bottomSlab].lo.loops[first.loLoop]
      const path = [loop.path]
      const slack = loop.perimeter * xyTol * 2
      const outline = ccwOutline(loop.path)

      // Bottom.
      let bottom: CavityBottom = 'through'
      if (bottomSlab > 0) {
        if (intersectionArea(path, floorRegion(bottomSlab)) > slack) bottom = 'flat'
        else if (intersectionArea(path, slabs[bottomSlab - 1].hi.material) > slack) bottom = 'taper'
        else {
          // Nothing under the outline all the way down: the hole comes out of
          // the part here, on an underside that is not the mesh's lowest point
          // (a plate standing on feet). Anything under it and it only opens
          // into a wider cavity.
          let clearBelow = true
          for (let k = 0; k < bottomSlab && clearBelow; k += 1) {
            clearBelow = intersectionArea(path, slabs[k].lo.material) <= slack
              && intersectionArea(path, slabs[k].hi.material) <= slack
          }
          bottom = clearBelow ? 'through' : 'open'
        }
      }
      const zBottom = levels[bottomSlab]
      tracks.push({ path: loop.path, area: loop.area, bottomSlab, topSlab, bottom })

      // Top: carry on up through bands that are not vertical.
      let zTop = topLevel
      let flaredAbove = false
      for (let k = topSlab + 1; k < slabs.length; k += 1) {
        const above = slabs[k]
        let containing = -1
        above.lo.loops.forEach((candidate, candidateIndex) => {
          if (!candidate.hole) return
          if (intersectionArea(path, [candidate.path]) < loop.area - slack) return
          if (containing < 0 || candidate.area < above.lo.loops[containing].area) containing = candidateIndex
        })
        if (containing < 0 || above.loBand[containing]) {
          zTop = levels[k]
          break
        }
        flaredAbove = true
      }

      const report = (reason: SkippedCavity['reason']): void => {
        skipped.push({ reason, outline, zBottom, zTop })
      }

      // A section with an unclosed contour cannot be trusted to say where the
      // material is, here or anywhere the tool passes on its way in.
      let open = false
      for (let k = bottomSlab; k < slabs.length && !open; k += 1) {
        open = slabs[k].lo.openChainCount > 0 || slabs[k].hi.openChainCount > 0
      }
      if (open) {
        report('openMesh')
        continue
      }

      // Reach: nothing above the straight walls may cover the outline.
      let covered = false
      for (let k = topSlab + 1; k < slabs.length && !covered; k += 1) {
        covered = intersectionArea(path, slabs[k].lo.material) > slack
          || intersectionArea(path, slabs[k].hi.material) > slack
      }

      // Islands: material standing on the floor inside the outline. Anything
      // else inside it higher up overhangs the floor.
      const islandLoops = loop.children
        .map((child) => slabs[bottomSlab].lo.loops[child])
        .filter((child) => child.area >= minLoopArea)
      const islandPaths = islandLoops.map((island) => island.path)
      for (let k = bottomSlab; k <= topSlab && !covered; k += 1) {
        for (const section of [slabs[k].lo, slabs[k].hi]) {
          const inside = intersectionPaths(path, section.material)
          if (differenceArea(inside, islandPaths) > slack) {
            covered = true
            break
          }
        }
      }
      if (covered) {
        report('undercut')
        continue
      }

      const islands: RecognizedIsland[] = islandLoops.map((island) => {
        const islandSlack = island.perimeter * xyTol * 2
        let islandTop = levels[bottomSlab + 1]
        for (let k = bottomSlab + 1; k < slabs.length; k += 1) {
          if (intersectionArea([island.path], slabs[k].lo.material) <= islandSlack) break
          islandTop = levels[k + 1]
        }
        const islandOutline = ccwOutline(island.path)
        return { ...fitOutline(islandOutline, xyTol), outline: islandOutline, zBottom, zTop: islandTop }
      })

      const fitted = fitOutline(outline, xyTol)
      cavities.push({
        shape: fitted.circle ? 'hole' : 'pocket',
        bottom,
        profile: fitted.profile,
        outline,
        circle: fitted.circle,
        zBottom,
        zTop,
        islands,
        flaredAbove,
      })
    }
  }

  // ── Solids: the material the cavities are cut out of ───────────────────────
  const solids: RecognizedSolid[] = []
  const skippedSolids: SkippedCavity[] = []

  for (const slab of slabs) {
    for (const first of slab.solidBands) {
      if (first.hasPrevious) continue
      let last = first
      while (last.next) last = last.next
      const bottomSlab = first.slab
      const topSlab = last.slab

      const loop = slabs[bottomSlab].lo.loops[first.loLoop]
      // A solid ends where its straight walls end: no carrying the top up
      // through a band that is not vertical.
      const zBottom = levels[bottomSlab]
      const zTop = levels[topSlab + 1]
      const outline = ccwOutline(loop.path)
      const slack = loop.perimeter * xyTol * 2

      const report = (reason: SkippedCavity['reason']): void => {
        skippedSolids.push({ reason, outline, zBottom, zTop })
      }

      // A section this body's own walls pass through cannot be trusted to say
      // where its material is.
      let open = false
      for (let k = bottomSlab; k <= topSlab && !open; k += 1) {
        open = slabs[k].lo.openChainCount > 0 || slabs[k].hi.openChainCount > 0
      }
      if (open) {
        report('openMesh')
        continue
      }

      // Stands on something: the underside, or material covering the whole
      // outline just below it. A body over empty space is an undercut.
      const stands = bottomSlab === 0
        || differenceArea([loop.path], slabs[bottomSlab - 1].hi.material) <= slack
      if (!stands) {
        report('undercut')
        continue
      }

      const fitted = fitOutline(outline, xyTol)
      solids.push({
        profile: fitted.profile,
        outline,
        circle: fitted.circle,
        zBottom,
        zTop,
      })
    }
  }

  // ── Voids whose walls are never vertical ───────────────────────────────────
  const taperLoops: UnbandedLoop[] = []
  slabs.forEach((slab, slabIndex) => {
    slab.lo.loops.forEach((loop, loopIndex) => {
      if (isCandidate(loop) && !slab.loBand[loopIndex]) taperLoops.push({ slab: slabIndex, loop, group: -1 })
    })
    slab.hi.loops.forEach((loop, loopIndex) => {
      if (isCandidate(loop) && !slab.hiBanded[loopIndex]) taperLoops.push({ slab: slabIndex, loop, group: -1 })
    })
  })

  for (const members of groupUnbandedLoops(taperLoops)) {
    // Sorted by area, so the first member is the void at its widest.
    const widest = members[0].loop
    const lowSlab = Math.min(...members.map((member) => member.slab))
    const highSlab = Math.max(...members.map((member) => member.slab))

    // A cone under a cavity or a flare above one is that cavity's own end, and
    // is already told by its `bottom` and `flaredAbove`. This suppression is
    // the cavity's alone: a solid has no such end to hide behind.
    const partOfCavity = tracks.some((track) => {
      const shared = intersectionArea([widest.path], [track.path])
      const below = highSlab === track.bottomSlab - 1 && track.bottom === 'taper'
        && shared > Math.min(widest.area, track.area) / 2
      const above = lowSlab === track.topSlab + 1 && shared >= track.area * 0.9
      return below || above
    })
    if (partOfCavity) continue

    skipped.push({
      reason: 'taperedWalls',
      outline: ccwOutline(widest.path),
      zBottom: levels[lowSlab],
      zTop: levels[highSlab + 1],
    })
  }

  // ── Bodies whose walls are never vertical ──────────────────────────────────
  const taperSolids: UnbandedLoop[] = []
  slabs.forEach((slab, slabIndex) => {
    slab.lo.loops.forEach((loop, loopIndex) => {
      if (isSolidLoop(loop) && !slab.solidLoBand[loopIndex]) {
        taperSolids.push({ slab: slabIndex, loop, group: -1 })
      }
    })
    slab.hi.loops.forEach((loop, loopIndex) => {
      if (isSolidLoop(loop) && !slab.solidHiBanded[loopIndex]) {
        taperSolids.push({ slab: slabIndex, loop, group: -1 })
      }
    })
  })

  for (const members of groupUnbandedLoops(taperSolids)) {
    const widest = members[0].loop
    const lowSlab = Math.min(...members.map((member) => member.slab))
    const highSlab = Math.max(...members.map((member) => member.slab))
    skippedSolids.push({
      reason: 'taperedWalls',
      outline: ccwOutline(widest.path),
      zBottom: levels[lowSlab],
      zTop: levels[highSlab + 1],
    })
  }

  const byHeightThenSize = (
    a: { zTop: number; zBottom: number; outline: Point[] },
    b: { zTop: number; zBottom: number; outline: Point[] },
  ): number => (b.zTop - a.zTop) || (a.zBottom - b.zBottom) || (a.outline[0].x - b.outline[0].x)
    || (a.outline[0].y - b.outline[0].y)
  // Solids stack bottom first, so a body drawn before the one standing on it
  // is folded into the tree in the order that recreates the part.
  const byBottomThenTop = (
    a: { zBottom: number; zTop: number; outline: Point[] },
    b: { zBottom: number; zTop: number; outline: Point[] },
  ): number => (a.zBottom - b.zBottom) || (a.zTop - b.zTop) || (a.outline[0].x - b.outline[0].x)
    || (a.outline[0].y - b.outline[0].y)
  cavities.sort(byHeightThenSize)
  skipped.sort(byHeightThenSize)
  solids.sort(byBottomThenTop)
  skippedSolids.sort(byHeightThenSize)

  const meshOpen = slabs.some((slab) => slab.lo.openChainCount > 0 || slab.hi.openChainCount > 0)
  return { cavities, skipped, solids, skippedSolids, levelsTruncated: truncated, meshOpen }
}
