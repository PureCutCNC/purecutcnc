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
 * Rolling-hills-with-flats model, the fixture #698 is calibrated against.
 *
 * A 3D finish has to handle four surface characters at once, and waterline is
 * uneven across them by construction — it is a constant-Z strategy, so its
 * contours crowd together on steep ground and spread arbitrarily far apart on
 * shallow ground. This mixes all four deliberately:
 *
 *   - a large flat background plane      (waterline's worst case)
 *   - flat plateau tops on clamped domes (waterline's worst case, and #700)
 *   - steep dome flanks                  (waterline's best case)
 *   - a gentle ramp                      (shallow without being horizontal)
 *
 * It is generated rather than checked in as an STL so the shape is readable and
 * the resolution is a parameter: `finishSurfaceWaterlineBudget.test.ts` wants a
 * small mesh it can run four times, `scripts/waterline-coverage-probe.ts` wants
 * a fine one whose facets do not show up in the measurement.
 *
 * The mesh is a closed solid: heightfield top, vertical skirt, flat bottom at
 * z = 0. Units are mm.
 */

import {
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type Project,
  type SketchFeature,
  type Tool,
} from '../types/project'
import { projectWithFeatures } from './projectFixtures'

export interface HillsOptions {
  spanX?: number
  spanY?: number
  /** Heightfield sample spacing; the triangle count goes as its square. */
  cell?: number
  /** Flat background plane height. */
  baseZ?: number
  /** Dome tops are clamped here, producing genuine horizontal plateaus. */
  plateauZ?: number
}

type ResolvedHillsOptions = Required<HillsOptions>

interface Hill {
  /** Centre and radius as a fraction of the span, so the shape scales. */
  cx: number
  cy: number
  r: number
  /** Height above `baseZ` at the centre, before clamping. */
  h: number
}

/**
 * Fractions of the span, so a 40 mm test fixture and an 80 mm probe fixture are
 * the same shape at different resolutions. Three of the five clear `plateauZ`
 * and so carry a flat top; two stay rounded.
 */
const HILLS: Hill[] = [
  { cx: 0.200, cy: 0.267, r: 0.2167, h: 14 },
  { cx: 0.200, cy: 0.733, r: 0.2000, h: 7 },
  { cx: 0.525, cy: 0.500, r: 0.2500, h: 14 },
  { cx: 0.500, cy: 0.117, r: 0.1333, h: 11 },
  { cx: 0.525, cy: 0.883, r: 0.1333, h: 5.5 },
]

export function resolveHillsOptions(options: HillsOptions = {}): ResolvedHillsOptions {
  return {
    spanX: options.spanX ?? 80,
    spanY: options.spanY ?? 60,
    cell: options.cell ?? 0.4,
    baseZ: options.baseZ ?? 2,
    plateauZ: options.plateauZ ?? 10,
  }
}

/** Surface height at a point, in mesh-local coordinates. */
export function hillsHeight(x: number, y: number, o: ResolvedHillsOptions): number {
  let z = o.baseZ
  for (const hill of HILLS) {
    const cx = hill.cx * o.spanX
    const cy = hill.cy * o.spanY
    const radius = hill.r * Math.min(o.spanX, o.spanY)
    const d = Math.hypot(x - cx, y - cy)
    if (d >= radius) continue
    // Raised cosine: zero slope at the centre and at the skirt, steepest at r/2.
    const dome = o.baseZ + hill.h * 0.5 * (1 + Math.cos((Math.PI * d) / radius))
    if (dome > z) z = dome
  }
  if (z > o.plateauZ) z = o.plateauZ
  // Gentle ramp over the right quarter — shallow, but not horizontal.
  const rampStart = o.spanX * 0.725
  if (x > rampStart) {
    const ramp = o.baseZ + Math.min(4, ((x - rampStart) / (o.spanX - rampStart)) * 4)
    if (ramp > z) z = ramp
  }
  return z
}

type Vertex = readonly [number, number, number]

function pushTriangle(lines: string[], a: Vertex, b: Vertex, c: Vertex): void {
  lines.push('  facet normal 0 0 0')
  lines.push('    outer loop')
  lines.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`)
  lines.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`)
  lines.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`)
  lines.push('    endloop')
  lines.push('  endfacet')
}

/** ASCII STL of the closed hills solid, as a data URL. */
export function hillsStlDataUrl(options: HillsOptions = {}): string {
  const o = resolveHillsOptions(options)
  const nx = Math.max(2, Math.round(o.spanX / o.cell))
  const ny = Math.max(2, Math.round(o.spanY / o.cell))
  const at = (i: number, j: number): Vertex => {
    const x = (i / nx) * o.spanX
    const y = (j / ny) * o.spanY
    return [x, y, hillsHeight(x, y, o)]
  }
  const lines = ['solid hills']

  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const a = at(i, j)
      const b = at(i + 1, j)
      const c = at(i + 1, j + 1)
      const d = at(i, j + 1)
      pushTriangle(lines, a, b, c)
      pushTriangle(lines, a, c, d)
    }
  }

  // Vertical skirt down to z = 0, walked around the boundary so consecutive
  // entries pair into wall quads.
  const boundary: Array<[number, number]> = []
  for (let i = 0; i < nx; i += 1) boundary.push([i, 0])
  for (let j = 0; j < ny; j += 1) boundary.push([nx, j])
  for (let i = nx; i > 0; i -= 1) boundary.push([i, ny])
  for (let j = ny; j > 0; j -= 1) boundary.push([0, j])
  for (let k = 0; k < boundary.length; k += 1) {
    const [i0, j0] = boundary[k]
    const [i1, j1] = boundary[(k + 1) % boundary.length]
    const top0 = at(i0, j0)
    const top1 = at(i1, j1)
    const base0: Vertex = [top0[0], top0[1], 0]
    const base1: Vertex = [top1[0], top1[1], 0]
    pushTriangle(lines, top0, base0, base1)
    pushTriangle(lines, top0, base1, top1)
  }

  // Flat bottom, two triangles across the corners.
  const c00: Vertex = [0, 0, 0]
  const c10: Vertex = [o.spanX, 0, 0]
  const c11: Vertex = [o.spanX, o.spanY, 0]
  const c01: Vertex = [0, o.spanY, 0]
  pushTriangle(lines, c00, c11, c10)
  pushTriangle(lines, c00, c01, c11)

  lines.push('endsolid hills')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

export function hillsModelFeature(options: HillsOptions = {}): SketchFeature {
  const o = resolveHillsOptions(options)
  const silhouette = [
    { x: 0, y: 0 },
    { x: o.spanX, y: 0 },
    { x: o.spanX, y: o.spanY },
    { x: 0, y: o.spanY },
  ]
  return {
    id: 'hills-model',
    name: 'Hills STL',
    kind: 'stl',
    stl: {
      format: 'stl',
      fileData: hillsStlDataUrl(options),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [silhouette],
    },
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, o.spanX, o.spanY),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: o.plateauZ,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

export interface HillsProjectOptions extends HillsOptions {
  toolDiameter?: number
  stepdown?: number
  /** Adaptive spacing in mm; 0 leaves the automatic stepover x diameter. */
  microStepover?: number
}

function hillsTool(diameter: number): Tool {
  return {
    ...defaultTool('mm', diameter),
    id: 'hills-tool',
    name: `${diameter} mm ball endmill`,
    type: 'ball_endmill',
    diameter,
    defaultStepdown: 0.5,
    defaultStepover: 0.1,
    maxCutDepth: 20,
  }
}

/** The hills model with a waterline finish operation over the whole of it. */
export function hillsWaterlineProject(
  options: HillsProjectOptions = {},
): { project: Project; operation: Operation } {
  const o = resolveHillsOptions(options)
  const project = projectWithFeatures({
    ...newProject('waterline-hills', 'mm'),
    tools: [hillsTool(options.toolDiameter ?? 3)],
  }, [hillsModelFeature(options)])
  const operation: Operation = {
    id: 'hills-waterline',
    name: 'Hills waterline finish',
    kind: 'finish_surface',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['hills-model'] },
    toolRef: 'hills-tool',
    stepdown: options.stepdown ?? 0.5,
    stepover: 0.1,
    feed: 1000,
    plungeFeed: 400,
    rpm: 16000,
    pocketPattern: 'waterline',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'feature_first',
    waterlineAdaptiveRefinement: true,
    waterlineMicroStepover: options.microStepover ?? 0,
    arcFittingEnabled: false,
  }
  project.operations = [operation]
  project.stock = {
    ...project.stock,
    profile: rectProfile(-5, -5, o.spanX + 10, o.spanY + 10),
    thickness: o.plateauZ,
  }
  return { project, operation }
}
