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
 * #1177 diagnosis aid: the shoulder residual measured with a **wider pose window**
 * than `cutterPosesByAngle`'s default.
 *
 * `cutterPosesByAngle` assigns a pose to every angle its body can reach, but the
 * window it uses is `asin(toolRadius / barMaxRadius) + 0.5` -- the *blank's*
 * radius. A turned surface inside the blank has a smaller radius, and a pose at
 * that surface subtends a *wider* angle (`asin(r / R_material)`): on Frank's
 * bolt the default window is 7.68 degrees while the hex flat's radius needs
 * 8.66, so the poses whose disc rim lands exactly on a flat point -- the only
 * ones that clear it to the plane -- are dropped before `sweepProfile` sees
 * them. This probe re-runs the same sweep at several windows so the residual
 * can be read with and without that cap.
 *
 *   npx tsx scripts/issue-1177-window-probe.ts [project.camj]
 */
import { readFileSync } from 'node:fs'

import type { BarStock, Operation, Project } from '../src/types/project'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { isBarStock } from '../src/types/barStock'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import type { NormalizedTool, ToolpathMove } from '../src/engine/toolpaths/types'
import { blankProfile, cutterPosesByAngle, sweepProfile } from '../src/test/rotaryWallFootSweep'
import type { WallFootProfile } from '../src/test/rotaryWallFootSweep'

const HEX_END = 1.25
const APOTHEM = 0.75
const facet = (t: number): number => {
  const w = ((t % 60) + 60) % 60
  return Math.min(w, 60 - w)
}
const above = (r: number, a: number): number =>
  (r * Math.cos((facet(a) * Math.PI) / 180) - APOTHEM) * 25.4

const path = process.argv[2] ?? 'work/bolt-test-02-x.camj'
const project = normalizeProject(JSON.parse(readFileSync(path, 'utf8')) as never)
if (!isBarStock(project.stock)) throw new Error('the project is not on a bar')
const stock = project.stock as BarStock

const ids = ['op0197', 'op0198']
const operations: Operation[] = ids
  .map((id) => project.operations.find((op) => op.id === id))
  .filter((op): op is Operation => op !== undefined)
const from = 1.15
const to = 1.32

for (const windowDeg of [undefined, 9, 12, 30]) {
  let profiles: Map<number, WallFootProfile> | null = null
  for (const operation of operations) {
    const tool = normalizeToolForProject(project.tools.find((t) => t.id === operation.toolRef)!, project)
    const envelope = computeOperationToolpath(project as Project, operation)
    if (!envelope) throw new Error(`${operation.id} does not dispatch`)
    const moves: ToolpathMove[] = envelope.result.moves
    const poses = cutterPosesByAngle(moves, stock, tool, windowDeg)
    if (profiles === null) {
      const blank = blankProfile(stock, from, to, tool, HEX_END)
      profiles = new Map(poses.map((entry) => [
        entry.angle, sweepProfile(blank, entry.poses, tool, entry.angle),
      ]))
      continue
    }
    for (const entry of poses) {
      const current = profiles.get(entry.angle)
      if (!current) continue
      profiles.set(entry.angle, sweepProfile(current, entry.poses, tool, entry.angle))
    }
  }
  const spots: string[] = []
  for (const [along, angle] of [[1.20996, 15], [1.20996, 20], [1.20996, 25], [1.24, 25]] as const) {
    const profile = profiles!.get(angle)!
    let best = 0
    let distance = Number.POSITIVE_INFINITY
    for (let i = 0; i < profile.along.length; i++) {
      const candidate = Math.abs(profile.along[i] - along)
      if (candidate < distance) { distance = candidate; best = i }
    }
    spots.push(`X${along.toFixed(3)}A${angle}:${above(profile.top[best], angle).toFixed(3)}`)
  }
  let worst = Number.NEGATIVE_INFINITY
  let worstAt = ''
  for (const [angle, profile] of profiles!) {
    for (let i = 0; i < profile.along.length; i++) {
      if (profile.along[i] < 1.2 - 1e-9 || profile.along[i] > HEX_END + 1e-9) continue
      const height = above(profile.top[i], angle)
      if (height > worst) { worst = height; worstAt = `X${profile.along[i].toFixed(3)}A${angle}` }
    }
  }
  const tool = normalizeToolForProject(project.tools.find((t) => t.id === operations[0].toolRef)!, project)
  void tool
  console.log(`window ${windowDeg ?? 'default'}: ${spots.join(' ')} worst ${worst.toFixed(3)}mm at ${worstAt}`)
}
