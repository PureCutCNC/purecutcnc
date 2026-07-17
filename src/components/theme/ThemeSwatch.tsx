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

import type { ThemeValues } from '../../theme/registry'

/**
 * Small representative color strip for a theme: app surface, panel, text,
 * accent, and cut colors. Rendered from the theme's own resolved values so a
 * list of themes previews correctly regardless of the active theme.
 */
export function ThemeSwatch({ values }: { values: ThemeValues }) {
  const chips = [
    values['surface-app'],
    values['surface-panel'],
    values.text,
    values.accent,
    values.cut,
  ]
  return (
    <span className="theme-swatch" aria-hidden="true">
      {chips.map((color, index) => (
        <span key={index} className="theme-swatch__chip" style={{ background: color }} />
      ))}
    </span>
  )
}
