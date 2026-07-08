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

import type { KeyboardEvent, ReactNode } from 'react'
import type { PendingAddTool } from '../../store/types'

type PendingNgon = Extract<PendingAddTool, { shape: 'ngon' }>
type PendingRectCorner = Extract<PendingAddTool, { shape: 'roundrect' | 'chamferrect' }>

interface NgonParameterPanelProps {
  pendingAdd: PendingNgon
  setPendingNgonSides: (sides: number) => void
}

interface RectCornerParameterPanelProps {
  pendingAdd: PendingRectCorner
  setPendingRectCorner: (corner: number) => void
}

interface CreationParameterFieldProps {
  children: ReactNode
  label: string
  reference: ReactNode
}

function stopPanelKey(event: KeyboardEvent<HTMLInputElement>): void {
  event.stopPropagation()
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function commitNumber(
  value: string,
  fallback: number,
  commit: (value: number) => void,
  normalize: (value: number, fallback: number) => number = (next) => next,
): string {
  const next = normalize(parseNumber(value, fallback), fallback)
  commit(next)
  return String(next)
}

function normalizeNgonSides(value: number): number {
  return Math.max(3, Math.min(50, Math.round(value)))
}

function normalizeCorner(value: number, fallback: number): number {
  return value < 0 ? fallback : value
}

function CreationParameterField({ children, label, reference }: CreationParameterFieldProps) {
  return (
    <label className="canvas-workflow-panel__field canvas-workflow-panel__field--reference">
      <span>{label}</span>
      {children}
      {reference}
    </label>
  )
}

function CreationReferenceFrame({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <svg
      className="canvas-workflow-panel__parameter-reference"
      viewBox="0 0 58 34"
      role="img"
      aria-label={label}
      focusable="false"
    >
      {children}
    </svg>
  )
}

function polygonPath(sides: number): string {
  const displaySides = Math.max(3, Math.min(16, sides))
  const points = Array.from({ length: displaySides }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / displaySides
    return `${(29 + Math.cos(angle) * 11).toFixed(2)} ${(17 + Math.sin(angle) * 11).toFixed(2)}`
  })
  return `M${points.join('L')}Z`
}

function NgonSidesReference({ sides }: { sides: number }) {
  return (
    <CreationReferenceFrame label="Polygon side count reference">
      <path className="gear-reference__guide" d="M29 5v24M16 17h26" />
      <path className="gear-reference__outline" d={polygonPath(sides)} />
      <path className="gear-reference__accent" d="M29 6L38.5 12.5" />
      <circle className="gear-reference__accent-fill" cx="29" cy="6" r="1.5" />
      <circle className="gear-reference__accent-fill" cx="38.5" cy="12.5" r="1.5" />
    </CreationReferenceFrame>
  )
}

function RectCornerReference({ kind }: { kind: PendingRectCorner['shape'] }) {
  if (kind === 'roundrect') {
    return (
      <CreationReferenceFrame label="Rounded rectangle corner radius reference">
        <path className="gear-reference__outline" d="M10 28V11Q10 6 15 6H48" />
        <path className="gear-reference__guide" d="M21 17L10 17M21 17V6" />
        <path className="gear-reference__accent" d="M10 17A11 11 0 0 1 21 6" />
        <circle className="gear-reference__accent-fill" cx="21" cy="17" r="1.5" />
      </CreationReferenceFrame>
    )
  }

  return (
    <CreationReferenceFrame label="Chamfered rectangle corner reference">
      <path className="gear-reference__outline" d="M10 28V16L20 6H48" />
      <path className="gear-reference__guide" d="M10 16H20V6" />
      <path className="gear-reference__accent" d="M10 16L20 6" />
      <path className="gear-reference__accent-fill" d="M10 16l4-1-3-3zM20 6l-4 1 3 3z" />
    </CreationReferenceFrame>
  )
}

export function NgonParameterPanel({ pendingAdd, setPendingNgonSides }: NgonParameterPanelProps) {
  return (
    <div className="canvas-workflow-panel__meta canvas-workflow-panel__parameter-fields">
      <CreationParameterField label="Sides (3-50)" reference={<NgonSidesReference sides={pendingAdd.sides} />}>
        <input
          key={pendingAdd.session}
          className="canvas-workflow-panel__count-input"
          type="text"
          inputMode="numeric"
          defaultValue={pendingAdd.sides}
          onBlur={(event) => {
            event.currentTarget.value = commitNumber(
              event.currentTarget.value,
              pendingAdd.sides,
              setPendingNgonSides,
              normalizeNgonSides,
            )
          }}
          onKeyDown={(event) => {
            stopPanelKey(event)
            if (event.key === 'Enter') {
              event.currentTarget.value = commitNumber(
                event.currentTarget.value,
                pendingAdd.sides,
                setPendingNgonSides,
                normalizeNgonSides,
              )
            }
          }}
        />
      </CreationParameterField>
    </div>
  )
}

export function RectCornerParameterPanel({ pendingAdd, setPendingRectCorner }: RectCornerParameterPanelProps) {
  return (
    <div className="canvas-workflow-panel__meta canvas-workflow-panel__parameter-fields">
      <CreationParameterField
        label={pendingAdd.shape === 'roundrect' ? 'Corner radius' : 'Chamfer'}
        reference={<RectCornerReference kind={pendingAdd.shape} />}
      >
        <input
          key={pendingAdd.session}
          className="canvas-workflow-panel__count-input"
          type="text"
          inputMode="decimal"
          defaultValue={pendingAdd.corner}
          onBlur={(event) => {
            event.currentTarget.value = commitNumber(
              event.currentTarget.value,
              pendingAdd.corner,
              setPendingRectCorner,
              normalizeCorner,
            )
          }}
          onKeyDown={(event) => {
            stopPanelKey(event)
            if (event.key === 'Enter') {
              event.currentTarget.value = commitNumber(
                event.currentTarget.value,
                pendingAdd.corner,
                setPendingRectCorner,
                normalizeCorner,
              )
            }
          }}
        />
      </CreationParameterField>
    </div>
  )
}
