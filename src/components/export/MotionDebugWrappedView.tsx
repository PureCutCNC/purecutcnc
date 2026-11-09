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
 * The 3D wrapped view inside the Exported Motion debug dialog (issue #1179).
 *
 * A small three.js canvas that draws the wrapped path on the bar, so a rotary
 * program whose turns are wrong is seen rather than read. The geometry comes
 * from `motionDebugWrapped.ts` — already in stock space, through the viewport's
 * own wrap path — so this file only owns the scene: the faint bar outline, one
 * line object per debug layer, orbit controls, and the angle readout.
 *
 * It is a debug aid, so the scene is built once per model and redrawn on demand
 * (orbit, resize) rather than on a frame loop; everything it creates is
 * disposed when the dialog closes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useI18n } from '../../i18n/i18nContext'
import { useTheme } from '../../theme/themeContext'
import type { BarStock } from '../../types/project'
import type { MotionDebugLayerId } from '../../engine/gcode/motionDebug'
import type { WrappedPiece } from './motionDebugWrapped'
import { barOutline, filterWrappedPieces } from './motionDebugWrapped'
import { toolpathPointToWorldTuple } from '../viewport3d/toolpathOverlay'
import { createOrbitControls } from '../viewport3d/orbitControls'
import { createViewportRenderer } from '../viewport3d/webglRenderer'

/** One debug layer as the 3D view draws it. */
export interface WrappedViewLayer {
  id: MotionDebugLayerId
  /** Layer colour, the same swatch the sidebar shows. */
  color: string
  /** Layer opacity, the same value the 2D path uses. */
  opacity: number
  pieces: readonly WrappedPiece[]
}

interface MotionDebugWrappedViewProps {
  stock: BarStock
  layers: readonly WrappedViewLayer[]
  visibleLayers: Record<MotionDebugLayerId, boolean>
  /** The sidebar's cutting-level selection: `'all'` or one cutting level. */
  selectedZ: number | 'all'
  /** The sidebar's "non-cutting moves" checkbox. */
  showNonCutting: boolean
  /** The exported program's A span, in degrees. */
  aRange: { min: number; max: number } | null
  /**
   * Whether the dialog has a 2D plan to fall back to. A variable-Z rotary
   * program has no plan view at all, so the WebGL-unavailable message must not
   * promise one (review of #1179, correction round 4).
   */
  fallbackPlan: boolean
  /**
   * Renderer factory, injectable so a test can watch the draw calls: the unit
   * suite has no WebGL2 context, but the redraw-on-toggle behaviour is exactly
   * what must not regress (review of #1179).
   */
  rendererFactory?: (viewName: string) => THREE.WebGLRenderer | null
}

/** A drawn point the pointer can be measured against, with its commanded angle. */
interface AngleSample {
  x: number
  y: number
  z: number
  a: number
}

/** Most samples the hover search projects; the nearest of these still reads right. */
const MAX_HOVER_SAMPLES = 2000
/** How close (CSS pixels) the pointer must come to a drawn point to report its angle. */
const HOVER_RADIUS_PIXELS = 26
/** Hover work is coalesced to about one update per this many milliseconds. */
const HOVER_INTERVAL_MS = 80

/** A readout angle: one decimal, with no trailing `.0`. */
function formatAngle(degrees: number): string {
  return String(Math.round(degrees * 10) / 10)
}

/**
 * Which point of the quiet bar a wrapped piece's end lands on, as a world
 * position for three.js: (project x, project z, project y), the same axis swap
 * the toolpath overlay uses.
 */
function worldPosition(point: { x: number; y: number; z: number }): THREE.Vector3 {
  const [x, y, z] = toolpathPointToWorldTuple(point)
  return new THREE.Vector3(x, y, z)
}

