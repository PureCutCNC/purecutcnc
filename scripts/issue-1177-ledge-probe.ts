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
 * #1177: the material a rotary Turn leaves **above the neighbouring Hex's flat**
 * where the two overlap, measured with the real cutter body at every emitted
 * pose.
 *
 *   npx tsx scripts/issue-1177-ledge-probe.ts [project.camj] [op ids...]
 *
 * With no file it builds the handoff's fixture in code (a Ø2 in bar along X, a
 * 1.5 in across-flats Hex over 0.75..1.25, a Ø1 Turn over 1.2..3.75, the file's
 * flat 1/4" endmill), which is the geometry of `bolt-test-02-x.camj`. With a
 * file it measures the operations named (default: every enabled one).
 *
 * The measurement is `src/test/rotaryWallFootSweep.ts`'s own sweep: one radial
 * material profile per whole degree of A, cut by the flat endmill's section at
 * every pose the operation emits. Material is reported as **height above the
 * Hex's flat plane** -- `r * cos(theta) - acrossFlats / 2`, with `theta` the
 * angle from the nearest facet normal -- so 0 is the Hex's own surface, positive
 * is material standing proud of it (the ledge #1177 is about), and negative is
 * material already removed below it.
 */

import { readFileSync } from 'node:fs'

import type { BarStock, Operation, Project, Tool } from '../src/types/project'
import { defaultTool, newProject, roundStock } from '../src/types/project'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { isBarStock } from '../src/types/barStock'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import type { NormalizedTool, ToolpathMove } from '../src/engine/toolpaths/types'
import { defaultOperationForTarget } from '../src/store/helpers/operationDefaults'
import { planRotarySolid } from '../src/store/helpers/rotarySolids'
import type { SelectionState } from '../src/store/types'
import { blankProfile, cutterPosesByAngle, sweepProfile } from '../src/test/rotaryWallFootSweep'
import type { WallFootProfile } from '../src/test/rotaryWallFootSweep'

const EMPTY_SELECTION = {
  mode: 'feature', selectedFeatureId: null, selectedFeatureIds: [], selectedTabIds: [],
  selectedClampIds: [], selectedNode: null, hoveredFeatureId: null, sketchEditTool: null,
  activeControl: null, groupFolderId: null,
} as unknown as SelectionState

const HEX_START = 0.75
const HEX_END = 1.25
const HEX_ACROSS_FLATS = 1.5
const TURN_START = 1.2
const TURN_LENGTH = 2.55
const TURN_DIAMETER = 1
const FLAT_TOOL_ID = 'flat-025'
const FLAT_RADIUS = 0.125
/**
 * The sweep's pose window: the angle a pose's disc subtends on the Hex's flat,
 * `asin(radius / apothem)`. `cutterPosesByAngle`'s default is sized by the
 * blank's radius (7.68 degrees), which drops the rim poses that physically
 * touch the flat; `sweepProfile`'s own reach check still decides every pose, so
 * this window credits nothing that does not reach.
 */
const POSE_WINDOW_DEG = Math.asin(FLAT_RADIUS / (HEX_ACROSS_FLATS / 2)) * 180 / Math.PI + 0.5

/** The spots on Frank's file, in the file's own project (inch) coordinates. */
const SPOTS: Array<{ along: number; angle: number; label: string }> = [
  { along: 1.21, angle: 15, label: 'X1.210' },
  { along: 1.21, angle: 20, label: 'X1.210' },
  { along: 1.21, angle: 25, label: 'X1.210' },
  { along: 1.24, angle: 25, label: 'X1.240' },
]

function boltProject(name: string): Project {
  const base = newProject(name, 'inch')
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 2
  base.stock = roundStock(2, 4, 'x')
  base.tools = [{
    ...defaultTool('inch', 1), id: FLAT_TOOL_ID, name: '1/4" Endmill', type: 'flat_endmill',
    diameter: 2 * FLAT_RADIUS, defaultStepover: 0.32, defaultStepdown: 0.125,
  }] as Tool[]
  base.setups.push({
    ...base.setups[0], id: 'around', name: 'Around', kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  base.activeSetupId = 'around'
  return base
}

function boltFixture(): { project: Project; turnId: string } {
  const base = boltProject('ledge probe')
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: TURN_DIAMETER,
  })
  if (!turn.ok) throw new Error(`the Turn must plan: ${turn.reason}`)
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_END - HEX_START, sides: 6,
    acrossFlats: HEX_ACROSS_FLATS, rotationDeg: 0,
  })
  if (!hex.ok) throw new Error(`the Hex must plan: ${hex.reason}`)
  return { project: hex.project, turnId: turn.created.featureId }
}

function turnOperation(project: Project, turnId: string, kind: 'rotary_rough' | 'rotary_finish'): Operation {
  return {
    ...defaultOperationForTarget(
      project, kind, kind === 'rotary_rough' ? 'rough' : 'finish',
      { source: 'features', featureIds: [turnId] }, project.operations.length + 1,
    ),
    setupId: 'around',
    rotaryPassDirection: 'around',
    name: kind === 'rotary_rough' ? 'Rotary rough 2' : 'Rotary finish 2',
    toolRef: FLAT_TOOL_ID,
    stepover: 0.32,
    stepdown: 0.125,
    stockToLeaveRadial: kind === 'rotary_rough' ? 0.02 : 0,
  }
}

function generate(project: Project, operation: Operation): ToolpathMove[] {
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope) throw new Error(`${operation.name} does not dispatch to the rotary generator`)
  return envelope.result.moves
}

function toolOf(project: Project, operation: Operation): NormalizedTool {
  const record = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!record) throw new Error(`${operation.name} has no tool`)
  return normalizeToolForProject(record, project)
}

