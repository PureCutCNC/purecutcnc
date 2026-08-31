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

import { Camera, CanvasTexture, Mesh, NoColorSpace, PlaneGeometry, Scene, ShaderMaterial, WebGLRenderer } from 'three'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { CanvasThemePalette } from '../../theme/palette'
import type { ToolpathVisibility } from '../toolpathVisibility'
import { drawToolpathAnnotations } from './previewPrimitives'
import { compositeVertexShader } from './gpuToolpathShaders'
import type { ViewTransform } from './viewTransform'

/**
 * One reusable annotation raster, not another set of arrow/debug shape rules.
 * Only the selected operation has annotations. Upload on view/detail changes,
 * then composite in that operation's painter slot (never above later paths).
 * No GPU readback and no extra WebGL context; booklets still draw directly.
 */
export class GpuToolpathAnnotations {
  private canvas: HTMLCanvasElement | null = null
  private texture: CanvasTexture | null = null
  private material: ShaderMaterial | null = null
  private geometry: PlaneGeometry | null = null
  private readonly scene = new Scene()
  private toolpath: ToolpathResult | null = null
  private key = ''

  render(renderer: WebGLRenderer, camera: Camera, toolpath: ToolpathResult, emphasized: boolean,
    vt: ViewTransform, width: number, height: number, visibility: ToolpathVisibility,
    palette: CanvasThemePalette, deferArrows: boolean): void {
    if (!emphasized || !toolpath.bounds || !visibility.directions) return
    if (deferArrows && !toolpath.debugToolpath) return
    if (!this.canvas) {
      this.canvas = document.createElement('canvas')
      this.texture = new CanvasTexture(this.canvas)
      this.texture.colorSpace = NoColorSpace
      this.texture.generateMipmaps = false
      this.material = new ShaderMaterial({
        uniforms: { annotations: { value: this.texture } },
        vertexShader: compositeVertexShader,
        fragmentShader: `
          uniform sampler2D annotations;
          varying vec2 sampleUv;
          void main() { gl_FragColor = texture2D(annotations, sampleUv); }
        `,
        transparent: true, depthTest: false, depthWrite: false,
      })
      this.geometry = new PlaneGeometry(2, 2)
      this.scene.add(new Mesh(this.geometry, this.material))
    }
    const key = JSON.stringify([vt.scale, vt.offsetX, vt.offsetY, width, height, visibility, palette, deferArrows])
    if (this.toolpath !== toolpath || this.key !== key) {
      if (this.canvas.width !== width || this.canvas.height !== height) {
        // Texture storage dimensions are immutable after the first upload.
        // Replace the texture on resize, retaining the scene/material.
        this.texture!.dispose()
        this.texture = new CanvasTexture(this.canvas)
        this.texture.colorSpace = NoColorSpace
        this.texture.generateMipmaps = false
        this.material!.uniforms.annotations.value = this.texture
      }
      // Resizing clears pixels and context state, even when dimensions match.
      this.canvas.width = width
      this.canvas.height = height
      const ctx = this.canvas.getContext('2d')
      if (!ctx) throw new Error('Toolpath annotation canvas is unavailable')
      drawToolpathAnnotations(ctx, toolpath, vt, true, visibility, { deferArrows })
      this.texture!.needsUpdate = true
      this.toolpath = toolpath
      this.key = key
    }
    renderer.render(this.scene, camera)
  }

  retain(active: ReadonlySet<ToolpathResult>): void {
    if (this.toolpath && !active.has(this.toolpath)) this.dispose()
  }

  dispose(): void {
    this.texture?.dispose()
    this.material?.dispose()
    this.geometry?.dispose()
    this.scene.clear()
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0 }
    this.canvas = null
    this.texture = null
    this.material = null
    this.geometry = null
    this.toolpath = null
    this.key = ''
  }
}
