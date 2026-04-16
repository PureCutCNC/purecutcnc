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

import * as THREE from 'three'
import ManifoldModule, { type Manifold as ManifoldSolid, type ManifoldToplevel, type Mesh as ManifoldMesh } from 'manifold-3d'
import { bezierPoint, rectProfile } from '../types/project'
import type { Clamp, DimensionRef, MachineOrigin, Project, SketchFeature, SketchProfile, Segment, Stock, Tab } from '../types/project'
import { expandFeatureGeometry } from '../text'

const ARC_STEP_RADIANS = Math.PI / 18

let manifoldModulePromise: Promise<ManifoldToplevel> | null = null

function resolveDimension(ref: DimensionRef, project: Project): number {
  if (typeof ref === 'number') {
    return ref
  }

  const namedDimension = project.dimensions[ref]
  if (namedDimension) {
    return namedDimension.value
  }

  const parsed = Number.parseFloat(ref)
  return Number.isFinite(parsed) ? parsed : 0
}

async function getManifoldModule(): Promise<ManifoldToplevel> {
  if (!manifoldModulePromise) {
    manifoldModulePromise = ManifoldModule().then((module) => {
      module.setup()
      return module
    }).catch((error) => {
      manifoldModulePromise = null
      throw error
    })
  }

  return manifoldModulePromise
}

// ── Profile → Three.js Shape ─────────────────────────────────────────────────

export function profileToShape(profile: SketchProfile): THREE.Shape {
  const shape = new THREE.Shape()
  shape.moveTo(profile.start.x, profile.start.y)

  for (const seg of profile.segments) {
    if (seg.type === 'line') {
      shape.lineTo(seg.to.x, seg.to.y)
    } else if (seg.type === 'bezier') {
      shape.bezierCurveTo(
        seg.control1.x,
        seg.control1.y,
        seg.control2.x,
        seg.control2.y,
        seg.to.x,
        seg.to.y,
      )
    } else {
      const { type, to, center, clockwise } = seg as Extract<Segment, { type: 'arc' | 'circle' }>
      const startAngle = Math.atan2(
        shape.currentPoint.y - center.y,
        shape.currentPoint.x - center.x
      )
      const endAngle = Math.atan2(to.y - center.y, to.x - center.x)
      const radius = Math.hypot(
        shape.currentPoint.x - center.x,
        shape.currentPoint.y - center.y
      )

      let sweep = endAngle - startAngle
      if (type === 'circle') {
        sweep = clockwise ? -Math.PI * 2 : Math.PI * 2
      } else {
        if (clockwise && sweep > 0) sweep -= Math.PI * 2
        else if (!clockwise && sweep < 0) sweep += Math.PI * 2
      }

      shape.absarc(center.x, center.y, radius, startAngle, startAngle + sweep, clockwise)
    }
  }

  if (profile.closed) {
    shape.closePath()
  }
  return shape
}

function profileToPolygon(profile: SketchProfile): [number, number][] {
  const points: [number, number][] = [[profile.start.x, profile.start.y]]
  let current = profile.start

  for (const seg of profile.segments) {
    if (seg.type === 'line') {
      points.push([seg.to.x, seg.to.y])
      current = seg.to
      continue
    }

    if (seg.type === 'bezier') {
      const segmentCount = 18
      for (let index = 1; index <= segmentCount; index += 1) {
        const point = bezierPoint(current, seg.control1, seg.control2, seg.to, index / segmentCount)
        points.push([point.x, point.y])
      }
      current = seg.to
      continue
    }

    const { type, to, center, clockwise } = seg as Extract<Segment, { type: 'arc' | 'circle' }>
    const startAngle = Math.atan2(current.y - center.y, current.x - center.x)
    const endAngle = Math.atan2(to.y - center.y, to.x - center.x)
    const radius = Math.hypot(current.x - center.x, current.y - center.y)

    let sweep = endAngle - startAngle
    if (type === 'circle') {
      sweep = clockwise ? -Math.PI * 2 : Math.PI * 2
    } else {
      if (clockwise && sweep > 0) sweep -= Math.PI * 2
      else if (!clockwise && sweep < 0) sweep += Math.PI * 2
    }

    const segmentCount = Math.max(8, Math.ceil(Math.abs(sweep) / ARC_STEP_RADIANS))
    for (let index = 1; index <= segmentCount; index += 1) {
      const angle = startAngle + (sweep * index) / segmentCount
      points.push([
        center.x + Math.cos(angle) * radius,
        center.y + Math.sin(angle) * radius,
      ])
    }
    current = to
  }

  const first = points[0]
  const last = points.at(-1)
  if (last && Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-6) {
    points.pop()
  }

  return points
}


// ── Stock mesh ───────────────────────────────────────────────────────────────

