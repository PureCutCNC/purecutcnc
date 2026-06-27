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

import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { ToolpathVisibility } from '../toolpathVisibility'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import type { OpenProfileEndpoint, SketchEditTool } from '../../store/types'
import type { OperationKind, Point } from '../../types/project'

export const NODE_HIT_RADIUS = 9
export const HANDLE_HIT_RADIUS = 7
export const POLYGON_CLOSE_RADIUS = 12
export const OPEN_ENDPOINT_JOIN_HIT_RADIUS = 14
export const MIN_SKETCH_ZOOM = 0.02

export interface PendingPreviewPoint {
  point: Point
  session: number
}

export interface SketchEditPreviewPoint {
  point: Point
  mode: SketchEditTool
}

export interface PendingSketchFillet {
  anchorIndex: number
  corner: Point
}

export interface OpenEndpointHit {
  featureId: string
  endpoint: OpenProfileEndpoint
  anchor: Point
}

export interface SegmentHit {
  segmentIndex: number
  point: Point
}

export interface SketchCanvasHandle {
  zoomToModel: () => void
}

export interface SketchCanvasProps {
  onFeatureContextMenu?: (featureId: string, x: number, y: number) => void
  onTabContextMenu?: (tabId: string, x: number, y: number) => void
  onClampContextMenu?: (clampId: string, x: number, y: number) => void
  toolpaths?: ToolpathResult[]
  selectedOperationId?: string | null
  collidingClampIds?: string[]
  snapSettings: SnapSettings
  zoomWindowActive?: boolean
  onZoomWindowComplete?: () => void
  onActiveSnapModeChange?: (mode: SnapMode | null) => void
  depthLegendCollapsed?: boolean
  onToggleDepthLegend?: () => void
  toolpathVisibility?: ToolpathVisibility
  onToolpathVisibilityChange?: (visibility: ToolpathVisibility) => void
  /**
   * A1.3: when an operation kind is armed/hovered in the CAM "Add operation"
   * menu, the canvas highlights features that operation could act on and dims
   * the rest. Null when nothing is armed.
   */
  operationHighlightKind?: OperationKind | null
}
