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
 * #1155 rn-c: sweep the real cutter body along every emitted move of a rotary
 * operation and report the deepest penetration into the material it must keep.
 *
 * Usage:
 *   npx tsx scripts/issue-1155-rn-c-gouge-probe.ts <project.camj> [ops...]
 *
 * The protected solids are analytic, built from the project's **canned** models
 * (a Polygon becomes a prism over its band, a Turn a cylinder). Nothing here
 * reads the generator's own sampled heights, so a pass that believes it is
 * clear is still measured against the real solid.
 */

import { readFileSync } from 'node:fs'

import type { BarStock, Operation, Project, Tool } from '../src/types/project'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import type { NormalizedTool, ToolpathMove } from '../src/engine/toolpaths/types'
import { barCentre, barPivotZ, isBarStock } from '../src/types/barStock'
import { minRenderHeight } from '../src/engine/csg'

/** A convex solid in stock coordinates, about a bar axis along X. */
interface Solid {
  readonly kind: 'polygon' | 'cylinder'
  readonly alongMin: number
  readonly alongMax: number
  /** Polygon facets' outward normals, `across` and `up` components. */
  readonly normals: readonly { readonly across: number; readonly up: number }[]
  readonly apothem: number
  readonly radius: number
}

/** The canned parameters the probe can read, from a model feature definition. */
interface CannedModel {
  readonly featureId: string
  readonly kind: 'polygon' | 'turn'
  readonly alongMin: number
  readonly alongMax: number
  readonly acrossFlats: number
  readonly diameter: number
  readonly sides: number
  readonly rotation: number
}

function cannedModels(project: Project): CannedModel[] {
  const models: CannedModel[] = []
  for (const feature of project.features) {
    const definition = project.featureDefinitions[feature.definitionId]
    const canned = definition?.canned as { kind?: string; params?: Record<string, unknown> } | null | undefined
    if (!canned || (canned.kind !== 'polygon' && canned.kind !== 'turn')) continue
    const params = canned.params ?? {}
    const start = Number(params.start)
    const length = Number(params.length)
    if (!Number.isFinite(start) || !Number.isFinite(length)) continue
    models.push({
      featureId: feature.id,
      kind: canned.kind,
      alongMin: start,
      alongMax: start + length,
      acrossFlats: Number(params.acrossFlats ?? 0),
      diameter: Number(params.diameter ?? 0),
      sides: Number(params.sides ?? 0),
      rotation: Number(params.rotation ?? 0),
    })
  }
  return models
}

function solidOf(model: CannedModel, alongMin: number, alongMax: number): Solid {
  if (model.kind === 'turn') {
    return { kind: 'cylinder', alongMin, alongMax, normals: [], apothem: 0, radius: model.diameter / 2 }
  }
  const angleStep = (2 * Math.PI) / model.sides
  const rotation = (model.rotation * Math.PI) / 180
  const normals = Array.from({ length: model.sides }, (_, k) => {
    // A polygon at rotation 0 has one flat up, so facet normals sit at
    // `k * 360 / sides` measured from +up (`rotaryPolygonCrossSection`).
    const angle = k * angleStep + rotation
    return { across: Math.sin(angle), up: Math.cos(angle) }
  })
  return { kind: 'polygon', alongMin, alongMax, normals, apothem: model.acrossFlats / 2, radius: 0 }
}

/**
 * How far inside the solid a stock-frame point lies. Positive is inside.
 *
 * The end faces are constraints too: without them a body point inside the band
 * reads as "inside by the whole radial depth", so a pass tangent to an end face
 * looks like a gouge.
 */
function depthInto(
  along: number, across: number, up: number, solid: Solid, centre: number, pivot: number,
): number {
  if (along < solid.alongMin || along > solid.alongMax) return Number.NEGATIVE_INFINITY
  const endDepth = Math.min(along - solid.alongMin, solid.alongMax - along)
  if (solid.kind === 'cylinder') {
    const radial = Math.hypot(across - centre, up - pivot)
    return Math.min(endDepth, solid.radius - radial)
  }
  let largest = Number.NEGATIVE_INFINITY
  for (const normal of solid.normals) {
    largest = Math.max(largest, normal.across * (across - centre) + normal.up * (up - pivot))
  }
  return Math.min(endDepth, solid.apothem - largest)
}

/** One point of the cutter body, relative to the tip, in the tool's own frame. */
interface BodyPoint {
  readonly lateral: number
  readonly along: number
  readonly rise: number
}

