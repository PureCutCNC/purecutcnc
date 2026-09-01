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
 * A flat background plane with one square mesa standing on it — the smallest
 * model that carries the plateau top #699 is about.
 *
 * The hills fixture next door mixes four surface characters on purpose, which
 * is what makes it a good coverage benchmark and a poor unit test: nothing in
 * it can be pointed at and called "the plateau". Here the plateau is a square
 * of known size at a known Z, so a test can ask the one question that matters —
 * does the cutter ever travel *inside* it — and answer it in 28 triangles.
 *
 * `topHalf` is the lever the tests pull. A mesa whose top clears `PI * r^2` is
 * reachable and must be machined; one under that bound is the area #682/#685
 * rules out, and must still be left alone. Units are mm.
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

export interface MesaOptions {
  /** Square block side. */
  span?: number
  /** Flat background plane height, and the foot of the mesa. */
  baseZ?: number
  /** Mesa top, and the top of the model. */
  topZ?: number
  /** Half-width of the flat mesa top; its area is `(2 * topHalf)^2`. */
  topHalf?: number
  /** Wall run per unit of rise. 0 is a vertical boss. */
  wallSlope?: number
}

type ResolvedMesaOptions = Required<MesaOptions>

export function resolveMesaOptions(options: MesaOptions = {}): ResolvedMesaOptions {
  return {
    span: options.span ?? 40,
    baseZ: options.baseZ ?? 2,
    topZ: options.topZ ?? 8,
    topHalf: options.topHalf ?? 4,
    wallSlope: options.wallSlope ?? 0.5,
  }
}

/** Centre of the mesa, which is the centre of the block. */
export function mesaCentre(options: MesaOptions = {}): { x: number; y: number } {
  const o = resolveMesaOptions(options)
  return { x: o.span / 2, y: o.span / 2 }
}

/** Half-width of the mesa where it meets the background plane. */
function mesaFootHalf(o: ResolvedMesaOptions): number {
  return o.topHalf + o.wallSlope * (o.topZ - o.baseZ)
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

/** Two triangles over an axis-aligned rectangle at one Z, normal +Z. */
function pushQuadUp(
  lines: string[],
  x0: number, y0: number, x1: number, y1: number, z: number,
): void {
  pushTriangle(lines, [x0, y0, z], [x1, y0, z], [x1, y1, z])
  pushTriangle(lines, [x0, y0, z], [x1, y1, z], [x0, y1, z])
}

/** The four corners of a square, anticlockwise seen from above. */
function squareRing(cx: number, cy: number, half: number, z: number): Vertex[] {
  return [
    [cx - half, cy - half, z],
    [cx + half, cy - half, z],
    [cx + half, cy + half, z],
    [cx - half, cy + half, z],
  ]
}

/** Wall quads between two rings walked in the same direction. */
function pushWall(lines: string[], top: Vertex[], base: Vertex[]): void {
  for (let k = 0; k < top.length; k += 1) {
    const next = (k + 1) % top.length
    pushTriangle(lines, top[k], base[k], base[next])
    pushTriangle(lines, top[k], base[next], top[next])
  }
}

/** ASCII STL of the closed mesa solid, as a data URL. */
export function mesaStlDataUrl(options: MesaOptions = {}): string {
  const o = resolveMesaOptions(options)
  const { x: cx, y: cy } = mesaCentre(options)
  const foot = mesaFootHalf(o)
  const lines = ['solid mesa']

  // The plateau itself.
  pushQuadUp(lines, cx - o.topHalf, cy - o.topHalf, cx + o.topHalf, cy + o.topHalf, o.topZ)
  pushWall(lines, squareRing(cx, cy, o.topHalf, o.topZ), squareRing(cx, cy, foot, o.baseZ))

  // Background plane, as a frame around the mesa foot so the solid stays closed.
  pushQuadUp(lines, 0, 0, o.span, cy - foot, o.baseZ)
  pushQuadUp(lines, 0, cy + foot, o.span, o.span, o.baseZ)
  pushQuadUp(lines, 0, cy - foot, cx - foot, cy + foot, o.baseZ)
  pushQuadUp(lines, cx + foot, cy - foot, o.span, cy + foot, o.baseZ)

  // Skirt down to z = 0 and the flat bottom.
  pushWall(lines, squareRing(o.span / 2, o.span / 2, o.span / 2, o.baseZ), squareRing(o.span / 2, o.span / 2, o.span / 2, 0))
  pushTriangle(lines, [0, 0, 0], [o.span, o.span, 0], [o.span, 0, 0])
  pushTriangle(lines, [0, 0, 0], [0, o.span, 0], [o.span, o.span, 0])

  lines.push('endsolid mesa')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

export function mesaModelFeature(options: MesaOptions = {}): SketchFeature {
  const o = resolveMesaOptions(options)
  const silhouette = [
    { x: 0, y: 0 },
    { x: o.span, y: 0 },
    { x: o.span, y: o.span },
    { x: 0, y: o.span },
  ]
  return {
    id: 'mesa-model',
    name: 'Mesa STL',
    kind: 'stl',
    stl: {
      format: 'stl',
      fileData: mesaStlDataUrl(options),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [silhouette],
    },
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, o.span, o.span),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: o.topZ,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

export interface MesaProjectOptions extends MesaOptions {
  toolDiameter?: number
  stepdown?: number
  /** Adaptive spacing in mm; 0 leaves the automatic stepover x diameter. */
  microStepover?: number
}

function mesaTool(diameter: number): Tool {
  return {
    ...defaultTool('mm', diameter),
    id: 'mesa-tool',
    name: `${diameter} mm ball endmill`,
    type: 'ball_endmill',
    diameter,
    defaultStepdown: 0.5,
    defaultStepover: 0.1,
    maxCutDepth: 20,
  }
}

/** The mesa model with a waterline finish operation over the whole of it. */
export function mesaWaterlineProject(
  options: MesaProjectOptions = {},
): { project: Project; operation: Operation } {
  const o = resolveMesaOptions(options)
  const project = projectWithFeatures({
    ...newProject('waterline-mesa', 'mm'),
    tools: [mesaTool(options.toolDiameter ?? 3)],
  }, [mesaModelFeature(options)])
  const operation: Operation = {
    id: 'mesa-waterline',
    name: 'Mesa waterline finish',
    kind: 'finish_surface',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['mesa-model'] },
    toolRef: 'mesa-tool',
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
    profile: rectProfile(-5, -5, o.span + 10, o.span + 10),
    thickness: o.topZ,
  }
  return { project, operation }
}
