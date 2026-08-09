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

import { useRef, useState, useMemo, useEffect } from 'react'
import { formatLength, parseLengthInput } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import { constrainZ, zHandleAriaBounds } from './mixedValue'

// Fraction of track height reserved as visual margin at each end.
const EDGE_MARGIN = 0.08

function zToPercent(z: number, domainMin: number, domainMax: number): number {
  const range = domainMax - domainMin
  if (range <= 0) return 50
  const usable = 1 - 2 * EDGE_MARGIN
  const fraction = 1 - Math.max(0, Math.min(range, z - domainMin)) / range
  return (EDGE_MARGIN + fraction * usable) * 100
}

function percentToZ(percent: number, domainMin: number, domainMax: number): number {
  const range = domainMax - domainMin
  if (range <= 0) return domainMin
  const usable = 1 - 2 * EDGE_MARGIN
  const fraction = (percent / 100 - EDGE_MARGIN) / usable
  return domainMax - range * Math.max(0, Math.min(1, fraction))
}

export interface ZRangeSliderProps {
  /** When this changes the component remounts, resetting all internal state. */
  selectionKey: string
  /** Current top value. `null` means mixed / not applicable — field shows placeholder. */
  zTop: number | null
  /** Current bottom value. `null` means mixed / not applicable — field shows placeholder. */
  zBottom: number | null
  /** Minimum domain value (default 0). */
  domainMin?: number
  /** Maximum domain value. Must be >= the largest displayed value. */
  domainMax: number
  units: 'mm' | 'inch'
  /** When true the top handle is locked — only the field is editable. */
  topLocked?: boolean
  /** When true the bottom handle is locked — only the field is editable. */
  bottomLocked?: boolean
  mixedPlaceholder?: string
  /** Called once per user gesture with the changed fields.
   *  Return `false` to signal rejection — the slider will restore its display. */
  onCommit: (patch: { top?: number; bottom?: number }) => boolean
}

type ZRangeSliderInnerProps = Omit<ZRangeSliderProps, 'selectionKey'>

/**
 * Thin wrapper that remounts the inner slider whenever `selectionKey` changes,
 * resetting all internal drag state, draft input state, and listener refs.
 */
export function ZRangeSlider({ selectionKey, ...innerProps }: ZRangeSliderProps) {
  return <ZRangeSliderInner key={selectionKey} {...innerProps} />
}