function cutterBody(radius: number, type: 'flat' | 'ball'): BodyPoint[] {
  const points: BodyPoint[] = []
  const longitudes = 16
  const rises = [0, radius / 2, radius, 2 * radius]
  if (type === 'flat') {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const rr = radius * fraction
      for (let i = 0; i < longitudes; i++) {
        const theta = (i / longitudes) * Math.PI * 2
        for (const rise of rises) {
          points.push({ lateral: rr * Math.cos(theta), along: rr * Math.sin(theta), rise })
        }
      }
    }
    return points
  }
  for (let latitude = 0; latitude <= 8; latitude++) {
    const phi = (latitude / 8) * Math.PI / 2
    for (let i = 0; i < longitudes; i++) {
      const theta = (i / longitudes) * Math.PI * 2
      points.push({
        lateral: radius * Math.sin(phi) * Math.cos(theta),
        along: radius * Math.sin(phi) * Math.sin(theta),
        rise: radius * (1 - Math.cos(phi)),
      })
    }
  }
  for (let i = 0; i < longitudes; i++) {
    const theta = (i / longitudes) * Math.PI * 2
    for (const rise of [radius, 2 * radius]) {
      points.push({ lateral: radius * Math.cos(theta), along: radius * Math.sin(theta), rise })
    }
  }
  return points
}

type Movement = 'ring' | 'helix' | 'link' | 'along' | 'plunge' | 'retract' | 'other'

function movementOf(move: ToolpathMove): Movement {
  if (move.kind === 'rapid') return 'retract'
  const da = Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))
  const dl = Math.abs(move.to.x - move.from.x) + Math.abs(move.to.y - move.from.y)
  const dr = Math.abs(move.to.z - move.from.z)
  if (da >= 360) return 'helix'
  if (da > 1e-9 && dl <= 1e-9) return 'ring'
  if (da > 1e-9 && dl > 1e-9) return 'helix'
  if (da <= 1e-9 && dl > 1e-9) return dr > 1e-9 ? 'helix' : 'link'
  if (da <= 1e-9 && dl <= 1e-9) return dr > 1e-9 ? 'plunge' : 'other'
  return 'other'
}

interface Gouge {
  depth: number
  where: string
}

/** The tip alone, with no body: the pose against the same solid. */
function deepestTip(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  solid: Solid,
): Gouge {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const axis = stock.axis
  let depth = Number.NEGATIVE_INFINITY
  let where = 'nowhere'
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index]
    if (move.kind === 'rapid') continue
    const angle = ((move.from.a ?? 0) * Math.PI) / 180
    const along = axis === 'x' ? move.from.x : move.from.y
    const radius = move.from.z - pivot
    const candidate = depthInto(
      along, centre + Math.sin(angle) * radius, pivot + Math.cos(angle) * radius, solid, centre, pivot)
    if (candidate > depth) {
      depth = candidate
      where = `move ${index} (${move.kind}, ${movementOf(move)}) at along ${along.toFixed(4)}, `
        + `A ${((angle * 180) / Math.PI).toFixed(1)}°, tip radius ${radius.toFixed(4)}`
    }
  }
  return { depth, where }
}


/**
 * Sweep the cutter body along `moves`, interpolating in `(along, A, tip radius)`
 * -- a ring's XYZ chord would cut through the bar -- at no more than a quarter
 * tool radius of tool-centre travel, and report the deepest penetration.
 */
function deepestGouge(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  tool: NormalizedTool,
  solid: Solid,
): Gouge & { byMovement: Map<Movement, Gouge> } {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const axis = stock.axis
  const body = cutterBody(tool.radius, tool.type === 'ball_endmill' ? 'ball' : 'flat')
  const step = Math.max(tool.radius / 4, 1e-4)
  let depth = Number.NEGATIVE_INFINITY
  let where = 'nowhere'
  const byMovement = new Map<Movement, Gouge>()
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index]
    if (move.kind === 'rapid') continue
    const movement = movementOf(move)
    const alongFrom = axis === 'x' ? move.from.x : move.from.y
    const alongTo = axis === 'x' ? move.to.x : move.to.y
    const angleFrom = ((move.from.a ?? 0) * Math.PI) / 180
    const angleTo = ((move.to.a ?? 0) * Math.PI) / 180
    const radiusFrom = move.from.z - pivot
    const radiusTo = move.to.z - pivot
    const arc = Math.abs(angleTo - angleFrom) * Math.max(Math.abs(radiusFrom), Math.abs(radiusTo))
    const steps = Math.max(1, Math.ceil(Math.hypot(alongTo - alongFrom, arc, radiusTo - radiusFrom) / step))
    for (let pose = 0; pose <= steps; pose++) {
      const t = pose / steps
      const along = alongFrom + (alongTo - alongFrom) * t
      const angle = angleFrom + (angleTo - angleFrom) * t
      const radius = radiusFrom + (radiusTo - radiusFrom) * t
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      for (const point of body) {
        const across = centre + cos * point.lateral + sin * (radius + point.rise)
        const up = pivot - sin * point.lateral + cos * (radius + point.rise)
        const candidate = depthInto(along + point.along, across, up, solid, centre, pivot)
        if (candidate <= (byMovement.get(movement)?.depth ?? Number.NEGATIVE_INFINITY)) continue
        const record: Gouge = {
          depth: candidate,
          where: `move ${index} (${move.kind}, ${movement}) at along ${(along + point.along).toFixed(4)}, `
            + `A ${((angle * 180) / Math.PI).toFixed(1)}°, tip radius ${radius.toFixed(4)}`,
        }
        byMovement.set(movement, record)
        if (candidate > depth) {
          depth = candidate
          where = record.where
        }
      }
    }
  }
  return { depth, where, byMovement }
}

