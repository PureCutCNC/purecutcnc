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

import {
  BufferAttribute, Camera, Color, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, NoBlending, NoColorSpace, PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector3,
  WebGLRenderer, WebGLRenderTarget,
} from 'three'
import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import { parseColor } from '../../theme/color'
import { canvasFeedColour, feedColourStep, type CanvasThemePalette } from '../../theme/palette'
import { toolpathHasEngagementTelemetry, type ToolpathVisibility } from '../toolpathVisibility'
import { buildToolpathOverlayLayers, toolpathLayerBuckets, type ToolpathOverlayLayerKey } from '../viewport3d/toolpathOverlay'
import { toolpathLayerStyles, toolpathStrokeWidth } from './toolpathStyles'
import type { ViewTransform } from './viewTransform'
import { maskVertexShader, maskFragmentShader, compositeVertexShader, compositeFragmentShader } from './gpuToolpathShaders'

interface LayerBatch { scene: Scene; geometries: InstancedBufferGeometry[] }
interface PreparedToolpath {
  slotScale: number
  layers: Record<ToolpathOverlayLayerKey, LayerBatch>
  feeds: Map<number, LayerBatch>
  collisions: LayerBatch
}
export interface GpuToolpathEntry { toolpath: ToolpathResult; emphasized: boolean; slotScale: number }

/** Retained, full-resolution XY buffers. Pan/zoom only change uniforms.
 * Opaque MSAA coverage is resolved before applying layer alpha exactly once.
 * Independent operations/feed buckets still composite in source order.
 */
export class GpuToolpathPoc {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: WebGLRenderer
  private readonly camera = new Camera()
  private readonly mask = new WebGLRenderTarget(1, 1, { samples: 4, depthBuffer: false })
  private readonly view = new Vector3()
  private readonly viewport = new Vector2()
  private readonly maskMaterial = new ShaderMaterial({
    uniforms: { view: { value: this.view }, viewport: { value: this.viewport },
      lineWidth: { value: 1 }, dashed: { value: 0 } },
    vertexShader: maskVertexShader, fragmentShader: maskFragmentShader,
    blending: NoBlending, depthTest: false, depthWrite: false, side: DoubleSide,
  })
  private readonly compositeMaterial = new ShaderMaterial({
    uniforms: { coverage: { value: this.mask.texture }, stroke: { value: new Color() }, alpha: { value: 1 } },
    vertexShader: compositeVertexShader, fragmentShader: compositeFragmentShader,
    transparent: true, depthTest: false, depthWrite: false,
  })
  private readonly quadGeometry = new PlaneGeometry(2, 2)
  private readonly compositeScene = new Scene()
  private readonly cache = new Map<ToolpathResult, PreparedToolpath>()
  private lost = false
  private disposed = false
  private readonly onLoss: (event: Event) => void
  private readonly onRestore: () => void
  readonly stats = { preparations: 0, preparationMs: 0, submissions: 0, firstToolpathSubmissionMs: 0 }

