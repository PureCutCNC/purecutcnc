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

import type { PlatformApi, OpenProjectResult, PickGeometryResult } from './api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    // Resolve null if the dialog is dismissed without a selection
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

function triggerDownload(content: string, fileName: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Save via the File System Access API when available.  This lets us detect
 * when the user cancels the native "Save As" dialog (throws AbortError).
 * Returns the chosen file name on success, or null on cancel.
 * Falls back to triggerDownload (always succeeds) when the API is missing.
 */
async function saveFile(
  content: string,
  fileName: string,
  mimeType: string,
  description: string,
  extensions: string[]
): Promise<string | null> {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description, accept: { [mimeType]: extensions } }],
      })
      const writable = await handle.createWritable()
      await writable.write(content)
      await writable.close()
      return handle.name
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
  }
  // Fallback — no way to detect cancel, assume success
  triggerDownload(content, fileName, mimeType)
  return fileName
}

// ---------------------------------------------------------------------------
// Browser implementation
// ---------------------------------------------------------------------------

export const browserPlatform: PlatformApi = {
  isDesktop: false,

  async openProjectFile(): Promise<OpenProjectResult | null> {
    const file = await pickFile('.camj,.json')
    if (!file) return null
    const content = await readFileAsText(file)
    return { content, path: null }
  },

  async saveProjectFile(suggestedName: string, content: string): Promise<string | null> {
    const fileName = suggestedName.endsWith('.camj') ? suggestedName : `${suggestedName}.camj`
    return saveFile(content, fileName, 'application/json', 'PureCutCNC Project', ['.camj'])
  },

  async saveTextFile(
    suggestedName: string,
    content: string,
    extension: string
  ): Promise<string | null> {
    const fileName = suggestedName.endsWith(`.${extension}`)
      ? suggestedName
      : `${suggestedName}.${extension}`
    return saveFile(content, fileName, 'text/plain', `${extension.toUpperCase()} file`, [`.${extension}`])
  },

  async pickJsonFile(): Promise<string | null> {
    const file = await pickFile('.json,application/json')
    if (!file) return null
    return readFileAsText(file)
  },

  async pickGeometryFile(): Promise<PickGeometryResult | null> {
    const file = await pickFile('.svg,.dxf')
    if (!file) return null
    const content = await readFileAsText(file)
    return { name: file.name, content }
  },

  async revealInFileManager(_path: string): Promise<void> {
    // Not supported in the browser
  },

  async confirmDiscardChanges(): Promise<boolean> {
    return window.confirm('You have unsaved changes. Discard them and continue?')
  },
}
