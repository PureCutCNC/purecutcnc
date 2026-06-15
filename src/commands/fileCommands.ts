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

import { useFileActions } from '../platform/useFileActions'
import { useProjectStore } from '../store/projectStore'

export type FileCommandId =
  | 'newProject'
  | 'openProject'
  | 'importGeometry'
  | 'exportModel'
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
}

export function useFileCommands({
  onNewProject,
  onImportGeometry,
  onExportModel,
}: UseFileCommandsArgs): {
  dirty: boolean
  historyPastLength: number
  historyFutureLength: number
  commands: Record<FileCommandId, FileCommandDescriptor>
} {
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
        label: 'New project',
        enabled: true,
        active: false,
        onActivate: handleNewProject,
      },
      openProject: {
        id: 'openProject',
        icon: 'open',
        label: 'Open project',
        enabled: true,
        active: false,
        onActivate: handleOpenProject,
      },
      importGeometry: {
        id: 'importGeometry',
        icon: 'import',
        label: 'Import geometry',
        enabled: true,
        active: false,
        onActivate: onImportGeometry,
      },
      exportModel: {
        id: 'exportModel',
        icon: 'export',
        label: 'Export model',
        enabled: true,
        active: false,
        onActivate: onExportModel,
      },
      saveProject: {
        id: 'saveProject',
        icon: 'save',
        label: dirty ? 'Save project with unsaved changes' : 'Save project',
        enabled: true,
        active: false,
        onActivate: handleSaveProject,
      },
      undo: {
        id: 'undo',
        icon: 'undo',
        label: 'Undo',
        enabled: history.past.length > 0,
        active: false,
        onActivate: undo,
      },
      redo: {
        id: 'redo',
        icon: 'redo',
        label: 'Redo',
        enabled: history.future.length > 0,
        active: false,
        onActivate: redo,
      },
    },
  }
}
