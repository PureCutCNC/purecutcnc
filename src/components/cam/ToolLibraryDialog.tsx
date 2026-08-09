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

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/i18nContext'
import type { Tool, ToolType } from '../../types/project'
import type { ToolLibraryEntry } from '../../toolLibrary'
import { Select } from '../Select'
import { camT, camTPlural } from './camI18n'
import {
  annotateEntryStates,
  buildImportInput,
  countImportableSelected,
  filterLibraryEntries,
  type LibraryEntryState,
  type LibraryFilterValues,
} from './toolLibraryDialogModel'
import { formatLength } from '../../utils/units'

function toolTypeLabel(type: ToolType): string {
  switch (type) {
    case 'flat_endmill':
      return camT('cam.toolType.flatEndmill')
    case 'ball_endmill':
      return camT('cam.toolType.ballEndmill')
    case 'v_bit':
      return camT('cam.toolType.vBit')
    case 'drill':
      return camT('cam.toolType.drill')
  }
}

function toolUnitsLabel(units: Tool['units']): string {
  return units === 'inch' ? 'in' : 'mm'
}

export interface ToolLibraryDialogProps {
  /** The full unfiltered library entry list. */
  libraryEntries: ToolLibraryEntry[]
  /** True while the bundled library is loading. */
  loading: boolean
  /** Non-null when loading failed. */
  error: string | null
  /** Called when the user asks to retry the library load. */
  onRetry: () => void
  /** Current project tools for already-imported detection. */
  projectTools: Tool[]
  /** Current project units — default for the units filter. */
  projectUnits: Tool['units']
  /** Callback: import selected tools. Receives the import input array. */
  onImport: (tools: Array<Omit<Tool, 'id'>>) => string[]
  /** Called when the dialog should close (cancel / backdrop / Escape). */
  onClose: () => void
  /** Ref to the trigger element for focus restoration on close. */
  triggerRef: React.RefObject<HTMLElement | null>
}

