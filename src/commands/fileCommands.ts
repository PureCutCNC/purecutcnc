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
import { useFileActions } from '../platform/useFileActions'
import { useProjectStore } from '../store/projectStore'

export type FileCommandId =
  | 'newProject'
  | 'openProject'
  | 'importGeometry'
  | 'exportModel'
  | 'printDesign'
  | 'saveProject'
  | 'undo'
  | 'redo'

export interface FileCommandDescriptor {
  id: FileCommandId
  icon: string
  label: string
  enabled: boolean
  active: boolean
  onActivate: () => void
}

interface UseFileCommandsArgs {
  onNewProject: () => void
  onImportGeometry: () => void
  onExportModel: () => void
  onPrintDesign: () => void
}

export function useFileCommands({
  onNewProject,
  onImportGeometry,
  onExportModel,
  onPrintDesign,
}: UseFileCommandsArgs): {
  dirty: boolean
  historyPastLength: number
  historyFutureLength: number
  commands: Record<FileCommandId, FileCommandDescriptor>
} {
  const { t } = useI18n()
  const fileActions = useFileActions()
  const { dirty, history, undo, redo } = useProjectStore()

  async function handleNewProject() {
    const ok = await fileActions.confirmDiscardIfDirty()
    if (ok) {
      onNewProject()
    }
  }

  async function handleOpenProject() {
    await fileActions.open()
  }

  async function handleSaveProject() {
    await fileActions.save()
  }

  return {
    dirty,
    historyPastLength: history.past.length,
    historyFutureLength: history.future.length,
    commands: {
      newProject: {
        id: 'newProject',
        icon: 'new',
        label: t('file.newProject'),
        enabled: true,
        active: false,
        onActivate: handleNewProject,
      },
      openProject: {
        id: 'openProject',
        icon: 'open',
        label: t('file.openProject'),
        enabled: true,
        active: false,
        onActivate: handleOpenProject,
      },
      importGeometry: {
        id: 'importGeometry',
        icon: 'import',
        label: t('file.importGeometry'),
        enabled: true,
        active: false,
        onActivate: onImportGeometry,
      },
      exportModel: {
        id: 'exportModel',
        icon: 'export',
        label: t('file.exportModel'),
        enabled: true,
        active: false,
        onActivate: onExportModel,
      },
      printDesign: {
        id: 'printDesign',
        icon: 'print',
        label: t('file.printDesign'),
        enabled: true,
        active: false,
        onActivate: onPrintDesign,
      },
      saveProject: {
        id: 'saveProject',
        icon: 'save',
        label: dirty ? t('file.saveProjectDirty') : t('file.saveProject'),
        enabled: true,
        active: false,
        onActivate: handleSaveProject,
      },
      undo: {
        id: 'undo',
        icon: 'undo',
        label: t('file.undo'),
        enabled: history.past.length > 0,
        active: false,
        onActivate: undo,
      },
      redo: {
        id: 'redo',
        icon: 'redo',
        label: t('file.redo'),
        enabled: history.future.length > 0,
        active: false,
        onActivate: redo,
      },
    },
  }
}
