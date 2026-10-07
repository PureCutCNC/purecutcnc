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

import { plasmaStartPointForContour } from './plasmaStartPoint'
import type { Operation, Point, Project } from '../../types/project'
import { setupFace, setupForOperation } from '../setupOrientation'
import { resolveProject } from '../../store/helpers/resolveFeatures'
import { expandFeatureGeometry } from '../../text'
import { findOperationTool } from '../../toolPolicy'
import { convertLength } from '../../utils/units'
import { flattenProfile, fromClipperPath, getOperationSafeZ, normalizeToolForProject, normalizeWinding, resolveDimensionRef, offsetKeepOutPaths, toClipperPath, DEFAULT_CLIPPER_SCALE } from './geometry'
import { buildTangentLeadPath } from './tangentLink'
import { distanceToContour, insideContour, pathClearOfContour, pathOnScrap, plasmaArrivals } from './plasmaGeometry'
import type { ToolpathMove, ToolpathResult } from './types'

export function plasmaLeadLength(project: Project, operation: Operation): number {
  return operation.plasmaLeadInLength ?? Math.max(convertLength(3, 'mm', project.meta.units), project.stock.thickness)
}

/** Quarter-circle uses the same tangent arc builder as xyLead.ts; radius is the
 * requested distance from the part edge, rather than an automatic milling budget. */
function lead(start: Point, tangent: Point, normal: Point, length: number, style: 'line' | 'arc', entering: boolean): Point[] {
  if (style === 'line') {
    const far = { x: start.x + normal.x * length, y: start.y + normal.y * length }
    return entering ? [far, start] : [start, far]
  }
  const t = entering ? { x: -tangent.x, y: -tangent.y } : tangent
  const side = t.x * normal.y - t.y * normal.x > 0 ? 1 : -1
  const points = buildTangentLeadPath(start, t, { turn1: side * Math.PI / 2, radius1: side * length, straight: 0, turn2: 0, radius2: 0 }, Math.PI / 90)
  return entering ? points.reverse() : points
}