export function buildStockMesh(stock: Stock): THREE.Mesh {
  const shape = profileToShape(stock.profile)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: stock.thickness,
    bevelEnabled: false,
  })
  // Rotate so Z is up (Three.js extrudes along Z by default, we want Y-up world)
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(stock.color ?? '#8899aa'),
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.scale.z = -1
  return mesh
}

// ── Feature mesh ─────────────────────────────────────────────────────────────

export function buildFeatureMesh(
  feature: SketchFeature,
  selected = false,
  hovered = false
): THREE.Mesh {
  const shape = profileToShape(feature.sketch.profile)
  const zTop = typeof feature.z_top === 'number' ? feature.z_top : 0
  const zBottom = typeof feature.z_bottom === 'number' ? feature.z_bottom : 5
  const yStart = Math.min(zTop, zBottom)
  const depth = Math.abs(zBottom - zTop)

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(depth, 0.1),
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, yStart, 0)

  const color =
    selected ? 0xffaa00
    : hovered ? 0x44aaff
    : feature.operation === 'subtract' ? 0x3366cc
    : 0x33aa66

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.78,
    metalness: 0.08,
    side: THREE.FrontSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.scale.z = -1
  return mesh
}

export function buildClampMesh(clamp: Clamp, selected = false, colliding = false): THREE.Mesh {
  const shape = profileToShape(rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(clamp.height, 0.1),
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.MeshStandardMaterial({
    color:
      colliding
        ? (selected ? new THREE.Color('#ff9c9c') : new THREE.Color('#d46b6b'))
        : (selected ? new THREE.Color('#9db9ff') : new THREE.Color('#6c89d1')),
    transparent: true,
    opacity: colliding ? (selected ? 0.8 : 0.68) : (selected ? 0.72 : 0.58),
    roughness: 0.72,
    metalness: 0.08,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.scale.z = -1
  return mesh
}

export function buildTabMesh(tab: Tab, selected = false): THREE.Mesh {
  const shape = profileToShape(rectProfile(tab.x, tab.y, tab.w, tab.h))
  const zStart = Math.min(tab.z_top, tab.z_bottom)
  const depth = Math.max(Math.abs(tab.z_top - tab.z_bottom), 0.1)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, zStart, 0)

  const material = new THREE.MeshStandardMaterial({
    color: selected ? new THREE.Color('#c7ef94') : new THREE.Color('#9ccd67'),
    transparent: true,
    opacity: selected ? 0.72 : 0.56,
    roughness: 0.74,
    metalness: 0.06,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.scale.z = -1
  return mesh
}

export function buildOriginTriad(origin: MachineOrigin, size: number): THREE.Group {
  const group = new THREE.Group()
  group.position.set(origin.x, origin.z, origin.y)

  const axisData = [
    { direction: new THREE.Vector3(1, 0, 0), color: 0xe35b5b },
    { direction: new THREE.Vector3(0, 0, -1), color: 0x63c07a },
    { direction: new THREE.Vector3(0, 1, 0), color: 0x5b90e3 },
  ]
  const shaftRadius = Math.max(size * 0.025, 0.005)
  const tipRadius = Math.max(size * 0.055, shaftRadius * 1.5)
  const tipLength = Math.max(size * 0.18, shaftRadius * 4)
  const shaftLength = Math.max(size - tipLength, size * 0.55)

  for (const axis of axisData) {
    const material = new THREE.MeshStandardMaterial({
      color: axis.color,
      roughness: 0.38,
      metalness: 0.08,
      transparent: true,
      opacity: 0.98,
    })

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 12),
      material.clone(),
    )
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(tipRadius, tipLength, 12),
      material.clone(),
    )

    // The cylinder and cone are Y-aligned by default.
    // We rotate them to align with the axis direction.
    const direction = axis.direction.clone().normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction)

    shaft.quaternion.copy(quaternion)
    tip.quaternion.copy(quaternion)

    shaft.position.copy(direction).multiplyScalar(shaftLength / 2)
    tip.position.copy(direction).multiplyScalar(shaftLength + tipLength / 2)

    group.add(shaft)
    group.add(tip)
  }

  const centerGeometry = new THREE.SphereGeometry(Math.max(size * 0.1, shaftRadius * 1.2), 14, 14)
  const centerMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6edf5,
    roughness: 0.4,
    metalness: 0.1,
  })
  group.add(new THREE.Mesh(centerGeometry, centerMaterial))

  return group
}