export function ToolLibraryDialog({
  libraryEntries,
  loading,
  error,
  onRetry,
  projectTools,
  projectUnits,
  onImport,
  onClose,
  triggerRef,
}: ToolLibraryDialogProps) {
  useI18n()

  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<ToolType | 'all'>('all')
  const [unitsFilter, setUnitsFilter] = useState<Tool['units'] | 'all'>(projectUnits)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [importMessage, setImportMessage] = useState<string | null>(null)

  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Save the trigger element on mount for focus restoration.
  useEffect(() => {
    previousFocusRef.current = triggerRef.current
  }, [triggerRef])

  // Focus the search input on mount.
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Escape key closes the dialog.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Restore focus to the trigger on unmount.
  useEffect(() => {
    return () => {
      previousFocusRef.current?.focus()
    }
  }, [])

  const filters: LibraryFilterValues = useMemo(
    () => ({ search, type: typeFilter, units: unitsFilter }),
    [search, typeFilter, unitsFilter],
  )

  const filteredEntries = useMemo(
    () => filterLibraryEntries(libraryEntries, filters),
    [libraryEntries, filters],
  )

  const annotatedEntries: LibraryEntryState[] = useMemo(
    () => annotateEntryStates(filteredEntries, projectTools),
    [filteredEntries, projectTools],
  )

  const importableCount = useMemo(
    () => countImportableSelected(annotatedEntries, selectedKeys),
    [annotatedEntries, selectedKeys],
  )

  const allImported = useMemo(
    () => annotatedEntries.length > 0 && annotatedEntries.every((e) => e.alreadyImported),
    [annotatedEntries],
  )

  function toggleSelection(key: string) {
    setImportMessage(null)
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  function handleRowKeyDown(key: string, event: React.KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleSelection(key)
    }
  }

  function handleBackdropClick(event: React.MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const input = buildImportInput(annotatedEntries, selectedKeys)
    if (input.length === 0) {
      setImportMessage(camT('cam.tools.noImportable'))
      return
    }
    const importedIds = onImport(input)
    if (importedIds.length === 0) {
      setImportMessage(camT('cam.tools.noImportable'))
      return
    }
    onClose()
  }

  function handleClearFilters() {
    setSearch('')
    setTypeFilter('all')
    setUnitsFilter('all')
  }

  const hasActiveFilters = search !== '' || typeFilter !== 'all' || unitsFilter !== 'all'
  const showNoMatch = !loading && !error && annotatedEntries.length === 0 && hasActiveFilters
  const showAllImported = !loading && !error && allImported && !hasActiveFilters
  const searchInputId = 'tool-library-search'

  return createPortal(
    <div className="dialog-backdrop" onClick={handleBackdropClick}>
      <div
        className="dialog dialog--tool-library"
        role="dialog"
        aria-modal="true"
        aria-label={camT('cam.tools.dialogTitle')}
        ref={dialogRef}
      >
        <form onSubmit={handleSubmit}>
          <div className="dialog-header">
            <h2 className="dialog-title">{camT('cam.tools.dialogTitle')}</h2>
            <button
              className="dialog-close"
              type="button"
              onClick={onClose}
              aria-label={camT('cam.tools.close')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="dialog-body dialog-body--tool-library">
            <div className="tl-filters">
              <div className="tl-search">
                <label htmlFor={searchInputId} className="tl-sr-only">
                  {camT('cam.tools.searchAria')}
                </label>
                <input
                  id={searchInputId}
                  ref={searchRef}
                  type="search"
                  className="tl-search-input"
                  placeholder={camT('cam.tools.searchPlaceholder')}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div className="tl-filter-selects">
                <Select
                  value={typeFilter}
                  options={[
                    { value: 'all', label: camT('cam.tools.allTypes') },
                    { value: 'flat_endmill', label: toolTypeLabel('flat_endmill') },
                    { value: 'ball_endmill', label: toolTypeLabel('ball_endmill') },
                    { value: 'v_bit', label: toolTypeLabel('v_bit') },
                    { value: 'drill', label: toolTypeLabel('drill') },
                  ]}
                  onChange={(value) => setTypeFilter(value as ToolType | 'all')}
                />
                <Select
                  value={unitsFilter}
                  options={[
                    { value: 'all', label: camT('cam.tools.allUnits') },
                    { value: 'mm', label: 'mm' },
                    { value: 'inch', label: 'in' },
                  ]}
                  onChange={(value) => setUnitsFilter(value as Tool['units'] | 'all')}
                />
              </div>
            </div>

            <div className="tl-results">
              {loading ? (
                <div className="tl-status" role="status">
                  <span className="tl-spinner" aria-hidden="true" />
                  <span>{camT('cam.tools.loadingDialog')}</span>
                </div>
              ) : error ? (
                <div className="tl-status tl-status--error" role="alert">
                  <span>{error}</span>
                  <button className="cam-header-action" type="button" onClick={onRetry}>
                    {camT('cam.tools.retry')}
                  </button>
                </div>
              ) : showNoMatch ? (
                <div className="tl-status">
                  <span>{camT('cam.tools.noMatch')}</span>
                  <button className="cam-header-action" type="button" onClick={handleClearFilters}>
                    {camT('cam.tools.clearFilters')}
                  </button>
                </div>
              ) : showAllImported ? (
                <div className="tl-status">
                  <span>{camT('cam.tools.allImported')}</span>
                </div>
              ) : annotatedEntries.length === 0 ? (
                <div className="tl-status">
                  <span>{camT('cam.tools.noMatch')}</span>
                </div>
              ) : (
                annotatedEntries.map((entry) => {
                  const isSelected = selectedKeys.has(entry.key)
                  return (
                    <div
                      key={entry.key}
                      className={[
                        'tl-row',
                        entry.alreadyImported ? 'tl-row--imported' : '',
                        isSelected ? 'tl-row--selected' : '',
                      ].join(' ')}
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-disabled={entry.alreadyImported}
                      tabIndex={0}
                      onClick={() => {
                        if (!entry.alreadyImported) {
                          toggleSelection(entry.key)
                        }
                      }}
                      onKeyDown={(event) => {
                        if (!entry.alreadyImported) {
                          handleRowKeyDown(entry.key, event)
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        className="tl-row__check"
                        checked={isSelected}
                        disabled={entry.alreadyImported}
                        onChange={() => toggleSelection(entry.key)}
                        tabIndex={-1}
                      />
                      <span className="tl-row__name">{entry.name}</span>
                      <span className="tl-row__meta">
                        {toolTypeLabel(entry.type)}
                        {' · ⌀'}
                        {formatLength(entry.diameter, entry.units)}
                        {' '}
                        {toolUnitsLabel(entry.units)}
                        {entry.maxCutDepth > 0
                          ? ` · max ${formatLength(entry.maxCutDepth, entry.units)} ${toolUnitsLabel(entry.units)}`
                          : ''}
                        {' · '}
                        {entry.flutes} {entry.flutes === 1 ? 'flute' : 'flutes'}
                        {' · '}
                        {entry.material === 'carbide' ? 'Carbide' : 'HSS'}
                      </span>
                      <span className="tl-row__status">
                        {entry.alreadyImported ? camT('cam.tools.inProject') : camT('cam.tools.new')}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="dialog-footer">
            {importMessage ? (
              <span className="tl-footer-message">{importMessage}</span>
            ) : null}
            <span className="tl-footer-count">
              {camTPlural(
                importableCount,
                'cam.tools.selectedCount.one',
                'cam.tools.selectedCount.other',
              )}
            </span>
            <button className="btn-secondary" type="button" onClick={onClose}>
              {camT('cam.panel.close')}
            </button>
            <button
              className="btn-primary"
              type="submit"
              disabled={importableCount === 0}
            >
              {importableCount > 0
                ? camTPlural(
                    importableCount,
                    'cam.tools.importAction.one',
                    'cam.tools.importAction.other',
                  )
                : camT('cam.tools.importAction.one')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
