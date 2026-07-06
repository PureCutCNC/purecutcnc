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
 * SVG export format (issue #257): the 2D design view as an editable vector
 * drawing at true 1:1 physical scale, rendered by the designPrint engine.
 * A '2d' format — it draws from the project directly and needs no mesh.
 */

import { buildDesignSvgExport } from '../designPrint'
import type { DesignSvgExportOptions } from '../designPrint'
import type { ModelExportFormat, ModelExportInput, ModelExportOutput } from './types'

export type SvgExportOptions = DesignSvgExportOptions

/**
 * Static fallback defaults; the dialog seeds its state from
 * `defaultDesignSvgExportOptions(project)` so toggles follow the project.
 */
export const SVG_DEFAULT_OPTIONS: SvgExportOptions = {
  area: 'visible',
  colorMode: 'color',
  content: {
    grid: false,
    featureLabels: false,
    tabs: true,
    clamps: true,
  },
}

export const svgExportFormat: ModelExportFormat<SvgExportOptions> = {
  id: 'svg',
  name: 'SVG (2D vector drawing)',
  extension: 'svg',
  mimeType: 'image/svg+xml',
  kind: '2d',
  defaultOptions: SVG_DEFAULT_OPTIONS,
  renderOptions: () => null, // Provided by the dialog itself (avoids React import in this file).
  export(input: ModelExportInput, options: SvgExportOptions): ModelExportOutput {
    return {
      data: buildDesignSvgExport(input.project, options),
      encoding: 'text',
    }
  },
}
