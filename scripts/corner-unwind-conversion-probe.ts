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
 * Corner-unwind conversion probe (issue #499).
 *
 * Answers the question a green test suite cannot: of the corners the qualifier
 * accepts, how many can the generator ACTUALLY unwind? A qualifier count is not
 * a payoff — a corner with no cleared room to unwind into is declined, and the
 * decline rate is what decides whether the feature earns its wiring.
 *
 * Run:  ./node_modules/.bin/tsx scripts/corner-unwind-conversion-probe.ts
 */
import { buildPocketFixturePack, type PocketFixtureEntry } from '../src/test/pocketFixturePack'
import { generatePocketToolpath } from '../src/engine/toolpaths/pocket'
import { SweptMaterialIndex, nominalEngagement } from '../src/engine/toolpaths/engagement'
import { qualifyCorners, type CornerQualifierRing, type CornerQualifierPoint } from '../src/engine/toolpaths/cornerQualifier'
import { cornerUnwindPath } from '../src/engine/toolpaths/engagementLimitedPath'
import type { ToolpathMove } from '../src/engine/toolpaths/types'
import type { Operation } from '../src/types/project'

const pointKey = (point: { x: number; y: number }): string =>
  `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`

function reconstructRings(moves: ToolpathMove[]): Array<{ points: CornerQualifierPoint[]; level: number }> {
  const levels: Array<{ z: number; moves: Array<{ from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } }> }> = []
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const level = levels.find((c) => c.z === move.from.z)
    if (level) level.moves.push({ from: move.from, to: move.to })
    else levels.push({ z: move.from.z, moves: [{ from: move.from, to: move.to }] })
  }
  const rings: Array<{ points: CornerQualifierPoint[]; level: number }> = []
  for (const level of levels) {
    let openPath: CornerQualifierPoint[] = []
    const openIndex = new Map<string, number>()
    for (const move of level.moves) {
      const from = { x: move.from.x, y: move.from.y }
      const to = { x: move.to.x, y: move.to.y }
      if (openPath.length === 0) { openPath.push(from); openIndex.set(pointKey(from), 0) }
      const toKey = pointKey(to)
      const revisit = openIndex.get(toKey)
      if (revisit !== undefined) {
        const points = openPath.slice(revisit)
        const first = points[0], last = points[points.length - 1]
        if (Math.hypot(last.x - first.x, last.y - first.y) <= 1e-9) points.pop()
        if (points.length >= 3) rings.push({ points, level: level.z })
        openPath = []; openIndex.clear()
      } else { openPath.push(to); openIndex.set(toKey, openPath.length - 1) }
    }
  }
  return rings
}

const norm = (x: number, y: number): { x: number; y: number } => {
  const l = Math.hypot(x, y) || 1
  return { x: x / l, y: y / l }
}

console.log('fixture         qualified  unwound  declined  reasons')
let totalQ = 0, totalOk = 0
for (const entry of buildPocketFixturePack({ toolDiameter: 6, stepover: 0.4 }) as PocketFixtureEntry[]) {
  const op = entry.project.operations.find((c) => c.kind === 'pocket')
  if (!op) continue
  const tool = entry.project.tools.find((c) => c.id === op.toolRef)
  if (!tool) continue
  const d = tool.diameter, r = d / 2
  const nominal = nominalEngagement(d * op.stepover, r)
  const result = generatePocketToolpath(entry.project, { ...op, pocketFeedReduction: 'engagement' } as Operation)
  const raw = reconstructRings(result.moves)
  const acc: Array<[number, number, number, number]> = []
  const rings: CornerQualifierRing[] = raw.map((ring) => {
    const index = new SweptMaterialIndex(r)
    for (const [ax, ay, bx, by] of acc) index.addSweptSegment(ax, ay, bx, by)
    for (let k = 0; k < ring.points.length; k += 1) {
      const c = ring.points[k], n = ring.points[(k + 1) % ring.points.length]
      if (Math.hypot(n.x - c.x, n.y - c.y) > 1e-9) acc.push([c.x, c.y, n.x, n.y])
    }
    return { ...ring, engagementAt: (x: number, y: number, dx: number, dy: number) => index.engagementAt(x, y, dx, dy) }
  })
  const corners = qualifyCorners(rings, { toolDiameter: d, nominalEngagement: nominal })
  const reasons = new Map<string, number>()
  let ok = 0
  for (const corner of corners) {
    const ring = rings[corner.ringIndex]
    const pts = ring.points
    const n = pts.length
    const v = pts[corner.vertexIndex]
    const prev = pts[(corner.vertexIndex - 1 + n) % n]
    const next = pts[(corner.vertexIndex + 1) % n]
    const approach = norm(v.x - prev.x, v.y - prev.y)
    const departure = norm(next.x - v.x, next.y - v.y)
    const side = corner.turnAngle >= 0 ? 'left' : 'right'
    try {
      const res = cornerUnwindPath({
        cornerX: v.x, cornerY: v.y,
        approachX: approach.x, approachY: approach.y,
        departureX: departure.x, departureY: departure.y,
        side, toolDiameter: d, nominalEngagement: nominal,
        engagementAt: ring.engagementAt,
      })
      if (res.status === 'ok') ok += 1
      else reasons.set(res.status, (reasons.get(res.status) ?? 0) + 1)
    } catch (e) {
      const key = `throw:${(e as Error).message.split(':')[0]}`
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
  }
  totalQ += corners.length; totalOk += ok
  const rs = [...reasons.entries()].map(([k, c]) => `${k}=${c}`).join(' ')
  console.log(`${entry.id.padEnd(15)} ${String(corners.length).padStart(8)} ${String(ok).padStart(8)} ${String(corners.length - ok).padStart(9)}  ${rs}`)
}
console.log(`\nTOTAL qualified ${totalQ}, unwound ${totalOk} (${(100 * totalOk / Math.max(1, totalQ)).toFixed(1)}%)`)
