/**
 * Copyright 2026 Maik Rolf
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
import {
  DIMENSION_TYPE_COMMANDS,
  FEATURE_ALIGNMENT_COMMANDS,
  FEATURE_DISTRIBUTION_COMMANDS,
} from './arrangeCommands'
import { useCreationShapeCommands } from './creationShapes'
import { useFileCommands, type FileCommandId } from './fileCommands'
import { useSketchCommands } from './sketchCommands'
import type { CommandEffect, CommandSpec } from './commandRegistry'

/**
 * Commands exposed outside the toolbar. The descriptors stay owned by the
 * existing hooks (file, sketch, creation); this adapter only gives them a
 * stable, namespaced identity and the metadata a palette or a bridge needs.
 *
 * Search keywords are the stable descriptor ids and icon names plus a few
 * English synonyms. The localized label is the primary search surface; the
 * aliases deliberately stay stable so command ids remain findable in every
 * locale.
 */

const FILE_EFFECTS: Record<FileCommandId, CommandEffect> = {
  newProject: 'destructive',
  openProject: 'destructive',
  importGeometry: 'edit',
  exportModel: 'read',
  printDesign: 'read',
  saveProject: 'edit',
  undo: 'edit',
  redo: 'edit',
}

// Only shortcuts this app actually handles belong here. Native desktop menu
// accelerators are intentionally not guessed.
const FILE_SHORTCUTS: Partial<Record<FileCommandId, string>> = {
  undo: 'Ctrl/Cmd+Z',
  redo: 'Ctrl/Cmd+Shift+Z',
  printDesign: 'Ctrl/Cmd+P',
}

export interface UseAppCommandsArgs {
  onNewProject: () => void
  onImportGeometry?: () => void
  onExportModel: () => void
  onPrintDesign?: () => void
  onRequestText?: () => void
  onZoomToModel: () => void
}

