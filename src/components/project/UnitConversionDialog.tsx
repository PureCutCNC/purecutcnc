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

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '../../types/project'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'

interface UnitConversionDialogProps {
  fromUnits: Project['meta']['units']
  toUnits: Project['meta']['units']
  onConvert: () => void
  onReinterpret: () => void
  onCancel: () => void
}

function shortUnitLabel(units: Project['meta']['units']): string {
  return units === 'inch' ? 'in' : 'mm'
}

function unitName(units: Project['meta']['units']): string {
  return units === 'inch' ? 'inches' : 'millimeters'
}

export function UnitConversionDialog({
  fromUnits,
  toUnits,
  onConvert,
  onReinterpret,
  onCancel,
}: UnitConversionDialogProps) {
  useRestoreCanvasFocus()

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const fromShort = shortUnitLabel(fromUnits)
  const toShort = shortUnitLabel(toUnits)
  const conversionExample = fromUnits === 'inch'
    ? '1 in becomes 25.4 mm'
    : '25.4 mm becomes 1 in'
  const reinterpretExample = fromUnits === 'inch'
    ? '1 in becomes 1 mm'
    : '1 mm becomes 1 in'

  return createPortal(
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog dialog--unit-conversion"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unit-conversion-title"
        aria-describedby="unit-conversion-description"
      >
        <div className="dialog-header">
          <div>
            <span className="unit-conversion-eyebrow">Project scale</span>
            <h2 className="dialog-title" id="unit-conversion-title">Change project units?</h2>
          </div>
          <button className="dialog-close" onClick={onCancel} aria-label="Close" type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body dialog-body--unit-conversion">
          <div className="unit-conversion-route" aria-label={`Changing from ${unitName(fromUnits)} to ${unitName(toUnits)}`}>
            <span>{fromShort}</span>
            <span className="unit-conversion-route__line" aria-hidden="true" />
            <span>{toShort}</span>
          </div>

          <p id="unit-conversion-description" className="unit-conversion-intro">
            Choose whether the existing measurements should keep their physical size or keep
            their written numbers.
          </p>

          <div className="unit-conversion-options">
            <button
              className="unit-conversion-option unit-conversion-option--recommended"
              type="button"
              onClick={onConvert}
              autoFocus
            >
              <span className="unit-conversion-option__heading">
                <strong>Convert values</strong>
                <span className="unit-conversion-option__badge">Recommended</span>
              </span>
              <span>Preserves the physical size of the design, stock, dimensions, and machining values.</span>
              <code>{conversionExample}</code>
            </button>

            <button
              className="unit-conversion-option unit-conversion-option--reinterpret"
              type="button"
              onClick={onReinterpret}
            >
              <span className="unit-conversion-option__heading">
                <strong>Keep numeric values</strong>
              </span>
              <span>Reinterprets every number in the new units, changing the project's physical scale.</span>
              <code>{reinterpretExample}</code>
            </button>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