export function MotionDebugWrappedView({
  stock,
  layers,
  visibleLayers,
  selectedZ,
  showNonCutting,
  aRange,
  fallbackPlan,
  rendererFactory,
}: MotionDebugWrappedViewProps) {
  const { t } = useI18n()
  const { palette } = useTheme()
  const background = palette.three.background
  const barColor = palette.three.stockDefault

  const hostRef = useRef<HTMLDivElement | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const objectsRef = useRef<Map<MotionDebugLayerId, THREE.Object3D>>(new Map())
  const samplesRef = useRef<AngleSample[]>([])
  const allSamplesRef = useRef<AngleSample[]>([])
  /** Draws the current scene; the layer toggles call it to repaint in place. */
  const renderRef = useRef<(() => void) | null>(null)
  const lastHoverRef = useRef(0)
  const projectedRef = useRef(new THREE.Vector3())
  const [webglStatus, setWebglStatus] = useState<'ok' | 'unavailable'>('ok')
  const [pointerAngle, setPointerAngle] = useState<number | null>(null)

  // What the sidebar leaves visible, in the exported layer. The scene builds the
  // same filtered pieces; this copy is what the canvas reports, so a test can
  // tell a filtered scene from an unfiltered one.
  const exportedPieces = useMemo(
    () => layers.find((layer) => layer.id === 'exported')?.pieces ?? [],
    [layers],
  )
  const drawnExportedPieces = useMemo(
    () => filterWrappedPieces(exportedPieces, selectedZ, showNonCutting),
    [exportedPieces, selectedZ, showNonCutting],
  )
  const drawnExportedCount = visibleLayers.exported ? drawnExportedPieces.length : 0

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const createRenderer = rendererFactory ?? createViewportRenderer
    const renderer = createRenderer('MotionDebugWrappedView')
    if (!renderer) {
      // No WebGL2 context: the dialog reports this instead of failing the open
      // (#786). Whether a 2D plan stands in is the dialog's answer, not this
      // view's — a wrapped-only rotary program has none.
      setWebglStatus('unavailable')
      return () => setWebglStatus('ok')
    }

    // The aspect must be right *before* the fit: framing with a square aspect
    // pushes the camera back for a wide bar and never recovers.
    const width = Math.max(host.clientWidth, 1)
    const height = Math.max(host.clientHeight, 1)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    renderer.setClearColor(background, 1)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.touchAction = 'none'
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 20000)
    cameraRef.current = camera

    // Every draw goes through here, so a layer toggle can redraw without a new
    // frame loop (review of #1179: visibility used to change with no draw).
    const renderScene = () => {
      renderer.render(scene, camera)
    }
    renderRef.current = renderScene

    const layerObjects = objectsRef.current
    const controls = createOrbitControls(camera, renderer.domElement, {
      onChange: renderScene,
      onPresetChange: () => {},
      isInteractionBlocked: () => false,
    })

    const disposables: Array<{ dispose: () => void }> = []
    const outline = barOutline(stock)
    const length = Math.max(outline.alongMax - outline.alongMin, 1e-6)
    const alongCentre = (outline.alongMin + outline.alongMax) / 2

    // The bar, faint: a translucent body plus its outline. A round bar draws
    // its two end circles; a square blank draws its box edges. Nothing here is
    // material the program cut — it is the blank the program was written for.
    if (outline.shape === 'round') {
      const body = new THREE.CylinderGeometry(outline.radius, outline.radius, length, 48, 1, true)
      if (outline.axis === 'x') body.rotateZ(Math.PI / 2)
      else body.rotateX(Math.PI / 2)
      const bodyMaterial = new THREE.MeshBasicMaterial({
        color: barColor,
        transparent: true,
        opacity: 0.08, // theme-exempt: developer-only motion-debug overlay
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      const bodyMesh = new THREE.Mesh(body, bodyMaterial)
      bodyMesh.position.set(
        outline.axis === 'x' ? alongCentre : outline.centre,
        outline.pivotZ,
        outline.axis === 'x' ? outline.centre : alongCentre,
      )
      scene.add(bodyMesh)
      disposables.push(body, bodyMaterial)

      const ringMaterial = new THREE.LineBasicMaterial({
        color: barColor,
        transparent: true,
        opacity: 0.45, // theme-exempt: developer-only motion-debug overlay
      })
      disposables.push(ringMaterial)
      for (const along of [outline.alongMin, outline.alongMax]) {
        const ring = new THREE.BufferGeometry().setFromPoints(
          Array.from({ length: 49 }, (_, index) => {
            const angle = (index / 48) * Math.PI * 2
            const across = outline.centre + outline.radius * Math.cos(angle)
            const up = outline.pivotZ + outline.radius * Math.sin(angle)
            return outline.axis === 'x'
              ? new THREE.Vector3(along, up, across)
              : new THREE.Vector3(across, up, along)
          }),
        )
        disposables.push(ring)
        scene.add(new THREE.Line(ring, ringMaterial))
      }
    } else {
      const box = outline.axis === 'x'
        ? new THREE.BoxGeometry(length, outline.thickness, outline.thickness)
        : new THREE.BoxGeometry(outline.thickness, outline.thickness, length)
      const boxMaterial = new THREE.MeshBasicMaterial({
        color: barColor,
        transparent: true,
        opacity: 0.08, // theme-exempt: developer-only motion-debug overlay
        depthWrite: false,
      })
      const boxMesh = new THREE.Mesh(box, boxMaterial)
      boxMesh.position.set(
        outline.axis === 'x' ? alongCentre : outline.centre,
        outline.pivotZ,
        outline.axis === 'x' ? outline.centre : alongCentre,
      )
      scene.add(boxMesh)
      disposables.push(box, boxMaterial)

      const edgesGeometry = new THREE.EdgesGeometry(box)
      const edgesMaterial = new THREE.LineBasicMaterial({
        color: barColor,
        transparent: true,
        opacity: 0.45, // theme-exempt: developer-only motion-debug overlay
      })
      const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial)
      edges.position.copy(boxMesh.position)
      scene.add(edges)
      disposables.push(edgesGeometry, edgesMaterial)
    }

    // One line object per layer: feeds in the layer's own colour, rapids in the
    // dim non-cutting grey the 2D view uses, so a rapid can never be mistaken
    // for a cut while the whole program stays visible.
    const rapidMaterial = new THREE.LineBasicMaterial({
      color: 0x8a8a8a, // theme-exempt: developer-only motion-debug overlay
      transparent: true,
      opacity: 0.35, // theme-exempt: developer-only motion-debug overlay
    })
    disposables.push(rapidMaterial)
    const sceneBox = new THREE.Box3()
    const exportedSamples: AngleSample[] = []

    for (const layer of layers) {
      // The same sidebar filters the 2D plan applies: one cutting level (or
      // all), and rapids only with "non-cutting moves" on (review of #1179).
      const pieces = filterWrappedPieces(layer.pieces, selectedZ, showNonCutting)
      const feedPositions: number[] = []
      const rapidPositions: number[] = []
      const vertexCount = pieces.length * 2
      const stride = Math.max(1, Math.ceil(vertexCount / MAX_HOVER_SAMPLES))
      let vertexIndex = 0
      for (const piece of pieces) {
        const positions = piece.rapid ? rapidPositions : feedPositions
        const from = worldPosition(piece.from)
        const to = worldPosition(piece.to)
        positions.push(from.x, from.y, from.z, to.x, to.y, to.z)
        sceneBox.expandByPoint(from)
        sceneBox.expandByPoint(to)
        if (layer.id === 'exported' && piece.aFrom !== undefined && vertexIndex % stride === 0) {
          exportedSamples.push({ x: from.x, y: from.y, z: from.z, a: piece.aFrom })
          if (piece.aTo !== undefined) {
            exportedSamples.push({ x: to.x, y: to.y, z: to.z, a: piece.aTo })
          }
        }
        vertexIndex += 2
      }

      const material = new THREE.LineBasicMaterial({
        color: layer.color,
        transparent: true,
        opacity: layer.opacity,
      })
      disposables.push(material)

      const group = new THREE.Group()
      for (const positions of [feedPositions, rapidPositions]) {
        if (positions.length === 0) continue
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        disposables.push(geometry)
        group.add(new THREE.LineSegments(
          geometry,
          positions === feedPositions ? material : rapidMaterial,
        ))
      }
      group.visible = visibleLayers[layer.id]
      layerObjects.set(layer.id, group)
      scene.add(group)
    }

    allSamplesRef.current = exportedSamples
    samplesRef.current = visibleLayers.exported ? exportedSamples : []

    // Frame the blank and the path together: the bar's whole box, not just the
    // points the program happens to touch, so the reference outline is never
    // cropped by a short cut.
    const acrossHalf = outline.maxRadius
    const halfHeight = outline.thickness / 2
    sceneBox.union(new THREE.Box3(
      new THREE.Vector3(
        outline.axis === 'x' ? outline.alongMin : outline.centre - acrossHalf,
        outline.pivotZ - halfHeight,
        outline.axis === 'x' ? outline.centre - acrossHalf : outline.alongMin,
      ),
      new THREE.Vector3(
        outline.axis === 'x' ? outline.alongMax : outline.centre + acrossHalf,
        outline.pivotZ + halfHeight,
        outline.axis === 'x' ? outline.centre + acrossHalf : outline.alongMax,
      ),
    ))
    controls.setSceneBounds(sceneBox)
    controls.fitToBounds(sceneBox)

    const resize = () => {
      const width = Math.max(host.clientWidth, 1)
      const height = Math.max(host.clientHeight, 1)
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderScene()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    return () => {
      observer.disconnect()
      controls.dispose()
      scene.clear()
      for (const disposable of disposables) disposable.dispose()
      layerObjects.clear()
      samplesRef.current = []
      allSamplesRef.current = []
      cameraRef.current = null
      renderRef.current = null
      renderer.dispose()
      renderer.domElement.remove()
      setWebglStatus('ok')
      setPointerAngle(null)
    }
    // `layers` is rebuilt only with the model (memoized by the dialog), and the
    // two palette colours are read once per scene build. A filter change rebuilds
    // the scene (the drawn pieces differ), which also refits the camera; the
    // framing is dominated by the bar outline, so the view does not drift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock, layers, background, barColor, selectedZ, showNonCutting, rendererFactory])

  // Layer toggles only hide the built objects; the scene is not rebuilt, but it
  // must be redrawn — `visible` alone changes nothing on screen until the next
  // orbit or resize (review of #1179: stale pixels).
  const visibleKey = `${visibleLayers.generated ? 1 : 0}${visibleLayers.optimized ? 1 : 0}${visibleLayers.exported ? 1 : 0}`
  useEffect(() => {
    for (const [id, object] of objectsRef.current) {
      object.visible = visibleLayers[id]
    }
    // The readout describes the exported program's angles, so hiding that layer
    // takes the hover angle with it.
    samplesRef.current = visibleLayers.exported ? allSamplesRef.current : []
    if (!visibleLayers.exported) setPointerAngle(null)
    renderRef.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey])

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const samples = samplesRef.current
    const camera = cameraRef.current
    const host = hostRef.current
    if (samples.length === 0 || !camera || !host) return
    const now = performance.now()
    if (now - lastHoverRef.current < HOVER_INTERVAL_MS) return
    lastHoverRef.current = now
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const projected = projectedRef.current
    let bestAngle: number | null = null
    let bestDistance = HOVER_RADIUS_PIXELS
    for (const sample of samples) {
      projected.set(sample.x, sample.y, sample.z).project(camera)
      if (projected.z > 1) continue
      const screenX = (projected.x * 0.5 + 0.5) * rect.width
      const screenY = (-projected.y * 0.5 + 0.5) * rect.height
      const distance = Math.hypot(screenX - pointerX, screenY - pointerY)
      if (distance < bestDistance) {
        bestDistance = distance
        bestAngle = sample.a
      }
    }
    setPointerAngle(bestAngle)
  }

  const rangeText = aRange === null
    ? t('dialogs.motionDebug.angleNoTurn')
    : t('dialogs.motionDebug.angleRange', {
        min: formatAngle(aRange.min),
        max: formatAngle(aRange.max),
      })

  // `data-motion-pieces` reports what was actually drawn under the current
  // filters, so a test can tell a built scene from an empty canvas and a
  // filtered scene from an unfiltered one (the same idea as the viewport's
  // data-toolpath-* counts).
  return (
    <div
      ref={hostRef}
      className="motion-debug__canvas-wrap"
      data-testid="motion-debug-3d"
      data-motion-pieces={drawnExportedCount}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setPointerAngle(null)}
    >
      {webglStatus === 'unavailable' && (
        <div className="motion-debug__empty" data-testid="motion-debug-webgl-unavailable">
          {t(fallbackPlan
            ? 'dialogs.motionDebug.webglUnavailable'
            : 'dialogs.motionDebug.webglUnavailableNoPlan')}
        </div>
      )}
      <div className="motion-debug__angle-readout">
        <span className="motion-debug__angle-range">{rangeText}</span>
        {pointerAngle !== null && (
          <span className="motion-debug__angle-pointer">
            {t('dialogs.motionDebug.angleAtPointer', { angle: formatAngle(pointerAngle) })}
          </span>
        )}
      </div>
    </div>
  )
}
