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
 * Key hints shown on the canvas workflow panels. These are deliberately NOT
 * translated and deliberately NOT baked into the locale files — a bracketed key
 * name is the same in every language, and duplicating it across five locale
 * files only invites drift. `withShortcut` appends it at render time instead.
 *
 * Every binding here is owned by useCanvasKeyboard; this module only names them
 * so the label and the handler cannot disagree.
 */
export const CANVAS_SHORTCUT = {
  cancel: 'Esc',
  confirm: 'Enter',
  /** Tab opens dimension/width/radius/scale/angle entry, depending on the panel. */
  dimensions: 'Tab',
  undo: 'Backspace',
  keepOriginals: 'K',
  compositeLine: 'L',
  compositeArc: 'A',
  compositeSpline: 'S',
} as const

export type CanvasShortcut = (typeof CANVAS_SHORTCUT)[keyof typeof CANVAS_SHORTCUT]

/** `Keep originals` + `K` → `Keep originals (K)`. */
export function withShortcut(label: string, shortcut: CanvasShortcut): string {
  return `${label} (${shortcut})`
}
