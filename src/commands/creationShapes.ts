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

import { useProjectStore } from '../store/projectStore'
import type { CreationTarget } from '../store/types'
import type { TextToolConfig } from '../text'

export const CREATION_SHAPE_OPTIONS = [
  { value: 'rect', icon: 'rect', noun: 'rectangle' },
  { value: 'circle', icon: 'circle', noun: 'circle' },
  { value: 'ellipse', icon: 'ellipse', noun: 'ellipse' },
  { value: 'polygon', icon: 'polygon', noun: 'polygon' },
  { value: 'spline', icon: 'spline', noun: 'spline' },
  { value: 'composite', icon: 'composite', noun: 'composite' },
  { value: 'text', icon: 'text', noun: 'text' },
  { value: 'slot', icon: 'slot', noun: 'slot' },
  { value: 'ngon', icon: 'ngon', noun: 'regular polygon' },
  { value: 'roundrect', icon: 'roundrect', noun: 'rounded rectangle' },
  { value: 'chamferrect', icon: 'chamferrect', noun: 'chamfered rectangle' },
] as const

export type CreationShape = typeof CREATION_SHAPE_OPTIONS[number]['value']
export type PlacementShape = Exclude<CreationShape, 'text'>

export interface CreationShapeCommand {
  id: CreationShape
  icon: string
  noun: string
  label: string
  enabled: boolean
  active: boolean
  onActivate: () => void
}

interface UseCreationShapeCommandsArgs {
  onRequestText: () => void
}

function isPlacementShape(shape: CreationShape): shape is PlacementShape {
  return shape !== 'text'
}

export function shapeEnabledForTarget(shape: CreationShape, creationTarget: CreationTarget): boolean {
  // Text is only a feature-target shape: regions must be closed masks and
  // construction geometry is plain reference geometry (points/lines/shapes).
  return creationTarget === 'feature' || shape !== 'text'
}

export function useCreationShapeCommands({
  onRequestText,
}: UseCreationShapeCommandsArgs): {
  creationTarget: CreationTarget
  setCreationTarget: (target: CreationTarget) => void
  pendingShape: string | null
  shapeCommands: CreationShapeCommand[]
  availableShapeCommands: CreationShapeCommand[]
  activateShape: (shape: CreationShape) => void
  confirmTextTool: (config: TextToolConfig) => void
} {
  const {
    pendingAdd,
    creationTarget,
    setCreationTarget,
    startAddRectPlacement,
    startAddCirclePlacement,
    startAddEllipsePlacement,
    startAddPolygonPlacement,
    startAddSplinePlacement,
    startAddCompositePlacement,
    startAddTextPlacement,
    startAddSlotPlacement,
    startAddNgonPlacement,
    startAddRoundRectPlacement,
    startAddChamferRectPlacement,
    cancelPendingAdd,
  } = useProjectStore()

  function togglePlacement(shape: PlacementShape, start: () => void) {
    if (pendingAdd?.shape === shape) {
      cancelPendingAdd()
      return
    }

    start()
  }

  function activateShape(shape: CreationShape) {
    if (!shapeEnabledForTarget(shape, creationTarget)) {
      return
    }

    if (!isPlacementShape(shape)) {
      if (pendingAdd) {
        cancelPendingAdd()
      }
      onRequestText()
      return
    }

    if (shape === 'rect') {
      togglePlacement(shape, startAddRectPlacement)
    } else if (shape === 'circle') {
      togglePlacement(shape, startAddCirclePlacement)
    } else if (shape === 'ellipse') {
      togglePlacement(shape, startAddEllipsePlacement)
    } else if (shape === 'polygon') {
      togglePlacement(shape, startAddPolygonPlacement)
    } else if (shape === 'spline') {
      togglePlacement(shape, startAddSplinePlacement)
    } else if (shape === 'slot') {
      togglePlacement(shape, startAddSlotPlacement)
    } else if (shape === 'ngon') {
      togglePlacement(shape, startAddNgonPlacement)
    } else if (shape === 'roundrect') {
      togglePlacement(shape, startAddRoundRectPlacement)
    } else if (shape === 'chamferrect') {
      togglePlacement(shape, startAddChamferRectPlacement)
    } else {
      togglePlacement(shape, startAddCompositePlacement)
    }
  }

  function confirmTextTool(config: TextToolConfig) {
    startAddTextPlacement(config)
  }

  const shapeCommands = CREATION_SHAPE_OPTIONS.map((option): CreationShapeCommand => {
    const active = pendingAdd?.shape === option.value
    return {
      id: option.value,
      icon: option.icon,
      noun: option.noun,
      label: active ? `Cancel ${option.noun}` : `Add ${creationTarget} ${option.noun}`,
      enabled: shapeEnabledForTarget(option.value, creationTarget),
      active,
      onActivate: () => activateShape(option.value),
    }
  })

  return {
    creationTarget,
    setCreationTarget,
    pendingShape: pendingAdd?.shape ?? null,
    shapeCommands,
    availableShapeCommands: shapeCommands.filter((command) => command.enabled),
    activateShape,
    confirmTextTool,
  }
}