export function generatePlasmaProfileToolpath(authoritativeProject: Project, operation: Operation): ToolpathResult {
  const result: ToolpathResult = { operationId: operation.id, moves: [], warnings: [], bounds: null }
  const warn = (code: 'plasmaInvalid' | 'plasmaOpenPath' | 'plasmaNoLead' | 'plasmaSmallHole' | 'plasmaCentrePierce' | 'plasmaLeadOutOmitted' | 'plasmaTopOnly' | 'plasmaHoleBeforePart' | 'plasmaPartialDepth' | 'plasmaStraightLead', name = operation.name): void => { result.warnings.push({ code, params: { name } }) }
  try {
    const setup = setupForOperation(authoritativeProject, operation)
    if (setup && setupFace(setup) !== 'top') { warn('plasmaTopOnly'); return result }
  } catch { warn('plasmaTopOnly'); return result }
  const rawTool = findOperationTool(authoritativeProject, operation)
  if (operation.kind !== 'plasma_profile' || rawTool?.type !== 'plasma') { result.warnings.push({ code: 'noToolAssigned' }); return result }
  const tool = normalizeToolForProject(rawTool, authoritativeProject)
  const project = resolveProject(authoritativeProject)
  const inLength = plasmaLeadLength(authoritativeProject, operation)
  if (!(tool.radius > 0) || !Number.isFinite(tool.radius) || !(inLength > 0) || !Number.isFinite(inLength)
    || !Number.isFinite(tool.cutHeight) || (tool.cutHeight ?? -1) < 0
    || !(operation.feed > 0) || !Number.isFinite(operation.feed)
    || !(project.stock.thickness > 0) || !Number.isFinite(project.stock.thickness)
    || (operation.plasmaReverseDirection !== undefined && typeof operation.plasmaReverseDirection !== 'boolean')
    || !['auto', 'inside', 'outside'].includes(operation.plasmaSide ?? 'auto')
    || !['line', 'arc'].includes(operation.plasmaLeadIn ?? 'arc')
    || !['line', 'arc'].includes(operation.plasmaLeadOut ?? 'line')
    || (operation.plasmaStartPoint && (!Number.isFinite(operation.plasmaStartPoint.x) || !Number.isFinite(operation.plasmaStartPoint.y)))
    || (operation.plasmaLeadOutLength !== undefined && (!Number.isFinite(operation.plasmaLeadOutLength) || operation.plasmaLeadOutLength < 0))) { warn('plasmaInvalid'); return result }
  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) { warn('plasmaInvalid'); return result }
  const selected = operation.target.featureIds.map((id) => project.features.find((f) => f.id === id))
  const targets = selected.flatMap((f) => f ? expandFeatureGeometry(f, false) : [undefined])
  if (targets.length === 0 || targets.some((f) => !f || f.kind === 'stl' || !['add', 'subtract', 'line'].includes(f.operation))) { warn('plasmaInvalid'); return result }
  if (targets.some((f) => !f?.sketch.profile.closed)) { warn('plasmaOpenPath'); return result }
  const shapes = project.features.flatMap((f) => expandFeatureGeometry(f, false)).filter((f) => f.kind !== 'stl' && f.sketch.profile.closed && ['add', 'subtract', 'line'].includes(f.operation))
    .map((f) => ({ feature: f, ring: flattenProfile(f.sketch.profile).points }))
  const safeZ = Math.max(getOperationSafeZ(authoritativeProject), project.stock.thickness + (tool.cutHeight ?? 0) + convertLength(1, 'mm', project.meta.units))
  const z = project.stock.thickness + (tool.cutHeight ?? 0)
  const move = (kind: ToolpathMove['kind'], from: Point & { z?: number }, to: Point & { z?: number }): void => {
    result.moves.push({ kind, from: { ...from, z: from.z ?? z }, to: { ...to, z: to.z ?? z } })
  }
  for (const target of targets) {
    if (!target) continue
    const shape = shapes.find((s) => s.feature.id === target.id)
    if (!shape || shape.ring.length < 3 || shape.ring.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) { warn('plasmaInvalid', target.name); continue }
    if (target.operation === 'subtract') {
      if (shapes.some((s) => s.feature.operation === 'add' && shapes.indexOf(s) > shapes.indexOf(shape)
        && shape.ring.every((point) => insideContour(point, s.ring)))) { warn('plasmaHoleBeforePart', target.name); continue }
      let bottom: number
      try { bottom = resolveDimensionRef(authoritativeProject, target.z_bottom) } catch { warn('plasmaInvalid', target.name); continue }
      if (!Number.isFinite(bottom)) { warn('plasmaInvalid', target.name); continue }
      if (bottom > 0) warn('plasmaPartialDepth', target.name)
    }
    const inside = operation.plasmaSide === 'inside' || ((operation.plasmaSide ?? 'auto') === 'auto' && target.operation === 'subtract')
    const outLength = operation.plasmaLeadOutLength ?? (inside ? 0 : tool.diameter)
    // Separate calls per target: ClipperOffset must never orient a hole from an outside contour (#909).
    const offset = offsetKeepOutPaths([toClipperPath(normalizeWinding(shape.ring, true))], (inside ? -1 : 1) * tool.radius * DEFAULT_CLIPPER_SCALE)
    if (offset.length !== 1) { warn('plasmaNoLead', target.name); continue }
    let ring = fromClipperPath(offset[0])
    // Positive shoelace in Y-down is clockwise when viewed above the physical sheet.
    // normalizeWinding calls its negative sign 'clockwise' (Y-up); invert deliberately.
    ring = normalizeWinding(ring, inside !== Boolean(operation.plasmaReverseDirection)).slice(0, -1)
    const neighbourSafe = (path: Point[]): boolean => shapes.every((s) => {
      if (s.feature.id === target.id || s.feature.operation === 'subtract') return true
      const holes = shapes.filter((h) => h.feature.operation === 'subtract' && shapes.indexOf(h) > shapes.indexOf(s)
        && h.ring.every((p) => insideContour(p, s.ring)))
      // A hole in an enclosing part is scrap. A distinct part nested in that hole remains protected.
      if (holes.some((h) => pathOnScrap(path, h.ring, true, h.feature.id === target.id ? tool.radius : tool.diameter))) return true
      return path.every((p) => !insideContour(p, s.ring)) && pathClearOfContour(path, s.ring, tool.diameter)
    })
    if (!neighbourSafe([...ring, ring[0]])) { warn('plasmaNoLead', target.name); continue }
    const xs = shape.ring.map((p) => p.x), ys = shape.ring.map((p) => p.y)
    const diameter = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    if (inside && diameter < 1.5 * project.stock.thickness) warn('plasmaSmallHole', target.name)
    let chosen: { ring: Point[]; entry: Point[]; exit: Point[]; centrePierce: boolean; straightFallback: boolean } | null = null
    const owner = selected.find((feature) => feature && expandFeatureGeometry(feature, false).some((shape) => shape.id === target.id))
    const hasLocalStart = !!operation.plasmaStartPoints && Object.hasOwn(operation.plasmaStartPoints, target.id)
    const localStart = hasLocalStart ? operation.plasmaStartPoints![target.id] : undefined
    const startPoint = hasLocalStart
      ? localStart && owner ? plasmaStartPointForContour(target.sketch.profile, owner.transform, localStart) : null
      : operation.plasmaStartPoint
    if (hasLocalStart && !startPoint) { warn('plasmaInvalid', target.name); continue }
    const arrivals = plasmaArrivals(ring, startPoint ?? undefined)
    for (const arrival of startPoint ? arrivals.slice(0, 1) : arrivals) {
      const normal = inside ? { x: -arrival.normal.x, y: -arrival.normal.y } : arrival.normal
      const start = arrival.ring[0]
      const entrySafe = (path: Point[]): boolean => pathOnScrap(path, shape.ring, inside, tool.radius)
        && distanceToContour(path[0], shape.ring) + 2 / DEFAULT_CLIPPER_SCALE >= inLength && neighbourSafe(path)
      const style = operation.plasmaLeadIn ?? 'arc'
      let entry = lead(start, arrival.tangent, normal, inLength, style, true)
      let centrePierce = false, straightFallback = false
      // A tangent arc can fit but pierce too close to the hole edge. Try a
      // square-on line before the exceptional, warned centre pierce.
      if (inside && style === 'arc' && !entrySafe(entry)) {
        entry = lead(start, arrival.tangent, normal, inLength, 'line', true)
        straightFallback = true
      }
      if (!entrySafe(entry)) {
        if (!inside) continue
        const centre = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
        // The centre exception is only for a hole too small for the requested lead.
        if (distanceToContour(centre, shape.ring) >= inLength || startPoint) continue
        entry = [centre, start]
        if (!pathOnScrap(entry, shape.ring, true, tool.radius) || !neighbourSafe(entry)) continue
        centrePierce = true
      }
      let exit = outLength > 0 ? lead(start, arrival.tangent, normal, outLength, operation.plasmaLeadOut ?? 'line', false) : []
      if (exit.length && (!pathOnScrap(exit, shape.ring, inside, tool.radius) || !neighbourSafe(exit))) exit = []
      chosen = { ring: arrival.ring, entry, exit, centrePierce, straightFallback }
      break
    }
    if (!chosen) { warn('plasmaNoLead', target.name); continue }
    if (chosen.centrePierce) warn('plasmaCentrePierce', target.name)
    else if (chosen.straightFallback) warn('plasmaStraightLead', target.name)
    if (outLength > 0 && chosen.exit.length === 0) warn('plasmaLeadOutOmitted', target.name)
    const pierce = chosen.entry[0]
    const previous = result.moves[result.moves.length - 1]?.to
    if (previous) move('rapid', previous, { ...pierce, z: safeZ })
    move('plunge', { ...pierce, z: safeZ }, pierce)
    for (let i = 1; i < chosen.entry.length; i += 1) move('lead_in', chosen.entry[i - 1], chosen.entry[i])
    for (let i = 1; i < chosen.ring.length; i += 1) move('cut', chosen.ring[i - 1], chosen.ring[i])
    for (let i = 1; i < chosen.exit.length; i += 1) move('lead_out', chosen.exit[i - 1], chosen.exit[i])
    const end = chosen.exit.at(-1) ?? chosen.ring.at(-1) ?? pierce
    move('rapid', end, { ...end, z: safeZ })
  }
  if (result.moves.length) {
    const points = result.moves.flatMap((m) => [m.from, m.to])
    result.bounds = { minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)), minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)), minZ: Math.min(...points.map((p) => p.z)), maxZ: Math.max(...points.map((p) => p.z)) }
  }
  return result
}
