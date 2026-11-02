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

/**
 * The folder the desktop file dialogs start in (issue #1144). macOS remembers
 * the last folder by itself; the Linux (GTK) and Windows dialogs do not, so
 * the app remembers it: one folder for projects, one for every other file.
 */

export type DialogFolderKind = 'project' | 'file'

const STORAGE_KEY: Record<DialogFolderKind, string> = {
  project: 'purecut.dialogFolder.project',
  file: 'purecut.dialogFolder.file',
}

/** The folder part of a path, `/` or `\` separated; null for a bare name. */
export function folderOf(path: string): string | null {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (at < 0) return null
  // Keep the separator for a root ("/" or "C:\") so it still names a folder.
  return at === 0 || path[at - 1] === ':' ? path.slice(0, at + 1) : path.slice(0, at)
}

/** The file name part of a path, `/` or `\` separated. */
export function fileNameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(at + 1)
}

/** `name` inside `folder`, using the folder's own separator. */
export function joinFolder(folder: string, name: string): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return folder.endsWith('/') || folder.endsWith('\\') ? `${folder}${name}` : `${folder}${separator}${name}`
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function rememberedFolder(kind: DialogFolderKind): string | null {
  try {
    return storage()?.getItem(STORAGE_KEY[kind]) || null
  } catch {
    return null
  }
}

/** Remember the folder of a file the user just opened or saved. */
export function rememberFolderOf(kind: DialogFolderKind, path: string): void {
  const folder = folderOf(path)
  if (!folder) return
  try {
    storage()?.setItem(STORAGE_KEY[kind], folder)
  } catch {
    // Storage blocked: the dialog just starts where the system puts it.
  }
}

/** `defaultPath` for a save dialog: the suggested name in the remembered folder. */
export function saveDefaultPath(kind: DialogFolderKind, fileName: string): string {
  const folder = rememberedFolder(kind)
  return folder ? joinFolder(folder, fileName) : fileName
}