/**
 * The solid an operation must keep: every canned model it does not target, over
 * the part of its band the operation's own target does not own.
 *
 * A Turn ending 0.05 inside a Hex is the rn-c case: the overlap belongs to the
 * taller model, so an operation on the taller one protects the neighbour from
 * the taller model's far face on, and an operation on the shorter one protects
 * the neighbour's whole band.
 */
function protectedSolids(project: Project, operation: Operation): Solid[] {
  const targets = operation.target.source === 'features' ? operation.target.featureIds : []
  const models = cannedModels(project)
  const own = models.filter((model) => targets.includes(model.featureId))
  const others = models.filter((model) => !targets.includes(model.featureId))
  const ownMax = own.length === 0 ? -Infinity : Math.max(...own.map((model) => model.alongMax))
  const ownMin = own.length === 0 ? Infinity : Math.min(...own.map((model) => model.alongMin))
  const ownTall = own.length === 0 ? 0 : Math.max(...own.map((model) =>
    model.kind === 'polygon' ? model.acrossFlats / 2 : model.diameter / 2))
  const solids: Solid[] = []
  for (const model of others) {
    // Only the part that is not the target's own material: when the two bands
    // overlap and the target stands at least as tall, the overlap is the
    // target's (an operation on the Hex may cut the Turn inside the Hex).
    for (const [alongMin, alongMax] of cutBand(model, ownMin, ownMax, ownTall)) {
      if (alongMax - alongMin > 1e-9) solids.push(solidOf(model, alongMin, alongMax))
    }
  }
  return solids
}

/** The stretches of `model`'s band that are not the taller target's. */
function cutBand(
  model: CannedModel, ownMin: number, ownMax: number, ownTall: number,
): Array<[number, number]> {
  const modelTall = model.kind === 'polygon' ? model.acrossFlats / 2 : model.diameter / 2
  const overlaps = model.alongMin < ownMax && model.alongMax > ownMin
  if (!overlaps || ownTall < modelTall - 1e-9) return [[model.alongMin, model.alongMax]]
  const pieces: Array<[number, number]> = []
  if (model.alongMin < ownMin) pieces.push([model.alongMin, Math.min(ownMin, model.alongMax)])
  if (model.alongMax > ownMax) pieces.push([Math.max(ownMax, model.alongMin), model.alongMax])
  return pieces
}

function main(): void {
  const [projectPath, ...ops] = process.argv.slice(2)
  if (!projectPath) {
    console.error('usage: issue-1155-rn-c-gouge-probe.ts <project.camj> [ops...]')
    process.exitCode = 2
    return
  }
  const raw: unknown = JSON.parse(readFileSync(projectPath, 'utf8'))
  const project = normalizeProject(raw as Parameters<typeof normalizeProject>[0])
  if (!isBarStock(project.stock)) throw new Error('the project is not on a bar')
  const stock = project.stock
  const tolerance = minRenderHeight(project.meta.units)
  const wanted = ops.length > 0 ? ops : project.operations.filter((op) => op.enabled).map((op) => op.id)
  for (const id of wanted) {
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`no operation ${id}`)
    const record: Tool | undefined = project.tools.find((tool) => tool.id === operation.toolRef)
    if (!record) throw new Error(`${id} has no tool`)
    const tool: NormalizedTool = normalizeToolForProject(record, project)
    const solids = protectedSolids(project, operation)
    if (solids.length === 0) {
      console.log(`${id}: no protected solid beside it`)
      continue
    }
    const started = performance.now()
    const envelope = computeOperationToolpath(project, operation)
    const elapsed = performance.now() - started
    const moves = envelope?.result.moves ?? []
    const cut = moves.filter((move) => move.kind === 'cut').length
    const helix = moves.filter((move) => movementOf(move) === 'helix').length
    console.log(`${id} ${operation.kind} tool Ø${tool.diameter}" ${tool.type} target `
      + `${operation.target.source === 'features' ? operation.target.featureIds.join('+') : '?'}; `
      + `${moves.length} moves (${cut} cut, ${helix} helix) in ${elapsed.toFixed(0)} ms`)
    for (const solid of solids) {
      const report = deepestGouge(moves, stock, tool, solid)
      const worstOf = (movement: Movement): string => {
        const record = report.byMovement.get(movement)
        return record ? record.depth.toFixed(4) : '-'
      }
      const verdict = report.depth > tolerance ? 'GOUGE' : 'ok'
      const tip = deepestTip(moves, stock, solid)
      console.log(`  ${solid.kind} ${solid.alongMin}..${solid.alongMax}: deepest `
        + `${report.depth.toFixed(5)} ${verdict} (tol ${tolerance.toFixed(6)}); ${report.where}`)
      console.log(`    tip alone ${tip.depth.toFixed(5)}; ${tip.where}`)
      console.log(`    ring ${worstOf('ring')} helix ${worstOf('helix')} link ${worstOf('link')} `
        + `along ${worstOf('along')} plunge ${worstOf('plunge')}`)
    }
  }
}

main()
