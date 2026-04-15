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

export interface OpenProjectResult {
  /** Raw file content */
  content: string
  /** Filesystem path, or null in the browser where there is no real path */
  path: string | null
}

export interface PickGeometryResult {
  name: string
  content: string
}

/**
 * Platform-agnostic interface for all file I/O operations.
 *
 * The browser implementation uses blob downloads and <input type="file">.
 * The desktop implementation uses native Tauri dialog + fs APIs.
 */
export interface PlatformApi {
  /**
   * Prompt the user to choose a .camj file and return its content and path.
   * Returns null if the user cancels.
   */
  openProjectFile(): Promise<OpenProjectResult | null>

  /**
   * Write a .camj file.
   *
   * - If existingPath is provided, write to that path without a dialog.
   * - If existingPath is null/undefined, show a Save As dialog first.
   *
   * Returns the path written to, or null if the user cancels.
   */
  saveProjectFile(
    suggestedName: string,
    content: string,
    existingPath?: string | null
  ): Promise<string | null>

  /**
   * Write a plain-text file (e.g. G-code).
   *
   * - If existingPath is provided, write to that path without a dialog.
   * - Otherwise show a Save As dialog first.
   *
   * Returns the path written to, or null if the user cancels.
   */
  saveTextFile(
    suggestedName: string,
    content: string,
    extension: string,
    existingPath?: string | null
  ): Promise<string | null>

  /**
   * Prompt the user to choose a JSON file and return its content.
   * Returns null if the user cancels.
   */
  pickJsonFile(): Promise<string | null>

  /**
   * Prompt the user to choose an SVG or DXF file and return its name and content.
   * Returns null if the user cancels.
   */
  pickGeometryFile(): Promise<PickGeometryResult | null>

  /**
   * Open the OS file manager at the given path.
   * No-op on platforms/phases where this is not yet implemented.
   */
  revealInFileManager(path: string): Promise<void>

  /**
   * Ask the user whether they want to discard unsaved changes.
   * Returns true if they confirmed (i.e. safe to proceed), false if they cancelled.
   */
  confirmDiscardChanges(): Promise<boolean>

  /** True when running inside Tauri, false in a plain browser. */
  isDesktop: boolean
}