function ZRangeSliderInner({
  zTop,
  zBottom,
  domainMin = 0,
  domainMax,
  units,
  topLocked = false,
  bottomLocked = false,
  mixedPlaceholder,
  onCommit,
}: ZRangeSliderInnerProps) {
  const { t } = useI18n()
  const trackRef = useRef<HTMLDivElement>(null)
  const topInputRef = useRef<HTMLInputElement>(null)
  const botInputRef = useRef<HTMLInputElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  // Non-null = actively dragging; null = use prop values for display.
  const [dragTop, setDragTop] = useState<number | null>(null)
  const [dragBot, setDragBot] = useState<number | null>(null)

  // Distinct display fallbacks so mixed handles are independently reachable:
  // unknown top → domainMax, unknown bottom → domainMin.
  // Neither fallback acts as a real opposite constraint (drag uses null opposite).
  const effectiveTop = dragTop ?? zTop ?? domainMax
  const effectiveBot = dragBot ?? zBottom ?? domainMin
  const topPercent = zToPercent(effectiveTop, domainMin, domainMax)
  const botPercent = zToPercent(effectiveBot, domainMin, domainMax)

  const topAria = useMemo(
    () => zHandleAriaBounds(true, domainMin, domainMax, zBottom),
    [domainMin, domainMax, zBottom],
  )
  const botAria = useMemo(
    () => zHandleAriaBounds(false, domainMin, domainMax, zTop),
    [domainMin, domainMax, zTop],
  )

  // Sync input fields from props so Undo/Redo and external store changes
  // refresh the displayed values without requiring a remount.
  useEffect(() => {
    if (topInputRef.current) {
      topInputRef.current.value = zTop !== null ? formatLength(zTop, units) : ''
    }
    if (botInputRef.current) {
      botInputRef.current.value = zBottom !== null ? formatLength(zBottom, units) : ''
    }
  }, [zTop, zBottom, units])

  // Clean up active window listeners on unmount to prevent leaks.
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
      }
    }
  }, [])

  function handlePointerDown(handle: 'top' | 'bottom', event: React.PointerEvent) {
    event.preventDefault()
    event.stopPropagation()

    const pointerId = event.pointerId
    try {
      ;(event.currentTarget as Element).setPointerCapture(pointerId)
    } catch {
      // Fall through to window-level tracking.
    }

    // Mutable locals that track the live drag values.  Start from the
    // displayed position (falls back to domainMin only for display — the
    // constraint below uses the real committed values, not this fallback).
    let curTop = effectiveTop
    let curBot = effectiveBot

    function onMove(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const percent = ((e.clientY - rect.top) / rect.height) * 100
      const z = Math.round(percentToZ(percent, domainMin, domainMax) * 10000) / 10000

      if (handle === 'top') {
        // Constrain only against the ACTUAL committed zBottom (may be null
        // when mixed — then only domain bounds apply).  Never substitute
        // domainMin as a fabricated opposite constraint.
        curTop = constrainZ(z, true, domainMin, domainMax, zBottom)
      } else {
        // Constrain only against the ACTUAL committed zTop (may be null).
        curBot = constrainZ(z, false, domainMin, domainMax, zTop)
      }

      setDragTop(curTop)
      setDragBot(curBot)

      if (topInputRef.current) topInputRef.current.value = formatLength(curTop, units)
      if (botInputRef.current) botInputRef.current.value = formatLength(curBot, units)
    }

    function onUp(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      cleanup()

      // Commit only the handle whose value actually changed from its
      // display-fallback position (domainMax for unknown top, domainMin
      // for unknown bottom).  This keeps a no-drag click from triggering
      // a spurious commit when values are mixed.
      let accepted = true
      if (handle === 'top' && Math.abs(curTop - (zTop ?? domainMax)) > 1e-10) {
        accepted = onCommit({ top: curTop }) !== false
      } else if (handle === 'bottom' && Math.abs(curBot - (zBottom ?? domainMin)) > 1e-10) {
        accepted = onCommit({ bottom: curBot }) !== false
      }

      if (!accepted) {
        // Restore field display to committed values on rejection.
        if (topInputRef.current) topInputRef.current.value = zTop !== null ? formatLength(zTop, units) : ''
        if (botInputRef.current) botInputRef.current.value = zBottom !== null ? formatLength(zBottom, units) : ''
      }

      setDragTop(null)
      setDragBot(null)
    }

    function cleanup() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      cleanupRef.current = null
    }

    if (cleanupRef.current) cleanupRef.current()
    cleanupRef.current = cleanup

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function makeFieldHandlers(
    isTop: boolean,
    committedValue: number | null,
    otherCommittedValue: number | null,
  ) {
    function reset(el: HTMLInputElement) {
      el.value = committedValue !== null ? formatLength(committedValue, units) : ''
    }

    function commit(el: HTMLInputElement) {
      if (el.value.trim() === '') {
        reset(el)
        return
      }
      const next = parseLengthInput(el.value, units)
      if (next === null || !Number.isFinite(next) || next < domainMin) {
        reset(el)
        return
      }
      // Cross-handle constraint: only enforced when the other value is known.
      if (isTop && otherCommittedValue !== null && next < otherCommittedValue) {
        reset(el)
        return
      }
      if (!isTop && otherCommittedValue !== null && next > otherCommittedValue) {
        reset(el)
        return
      }
      if (committedValue === null || next !== committedValue) {
        const accepted = onCommit(isTop ? { top: next } : { bottom: next })
        if (!accepted) {
          reset(el)
        }
      } else {
        reset(el)
      }
    }

    return {
      onBlur: (e: React.FocusEvent<HTMLInputElement>) => commit(e.currentTarget),
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          reset(e.currentTarget)
          e.currentTarget.blur()
        }
      },
    }
  }

  const topHandlers = topLocked ? undefined : makeFieldHandlers(true, zTop, zBottom)
  const botHandlers = bottomLocked ? undefined : makeFieldHandlers(false, zBottom, zTop)

  const placeholder = mixedPlaceholder ?? '—'

  return (
    <div className="z-range-slider">
      <span className="z-range-slider__label z-range-slider__label--top">{t('featureTree.zRange.zTop')}</span>

      <div className="z-range-slider__track" ref={trackRef}>
        <div className="z-range-slider__track-line" />
        <div
          className="z-range-slider__filled"
          style={{ top: `${topPercent}%`, height: `${Math.max(0, botPercent - topPercent)}%` }}
        />
        {!topLocked ? (
          <div
            className="z-range-slider__handle"
            style={{ top: `${topPercent}%` }}
            onPointerDown={(e) => handlePointerDown('top', e)}
            role="slider"
            aria-label={t('featureTree.zRange.handleTopAria')}
            aria-valuemin={topAria.valuemin}
            aria-valuemax={topAria.valuemax}
            aria-valuenow={effectiveTop}
            tabIndex={0}
          />
        ) : null}
        {!bottomLocked ? (
          <div
            className="z-range-slider__handle"
            style={{ top: `${botPercent}%` }}
            onPointerDown={(e) => handlePointerDown('bottom', e)}
            role="slider"
            aria-label={t('featureTree.zRange.handleBottomAria')}
            aria-valuemin={botAria.valuemin}
            aria-valuemax={botAria.valuemax}
            aria-valuenow={effectiveBot}
            tabIndex={0}
          />
        ) : null}
      </div>

      <input
        ref={topInputRef}
        className="z-range-slider__field z-range-slider__field--top"
        type="text"
        inputMode="decimal"
        defaultValue={zTop !== null ? formatLength(zTop, units) : ''}
        placeholder={zTop === null ? placeholder : undefined}
        spellCheck={false}
        data-numeric-entry="true"
        disabled={topLocked}
        readOnly={topLocked}
        onBlur={topHandlers?.onBlur}
        onKeyDown={topHandlers?.onKeyDown}
      />

      <span className="z-range-slider__label z-range-slider__label--bot">{t('featureTree.zRange.zBottom')}</span>

      <input
        ref={botInputRef}
        className="z-range-slider__field z-range-slider__field--bot"
        type="text"
        inputMode="decimal"
        defaultValue={zBottom !== null ? formatLength(zBottom, units) : ''}
        placeholder={zBottom === null ? placeholder : undefined}
        spellCheck={false}
        data-numeric-entry="true"
        disabled={bottomLocked}
        readOnly={bottomLocked}
        onBlur={botHandlers?.onBlur}
        onKeyDown={botHandlers?.onKeyDown}
      />
    </div>
  )
}
