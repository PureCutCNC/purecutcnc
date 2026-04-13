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
}

/**
 * A reusable Icon component that references symbols in public/icons.svg
 * 
 * Usage:
 * <Icon id="rect" size={20} className="my-custom-icon" />
 */
export function Icon({ id, className, size = 18 }: IconProps) {
  return (
    <svg
      className={`icon-sprite ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      // currentColor allows the icon to inherit color from its parent text/button
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <use href={`${import.meta.env.BASE_URL}icons.svg#${id}`} />
    </svg>
  )
}