export function useAppCommands({
  onNewProject,
  onImportGeometry,
  onExportModel,
  onPrintDesign,
  onRequestText,
  onZoomToModel,
}: UseAppCommandsArgs): CommandSpec[] {
  const { t } = useI18n()

  const file = useFileCommands({
    onNewProject,
    onImportGeometry: onImportGeometry ?? (() => undefined),
    onExportModel,
    onPrintDesign: onPrintDesign ?? (() => undefined),
  })
  const sketch = useSketchCommands()
  const creation = useCreationShapeCommands({
    onRequestText: onRequestText ?? (() => undefined),
  })

  const commands: CommandSpec[] = []

  for (const descriptor of Object.values(file.commands)) {
    if (descriptor.id === 'importGeometry' && !onImportGeometry) continue
    if (descriptor.id === 'printDesign' && !onPrintDesign) continue
    commands.push({
      id: `file.${descriptor.id}`,
      label: descriptor.label,
      group: 'file',
      keywords: [descriptor.id, descriptor.icon],
      shortcut: FILE_SHORTCUTS[descriptor.id],
      effect: FILE_EFFECTS[descriptor.id],
      enabled: descriptor.enabled,
      active: descriptor.active,
      run: descriptor.onActivate,
    })
  }

  for (const descriptor of Object.values(sketch.transform)) {
    commands.push({
      id: `sketch.transform.${descriptor.id}`,
      label: descriptor.label,
      group: 'sketch',
      keywords: [descriptor.id, descriptor.icon],
      effect: descriptor.id === 'delete' ? 'destructive' : 'edit',
      enabled: descriptor.enabled,
      active: descriptor.active,
      run: descriptor.onActivate,
    })
  }

  for (const descriptor of Object.values(sketch.boolean)) {
    commands.push({
      id: `sketch.boolean.${descriptor.id}`,
      label: descriptor.label,
      group: 'sketch',
      keywords: [descriptor.id, descriptor.icon],
      effect: 'edit',
      enabled: descriptor.enabled,
      active: descriptor.active,
      run: descriptor.onActivate,
    })
  }

  for (const option of FEATURE_ALIGNMENT_COMMANDS) {
    commands.push({
      id: `sketch.align.${option.id}`,
      label: t(option.labelKey),
      group: 'sketch',
      keywords: ['align', option.id, option.icon],
      effect: 'edit',
      enabled: sketch.predicates.canAlignSelectedFeatures,
      run: () => sketch.arrange.alignFeature(option.id),
    })
  }

  for (const option of FEATURE_DISTRIBUTION_COMMANDS) {
    commands.push({
      id: `sketch.distribute.${option.id}`,
      label: t(option.labelKey),
      group: 'sketch',
      keywords: ['distribute', option.id, option.icon],
      effect: 'edit',
      enabled: sketch.predicates.canDistributeSelectedFeatures,
      run: () => sketch.arrange.distributeFeatures(option.id),
    })
  }

  for (const descriptor of Object.values(sketch.sketchEdit)) {
    commands.push({
      id: `sketch.edit.${descriptor.id}`,
      label: descriptor.label,
      group: 'sketch',
      keywords: [descriptor.id, descriptor.icon],
      effect: 'edit',
      enabled: descriptor.enabled,
      active: descriptor.active,
      run: descriptor.onActivate,
    })
  }

  commands.push({
    id: 'sketch.constraint.add',
    label: sketch.constraint.label,
    group: 'sketch',
    keywords: ['constraint', 'dimension', 'lock'],
    effect: 'edit',
    enabled: sketch.constraint.enabled,
    active: sketch.constraint.active,
    run: sketch.constraint.onActivate,
  })

  commands.push({
    id: 'sketch.dimension.tapeMeasure',
    label: sketch.dimension.tapeMeasure.label,
    group: 'sketch',
    keywords: ['measure', 'distance', 'tape'],
    effect: 'read',
    enabled: sketch.dimension.tapeMeasure.enabled,
    active: sketch.dimension.tapeMeasure.active,
    run: sketch.dimension.tapeMeasure.onActivate,
  })

  commands.push({
    id: 'sketch.dimension.delete',
    label: sketch.dimension.deleteDimension.label,
    group: 'sketch',
    keywords: ['measure', 'remove', 'annotation'],
    effect: 'destructive',
    enabled: sketch.dimension.deleteDimension.enabled,
    active: sketch.dimension.deleteDimension.active,
    run: sketch.dimension.deleteDimension.onActivate,
  })

  commands.push({
    id: 'sketch.dimension.toggle',
    label: sketch.dimension.showDimensions.label,
    group: 'sketch',
    keywords: ['measure', 'show', 'hide', 'annotations'],
    effect: 'edit',
    enabled: sketch.dimension.showDimensions.enabled,
    active: sketch.dimension.showDimensions.active,
    run: sketch.dimension.showDimensions.onActivate,
  })

  for (const option of DIMENSION_TYPE_COMMANDS) {
    const descriptor = sketch.dimension.dimensionTypes[option.id]
    commands.push({
      id: `sketch.dimension.${option.id}`,
      label: t(option.labelKey),
      group: 'sketch',
      keywords: ['measure', 'dimension', option.id, option.icon],
      effect: 'edit',
      enabled: descriptor.enabled,
      active: descriptor.active,
      run: () => descriptor.onActivate(option.id),
    })
  }

  for (const descriptor of creation.shapeCommands) {
    if (descriptor.id === 'text' && !onRequestText) continue
    commands.push({
      id: `create.${descriptor.id}`,
      label: descriptor.label,
      group: 'create',
      keywords: [descriptor.id, descriptor.icon, descriptor.noun],
      effect: 'edit',
      enabled: descriptor.enabled,
      active: descriptor.active,
      run: descriptor.onActivate,
    })
  }

  commands.push({
    id: 'view.zoomToModel',
    label: t('shell.topBar.zoomToModel'),
    group: 'view',
    keywords: ['zoom', 'fit', 'frame', 'model'],
    effect: 'read',
    enabled: true,
    run: onZoomToModel,
  })

  return commands
}
