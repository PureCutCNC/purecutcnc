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

/**
 * Turn the platform-neutral `Ctrl/Cmd` hint stored on a command into the
 * modifier label the current platform actually uses. The command descriptors
 * keep one spelling; only the display changes.
 */
export function formatShortcutHint(shortcut: string, apple = isApplePlatform()): string {
  if (!apple) return shortcut.replaceAll('Ctrl/Cmd', 'Ctrl')

  return shortcut
    .replaceAll('Ctrl/Cmd+', '⌘')
    .replaceAll('Cmd+', '⌘')
    .replaceAll('Shift+', '⇧')
    .replaceAll('Alt+', '⌥')
    .replaceAll('+', '')
}

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform || navigator.userAgent
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}
