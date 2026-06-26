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

interface IconProps {
  id: string
  className?: string
  size?: number | string
  /**
   * Opt out of the monochrome `currentColor` outline treatment so a colour/
   * filled icon renders with its own paint (see src/assets/icons/README.md).
   * Leave `false` (default) for the outline icons that inherit text colour.
   */
  fullColor?: boolean
}

/**
 * A reusable Icon component that references symbols in public/icons.svg
 *
 * Usage:
 * <Icon id="rect" className="my-custom-icon" />          // monochrome outline
 * <Icon id="logo" fullColor />                           // keeps its own colours
 *
 * By default the outer <svg> forces `fill="none" stroke="currentColor"` so
 * monochrome symbols inherit the surrounding text colour. With `fullColor`
 * those defaults are dropped, letting per-element fills/strokes in the source
 * SVG control the rendering. Symbol elements that set their own paint already
 * override the defaults, but `fullColor` also frees an icon from the forced
 * 1.5px stroke when it wants none.
 */
export function Icon({ id, className, size = 24, fullColor = false }: IconProps) {
  return (
    <svg
      className={`icon-sprite ${fullColor ? 'icon-sprite--full-color ' : ''}${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      // currentColor allows monochrome icons to inherit color from their parent
      // text/button; fullColor icons opt out so their own paint survives.
      fill={fullColor ? undefined : 'none'}
      stroke={fullColor ? undefined : 'currentColor'}
      strokeWidth={fullColor ? undefined : 1.5}
      strokeLinecap={fullColor ? undefined : 'round'}
      strokeLinejoin={fullColor ? undefined : 'round'}
    >
      <use href={`${import.meta.env.BASE_URL}icons.svg#${id}`} />
    </svg>
  )
}
