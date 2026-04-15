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
import { platform } from './index'

/**
 * Shared file action logic used by both the Toolbar and the desktop menu
 * integration. All actions read from the Zustand store so they are always
 * operating on the current state.
 */
export function useFileActions() {
  const { project, filePath, dirty, saveProject, openProjectFromText, markSaved } =
    useProjectStore()

  /** Save to the current path (desktop) or trigger a download (browser). */
  async function save(): Promise<void> {
    const json = saveProject()
    const savedPath = await platform.saveProjectFile(
      project.meta.name.replace(/\s+/g, '_'),
      json,
      filePath
    )
    if (savedPath) markSaved(savedPath)
  }

  /** Always show a Save As dialog, ignoring the current path. */
  async function saveAs(): Promise<void> {
    const json = saveProject()
    const savedPath = await platform.saveProjectFile(
      project.meta.name.replace(/\s+/g, '_'),
      json,
      null // force dialog
    )
    if (savedPath) markSaved(savedPath)
  }

  /**
   * Show an open file dialog and load the chosen project.
   * Returns true if a file was opened, false if the user cancelled or
   * chose not to discard unsaved changes.
   */
  async function open(): Promise<boolean> {
    if (dirty) {
      const ok = await platform.confirmDiscardChanges()
      if (!ok) return false
    }
    const result = await platform.openProjectFile()
    if (!result) return false
    try {
      openProjectFromText(result.content, result.path)
      return true
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to open project file.')
      return false
    }
  }

  /**
   * If there are unsaved changes, ask the user whether to discard them.
   * Returns true when it is safe to proceed (no changes, or user confirmed).
   */
  async function confirmDiscardIfDirty(): Promise<boolean> {
    if (!dirty) return true
    return platform.confirmDiscardChanges()
  }

  return { save, saveAs, open, confirmDiscardIfDirty }
}
