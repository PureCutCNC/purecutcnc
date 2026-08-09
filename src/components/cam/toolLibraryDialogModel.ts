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

import type { Tool, ToolType } from '../../types/project'
import type { ToolLibraryEntry } from '../../toolLibrary'

/**
 * Pure filtering and selection helpers for the tool-library import dialog.
 * No side effects, no store access — the component and structural tests
 * both drive this layer directly.
 */

export type LibraryEntryState = ToolLibraryEntry & {
  /** Derived: true when the project already contains a matching tool. */
  alreadyImported: boolean
}

export interface LibraryFilterValues {
  search: string
  type: ToolType | 'all'
  units: Tool['units'] | 'all'
}

/**
 * Match predicate copied from CAMPanel.tsx — the existing public contract
 * for "is this library tool already in the project." Must stay in sync.
 */
export function toolMatchesLibraryEntry(
  tool: Tool,
  libraryEntry: ToolLibraryEntry,
): boolean {
  return (
    tool.name === libraryEntry.name
    && tool.units === libraryEntry.units
    && tool.type === libraryEntry.type
    && tool.diameter === libraryEntry.diameter
    && tool.vBitAngle === libraryEntry.vBitAngle
    && tool.flutes === libraryEntry.flutes
    && tool.material === libraryEntry.material
    && tool.defaultRpm === libraryEntry.defaultRpm
    && tool.defaultFeed === libraryEntry.defaultFeed
    && tool.defaultPlungeFeed === libraryEntry.defaultPlungeFeed
    && tool.defaultStepdown === libraryEntry.defaultStepdown
    && tool.defaultStepover === libraryEntry.defaultStepover
  )
}

/** Normalize search text for loose matching. */
function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Return true when at least one token in `terms` appears in `haystack`. */
function searchTermsMatch(terms: string[], haystack: string): boolean {
  if (terms.length === 0) return true
  const normal = normalizeSearch(haystack)
  return terms.some((term) => normal.includes(term))
}

/** Shared filter logic for any entry with name, type, units, diameter. */
function entryMatchesFilters(
  entry: { name: string; type: ToolType; units: Tool['units']; diameter: number },
  filters: LibraryFilterValues,
): boolean {
  const { type, units, search } = filters
  const searchTerms = normalizeSearch(search).split(' ').filter(Boolean)

  if (type !== 'all' && entry.type !== type) return false
  if (units !== 'all' && entry.units !== units) return false
  if (searchTerms.length > 0) {
    const diameterStr = String(entry.diameter)
    const haystack = `${entry.name} ${diameterStr}`
    if (!searchTermsMatch(searchTerms, haystack)) return false
  }
  return true
}

/**
 * Apply type, units, and free-text search filters to a library entry list.
 * Search matches tool name and diameter (as a formatted decimal string).
 */
export function filterLibraryEntries(
  entries: ToolLibraryEntry[],
  filters: LibraryFilterValues,
): ToolLibraryEntry[] {
  return entries.filter((entry) => entryMatchesFilters(entry, filters))
}

/**
 * Filter already-annotated entries using the same filter contract.
 * Used for the display-only filtered view; selection/count/import
 * operate on the full annotated list so selections survive filter changes.
 */
export function filterLibraryEntryStates(
  entries: LibraryEntryState[],
  filters: LibraryFilterValues,
): LibraryEntryState[] {
  return entries.filter((entry) => entryMatchesFilters(entry, filters))
}

/**
 * Annotate each library entry with its already-imported status using the
 * existing project tools.
 */
export function annotateEntryStates(
  entries: ToolLibraryEntry[],
  projectTools: Tool[],
): LibraryEntryState[] {
  return entries.map((entry) => ({
    ...entry,
    alreadyImported: projectTools.some((tool) => toolMatchesLibraryEntry(tool, entry)),
  }))
}

/**
 * Count selected entries that are NOT yet in the project.
 * Operates on the full annotated list — selections survive filtering.
 */
export function countImportableSelected(
  entries: LibraryEntryState[],
  selectedKeys: Set<string>,
): number {
  let count = 0
  for (const entry of entries) {
    if (selectedKeys.has(entry.key) && !entry.alreadyImported) {
      count++
    }
  }
  return count
}

/**
 * Build the input array for importTools() from the selected importable entries.
 * Operates on the full annotated list — selections survive filtering.
 */
export function buildImportInput(
  entries: LibraryEntryState[],
  selectedKeys: Set<string>,
): Array<Omit<Tool, 'id'>> {
  return entries
    .filter((entry) => selectedKeys.has(entry.key) && !entry.alreadyImported)
    .map(({ key: _key, ...rest }) => rest)
}