/** The angle from the nearest Hex facet normal, degrees in `[0, 30]`. */
function facetOffset(angle: number): number {
  const wrapped = ((angle % 60) + 60) % 60
  return Math.min(wrapped, 60 - wrapped)
}

/** How far `top` at `angle` stands above the Hex's flat plane, project units. */
function aboveHexPlane(top: number, angle: number): number {
  return top * Math.cos((facetOffset(angle) * Math.PI) / 180) - HEX_ACROSS_FLATS / 2
}

function heightAt(profile: WallFootProfile, along: number): number {
  let best = 0
  let distance = Number.POSITIVE_INFINITY
  for (let i = 0; i < profile.along.length; i++) {
    const candidate = Math.abs(profile.along[i] - along)
    if (candidate < distance) {
      distance = candidate
      best = i
    }
  }
  return profile.top[best]
}

/**
 * The material after a run of operations: the blank cut by the first operation's
 * poses at each angle, then by the next one's, exactly the way a job runs.
 */
function sweptProfiles(
  project: Project,
  operations: readonly Operation[],
  from: number,
  to: number,
): Map<number, WallFootProfile> {
  const stock = project.stock as BarStock
  const window = { from, to }
  const anchor = HEX_END
  const profiles = new Map<number, WallFootProfile>()
  let started = false
  for (const operation of operations) {
    const tool = toolOf(project, operation)
    const moves = generate(project, operation)
    if (!started) {
      started = true
      const blank = blankProfile(stock, window.from, window.to, tool, anchor)
      for (const entry of cutterPosesByAngle(moves, stock, tool, POSE_WINDOW_DEG)) {
        profiles.set(entry.angle, sweepProfile(blank, entry.poses, tool, entry.angle))
      }
      continue
    }
    for (const entry of cutterPosesByAngle(moves, stock, tool, POSE_WINDOW_DEG)) {
      const current = profiles.get(entry.angle)
      if (!current) continue
      profiles.set(entry.angle, sweepProfile(current, entry.poses, tool, entry.angle))
    }
  }
  return profiles
}

function report(label: string, project: Project, operations: readonly Operation[]): void {
  const from = TURN_START - 2 * FLAT_RADIUS
  const to = HEX_END + 4 * FLAT_RADIUS
  const started = performance.now()
  const profiles = sweptProfiles(project, operations, from, to)
  const ms = performance.now() - started
  console.log(`\n${label}: ${operations.length} operation(s), ${ms.toFixed(0)} ms`)
  for (const spot of SPOTS) {
    const profile = profiles.get(spot.angle)
    if (!profile) continue
    const top = heightAt(profile, spot.along)
    const inches = aboveHexPlane(top, spot.angle)
    console.log(`  ${spot.label} A${spot.angle}°: top ${top.toFixed(5)} in, `
      + `${inches.toFixed(5)} in (${(inches * 25.4).toFixed(3)} mm) above the Hex plane`)
  }
  // The worst point over the overlap band, per angle, at whole degrees.
  let worst = Number.NEGATIVE_INFINITY
  let worstAngle = 0
  let worstAlong = 0
  for (const [angle, profile] of profiles) {
    for (let i = 0; i < profile.along.length; i++) {
      if (profile.along[i] < TURN_START - 1e-9 || profile.along[i] > HEX_END + 1e-9) continue
      const height = aboveHexPlane(profile.top[i], angle)
      if (height > worst) {
        worst = height
        worstAngle = angle
        worstAlong = profile.along[i]
      }
    }
  }
  console.log(`  worst inside the overlap ${TURN_START}..${HEX_END}: `
    + `${(worst * 25.4).toFixed(3)} mm above the Hex plane at X${worstAlong.toFixed(4)} A${worstAngle}°`)
  // The profile at A25 from the Turn start past the overlap, to show the shape.
  const slice = profiles.get(25)
  if (slice) {
    const cells: string[] = []
    for (let i = 0; i < slice.along.length; i++) {
      const along = slice.along[i]
      if (along < TURN_START - 0.01 || along > HEX_END + 0.08) continue
      if (Math.round(along * 1000) % 8 !== 0) continue
      cells.push(`${along.toFixed(3)}:${(aboveHexPlane(slice.top[i], 25) * 25.4).toFixed(2)}`)
    }
    console.log(`  A25° height above the Hex plane, mm, X vs value: ${cells.join(' ')}`)
  }
}

function fromFixture(): void {
  const { project, turnId } = boltFixture()
  const rough = turnOperation(project, turnId, 'rotary_rough')
  const finish = turnOperation(project, turnId, 'rotary_finish')
  report('Turn rough only', project, [rough])
  report('Turn rough + finish', project, [rough, finish])
}

function fromFile(path: string, wanted: readonly string[]): void {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const project = normalizeProject(raw as Parameters<typeof normalizeProject>[0])
  if (!isBarStock(project.stock)) throw new Error('the project is not on a bar')
  const ids = wanted.length > 0 ? wanted : project.operations.filter((op) => op.enabled).map((op) => op.id)
  const chosen: Operation[] = []
  for (const id of ids) {
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`no operation ${id}`)
    if (operation.kind !== 'rotary_rough' && operation.kind !== 'rotary_finish') {
      console.log(`${id} ${operation.name}: ${operation.kind} (not a rotary operation)`)
      continue
    }
    chosen.push(operation)
  }
  const turn = chosen.filter((operation) => operation.target.source === 'features'
    && operation.target.featureIds.includes('f0186'))
  report('Turn operations only', project, turn)
  report('the full sequence as listed', project, chosen)
}

const [projectPath, ...ops] = process.argv.slice(2)
if (projectPath === undefined) fromFixture()
else fromFile(projectPath, ops)
