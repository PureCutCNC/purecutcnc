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

import { formatLength, parseLengthInput } from '../../utils/units'

interface DraftNumberInputProps {
  value: number | null
  units: 'mm' | 'inch'
  min?: number
  max?: number
  disabled?: boolean
  placeholder?: string
  onCommit: (value: number) => void
  validate?: (value: number) => boolean
}

export function DraftNumberInput({
  value,
  units,
  min,
  max,
  disabled = false,
  placeholder,
  onCommit,
  validate,
}: DraftNumberInputProps) {
  function reset(el: HTMLInputElement) {
    el.value = value === null ? '' : formatLength(value, units)
  }

  function isValid(next: number) {
    if (!Number.isFinite(next)) return false
    if (min !== undefined && next < min) return false
    if (max !== undefined && next > max) return false
    if (validate && !validate(next)) return false
    return true
  }

  function commit(el: HTMLInputElement) {
    if (el.value.trim() === '') {
      reset(el)
      return
    }

    const next = parseLengthInput(el.value, units)
    if (next === null || !isValid(next)) {
      reset(el)
      return
    }

    if (value === null || next !== value) {
      onCommit(next)
    } else {
      reset(el)
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      defaultValue={value === null ? '' : formatLength(value, units)}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      data-numeric-entry="true"
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
          return
        }

        if (event.key === 'Escape') {
          reset(event.currentTarget)
          event.currentTarget.blur()
        }
      }}
    />
  )
}
