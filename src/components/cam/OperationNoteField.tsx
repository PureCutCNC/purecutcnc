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
 * The operation description field (issue #1102, proposal 10).
 *
 * Most operations carry no note, and an always-present four-line textarea
 * spends the largest block in the Identity group on nothing. An empty note is
 * therefore a compact "+ Add note" link; the textarea appears when it is
 * clicked, focused and ready to type into. An operation that already has a
 * note renders the textarea exactly as before — someone with a note is
 * editing it, not adding one.
 *
 * This lives in its own component because the reveal is local state, and the
 * per-field renderers in `CAMPanel` are plain closures: a hook cannot be
 * called from inside one.
 */

import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/i18nContext'
import { camT } from './camI18n'
import { operationNoteShowsTextarea } from './operationFields'

export interface OperationNoteFieldProps {
  /** The stored description; empty means no note yet. */
  value: string
  onCommit: (value: string) => void
}

export function OperationNoteField({ value, onCommit }: OperationNoteFieldProps) {
  // `camT` reads the module-level catalog, so subscribe to the locale here as
  // well; the parent panel's subscription is not this component's contract.
  useI18n()
  const [revealed, setRevealed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Only a click should move focus. Mounting with a stored note, or an undo
  // bringing one back, must not steal the caret from whatever the user is
  // editing.
  const focusAfterReveal = useRef(false)
  const showTextarea = operationNoteShowsTextarea(revealed, value)

  useEffect(() => {
    if (!focusAfterReveal.current) return
    focusAfterReveal.current = false
    textareaRef.current?.focus()
  }, [showTextarea])

  function reveal() {
    focusAfterReveal.current = true
    setRevealed(true)
  }

  function reset(element: HTMLTextAreaElement) {
    element.value = value
  }

  function commit(element: HTMLTextAreaElement) {
    if (element.value !== value) {
      onCommit(element.value)
    } else {
      reset(element)
    }
  }

  if (!showTextarea) {
    return (
      <div className="properties-field">
        <span>{camT('cam.operation.description')}</span>
        <button className="properties-add-note" type="button" onClick={reveal}>
          {camT('cam.operation.addNote')}
        </button>
      </div>
    )
  }

  return (
    <label className="properties-field properties-field--textarea">
      <span>{camT('cam.operation.description')}</span>
      <textarea
        ref={textareaRef}
        key={value}
        defaultValue={value}
        spellCheck
        onBlur={(event) => commit(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            reset(event.currentTarget)
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}
