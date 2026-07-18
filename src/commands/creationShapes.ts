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

import { useI18n } from '../i18n/i18nContext'
import type { MessageKey } from '../i18n/locales/en'
import { useProjectStore } from '../store/projectStore'
import type { CreationTarget } from '../store/types'
import type { TextToolConfig } from '../text'

export const CREATION_SHAPE_OPTIONS = [
  { value: 'rect', icon: 'rect', noun: 'rectangle', nounKey: 'sketch.shape.rectangle' as const },
  { value: 'circle', icon: 'circle', noun: 'circle', nounKey: 'sketch.shape.circle' as const },
  { value: 'ellipse', icon: 'ellipse', noun: 'ellipse', nounKey: 'sketch.shape.ellipse' as const },
  { value: 'polygon', icon: 'polygon', noun: 'polygon', nounKey: 'sketch.shape.polygon' as const },
  { value: 'spline', icon: 'spline', noun: 'spline', nounKey: 'sketch.shape.spline' as const },
  { value: 'composite', icon: 'composite', noun: 'composite', nounKey: 'sketch.shape.composite' as const },
  { value: 'text', icon: 'text', noun: 'text', nounKey: 'sketch.shape.text' as const },
  { value: 'slot', icon: 'slot', noun: 'slot', nounKey: 'sketch.shape.slot' as const },
  { value: 'ngon', icon: 'ngon', noun: 'regular polygon', nounKey: 'sketch.shape.regularPolygon' as const },
  { value: 'gear', icon: 'gear', noun: 'gear', nounKey: 'sketch.shape.gear' as const },
  { value: 'roundrect', icon: 'roundrect', noun: 'rounded rectangle', nounKey: 'sketch.shape.roundedRect' as const },
  { value: 'chamferrect', icon: 'chamferrect', noun: 'chamfered rectangle', nounKey: 'sketch.shape.chamferedRect' as const },
] as const

const CREATION_TARGET_NOUN_KEYS: Record<CreationTarget, MessageKey> = {
  feature: 'sketch.target.feature',
  line: 'sketch.target.line',
  region: 'sketch.target.region',
  construction: 'sketch.target.construction',
} as const

export type CreationShape = typeof CREATION_SHAPE_OPTIONS[number]['value']
export type PlacementShape = Exclude<CreationShape, 'text'>

export interface CreationShapeCommand {
  id: CreationShape
  icon: string
  noun: string
  nounKey: MessageKey
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
  // Text and Gear are only solid-feature shapes. Line, Region, and
  // Construction targets use plain profile geometry.
  if (shape === 'text' || shape === 'gear') {
    return creationTarget === 'feature'
  }
  return true
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
  const { t } = useI18n()
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
    startAddGearPlacement,
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
    } else if (shape === 'gear') {
      togglePlacement(shape, startAddGearPlacement)
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
    const shapeNoun = t(option.nounKey)
    const targetNoun = t(CREATION_TARGET_NOUN_KEYS[creationTarget])
    return {
      id: option.value,
      icon: option.icon,
      noun: option.noun,
      nounKey: option.nounKey,
      label: active
        ? t('sketch.creation.cancel', { shape: shapeNoun })
        : t('sketch.creation.addShape', { target: targetNoun, shape: shapeNoun }),
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
