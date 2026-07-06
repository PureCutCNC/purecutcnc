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

import type { ReactNode } from 'react'
import type { Project } from '../../types/project'

/** Triangle mesh in standard right-handed Z-up coordinates (the STL/CAD convention). */
export interface ExportTriangleMesh {
  /** Interleaved xyz vertex positions. */
  positions: Float32Array
  /** Triangle vertex indices (length is a multiple of 3). */
  index: Uint32Array
}

/**
 * Tessellation quality preset for arc/bezier curves in 2D sketches when
 * they're converted to a polygon prior to extrusion. Coarser presets produce
 * fewer triangles and match the 3D viewport's tessellation; finer presets
 * approximate true curves more closely.
 */
export type CurveQuality = 'coarse' | 'normal' | 'fine' | 'very_fine'

/** Maps a curve quality preset to its arc step in radians (smaller = finer). */
export const CURVE_QUALITY_ARC_STEP_RADIANS: Record<CurveQuality, number> = {
  coarse: Math.PI / 18,    // 10° — matches 3D viewport tessellation
  normal: Math.PI / 36,    // 5°
  fine: Math.PI / 90,      // 2°
  very_fine: Math.PI / 180, // 1°
}

export interface ModelExportAssembleOptions {
  /**
   * Include features stored as imported meshes that are rendered as visual
   * overlays in the 3D viewport (`operation === 'model'`). When false the
   * exported mesh matches exactly what the viewport's boolean preview shows.
   */
  includeImportedMeshes: boolean
  /** Curve tessellation quality. Defaults to 'normal'. */
  curveQuality: CurveQuality
}

export interface ModelExportAssembleResult {
  mesh: ExportTriangleMesh
  /** Non-blocking notes worth surfacing in the dialog (e.g. fallback geometry used). */
  warnings: string[]
}

export interface ModelExportInput {
  project: Project
  /** Assembled solid mesh; present only for `kind: '3d'` formats. */
  mesh?: ExportTriangleMesh
}

export interface ModelExportOutput {
  /** File bytes (binary formats) or text (ASCII formats). */
  data: Uint8Array | string
  /** Tells the caller which save path to use on the platform API. */
  encoding: 'binary' | 'text'
}

export interface ModelExportFormat<TOptions = unknown> {
  id: string
  /** Human-readable name shown in the dialog format dropdown. */
  name: string
  /** File extension without the leading dot. */
  extension: string
  /** MIME type used by the browser blob save fallback. */
  mimeType: string
  /**
   * '3d' formats consume the assembled triangle mesh; '2d' formats render
   * from the project directly and skip mesh assembly entirely.
   */
  kind: '2d' | '3d'
  defaultOptions: TOptions
  /** React node for the format-specific option controls in the dialog. */
  renderOptions: (props: {
    options: TOptions
    onChange: (next: TOptions) => void
  }) => ReactNode
  /**
   * Serialize the assembled mesh to the format's byte/text representation.
   * Implementations should be synchronous unless they genuinely need async work.
   */
  export: (input: ModelExportInput, options: TOptions) => Promise<ModelExportOutput> | ModelExportOutput
}
