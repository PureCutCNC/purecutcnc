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
 * The Polygon and Square-to-round dialogs for the Around face (issue #1016
 * C2-U2). One component, a discriminated form: the two shapes take the same
 * start/length/tool spine and differ in the size fields that define the solid.
 *
 * The fields are measured the way a turner measures them — from the **chuck
 * end** of the bar, along the bar, in project units — and mapped here into the
 * absolute ascending stock-space endpoints the frozen `addRotarySolid` contract
 * takes. That map is the one place a Y-axis sign can go wrong, so it is a pure
 * function with its own branch: for a bar along X the chuck end is `minX`, for a
 * bar along Y it is `maxY`, and offsets run away from it along the bar.
 *
 * Nothing is persisted: the numbers live in this component and disappear with
 * it. Create calls `addRotarySolid` once, which writes an ordinary model plus
 * its rotary rough and finish operations in one history step; a refusal is shown
 * in the same place and creates nothing. Validation is local so Create can be
 * disabled with an explanation before the store is asked, while the store stays
 * the authority on every rule.
 *
 * A polygon's default across-flats is 0.75 × the bar diameter and its inline
 * ceiling is the bar's own across-corners limit: `acrossFlats <= diameter ×
 * cos(π / sides)`. A square-to-round finished diameter defaults to the blank
 * side and cannot exceed it.
 */

import { useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '../../../store/projectStore'
import type { RotarySolidInput, RotarySolidRefusal } from '../../../store/helpers/rotarySolids'
import { getStockBounds, isRoundStock } from '../../../types/project'
import { isBarStock, isSquareStock } from '../../../types/barStock'
import { isToolCompatibleWithOperation } from '../../../toolPolicy'
import { useRestoreCanvasFocus } from '../../../utils/useRestoreCanvasFocus'
import { convertLength, formatLength } from '../../../utils/units'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { Select } from '../../Select'

export type RotarySolidKind = 'polygon' | 'square-to-round'

/** UI bounds for the polygon side count, matching `buildRotaryPolygonPrism`. */
const MIN_POLYGON_SIDES = 3
const MAX_POLYGON_SIDES = 64

/**
 * Numeric slack when the user types the bar's own length: a typed value that
 * round-trips through the field may sit a few ulps past the bound.
 */
const RANGE_SLACK = 1e-6

/**
 * Every refusal has human text. Field-level refusals reuse the message the
 * field itself shows, so one problem never reads two different ways.
 */
const REFUSAL_KEYS: Record<RotarySolidRefusal, MessageKey> = {
  notRotaryProject: 'dialogs.rotarySolid.refusal.notRotaryProject',
  notAroundFace: 'dialogs.rotarySolid.refusal.notAroundFace',
  setupAxisMismatch: 'dialogs.rotarySolid.refusal.setupAxisMismatch',
  needsRoundBar: 'dialogs.rotarySolid.refusal.needsRoundBar',
  needsSquareBar: 'dialogs.rotarySolid.refusal.needsSquareBar',
  invalidAlongRange: 'dialogs.rotarySolid.error.range',
  invalidSides: 'dialogs.rotarySolid.error.sides',
  invalidAcrossFlats: 'dialogs.rotarySolid.error.acrossFlats',
  invalidRotation: 'dialogs.rotarySolid.error.rotation',
  invalidDiameter: 'dialogs.rotarySolid.error.diameter',
  diameterExceedsBlank: 'dialogs.rotarySolid.error.diameterExceedsBlank',
  polygonExceedsBar: 'dialogs.rotarySolid.refusal.polygonExceedsBar',
  toolNotFound: 'dialogs.rotarySolid.refusal.toolNotFound',
  toolIncompatible: 'dialogs.rotarySolid.refusal.toolIncompatible',
  invalidTool: 'dialogs.rotarySolid.refusal.invalidTool',
  geometryNotRepresentable: 'dialogs.rotarySolid.refusal.geometryNotRepresentable',
  targetNotAllowed: 'dialogs.rotarySolid.refusal.targetNotAllowed',
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value)
}

/** A number that round-trips through the field without scientific notation. */
function tidy(value: number): string {
  return String(Number(value.toFixed(4)))
}

/**
 * The absolute ascending stock-space endpoints for a start offset and length
 * measured from the bar's **chuck end**. For a bar along X the chuck end is
 * `minX`; for a bar along Y it is `maxY` (the same start end `resizeRoundStock`
 * and `resizeSquareStock` keep). This is the one place a Y sign mistake would
 * silently mirror the band, and the browser spec pins both axes' emitted bounds.
 */
function alongEndpoints(
  axis: 'x' | 'y',
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  start: number,
  length: number,
): { alongStart: number; alongEnd: number } {
  return axis === 'x'
    ? { alongStart: bounds.minX + start, alongEnd: bounds.minX + start + length }
    : { alongStart: bounds.maxY - start - length, alongEnd: bounds.maxY - start }
}

interface RotarySolidDialogProps {
  kind: RotarySolidKind
  onClose: () => void
}

export function RotarySolidDialog({ kind, onClose }: RotarySolidDialogProps) {
  useRestoreCanvasFocus()
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const addRotarySolid = useProjectStore((state) => state.addRotarySolid)
  const units = project.meta.units
  const unitLabel = units === 'inch' ? 'in' : 'mm'
  const stock = project.stock
  const bounds = getStockBounds(stock)
  const axis = isBarStock(stock) ? stock.axis : 'x'
  const barLength = axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY
  const roundDiameter = isRoundStock(stock) ? stock.thickness : 0
  const blankSide = isSquareStock(stock) ? stock.thickness : 0

  const [start, setStart] = useState('0')
  const [length, setLength] = useState(tidy(barLength))
  const [sides, setSides] = useState('6')
  const [acrossFlats, setAcrossFlats] = useState(tidy(roundDiameter * 0.75))
  const [rotation, setRotation] = useState('0')
  const [finishedDiameter, setFinishedDiameter] = useState(tidy(blankSide))
  const [toolRef, setToolRef] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // The solid is machined by a rotary operation, so the picker offers exactly
  // the cutters that policy admits: flat and ball end mills in this project.
  const compatibleTools = useMemo(
    () => project.tools.filter((tool) => isToolCompatibleWithOperation(tool, 'rotary_rough')),
    [project.tools],
  )
  const selectedToolId = compatibleTools.some((tool) => tool.id === toolRef)
    ? toolRef
    : compatibleTools[0]?.id ?? ''

  /** The bar's across-corners ceiling for this side count, or Infinity. */
  const acrossFlatsCeiling = useMemo(() => {
    const sidesValue = parseNumber(sides)
    if (!Number.isInteger(sidesValue) || sidesValue < MIN_POLYGON_SIDES || sidesValue > MAX_POLYGON_SIDES) {
      return Number.POSITIVE_INFINITY
    }
    return roundDiameter * Math.cos(Math.PI / sidesValue)
  }, [roundDiameter, sides])

  function sharedProblem(): string | null {
    if (!isBarStock(stock)) {
      return t(kind === 'polygon'
        ? 'dialogs.rotarySolid.refusal.needsRoundBar'
        : 'dialogs.rotarySolid.refusal.needsSquareBar')
    }
    const startValue = parseNumber(start)
    if (!Number.isFinite(startValue) || startValue < 0) return t('dialogs.rotarySolid.error.start')
    const lengthValue = parseNumber(length)
    if (!Number.isFinite(lengthValue) || lengthValue <= 0) return t('dialogs.rotarySolid.error.length')
    if (startValue + lengthValue > barLength + RANGE_SLACK) {
      return t('dialogs.rotarySolid.error.range', { length: formatLength(barLength, units) })
    }
    if (!selectedToolId) return t('dialogs.rotarySolid.error.noTool')
    return null
  }

  function polygonProblem(): string | null {
    const shared = sharedProblem()
    if (shared !== null) return shared
    const sidesValue = parseNumber(sides)
    if (!Number.isInteger(sidesValue) || sidesValue < MIN_POLYGON_SIDES || sidesValue > MAX_POLYGON_SIDES) {
      return t('dialogs.rotarySolid.error.sides', { min: MIN_POLYGON_SIDES, max: MAX_POLYGON_SIDES })
    }
    const acrossFlatsValue = parseNumber(acrossFlats)
    if (!Number.isFinite(acrossFlatsValue) || acrossFlatsValue <= 0) {
      return t('dialogs.rotarySolid.error.acrossFlats')
    }
    if (acrossFlatsValue > acrossFlatsCeiling + RANGE_SLACK) {
      return t('dialogs.rotarySolid.error.acrossFlatsBound', {
        max: formatLength(acrossFlatsCeiling, units),
      })
    }
    if (!Number.isFinite(parseNumber(rotation))) {
      return t('dialogs.rotarySolid.error.rotation')
    }
    return null
  }

  function squareProblem(): string | null {
    const shared = sharedProblem()
    if (shared !== null) return shared
    const diameterValue = parseNumber(finishedDiameter)
    if (!Number.isFinite(diameterValue) || diameterValue <= 0) {
      return t('dialogs.rotarySolid.error.diameter')
    }
    if (diameterValue > blankSide + RANGE_SLACK) {
      return t('dialogs.rotarySolid.error.diameterExceedsBlank', { side: formatLength(blankSide, units) })
    }
    return null
  }

  const problem = kind === 'polygon' ? polygonProblem() : squareProblem()

  function buildInput(): RotarySolidInput {
    const startValue = parseNumber(start)
    const lengthValue = parseNumber(length)
    const { alongStart, alongEnd } = alongEndpoints(axis, bounds, startValue, lengthValue)
    if (kind === 'polygon') {
      return {
        kind: 'polygon',
        sides: parseNumber(sides),
        acrossFlats: parseNumber(acrossFlats),
        rotationDeg: parseNumber(rotation),
        alongStart,
        alongEnd,
        toolRef: selectedToolId,
      }
    }
    return {
      kind: 'square-to-round',
      diameter: parseNumber(finishedDiameter),
      alongStart,
      alongEnd,
      toolRef: selectedToolId,
    }
  }

  function handleCreate() {
    if (problem !== null) return
    const result = addRotarySolid(buildInput())
    if (result.ok) {
      onClose()
      return
    }
    // The store is the authority; a typed refusal is mapped to real text here.
    const key = REFUSAL_KEYS[result.reason]
    setRefusal(t(key, {
      min: MIN_POLYGON_SIDES,
      max: MAX_POLYGON_SIDES,
      side: formatLength(blankSide, units),
      length: formatLength(barLength, units),
    }))
  }

  const titleKey: MessageKey = kind === 'polygon'
    ? 'dialogs.rotarySolid.polygon.title'
    : 'dialogs.rotarySolid.squareToRound.title'

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--import dialog--rotary rotary-solid-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rotary-solid-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="rotary-solid-dialog-title">{t(titleKey)}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={t('dialogs.common.close')} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--import">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="rotary-solid-start">
                {t('dialogs.rotarySolid.start', { units: unitLabel })}
              </label>
              <div className="properties-field">
                <input
                  id="rotary-solid-start"
                  type="number"
                  min="0"
                  step="any"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="rotary-solid-length">
                {t('dialogs.rotarySolid.length', { units: unitLabel })}
              </label>
              <div className="properties-field">
                <input
                  id="rotary-solid-length"
                  type="number"
                  min="0"
                  step="any"
                  value={length}
                  onChange={(event) => setLength(event.target.value)}
                />
              </div>
            </div>

            {kind === 'polygon' ? (
              <>
                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-solid-sides">
                    {t('dialogs.rotarySolid.sides')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-solid-sides"
                      type="number"
                      min={MIN_POLYGON_SIDES}
                      max={MAX_POLYGON_SIDES}
                      step="1"
                      value={sides}
                      onChange={(event) => setSides(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-solid-across-flats">
                    {t('dialogs.rotarySolid.acrossFlats', { units: unitLabel })}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-solid-across-flats"
                      type="number"
                      min="0"
                      step="any"
                      value={acrossFlats}
                      onChange={(event) => setAcrossFlats(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-solid-rotation">
                    {t('dialogs.rotarySolid.rotation')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-solid-rotation"
                      type="number"
                      step="any"
                      value={rotation}
                      onChange={(event) => setRotation(event.target.value)}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="dialog-section-group">
                <label className="dialog-section-title" htmlFor="rotary-solid-diameter">
                  {t('dialogs.rotarySolid.diameter', { units: unitLabel })}
                </label>
                <div className="properties-field">
                  <input
                    id="rotary-solid-diameter"
                    type="number"
                    min="0"
                    step="any"
                    value={finishedDiameter}
                    onChange={(event) => setFinishedDiameter(event.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="dialog-section-group rotary-dialog__tool">
              <label className="dialog-section-title">
                {t('dialogs.rotarySolid.tool')}
              </label>
              <div className="properties-field">
                <Select
                  value={selectedToolId}
                  options={compatibleTools.map((tool) => ({
                    value: tool.id,
                    label: tool.name,
                    // The physical size, converted out of the tool's own units so
                    // a mixed-unit project never compares raw numbers.
                    detail: `Ø${formatLength(convertLength(tool.diameter, tool.units, units), units)} ${unitLabel}`,
                  }))}
                  onChange={(value) => setToolRef(value)}
                />
              </div>
            </div>

            <p className="rotary-dialog__note">{t('dialogs.rotarySolid.note')}</p>

            {problem !== null ? (
              <div className="cam-field-message rotary-dialog__error" role="alert">{problem}</div>
            ) : null}
            {refusal !== null ? (
              <div className="cam-field-message rotary-dialog__error" role="alert">{refusal}</div>
            ) : null}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="feat-btn" type="button" onClick={onClose}>
            {t('dialogs.common.cancel')}
          </button>
          <button
            className="feat-btn feat-btn--primary rotary-dialog__create"
            type="button"
            disabled={problem !== null}
            onClick={handleCreate}
          >
            {t('dialogs.rotarySolid.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
