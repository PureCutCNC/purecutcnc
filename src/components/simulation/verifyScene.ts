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
 * The Verify mode's scene pieces (issue #1269): the theme colours of each cell
 * class, the Internal ↔ Exported deviation markers, the highlight around the
 * selected finding, and the bounds that frame it.
 *
 * Finding coordinates are the setup-local grid frame; the heightfield scene
 * draws grid `(x, y, z)` at three's `(x, z, y)`, so everything here does too.
 */

import { useEffect } from 'react'
import * as THREE from 'three'
import { VERIFY_CELL_UNVERIFIED, type VerifyFinding } from '../../app/verify/verifyRun'
import type { CellTintColour } from '../../engine/simulation/cellTint'
import {
  MODEL_DEVIATION_GOUGE,
  MODEL_DEVIATION_INTENDED_LEFTOVER,
  MODEL_DEVIATION_UNINTENDED_LEFTOVER,
} from '../../engine/simulation/modelDeviation'
import type { SimulationGrid } from '../../engine/simulation/types'
import type { ThreeThemePalette } from '../../theme/palette'
import type { VerifyKindColours } from './VerifyPanel'

/** How strongly a class colour covers the stock colour. */
const TINT_ALPHA = 0.85

/** The tint colour of each overlay cell code; `ok` keeps the stock colour. */
export function verifyTintColours(three: ThreeThemePalette): Array<CellTintColour | null> {
  const colours: Array<CellTintColour | null> = []
  colours[MODEL_DEVIATION_GOUGE] = { rgb: three.verifyGouge, alpha: TINT_ALPHA }
  colours[MODEL_DEVIATION_INTENDED_LEFTOVER] = { rgb: three.verifyIntendedLeftover, alpha: TINT_ALPHA }
  colours[MODEL_DEVIATION_UNINTENDED_LEFTOVER] = { rgb: three.verifyUnintendedLeftover, alpha: TINT_ALPHA }
  colours[VERIFY_CELL_UNVERIFIED] = { rgb: three.verifyUnverified, alpha: TINT_ALPHA }
  return Array.from({ length: VERIFY_CELL_UNVERIFIED + 1 }, (_, code) => colours[code] ?? null)
}

function css(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`
}

/** The same colours for the panel's swatches. Markers share one colour. */
export function verifyKindColours(three: ThreeThemePalette): VerifyKindColours {
  return {
    gouge: css(three.verifyGouge),
    intendedLeftover: css(three.verifyIntendedLeftover),
    unintendedLeftover: css(three.verifyUnintendedLeftover),
    unverified: css(three.verifyUnverified),
    missingCut: css(three.verifyMarker),
    extraCut: css(three.verifyMarker),
    feed: css(three.verifyMarker),
  }
}

/** Cells of margin around a framed finding, so a point deviation is not framed to nothing. */
const FRAME_MARGIN_CELLS = 12

/** The box a finding is framed and highlighted with, in three's frame. */
export function verifyFindingBox(finding: VerifyFinding, grid: Pick<SimulationGrid, 'cellSize' | 'stockBottomZ' | 'stockTopZ'>): THREE.Box3 {
  const margin = grid.cellSize * FRAME_MARGIN_CELLS
  const { minX, minY, maxX, maxY } = finding.bounds
  const low = Math.min(grid.stockBottomZ, finding.at.z)
  const high = Math.max(grid.stockTopZ, finding.at.z)
  return new THREE.Box3(
    new THREE.Vector3(minX - margin, low, minY - margin),
    new THREE.Vector3(maxX + margin, high, maxY + margin),
  )
}

function disposeObject(object: THREE.Object3D): void {
  object.removeFromParent()
  object.traverse((entry) => {
    const withGeometry = entry as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }
    withGeometry.geometry?.dispose()
    const material = withGeometry.material
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material?.dispose()
  })
}

/** One fixed-size point per deviation, drawn over the stock. */
export function buildVerifyMarkers(findings: readonly VerifyFinding[], colour: number): THREE.Points | null {
  if (findings.length === 0) return null
  const positions = new Float32Array(findings.length * 3)
  findings.forEach((finding, index) => {
    positions[index * 3] = finding.at.x
    positions[index * 3 + 1] = finding.at.z
    positions[index * 3 + 2] = finding.at.y
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const material = new THREE.PointsMaterial({ color: colour, size: 9, sizeAttenuation: false, depthTest: false })
  const points = new THREE.Points(geometry, material)
  points.name = 'verifyMarkers'
  points.renderOrder = 10
  return points
}

interface VerifySceneArgs {
  sceneRef: React.RefObject<THREE.Scene | null>
  needsRenderRef: React.RefObject<boolean>
  /** Markers to draw, or none. */
  markers: readonly VerifyFinding[] | null
  /** The selected finding's highlight box, or null. */
  highlight: THREE.Box3 | null
  three: ThreeThemePalette
}

/**
 * Mount the markers and the highlight box while the Verify mode shows them,
 * and remove them when it stops.
 */
export function useVerifySceneObjects({ sceneRef, needsRenderRef, markers, highlight, three }: VerifySceneArgs): void {
  const markerColour = three.verifyMarker
  const highlightColour = three.verifyMarker
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !markers) return
    const points = buildVerifyMarkers(markers, markerColour)
    if (!points) return
    scene.add(points)
    needsRenderRef.current = true
    return () => {
      disposeObject(points)
      needsRenderRef.current = true
    }
  }, [markerColour, markers, needsRenderRef, sceneRef])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !highlight) return
    const helper = new THREE.Box3Helper(highlight, new THREE.Color(highlightColour))
    helper.name = 'verifyHighlight'
    const material = helper.material as THREE.LineBasicMaterial
    material.depthTest = false
    helper.renderOrder = 11
    scene.add(helper)
    needsRenderRef.current = true
    return () => {
      disposeObject(helper)
      needsRenderRef.current = true
    }
  }, [highlight, highlightColour, needsRenderRef, sceneRef])
}
