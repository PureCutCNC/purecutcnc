import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import { detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

function fmt(p: { x: number, y: number }): string {
  return `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`
}

function normalizeDir(x: number, y: number) {
  const len = Math.hypot(x, y)
  return len < 1e-9 ? null : { x: x / len, y: y / len }
}

function cornerBisector(contour: Point[], index: number) {
  const n = contour.length
  const prev = contour[(index - 1 + n) % n]
  const curr = contour[index]
  const next = contour[(index + 1) % n]
  const toPrev = normalizeDir(prev.x - curr.x, prev.y - curr.y)
  const toNext = normalizeDir(next.x - curr.x, next.y - curr.y)
  if (!toPrev || !toNext) return null
  return normalizeDir(toPrev.x + toNext.x, toPrev.y + toNext.y)
}

function findNearestIdx(contour: Point[], p: Point) {
  let best = 0, bestD = Infinity
  for (let i = 0; i < contour.length; i++) {
    const d = Math.hypot(contour[i].x - p.x, contour[i].y - p.y)
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

function inwardAt(contour: Point[], p: Point) {
  const idx = contour.findIndex(c => Math.hypot(c.x - p.x, c.y - p.y) < 1e-6)
  if (idx >= 0) return cornerBisector(contour, idx)
  // find nearest vertex
  return cornerBisector(contour, findNearestIdx(contour, p))
}

function findSplit(region: ResolvedPocketRegion, stepSize: number, depth: number): { depth: number, parent: ResolvedPocketRegion, children: ResolvedPocketRegion[] } | null {
  if (depth > 100) return null
  const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  if (next.length > 1) return { depth, parent: region, children: next }
  if (next.length === 1) return findSplit(next[0], stepSize, depth + 1)
  return null
}

// Find operations with O or circle shapes
for (const op of project.operations) {
  if (op.kind !== 'v_carve_recursive') continue
  const resolved = resolvePocketRegions(project, op)
  const stepSize = op.stepover

  for (const band of resolved.bands) {
    for (const region of band.regions) {
      const split = findSplit(region, stepSize, 0)
      if (!split) continue

      const tol = Math.max(1e-4, stepSize * 0.25)
      console.log(`\n=== op=${op.id} "${op.name}" split at depth=${split.depth} stepSize=${stepSize} ===`)
      console.log(`Parent contour: ${split.parent.outer.length} pts`)

      split.children.forEach((child, ci) => {
        const corners = detectCorners(child.outer, tol)
        console.log(`\n  Child ${ci}: ${child.outer.length} pts, ${corners.length} corners`)
        for (const c of corners) {
          const inward = inwardAt(child.outer, c)
          const outward = inward ? { x: -inward.x, y: -inward.y } : null
          console.log(`    corner ${fmt(c)}`)
          console.log(`      inward  bisector: ${inward ? fmt(inward) : 'null'}`)
          console.log(`      outward bisector: ${outward ? fmt(outward) : 'null'}`)

          if (!outward) continue

          // Simulate the walk: print first 5 probe points and whether they're inside parent
          let cur = { ...c }
          let guide = { ...outward }
          const parentContour = split.parent.outer
          for (let step = 0; step < 5; step++) {
            const probe = { x: cur.x + guide.x * stepSize, y: cur.y + guide.y * stepSize }
            // point-in-polygon
            let inside = false
            for (let i = 0, j = parentContour.length - 1; i < parentContour.length; j = i++) {
              const pi = parentContour[i], pj = parentContour[j]
              if (((pi.y > probe.y) !== (pj.y > probe.y)) &&
                  (probe.x < ((pj.x - pi.x) * (probe.y - pi.y) / (pj.y - pi.y)) + pi.x)) {
                inside = !inside
              }
            }
            console.log(`      step ${step}: probe ${fmt(probe)} inside=${inside}`)
            if (!inside) break
            cur = probe
            // update guide toward probe (simplified — no channel midpoint here)
          }
        }
      })
    }
  }
}
