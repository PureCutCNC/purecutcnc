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

import type { SnapMode, SnapSettings } from '../../../sketch/snapping'

interface ToolbarProps {
  onZoomToModel: () => void
  onZoomWindow: () => void
  zoomWindowActive?: boolean
  onImportComplete?: () => void
  onExportModel: () => void
  onPrintDesign?: () => void
}

interface SnapToolbarProps {
  snapSettings: SnapSettings
  activeSnapMode?: SnapMode | null
  onToggleSnapEnabled: () => void
  onToggleSnapMode: (mode: SnapMode) => void
}

interface CreationToolbarProps {
  layout?: 'horizontal' | 'vertical'
}

const CREATION_SHAPE_OPTIONS = [
  { value: 'rect', icon: 'rect', noun: 'rectangle', tier: 'primary' },
  { value: 'circle', icon: 'circle', noun: 'circle', tier: 'primary' },
  { value: 'ellipse', icon: 'ellipse', noun: 'ellipse', tier: 'primary' },
  { value: 'polygon', icon: 'polygon', noun: 'polygon', tier: 'primary' },
  { value: 'spline', icon: 'spline', noun: 'spline', tier: 'primary' },
  { value: 'composite', icon: 'composite', noun: 'composite', tier: 'primary' },
  { value: 'text', icon: 'text', noun: 'text', tier: 'primary' },
  { value: 'slot', icon: 'slot', noun: 'slot', tier: 'secondary' },
  { value: 'ngon', icon: 'ngon', noun: 'regular polygon', tier: 'secondary' },
  { value: 'gear', icon: 'gear', noun: 'gear', tier: 'secondary' },
  { value: 'roundrect', icon: 'roundrect', noun: 'rounded rectangle', tier: 'secondary' },
  { value: 'chamferrect', icon: 'chamferrect', noun: 'chamfered rectangle', tier: 'secondary' },
] as const

type CreationShape = typeof CREATION_SHAPE_OPTIONS[number]['value']
type PopoverOpenMode = 'hover' | 'click'

const TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS = 320
const TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS = 240

interface PopoverMenuOption<T extends string> {
  value: T
  icon: string
  label: string
}

export {
  CREATION_SHAPE_OPTIONS,
  TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS,
  TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS,
}
export type {
  CreationShape,
  CreationToolbarProps,
  PopoverMenuOption,
  PopoverOpenMode,
  SnapToolbarProps,
  ToolbarProps,
}
