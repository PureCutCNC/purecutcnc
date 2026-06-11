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

import { useState } from 'react'
import type { ToolpathVisibility } from './toolpathVisibility'

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
  const [expanded, setExpanded] = useState(true)

  return (
    <div className={`viewport-toolpath-vis${expanded ? ' viewport-toolpath-vis--expanded' : ''}${className ? ` ${className}` : ''}`}>
      <button
        className="viewport-toolpath-vis__label"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        Show
      </button>
      {expanded ? (
        ITEMS.map(({ key, label, swatch }) => {
          const selected = visibility[key]
          return (
            <button
              key={key}
              className={`viewport-toolpath-vis__item ${selected ? 'viewport-toolpath-vis__item--selected' : ''}`}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange({ ...visibility, [key]: !selected })}
            >
              <span className={`viewport-toolpath-vis__swatch ${swatch}`} />
              {label}
            </button>
          )
        })
      ) : null}
    </div>
  )
}
