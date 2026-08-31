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

import type { CanvasThemePalette } from '../../theme/palette'
import type { ToolpathOverlayLayerKey } from '../viewport3d/toolpathOverlay'

/** Shared by the Canvas reference/booklet renderer and the opt-in GPU POC. */
export function toolpathLayerStyles(palette: CanvasThemePalette): Record<ToolpathOverlayLayerKey, {
  stroke: string; lineWidth: number; dash: number[]
}> {
  return {
    cuts: { stroke: palette.toolpathCut, lineWidth: 2.1, dash: [] },
    leadIns: { stroke: palette.toolpathCut, lineWidth: 2.1, dash: [] },
    rapids: { stroke: palette.toolpathRapid, lineWidth: 1.3, dash: [] },
    plunges: { stroke: palette.toolpathPlunge, lineWidth: 1.5, dash: [3, 4] },
    retractions: { stroke: palette.toolpathRapid, lineWidth: 1.3, dash: [] },
  }
}
export function toolpathStrokeWidth(base: number, emphasized: boolean): number {
  return emphasized ? base + 0.35 : Math.max(1, base - 0.35)
}

