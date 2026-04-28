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
  return `(${p.x.toFixed(4)}, ${p.y.toFixed(4)})`
}

function normalizeDir(x: number, y: number) {
  const len = Math.hypot(x, y)
  return len < 1e-9 ? null : { x: x / len, y: y / len }
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i], pj = polygon[j]
    if (((pi.y > y) !== (pj.y > y)) &&
        (x < ((pj.x - pi.x) * (y - pi.y) / ((pj.y - pi.y) || 1e-12)) + pi.x))
      inside = !inside
  }
  return inside
}

function lineSegmentSignedIntersection(origin: Point, dir: { x: number, y: number }, a: Point, b: Point): number | null {
  const sx = b.x - a.x, sy = b.y - a.y
  const denom = dir.x * sy - dir.y * sx
  if (Math.abs(denom) < 1e-9) return null
  const qpx = a.x - origin.x, qpy = a.y - origin.y
  const lineT = (qpx * sy - qpy * sx) / denom
  const segT = (qpx * dir.y - qpy * dir.x) / denom
  if (segT < -1e-9 || segT > 1 + 1e-9) return null
  return lineT
}

function findChannelMidpoint(contour: Point[], probe: Point, guide: { x: number, y: number }) {
  const normal = normalizeDir(-guide.y, guide.x)
  if (!normal) return null

  const ts: number[] = []
  for (let i = 0; i < contour.length; i++) {
    const t = lineSegmentSignedIntersection(probe, normal, contour[i], contour[(i + 1) % contour.length])
    if (t !== null && !ts.some(e => Math.abs(e - t) < 1e-6)) ts.push(t)
  }

  if (ts.length < 2) return { point: null, ts, reason: `only ${ts.length} intersections` }

  ts.sort((a, b) => a - b)

  // try bracketing pair first
  for (let i = 0; i < ts.length - 1; i++) {
    if (ts[i] < -1e-6 && ts[i+1] > 1e-6) {
      const mid = (ts[i] + ts[i+1]) / 2
      return {
        point: { x: probe.x + normal.x * mid, y: probe.y + normal.y * mid },
        radius: (ts[i+1] - ts[i]) / 2,
        ts,
        reason: 'bracketed'
      }
    }
  }

  // fallback
  const neg = ts.filter(t => t < -1e-6).sort((a,b) => b - a)
  const pos = ts.filter(t => t > 1e-6).sort((a,b) => a - b)
  const left = neg.length > 0 ? neg[0] : ts[0]
  const right = pos.length > 0 ? pos[0] : ts[ts.length - 1]
  if (Math.abs(right - left) < 1e-6) return { point: null, ts, reason: 'zero-width' }
  const mid = (left + right) / 2
  return {
    point: { x: probe.x + normal.x * mid, y: probe.y + normal.y * mid },
    radius: Math.abs(right - left) / 2,
    ts,
    reason: `fallback left=${left.toFixed(4)} right=${right.toFixed(4)}`
  }
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
  return cornerBisector(contour, idx >= 0 ? idx : findNearestIdx(contour, p))
}

function findSplit(region: ResolvedPocketRegion, stepSize: number, depth: number): { depth: number, parent: ResolvedPocketRegion, children: ResolvedPocketRegion[] } | null {
  if (depth > 100) return null
  const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  if (next.length > 1) return { depth, parent: region, children: next }
  if (next.length === 1) return findSplit(next[0], stepSize, depth + 1)
  return null
}

const TARGET_OP = process.env.OP ?? 'op0012'
const op = project.operations.find(o => o.id === TARGET_OP) as Operation
if (!op) throw new Error(`${TARGET_OP} not found`)

const resolved = resolvePocketRegions(project, op)
const stepSize = op.stepover

for (const band of resolved.bands) {
  for (const region of band.regions) {
    const split = findSplit(region, stepSize, 0)
    if (!split) continue

    const tol = Math.max(1e-4, stepSize * 0.25)
    const parentContour = split.parent.outer
    console.log(`\nSplit at depth=${split.depth}, parent=${parentContour.length} pts, children=${split.children.length}`)

    // bounds of parent
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of parentContour) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    console.log(`Parent bounds: ${fmt({x:minX,y:minY})} to ${fmt({x:maxX,y:maxY})}`)

    split.children.forEach((child, ci) => {
      const corners = detectCorners(child.outer, tol)
      console.log(`\n  Child ${ci}: ${corners.length} corners`)

      for (const corner of corners.slice(0, 2)) { // limit to first 2 corners per child
        const inward = inwardAt(child.outer, corner)
        if (!inward) { console.log(`    corner ${fmt(corner)}: no bisector`); continue }
        const outward = { x: -inward.x, y: -inward.y }

        console.log(`\n  Corner ${fmt(corner)} outward=${fmt(outward)}`)

        let cur = { ...corner }
        let guide = { ...outward }

        for (let step = 0; step < 8; step++) {
          const probe = { x: cur.x + guide.x * stepSize, y: cur.y + guide.y * stepSize }
          const probeInside = pointInPolygon(probe.x, probe.y, parentContour)
          const ch = findChannelMidpoint(parentContour, probe, guide)

          console.log(`    step ${step}: probe=${fmt(probe)} probeInside=${probeInside}`)
          console.log(`             channel=${ch.point ? fmt(ch.point) : 'null'} reason=${ch.reason} ts=[${ch.ts?.map(t=>t.toFixed(3)).join(',')}]`)

          if (!ch.point) { console.log(`             -> STOP (no channel)`); break }

          const chInside = pointInPolygon(ch.point.x, ch.point.y, parentContour)
          console.log(`             channelInside=${chInside} radius=${(ch as any).radius?.toFixed(4)}`)

          if (!chInside) { console.log(`             -> STOP (channel outside)`); break }

          const next = normalizeDir(ch.point.x - cur.x, ch.point.y - cur.y)
          if (!next) { console.log(`             -> STOP (no next guide)`); break }
          cur = ch.point
          guide = next
        }
      }
    })
  }
}
