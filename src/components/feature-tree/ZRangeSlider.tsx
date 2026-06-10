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

import { useRef, useState } from 'react'
import { formatLength, parseLengthInput } from '../../utils/units'

// Fraction of track height reserved as visual margin at each end, so handles
// sit a bit in from the edges even at min/max Z values.
const EDGE_MARGIN = 0.08

function zToPercent(z: number, stockThickness: number): number {
  const usable = 1 - 2 * EDGE_MARGIN
  const fraction = 1 - Math.max(0, Math.min(stockThickness, z)) / stockThickness
  return (EDGE_MARGIN + fraction * usable) * 100
}

function percentToZ(percent: number, stockThickness: number): number {
  const usable = 1 - 2 * EDGE_MARGIN
  const fraction = (percent / 100 - EDGE_MARGIN) / usable
  return stockThickness * (1 - Math.max(0, Math.min(1, fraction)))
}

interface ZRangeSliderProps {
  featureId: string
  zTop: number
  zBottom: number
  stockThickness: number
  units: 'mm' | 'inch'
  onCommitZTop: (value: number) => void
  onCommitZBottom: (value: number) => void
}

export function ZRangeSlider({
  featureId,
  zTop,
  zBottom,
  stockThickness,
  units,
  onCommitZTop,
  onCommitZBottom,
}: ZRangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const topInputRef = useRef<HTMLInputElement>(null)
  const botInputRef = useRef<HTMLInputElement>(null)
  // Holds the cleanup function for active window listeners so we can remove
  // them if the component unmounts mid-drag.
  const cleanupRef = useRef<(() => void) | null>(null)

  // null = not dragging (use prop values); non-null = active drag display values
  const [dragTop, setDragTop] = useState<number | null>(null)
  const [dragBot, setDragBot] = useState<number | null>(null)

  // During drag, use drag state; otherwise derive positions directly from props.
  const effectiveTop = dragTop ?? zTop
  const effectiveBot = dragBot ?? zBottom

  const topPercent = zToPercent(effectiveTop, stockThickness)
  const botPercent = zToPercent(effectiveBot, stockThickness)

  function handlePointerDown(handle: 'top' | 'bottom', event: React.PointerEvent) {
    event.preventDefault()
    event.stopPropagation()

    const pointerId = event.pointerId
    try {
      ;(event.currentTarget as Element).setPointerCapture(pointerId)
    } catch {
      // Fall back to window-level tracking below.
    }

    // Minimum Z separation between handles (sub-unit, just prevents exact overlap)
    const minSep = 1e-6
    // Mutable locals that track the live drag values in the closure.
    let curTop = effectiveTop
    let curBot = effectiveBot

    function onMove(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const percent = ((e.clientY - rect.top) / rect.height) * 100
      const z = Math.round(percentToZ(percent, stockThickness) * 10000) / 10000

      if (handle === 'top') {
        if (z <= curBot) {
          // Push bottom handle down with the top handle.
          curTop = Math.max(z, 0)
          curBot = Math.max(curTop - minSep, 0)
        } else {
          curTop = Math.min(z, stockThickness)
        }
      } else {
        if (z >= curTop) {
          // Push top handle up with the bottom handle.
          curBot = Math.min(z, stockThickness)
          curTop = Math.min(curBot + minSep, stockThickness)
        } else {
          curBot = Math.max(z, 0)
        }
      }

      setDragTop(curTop)
      setDragBot(curBot)

      // Direct DOM update so the field shows live value during drag without
      // going through the React render cycle.
      if (topInputRef.current) topInputRef.current.value = formatLength(curTop, units)
      if (botInputRef.current) botInputRef.current.value = formatLength(curBot, units)
    }

    function onUp(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      cleanup()

      // Commit only values that actually changed relative to the last committed
      // props, so we don't push spurious store updates.
      if (Math.abs(curTop - zTop) > 1e-10) onCommitZTop(curTop)
      if (Math.abs(curBot - zBottom) > 1e-10) onCommitZBottom(curBot)

      setDragTop(null)
      setDragBot(null)
    }

    function cleanup() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      cleanupRef.current = null
    }

    // Remove any stale listeners from a previous interrupted drag.
    if (cleanupRef.current) cleanupRef.current()
    cleanupRef.current = cleanup

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Build blur/keydown handlers that mirror DraftNumberInput behaviour.
  function makeFieldHandlers(
    isTop: boolean,
    committedValue: number,
    otherCommittedValue: number,
  ) {
    function reset(el: HTMLInputElement) {
      el.value = formatLength(committedValue, units)
    }

    function commit(el: HTMLInputElement) {
      if (el.value.trim() === '') {
        reset(el)
        return
      }
      const next = parseLengthInput(el.value, units)
      if (
        next === null ||
        !Number.isFinite(next) ||
        next < 0 ||
        next > stockThickness
      ) {
        reset(el)
        return
      }
      // Cross-handle constraint
      if (isTop && next < otherCommittedValue) {
        reset(el)
        return
      }
      if (!isTop && next > otherCommittedValue) {
        reset(el)
        return
      }
      if (next !== committedValue) {
        if (isTop) onCommitZTop(next)
        else onCommitZBottom(next)
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

  const topHandlers = makeFieldHandlers(true, zTop, zBottom)
  const botHandlers = makeFieldHandlers(false, zBottom, zTop)

  return (
    <div className="z-range-slider">
      <span className="z-range-slider__label z-range-slider__label--top">Z Top</span>

      <div className="z-range-slider__track" ref={trackRef}>
        <div className="z-range-slider__track-line" />
        <div
          className="z-range-slider__filled"
          style={{ top: `${topPercent}%`, height: `${Math.max(0, botPercent - topPercent)}%` }}
        />
        <div
          className="z-range-slider__handle"
          style={{ top: `${topPercent}%` }}
          onPointerDown={(e) => handlePointerDown('top', e)}
          role="slider"
          aria-label="Z Top handle"
          aria-valuemin={zBottom}
          aria-valuemax={stockThickness}
          aria-valuenow={effectiveTop}
          tabIndex={0}
        />
        <div
          className="z-range-slider__handle"
          style={{ top: `${botPercent}%` }}
          onPointerDown={(e) => handlePointerDown('bottom', e)}
          role="slider"
          aria-label="Z Bottom handle"
          aria-valuemin={0}
          aria-valuemax={zTop}
          aria-valuenow={effectiveBot}
          tabIndex={0}
        />
      </div>

      <input
        key={`${featureId}-zrs-top-${zTop}-${zBottom}`}
        ref={topInputRef}
        className="z-range-slider__field z-range-slider__field--top"
        type="text"
        inputMode="decimal"
        defaultValue={formatLength(zTop, units)}
        spellCheck={false}
        data-numeric-entry="true"
        onBlur={topHandlers.onBlur}
        onKeyDown={topHandlers.onKeyDown}
      />

      <span className="z-range-slider__label z-range-slider__label--bot">Z Bottom</span>

      <input
        key={`${featureId}-zrs-bot-${zTop}-${zBottom}`}
        ref={botInputRef}
        className="z-range-slider__field z-range-slider__field--bot"
        type="text"
        inputMode="decimal"
        defaultValue={formatLength(zBottom, units)}
        spellCheck={false}
        data-numeric-entry="true"
        onBlur={botHandlers.onBlur}
        onKeyDown={botHandlers.onKeyDown}
      />
    </div>
  )
}
