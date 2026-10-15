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
 * The Thread and Flutes dialogs for the Around face (issue #1016 C1 slice B).
 *
 * Both collect the numbers the frozen `rotaryPatterns` helper takes and call
 * `addRotaryPattern` once. Nothing here is persisted: the dialog's fields
 * disappear with it, and the store writes ordinary lines, a folder and an
 * Engrave operation (plus a bundled V-bit for a thread when the project has
 * none). Lengths are project units; the inch thread field is threads per inch
 * and is converted to a physical pitch here, before the store call.
 *
 * Validation is local so Create can be disabled with an explanation before the
 * store is asked; a store refusal (a race, a tool policy change) is shown in
 * the same place and creates nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../../../store/projectStore'
import {
  THREAD_DEPTH_PER_PITCH,
  rotaryPatternFrame,
  type RotaryPatternInput,
  type RotaryPatternRefusal,
} from '../../../store/helpers/rotaryPatterns'
import { getStockBounds } from '../../../types/project'
import { isToolCompatibleWithOperation } from '../../../toolPolicy'
import { loadBundledToolLibrary, type ToolLibraryEntry } from '../../../toolLibrary'
import { useRestoreCanvasFocus } from '../../../utils/useRestoreCanvasFocus'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { Select } from '../../Select'

export type RotaryPatternKind = 'thread' | 'flutes'

/** UI caps, so a typo cannot ask the store for hundreds of lines. */
const MAX_THREAD_STARTS = 32
const MAX_FLUTE_COUNT = 64
const MM_DEFAULT_PITCH = 1.5
const INCH_DEFAULT_TPI = 20

/**
 * Every refusal has human text. A field-level refusal reuses the message the
 * field itself shows, so the same problem never reads two different ways.
 */
const REFUSAL_KEYS: Record<RotaryPatternRefusal, MessageKey> = {
  aroundUnavailable: 'dialogs.rotary.error.around',
  aroundNotActive: 'dialogs.rotary.refusal.aroundNotActive',
  invalidStart: 'dialogs.rotary.error.start',
  invalidLength: 'dialogs.rotary.error.length',
  invalidDepth: 'dialogs.rotary.error.depth',
  invalidPitch: 'dialogs.rotary.error.pitch',
  invalidStarts: 'dialogs.rotary.error.starts',
  invalidCount: 'dialogs.rotary.error.count',
  invalidTwist: 'dialogs.rotary.error.twist',
  depthReachesCentreline: 'dialogs.rotary.error.depthCentreline',
  noVBitTool: 'dialogs.rotary.refusal.noVBitTool',
  toolNotFound: 'dialogs.rotary.refusal.toolNotFound',
  toolIncompatible: 'dialogs.rotary.refusal.toolIncompatible',
  targetNotAllowed: 'dialogs.rotary.refusal.targetNotAllowed',
}

/** The second sentence an `aroundUnavailable` refusal adds, naming the cause. */
const AROUND_DETAIL_KEYS: Record<string, MessageKey> = {
  needsRotaryProject: 'dialogs.rotary.around.needsRotaryProject',
  needsRoundBar: 'dialogs.rotary.around.needsRoundBar',
  needsRotaryMachine: 'dialogs.rotary.around.needsRotaryMachine',
  machineAxisMismatch: 'dialogs.rotary.around.machineAxisMismatch',
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value)
}

/** A number that round-trips through the field without scientific notation. */
function tidy(value: number): string {
  return String(Number(value.toFixed(4)))
}

interface RotaryPatternDialogProps {
  kind: RotaryPatternKind
  onClose: () => void
}

