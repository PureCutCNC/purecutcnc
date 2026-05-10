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

export interface ToolpathVisibility {
  cuts: boolean
  rapids: boolean
  plunges: boolean
  retractions: boolean
  directions: boolean
}

export const DEFAULT_TOOLPATH_VISIBILITY: ToolpathVisibility = {
  cuts: true,
  rapids: true,
  plunges: true,
  retractions: true,
  directions: true,
}

interface ToolpathVisibilityPanelProps {
  visibility: ToolpathVisibility
  onChange: (visibility: ToolpathVisibility) => void
  className?: string
}

const ITEMS: Array<{ key: keyof ToolpathVisibility; label: string; swatch: string }> = [
  { key: 'cuts', label: 'Cuts', swatch: 'viewport-toolpath-vis__swatch--cuts' },
  { key: 'rapids', label: 'Rapids', swatch: 'viewport-toolpath-vis__swatch--rapids' },
  { key: 'plunges', label: 'Plunges', swatch: 'viewport-toolpath-vis__swatch--plunges' },
  { key: 'retractions', label: 'Retractions', swatch: 'viewport-toolpath-vis__swatch--retractions' },
  { key: 'directions', label: 'Directions', swatch: 'viewport-toolpath-vis__swatch--directions' },
]

export function ToolpathVisibilityPanel({ visibility, onChange, className }: ToolpathVisibilityPanelProps) {
  return (
    <div className={`viewport-toolpath-vis${className ? ` ${className}` : ''}`}>
      <div className="viewport-toolpath-vis__label">Show</div>
      {ITEMS.map(({ key, label, swatch }) => (
        <label key={key} className="viewport-toolpath-vis__item">
          <input
            type="checkbox"
            checked={visibility[key]}
            onChange={() => onChange({ ...visibility, [key]: !visibility[key] })}
          />
          <span className={`viewport-toolpath-vis__swatch ${swatch}`} />
          {label}
        </label>
      ))}
    </div>
  )
}