function manifoldMeshToGeometry(mesh: ManifoldMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(mesh.numVert * 3)

  for (let index = 0; index < mesh.numVert; index += 1) {
    const sourceOffset = index * mesh.numProp
    const targetOffset = index * 3
    positions[targetOffset] = mesh.vertProperties[sourceOffset]
    positions[targetOffset + 1] = mesh.vertProperties[sourceOffset + 1]
    positions[targetOffset + 2] = mesh.vertProperties[sourceOffset + 2]
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(Array.from(mesh.triVerts))

  const nonIndexed = geometry.toNonIndexed()
  geometry.dispose()
  nonIndexed.computeVertexNormals()
  nonIndexed.rotateX(-Math.PI / 2)
  nonIndexed.computeBoundingSphere()

  return nonIndexed
}

function buildFeatureSolid(
  module: ManifoldToplevel,
  project: Project,
  feature: SketchFeature
): ManifoldSolid | null {
  if (!feature.sketch.profile.closed) {
    return null
  }

  const contour = profileToPolygon(feature.sketch.profile)
  if (contour.length < 3) {
    return null
  }

  const zTop = resolveDimension(feature.z_top, project)
  const zBottom = resolveDimension(feature.z_bottom, project)
  const yStart = Math.min(zTop, zBottom)
  const depth = Math.max(Math.abs(zBottom - zTop), 0.1)

  const crossSection = module.CrossSection.ofPolygons([contour], 'EvenOdd')
  try {
    return crossSection.extrude(depth).translate(0, 0, yStart)
  } finally {
    crossSection.delete()
  }
}

async function buildBooleanModel(
  project: Project,
  visibleFeatures: SketchFeature[]
): Promise<THREE.Mesh | null> {
  const module = await getManifoldModule()
  let current: ManifoldSolid | null = null
  const expandedFeatures = visibleFeatures.flatMap((feature) => expandFeatureGeometry(feature))

  try {
    for (const feature of expandedFeatures) {
      let solid: ManifoldSolid | null = null

      try {
        solid = buildFeatureSolid(module, project, feature)
        if (!solid) {
          continue
        }

        if (!current) {
          if (feature.operation === 'add') {
            current = solid
            solid = null
          }
          continue
        }

        const next = feature.operation === 'subtract'
          ? module.Manifold.difference(current, solid)
          : module.Manifold.union(current, solid)

        current.delete()
        current = next
      } finally {
        solid?.delete()
      }
    }

    if (!current) {
      return null
    }

    const manifoldMesh = current.getMesh()
    const geometry = manifoldMeshToGeometry(manifoldMesh)
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#b7c2cf'),
      roughness: 0.82,
      metalness: 0.05,
      flatShading: true,
      side: THREE.FrontSide,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.scale.z = -1
    return mesh
  } finally {
    current?.delete()
  }
}

// ── Wireframe outline for stock ──────────────────────────────────────────────

export function buildStockWireframe(stock: Stock): THREE.LineSegments {
  const shape = profileToShape(stock.profile)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: stock.thickness,
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)
  const edges = new THREE.EdgesGeometry(geometry)
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(stock.color ?? '#aabbcc'),
    linewidth: 1,
  })
  const lines = new THREE.LineSegments(edges, material)
  lines.scale.z = -1
  return lines
}

// ── Full scene builder ───────────────────────────────────────────────────────

export interface SceneObjects {
  stockMesh: THREE.Mesh
  stockWireframe: THREE.LineSegments
  modelMesh: THREE.Mesh | null
  featureMeshes: Map<string, THREE.Mesh>
  tabMeshes: Map<string, THREE.Mesh>
  clampMeshes: Map<string, THREE.Mesh>
}

export async function buildScene(
  project: Project,
  selectedClampId: string | null = null,
  selectedTabId: string | null = null,
  collidingClampIds: string[] = [],
): Promise<SceneObjects> {
  const visibleFeatures = project.features.filter((feature) => feature.visible)
  const visibleTabs = project.tabs.filter((tab) => tab.visible)
  const visibleClamps = project.clamps.filter((clamp) => clamp.visible)
  const collidingClampIdSet = new Set(collidingClampIds)
  const stockMesh = buildStockMesh(project.stock)
  const stockWireframe = buildStockWireframe(project.stock)
  const featureMeshes = new Map<string, THREE.Mesh>()
  const tabMeshes = new Map<string, THREE.Mesh>()
  const clampMeshes = new Map<string, THREE.Mesh>()
  let modelMesh: THREE.Mesh | null = null

  if (visibleFeatures.length > 0) {
    try {
      modelMesh = await buildBooleanModel(project, visibleFeatures)
    } catch (error) {
      console.error('Failed to build boolean 3D preview, falling back to feature meshes.', error)
      for (const feature of visibleFeatures.flatMap((entry) => expandFeatureGeometry(entry))) {
        featureMeshes.set(feature.id, buildFeatureMesh(feature))
      }
    }
  }

  const showStockReference = project.stock.visible ?? true

  stockMesh.visible = showStockReference
  stockWireframe.visible = showStockReference

  for (const tab of visibleTabs) {
    tabMeshes.set(tab.id, buildTabMesh(tab, tab.id === selectedTabId))
  }

  for (const clamp of visibleClamps) {
    clampMeshes.set(
      clamp.id,
      buildClampMesh(clamp, clamp.id === selectedClampId, collidingClampIdSet.has(clamp.id)),
    )
  }

  return { stockMesh, stockWireframe, modelMesh, featureMeshes, tabMeshes, clampMeshes }
}
