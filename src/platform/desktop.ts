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

import { open, save, confirm } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { translate } from '../i18n/store'
import type { PlatformApi, OpenProjectResult, PickGeometryResult } from './api'

// ---------------------------------------------------------------------------
// Desktop (Tauri) implementation
// ---------------------------------------------------------------------------

export const desktopPlatform: PlatformApi = {
  isDesktop: true,

  async openProjectFile(): Promise<OpenProjectResult | null> {
    const path = await open({
      filters: [{ name: 'PureCutCNC Project', extensions: ['camj'] }],
      multiple: false,
    })
    if (!path) return null
    const content = await readTextFile(path)
    return { content, path }
  },

  async saveProjectFile(
    suggestedName: string,
    content: string,
    existingPath?: string | null
  ): Promise<string | null> {
    let targetPath = existingPath ?? null

    if (!targetPath) {
      const base = suggestedName.replace(/\.camj$/, '')
      targetPath = await save({
        defaultPath: `${base}.camj`,
        filters: [{ name: 'PureCutCNC Project', extensions: ['camj'] }],
      })
    }

    if (!targetPath) return null
    await writeTextFile(targetPath, content)
    return targetPath
  },

  async saveTextFile(
    suggestedName: string,
    content: string,
    extension: string,
    existingPath?: string | null
  ): Promise<string | null> {
    let targetPath = existingPath ?? null

    if (!targetPath) {
      const base = suggestedName.replace(new RegExp(`\\.${extension}$`), '')
      targetPath = await save({
        defaultPath: `${base}.${extension}`,
        filters: [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }],
      })
    }

    if (!targetPath) return null
    await writeTextFile(targetPath, content)
    return targetPath
  },

  async saveBinaryFile(
    suggestedName: string,
    content: Uint8Array,
    extension: string,
    _mimeType: string,
    existingPath?: string | null
  ): Promise<string | null> {
    let targetPath = existingPath ?? null

    if (!targetPath) {
      const base = suggestedName.replace(new RegExp(`\\.${extension}$`), '')
      targetPath = await save({
        defaultPath: `${base}.${extension}`,
        filters: [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }],
      })
    }

    if (!targetPath) return null
    await writeFile(targetPath, content)
    return targetPath
  },

  async pickJsonFile(): Promise<string | null> {
    const path = await open({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      multiple: false,
    })
    if (!path) return null
    return readTextFile(path)
  },

  async pickGeometryFile(): Promise<PickGeometryResult | null> {
    const path = await open({
      filters: [{ name: 'Geometry', extensions: ['svg', 'dxf'] }],
      multiple: false,
    })
    if (!path) return null
    const content = await readTextFile(path)
    const name = path.split('/').pop() ?? path
    return { name, content }
  },

  async revealInFileManager(path: string): Promise<void> {
    await revealItemInDir(path)
  },

  async confirmDiscardChanges(): Promise<boolean> {
    // "PureCutCNC" is the product name, deliberately untranslated.
    return confirm(translate('platform.confirmDiscard'), {
      title: 'PureCutCNC',
      kind: 'warning',
    })
  },

  async getAppVersion(): Promise<string> {
    return getVersion()
  },

  async openExternal(url: string): Promise<void> {
    await openUrl(url)
  },
}
