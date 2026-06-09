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

import { useState, type ReactNode } from 'react'
import { Icon } from '../Icon'
import {
  disclosureStorageKey,
  parseDisclosureOpen,
  serializeDisclosureOpen,
} from './disclosureState'

interface DisclosureSectionProps {
  /** Header label, e.g. "Advanced". */
  title: string
  children: ReactNode
  /**
   * Stable key for persisting the open/collapsed state in localStorage. When
   * omitted the state is in-memory only (resets on remount).
   */
  storageKey?: string
  /** Whether the section starts open the first time it is seen. Default false. */
  defaultOpen?: boolean
  /** Extra class names applied to the outer container. */
  className?: string
}

function readInitialOpen(storageKey: string | undefined, defaultOpen: boolean): boolean {
  if (storageKey && typeof window !== 'undefined') {
    try {
      return parseDisclosureOpen(window.localStorage.getItem(disclosureStorageKey(storageKey)), defaultOpen)
    } catch {
      return defaultOpen
    }
  }
  return defaultOpen
}

/**
 * A1.1: a reusable collapsible section so progressive disclosure ("Advanced"
 * groups) looks and behaves the same across the Properties and CAM panels.
 * Open/collapsed state persists per `storageKey` (consistent with PanelSplit).
 */
export function DisclosureSection({
  title,
  children,
  storageKey,
  defaultOpen = false,
  className,
}: DisclosureSectionProps) {
  const [open, setOpen] = useState<boolean>(() => readInitialOpen(storageKey, defaultOpen))

  function toggle() {
    setOpen((prev) => {
      const next = !prev
      if (storageKey && typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(disclosureStorageKey(storageKey), serializeDisclosureOpen(next))
        } catch {
          // Persistence is best-effort; ignore quota/availability errors.
        }
      }
      return next
    })
  }

  return (
    <div className={['disclosure-section', open ? 'disclosure-section--open' : '', className ?? ''].join(' ').trim()}>
      <button
        type="button"
        className="disclosure-section__header"
        aria-expanded={open}
        onClick={toggle}
      >
        <Icon id="chevron-down" size={12} className={open ? 'disclosure-section__chevron disclosure-section__chevron--open' : 'disclosure-section__chevron'} />
        <span className="disclosure-section__title">{title}</span>
      </button>
      {open ? <div className="disclosure-section__body">{children}</div> : null}
    </div>
  )
}