  constructor(canvas: HTMLCanvasElement, invalidate: () => void) {
    this.canvas = canvas
    const context = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true })
    if (!context) throw new Error('WebGL2 is unavailable; retaining Canvas toolpaths')
    this.renderer = new WebGLRenderer({ canvas, context })
    this.renderer.autoClear = false
    this.renderer.setClearColor(0, 0)
    this.mask.texture.colorSpace = NoColorSpace
    this.compositeScene.add(new Mesh(this.quadGeometry, this.compositeMaterial))
    this.renderer.debug.onShaderError = () => { throw new Error('GPU POC shader compilation failed') }
    this.onLoss = (event) => { event.preventDefault(); this.lost = true; canvas.hidden = true; invalidate() }
    this.onRestore = () => { this.lost = false; invalidate() }
    canvas.addEventListener('webglcontextlost', this.onLoss)
    canvas.addEventListener('webglcontextrestored', this.onRestore)
  }

  private batch(moves: readonly ToolpathMove[]): LayerBatch {
    const result: LayerBatch = { scene: new Scene(), geometries: [] }
    for (let start = 0; start < moves.length; start += 65536) {
      const count = Math.min(65536, moves.length - start)
      const packed = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        const move = moves[start + i]
        packed.set([move.from.x, move.from.y, move.to.x, move.to.y], i * 4)
      }
      const geometry = new InstancedBufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array([
        0, -.5, 0, 1, -.5, 0, 1, .5, 0, 0, .5, 0,
      ]), 3))
      geometry.setIndex([0, 1, 2, 0, 2, 3])
      geometry.setAttribute('endpoints', new InstancedBufferAttribute(packed, 4))
      geometry.instanceCount = count
      const mesh = new Mesh(geometry, this.maskMaterial)
      mesh.frustumCulled = false
      result.scene.add(mesh)
      result.geometries.push(geometry)
    }
    return result
  }

  private prepare(toolpath: ToolpathResult, slotScale: number): PreparedToolpath {
    const previous = this.cache.get(toolpath)
    if (previous?.slotScale === slotScale) return previous
    if (previous) this.release(previous)
    const start = performance.now()
    const buckets = toolpathLayerBuckets(toolpath)
    const feeds = new Map<number, ToolpathMove[]>()
    for (const move of buckets.cuts) {
      const step = feedColourStep(move.feedScale, slotScale)
      const group = feeds.get(step)
      if (group) group.push(move)
      else feeds.set(step, [move])
    }
    const prepared: PreparedToolpath = {
      slotScale,
      layers: {
        cuts: this.batch(buckets.cuts), leadIns: this.batch(buckets.leadIns),
        rapids: this.batch(buckets.rapids), plunges: this.batch(buckets.plunges),
        retractions: this.batch(buckets.retractions),
      },
      feeds: new Map([...feeds].map(([step, moves]) => [step, this.batch(moves)])),
      collisions: this.batch((toolpath.collidingMoveIndices ?? []).map(i => toolpath.moves[i]).filter(Boolean)),
    }
    this.cache.set(toolpath, prepared)
    this.stats.preparations++
    this.stats.preparationMs += performance.now() - start
    return prepared
  }

  private paint(batch: LayerBatch, stroke: string, width: number, alpha: number, dashed = false): void {
    if (batch.geometries.length === 0) return
    this.maskMaterial.uniforms.lineWidth.value = width
    this.maskMaterial.uniforms.dashed.value = dashed ? 1 : 0
    this.renderer.setRenderTarget(this.mask)
    this.renderer.clear()
    this.renderer.render(batch.scene, this.camera)
    this.renderer.setRenderTarget(null)
    // Do not apply Three's linear-light conversion: Canvas blends CSS sRGB.
    const color = parseColor(stroke)
    if (!color) throw new Error('Unsupported GPU POC theme colour: ' + stroke)
    ;(this.compositeMaterial.uniforms.stroke.value as Color).setRGB(color.r / 255, color.g / 255, color.b / 255)
    this.compositeMaterial.uniforms.alpha.value = alpha * color.a
    this.renderer.render(this.compositeScene, this.camera)
  }

  render(entries: readonly GpuToolpathEntry[], vt: ViewTransform, width: number, height: number,
    visibility: ToolpathVisibility, palette: CanvasThemePalette): boolean {
    if (this.disposed || this.lost || this.renderer.getContext().isContextLost()) return false
    const started = performance.now()
    const active = new Set(entries.map(entry => entry.toolpath))
    for (const [toolpath, prepared] of this.cache) {
      if (!active.has(toolpath)) { this.release(prepared); this.cache.delete(toolpath) }
    }
    if (this.viewport.x !== width || this.viewport.y !== height) {
      this.renderer.setSize(width, height, false)
      this.mask.setSize(width, height)
    }
    this.view.set(vt.scale, vt.offsetX, vt.offsetY)
    this.viewport.set(width, height)
    this.renderer.setRenderTarget(null)
    this.renderer.clear()
    const styles = toolpathLayerStyles(palette)
    for (const { toolpath, emphasized, slotScale } of entries) {
      const prepared = this.prepare(toolpath, slotScale)
      const feedOn = visibility.feedColours ?? (emphasized && toolpathHasEngagementTelemetry(toolpath))
      for (const layer of buildToolpathOverlayLayers(visibility)) {
        if (!layer.visible) continue
        const style = styles[layer.key]
        const width = toolpathStrokeWidth(style.lineWidth, emphasized)
        const alpha = emphasized ? 1 : .34
        if (layer.key === 'cuts' && feedOn) {
          for (const [step, batch] of prepared.feeds) this.paint(batch, canvasFeedColour(step, palette), width, alpha)
        } else {
          this.paint(prepared.layers[layer.key], style.stroke, width, alpha, style.dash.length > 0)
        }
      }
      this.paint(prepared.collisions, palette.toolpathCollision, emphasized ? 3 : 2.2, emphasized ? 1 : .55)
    }
    this.stats.submissions++
    if (entries.length > 0 && this.stats.firstToolpathSubmissionMs === 0) this.stats.firstToolpathSubmissionMs = performance.now() - started
    this.canvas.dataset.pocStats = JSON.stringify(this.stats)
    this.canvas.hidden = false
    return true
  }

  private release(prepared: PreparedToolpath): void {
    for (const batch of [...Object.values(prepared.layers), ...prepared.feeds.values(), prepared.collisions]) {
      for (const geometry of batch.geometries) geometry.dispose()
      batch.scene.clear()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.onLoss)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestore)
    for (const prepared of this.cache.values()) this.release(prepared)
    this.cache.clear()
    this.mask.dispose()
    this.maskMaterial.dispose()
    this.compositeMaterial.dispose()
    this.quadGeometry.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