export function RotaryPatternDialog({ kind, onClose }: RotaryPatternDialogProps) {
  useRestoreCanvasFocus()
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const addRotaryPattern = useProjectStore((state) => state.addRotaryPattern)
  const units = project.meta.units
  const unitLabel = units === 'inch' ? 'in' : 'mm'
  const frame = rotaryPatternFrame(project)
  const radius = frame?.radius ?? 0

  const bounds = getStockBounds(project.stock)
  const barLength = frame ? (frame.axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY) : 0

  const [start, setStart] = useState('0')
  const [length, setLength] = useState(tidy(barLength))
  const [pitchText, setPitchText] = useState(
    units === 'inch' ? String(INCH_DEFAULT_TPI) : String(MM_DEFAULT_PITCH),
  )
  const [starts, setStarts] = useState('1')
  const [depth, setDepth] = useState(tidy(
    kind === 'thread'
      ? THREAD_DEPTH_PER_PITCH * (units === 'inch' ? 1 / INCH_DEFAULT_TPI : MM_DEFAULT_PITCH)
      : radius / 4 || THREAD_DEPTH_PER_PITCH,
  ))
  // Once the user edits the depth, the pitch default no longer owns it.
  const [depthEdited, setDepthEdited] = useState(false)
  const [count, setCount] = useState('4')
  const [twist, setTwist] = useState('0')
  const [toolRef, setToolRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  // A catalog load can outlive the dialog; a closed dialog must create nothing.
  const activeRef = useRef(true)

  useEffect(() => () => {
    activeRef.current = false
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const compatibleTools = useMemo(
    () => project.tools.filter((tool) => isToolCompatibleWithOperation(tool, 'follow_line')),
    [project.tools],
  )
  // The user's explicit pick survives a re-render; it only falls back when the
  // chosen tool is gone from the project.
  const selectedToolId = compatibleTools.some((tool) => tool.id === toolRef)
    ? toolRef
    : compatibleTools[0]?.id ?? ''

  function handlePitchChange(value: string) {
    setPitchText(value)
    if (depthEdited) return
    const physicalPitch = units === 'inch' ? 1 / parseNumber(value) : parseNumber(value)
    if (Number.isFinite(physicalPitch) && physicalPitch > 0) {
      setDepth(tidy(THREAD_DEPTH_PER_PITCH * physicalPitch))
    }
  }

  function threadProblem(): string | null {
    if (!frame) return t('dialogs.rotary.error.around')
    if (!Number.isFinite(parseNumber(start))) return t('dialogs.rotary.error.start')
    const lengthValue = parseNumber(length)
    if (!Number.isFinite(lengthValue) || lengthValue <= 0) return t('dialogs.rotary.error.length')
    const rawPitch = parseNumber(pitchText)
    if (!Number.isFinite(rawPitch) || rawPitch <= 0) {
      return units === 'inch' ? t('dialogs.rotary.error.tpi') : t('dialogs.rotary.error.pitch')
    }
    const startsValue = parseNumber(starts)
    if (!Number.isInteger(startsValue) || startsValue < 1 || startsValue > MAX_THREAD_STARTS) {
      return t('dialogs.rotary.error.starts', { max: MAX_THREAD_STARTS })
    }
    const depthValue = parseNumber(depth)
    if (!Number.isFinite(depthValue) || depthValue <= 0) return t('dialogs.rotary.error.depth')
    if (radius > 0 && depthValue >= radius) return t('dialogs.rotary.error.depthCentreline')
    return null
  }

  function flutesProblem(): string | null {
    if (!frame) return t('dialogs.rotary.error.around')
    if (!Number.isFinite(parseNumber(start))) return t('dialogs.rotary.error.start')
    const lengthValue = parseNumber(length)
    if (!Number.isFinite(lengthValue) || lengthValue <= 0) return t('dialogs.rotary.error.length')
    const countValue = parseNumber(count)
    if (!Number.isInteger(countValue) || countValue < 1 || countValue > MAX_FLUTE_COUNT) {
      return t('dialogs.rotary.error.count', { max: MAX_FLUTE_COUNT })
    }
    if (!Number.isFinite(parseNumber(twist))) return t('dialogs.rotary.error.twist')
    const depthValue = parseNumber(depth)
    if (!Number.isFinite(depthValue) || depthValue <= 0) return t('dialogs.rotary.error.depth')
    if (radius > 0 && depthValue >= radius) return t('dialogs.rotary.error.depthCentreline')
    if (!selectedToolId) return t('dialogs.rotary.error.noTool')
    return null
  }

  const problem = kind === 'thread' ? threadProblem() : flutesProblem()

  function buildInput(): RotaryPatternInput {
    const depthValue = parseNumber(depth)
    if (kind === 'thread') {
      const rawPitch = parseNumber(pitchText)
      return {
        kind: 'thread',
        start: parseNumber(start),
        length: parseNumber(length),
        pitch: units === 'inch' ? 1 / rawPitch : rawPitch,
        starts: parseNumber(starts),
        depth: depthValue,
      }
    }
    return {
      kind: 'flutes',
      start: parseNumber(start),
      length: parseNumber(length),
      count: parseNumber(count),
      twist: parseNumber(twist),
      depth: depthValue,
      toolRef: selectedToolId,
    }
  }

  async function handleCreate() {
    if (busy || problem !== null) return
    const input = buildInput()
    setBusy(true)
    setRefusal(null)
    try {
      let libraryTools: ToolLibraryEntry[] = []
      if (kind === 'thread') {
        try {
          libraryTools = (await loadBundledToolLibrary()).tools
        } catch {
          libraryTools = []
        }
      }
      if (!activeRef.current) return
      const result = addRotaryPattern(input, kind === 'thread' ? libraryTools : undefined)
      if (result.ok) {
        onClose()
        return
      }
      const base = t(REFUSAL_KEYS[result.reason], {
        max: result.reason === 'invalidStarts' ? MAX_THREAD_STARTS : MAX_FLUTE_COUNT,
      })
      const detailKey = result.reason === 'aroundUnavailable' && result.detail
        ? AROUND_DETAIL_KEYS[result.detail]
        : undefined
      setRefusal(detailKey ? `${base} ${t(detailKey)}` : base)
    } finally {
      if (activeRef.current) setBusy(false)
    }
  }

  const titleKey: MessageKey = kind === 'thread'
    ? 'dialogs.rotary.thread.title'
    : 'dialogs.rotary.flutes.title'

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--import dialog--no-clip dialog--rotary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rotary-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="rotary-dialog-title">{t(titleKey)}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={t('dialogs.common.close')} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--import">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="rotary-start">
                {t('dialogs.rotary.start', { units: unitLabel })}
              </label>
              <div className="properties-field">
                <input
                  id="rotary-start"
                  type="number"
                  step="any"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="rotary-length">
                {t('dialogs.rotary.length', { units: unitLabel })}
              </label>
              <div className="properties-field">
                <input
                  id="rotary-length"
                  type="number"
                  min="0"
                  step="any"
                  value={length}
                  onChange={(event) => setLength(event.target.value)}
                />
              </div>
            </div>

            {kind === 'thread' ? (
              <>
                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-pitch">
                    {units === 'inch' ? t('dialogs.rotary.thread.tpi') : t('dialogs.rotary.thread.pitch', { units: unitLabel })}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-pitch"
                      type="number"
                      min="0"
                      step="any"
                      value={pitchText}
                      onChange={(event) => handlePitchChange(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-starts">
                    {t('dialogs.rotary.thread.starts')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-starts"
                      type="number"
                      min="1"
                      max={MAX_THREAD_STARTS}
                      step="1"
                      value={starts}
                      onChange={(event) => setStarts(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-depth">
                    {t('dialogs.rotary.depth', { units: unitLabel })}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-depth"
                      type="number"
                      min="0"
                      step="any"
                      value={depth}
                      onChange={(event) => {
                        setDepthEdited(true)
                        setDepth(event.target.value)
                      }}
                    />
                  </div>
                </div>

                <p className="rotary-dialog__note">{t('dialogs.rotary.thread.note')}</p>
              </>
            ) : (
              <>
                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-count">
                    {t('dialogs.rotary.flutes.count')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-count"
                      type="number"
                      min="1"
                      max={MAX_FLUTE_COUNT}
                      step="1"
                      value={count}
                      onChange={(event) => setCount(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-twist">
                    {t('dialogs.rotary.flutes.twist')}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-twist"
                      type="number"
                      step="any"
                      value={twist}
                      onChange={(event) => setTwist(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title" htmlFor="rotary-depth">
                    {t('dialogs.rotary.depth', { units: unitLabel })}
                  </label>
                  <div className="properties-field">
                    <input
                      id="rotary-depth"
                      type="number"
                      min="0"
                      step="any"
                      value={depth}
                      onChange={(event) => setDepth(event.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-section-group">
                  <label className="dialog-section-title">
                    {t('dialogs.rotary.flutes.tool')}
                  </label>
                  <div className="properties-field">
                    <Select
                      value={selectedToolId}
                      options={compatibleTools.map((tool) => ({ value: tool.id, label: tool.name }))}
                      onChange={(value) => setToolRef(value)}
                    />
                  </div>
                </div>
              </>
            )}

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
            disabled={problem !== null || busy}
            onClick={() => { void handleCreate() }}
          >
            {busy ? t('dialogs.rotary.creating') : t('dialogs.rotary.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
