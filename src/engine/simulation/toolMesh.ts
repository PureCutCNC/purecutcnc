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
import type { ToolType } from '../../types/project'

const TOOL_COLOR = 0xd9dde3
const TOOL_EMISSIVE = 0x2a3443
const SHANK_COLOR = 0x7d8591

export interface ToolMeshInfo {
  toolType: ToolType
  toolRadius: number
  vBitAngle: number | null
  /** Length of the flute / cutting portion. Falls back to ~3× diameter when omitted. */
  cutLength?: number
  /** Length of the shank above the flutes. Falls back to ~4× diameter, clamped. */
  shankLength?: number
}

function resolveCutLength(radius: number, explicit: number | undefined): number {
  if (typeof explicit === 'number' && explicit > 0) {
    return explicit
  }
  // Fall back to ~3× diameter when the caller didn't specify. Expressed purely in
  // diameters so the result is unit-agnostic (works for both mm and inch projects).
  return radius * 6
}

function resolveShankLength(diameter: number, explicit: number | undefined): number {
  if (typeof explicit === 'number' && explicit > 0) {
    return explicit
  }
  // A short stub above the flutes — diameter-relative, unit-agnostic.
  return diameter * 2
}

/**
 * Build a simple representation of the cutting tool. The tool is centered at origin with
 * the tip at y=0 and the shank extending upward (+Y). Caller translates it so the tip sits
 * at the current (toolCenterZ) position.
 */
export function buildToolMesh(info: ToolMeshInfo): THREE.Group {
  const radius = Math.max(info.toolRadius, 0.05)
  const diameter = radius * 2
  const cutLength = resolveCutLength(radius, info.cutLength)
  const shankLength = resolveShankLength(diameter, info.shankLength)
  const group = new THREE.Group()
  group.name = 'toolMesh'

  const cutterMaterial = new THREE.MeshStandardMaterial({
    color: TOOL_COLOR,
    emissive: TOOL_EMISSIVE,
    emissiveIntensity: 0.35,
    roughness: 0.3,
    metalness: 0.85,
  })

  const shankMaterial = new THREE.MeshStandardMaterial({
    color: SHANK_COLOR,
    roughness: 0.45,
    metalness: 0.7,
  })

  let cutterMesh: THREE.Mesh
  let cutterTopY = 0

  switch (info.toolType) {
    case 'ball_endmill': {
      const cylinderLength = Math.max(cutLength - radius, 0.5)
      const cylinderGeom = new THREE.CylinderGeometry(radius, radius, cylinderLength, 24, 1, false)
      const cylinder = new THREE.Mesh(cylinderGeom, cutterMaterial)
      cylinder.position.y = radius + cylinderLength / 2
      group.add(cylinder)

      const sphereGeom = new THREE.SphereGeometry(radius, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2)
      const sphereBottom = new THREE.Mesh(sphereGeom, cutterMaterial)
      sphereBottom.rotation.x = Math.PI
      sphereBottom.position.y = radius
      group.add(sphereBottom)

      cutterTopY = radius + cylinderLength
      cutterMesh = cylinder
      break
    }
    case 'v_bit': {
      const angle = Math.max(1, Math.min(179, info.vBitAngle ?? 60))
      const halfAngleRad = (angle * Math.PI) / 360
      const tipLength = Math.max(radius / Math.tan(halfAngleRad), 0.2)
      // ConeGeometry's apex points +Y by default; flip so the sharp tip is at y=0
      // (the cutting point) and the wide base meets the shank above.
      const coneGeom = new THREE.ConeGeometry(radius, tipLength, 24, 1, false)
      const cone = new THREE.Mesh(coneGeom, cutterMaterial)
      cone.rotation.x = Math.PI
      cone.position.y = tipLength / 2
      group.add(cone)

      const shaftLength = Math.max(cutLength - tipLength, 2)
      const shaftGeom = new THREE.CylinderGeometry(radius, radius, shaftLength, 24, 1, false)
      const shaft = new THREE.Mesh(shaftGeom, cutterMaterial)
      shaft.position.y = tipLength + shaftLength / 2
      group.add(shaft)

      cutterTopY = tipLength + shaftLength
      cutterMesh = cone
      break
    }
    case 'drill':
    case 'flat_endmill':
    default: {
      const cylinderGeom = new THREE.CylinderGeometry(radius, radius, cutLength, 24, 1, false)
      const cylinder = new THREE.Mesh(cylinderGeom, cutterMaterial)
      cylinder.position.y = cutLength / 2
      group.add(cylinder)
      cutterTopY = cutLength
      cutterMesh = cylinder
      break
    }
  }
  void cutterMesh

  // Keep the shank visually distinct but thin — just a touch wider than the flute
  // so the silhouette reads right without dwarfing the cutter. Purely
  // diameter-relative, so it stays proportional in both mm and inch projects.
  const shankRadius = radius * 1.05
  const shankGeom = new THREE.CylinderGeometry(shankRadius, shankRadius, shankLength, 24, 1, false)
  const shank = new THREE.Mesh(shankGeom, shankMaterial)
  shank.position.y = cutterTopY + shankLength / 2
  group.add(shank)

  return group
}

export function disposeToolMesh(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose()
      if (Array.isArray(object.material)) {
        object.material.forEach((material) => material.dispose())
      } else {
        object.material.dispose()
      }
    }
  })
}
