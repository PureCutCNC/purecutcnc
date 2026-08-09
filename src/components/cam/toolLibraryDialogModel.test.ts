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

import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  annotateEntryStates,
  buildImportInput,
  countImportableSelected,
  filterLibraryEntries,
  filterLibraryEntryStates,
  toolMatchesLibraryEntry,
  type LibraryEntryState,
} from './toolLibraryDialogModel'
import type { ToolLibraryEntry } from '../../toolLibrary'
import type { Tool } from '../../types/project'

function makeEntry(overrides: Partial<ToolLibraryEntry> = {}): ToolLibraryEntry {
  return {
    key: 'tool_1',
    name: '1/4" Endmill',
    units: 'inch',
    type: 'flat_endmill',
    diameter: 0.25,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 40,
    defaultPlungeFeed: 20,
    defaultStepdown: 0.125,
    defaultStepover: 0.4,
    maxCutDepth: 1.0,
    ...overrides,
  }
}

function makeTool(overrides: Partial<Tool> & { id?: string } = {}): Tool {
  return {
    id: overrides.id ?? 'proj_tool_1',
    name: '1/4" Endmill',
    units: 'inch',
    type: 'flat_endmill',
    diameter: 0.25,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 40,
    defaultPlungeFeed: 20,
    defaultStepdown: 0.125,
    defaultStepover: 0.4,
    maxCutDepth: 1.0,
    ...overrides,
  }
}

// ── toolMatchesLibraryEntry ──────────────────────────────────────────

describe('toolMatchesLibraryEntry', () => {
  it('matches identical entries', () => {
    const entry = makeEntry()
    const tool = makeTool()
    assert.equal(toolMatchesLibraryEntry(tool, entry), true)
  })

  it('rejects a tool with different name', () => {
    const entry = makeEntry()
    const tool = makeTool({ name: 'Different' })
    assert.equal(toolMatchesLibraryEntry(tool, entry), false)
  })

  it('rejects a tool with different units', () => {
    const entry = makeEntry()
    const tool = makeTool({ units: 'mm' })
    assert.equal(toolMatchesLibraryEntry(tool, entry), false)
  })

  it('rejects a tool with different diameter', () => {
    const entry = makeEntry()
    const tool = makeTool({ diameter: 0.5 })
    assert.equal(toolMatchesLibraryEntry(tool, entry), false)
  })

  it('does not check maxCutDepth', () => {
    const entry = makeEntry({ maxCutDepth: 2.0 })
    const tool = makeTool({ maxCutDepth: 1.0 })
    assert.equal(toolMatchesLibraryEntry(tool, entry), true)
  })
})

// ── filterLibraryEntries ─────────────────────────────────────────────

describe('filterLibraryEntries', () => {
  const entries: ToolLibraryEntry[] = [
    makeEntry({ key: 'e1', name: '1/4" Endmill', type: 'flat_endmill', units: 'inch', diameter: 0.25 }),
    makeEntry({ key: 'e2', name: '6mm Endmill', type: 'flat_endmill', units: 'mm', diameter: 6 }),
    makeEntry({ key: 'e3', name: '1/8" Ball', type: 'ball_endmill', units: 'inch', diameter: 0.125 }),
    makeEntry({ key: 'e4', name: '90° V-Bit', type: 'v_bit', units: 'mm', diameter: 12, vBitAngle: 90 }),
  ]

  it('returns all entries with default filters', () => {
    const result = filterLibraryEntries(entries, { search: '', type: 'all', units: 'all' })
    assert.equal(result.length, 4)
  })

  it('filters by type', () => {
    const result = filterLibraryEntries(entries, { search: '', type: 'v_bit', units: 'all' })
    assert.equal(result.length, 1)
    assert.equal(result[0]!.key, 'e4')
  })

  it('filters by units', () => {
    const result = filterLibraryEntries(entries, { search: '', type: 'all', units: 'mm' })
    assert.equal(result.length, 2)
    assert.ok(result.every((e) => e.units === 'mm'))
  })

  it('filters by type and units together', () => {
    const result = filterLibraryEntries(entries, { search: '', type: 'flat_endmill', units: 'inch' })
    assert.equal(result.length, 1)
    assert.equal(result[0]!.key, 'e1')
  })

  it('matches search text against name', () => {
    const result = filterLibraryEntries(entries, { search: 'Endmill', type: 'all', units: 'all' })
    assert.equal(result.length, 2)
    assert.ok(result.every((e) => e.type === 'flat_endmill'))
  })

  it('matches search text against diameter', () => {
    const result = filterLibraryEntries(entries, { search: '0.25', type: 'all', units: 'all' })
    assert.equal(result.length, 1)
    assert.equal(result[0]!.key, 'e1')
  })

  it('matches partial diameter', () => {
    const result = filterLibraryEntries(entries, { search: '6', type: 'all', units: 'all' })
    assert.equal(result.length, 1)
    assert.equal(result[0]!.key, 'e2')
  })

  it('returns empty array when nothing matches filters', () => {
    const result = filterLibraryEntries(entries, { search: 'nonexistent', type: 'all', units: 'all' })
    assert.equal(result.length, 0)
  })

  it('is case-insensitive', () => {
    const result = filterLibraryEntries(entries, { search: 'endmill', type: 'all', units: 'all' })
    assert.equal(result.length, 2)
  })
})

// ── filterLibraryEntryStates ─────────────────────────────────────────

describe('filterLibraryEntryStates', () => {
  const annotated: LibraryEntryState[] = [
    { ...makeEntry({ key: 'a', name: 'Aluminum Specific Tool', type: 'flat_endmill' }), alreadyImported: false },
    { ...makeEntry({ key: 'b', name: 'Roughing Mill', type: 'ball_endmill' }), alreadyImported: true },
    { ...makeEntry({ key: 'c', name: 'Finish Endmill', type: 'flat_endmill' }), alreadyImported: false },
  ]

  it('filters annotated entries by type', () => {
    const result = filterLibraryEntryStates(annotated, { search: '', type: 'ball_endmill', units: 'all' })
    assert.equal(result.length, 1)
    assert.equal(result[0]!.key, 'b')
  })

  it('filters annotated entries by search', () => {
    const result = filterLibraryEntryStates(annotated, { search: 'Aluminum', type: 'all', units: 'all' })
    assert.equal(result.length, 1)
    assert.equal(result[0]!.key, 'a')
  })

  it('returns empty when nothing matches', () => {
    const result = filterLibraryEntryStates(annotated, { search: 'nonexistent', type: 'all', units: 'all' })
    assert.equal(result.length, 0)
  })
})

// ── annotateEntryStates ───────────────────────────────────────────────

describe('annotateEntryStates', () => {
  it('marks entries already in the project', () => {
    const entries = [makeEntry({ key: 'e1' })]
    const projectTools = [makeTool()]
    const result = annotateEntryStates(entries, projectTools)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.alreadyImported, true)
  })

  it('leaves entries not in the project as not imported', () => {
    const entries = [makeEntry({ key: 'e1', name: 'Unique Tool' })]
    const projectTools = [makeTool({ name: 'Different' })]
    const result = annotateEntryStates(entries, projectTools)
    assert.equal(result[0]!.alreadyImported, false)
  })

  it('handles empty project tools', () => {
    const entries = [makeEntry(), makeEntry({ key: 'e2', name: 'Other' })]
    const result = annotateEntryStates(entries, [])
    assert.equal(result.length, 2)
    assert.ok(result.every((e) => !e.alreadyImported))
  })

  it('handles empty library entries', () => {
    const result = annotateEntryStates([], [makeTool()])
    assert.equal(result.length, 0)
  })
})

// ── countImportableSelected ───────────────────────────────────────────

describe('countImportableSelected', () => {
  function state(
    key: string,
    alreadyImported: boolean,
  ): LibraryEntryState {
    return { ...makeEntry({ key }), alreadyImported }
  }

  it('counts selected new entries', () => {
    const entries = [state('a', false), state('b', false)]
    const selected = new Set(['a'])
    assert.equal(countImportableSelected(entries, selected), 1)
  })

  it('excludes already-imported entries from count', () => {
    const entries = [state('a', true), state('b', false)]
    const selected = new Set(['a', 'b'])
    assert.equal(countImportableSelected(entries, selected), 1)
  })

  it('returns zero when only imported entries are selected', () => {
    const entries = [state('a', true), state('b', true)]
    const selected = new Set(['a', 'b'])
    assert.equal(countImportableSelected(entries, selected), 0)
  })

  it('returns zero when nothing is selected', () => {
    const entries = [state('a', false), state('b', false)]
    assert.equal(countImportableSelected(entries, new Set()), 0)
  })

  it('counts selected entries even when they are not in the filtered view', () => {
    // Regression: selection must survive filter changes.
    // The full annotated list contains both 'a' and 'b'; 'b' is selected.
    // This simulates a search that hides 'b' — the count must still include it.
    const fullList = [state('a', false), state('b', false)]
    // 'b' is selected but not in the filtered subset used for rendering
    const selectedKeys = new Set(['b'])
    assert.equal(countImportableSelected(fullList, selectedKeys), 1)
  })
})

// ── buildImportInput ──────────────────────────────────────────────────

describe('buildImportInput', () => {
  it('maps selected importable entries to Omit<Tool, id>', () => {
    const entries: LibraryEntryState[] = [
      { ...makeEntry({ key: 'e1' }), alreadyImported: false },
      { ...makeEntry({ key: 'e2', name: 'Another' }), alreadyImported: false },
    ]
    const selected = new Set(['e1', 'e2'])
    const result = buildImportInput(entries, selected)
    assert.equal(result.length, 2)
    assert.equal(result[0]!.name, '1/4" Endmill')
    assert.equal(result[1]!.name, 'Another')
    // key must be stripped
    assert.ok(!('key' in result[0]!))
  })

  it('excludes already-imported entries', () => {
    const entries: LibraryEntryState[] = [
      { ...makeEntry({ key: 'e1' }), alreadyImported: true },
      { ...makeEntry({ key: 'e2', name: 'New' }), alreadyImported: false },
    ]
    const selected = new Set(['e1', 'e2'])
    const result = buildImportInput(entries, selected)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.name, 'New')
  })

  it('excludes unselected entries', () => {
    const entries: LibraryEntryState[] = [
      { ...makeEntry({ key: 'e1' }), alreadyImported: false },
      { ...makeEntry({ key: 'e2', name: 'Other' }), alreadyImported: false },
    ]
    const result = buildImportInput(entries, new Set(['e1']))
    assert.equal(result.length, 1)
  })

  it('returns empty array when nothing is selected', () => {
    const entries: LibraryEntryState[] = [{ ...makeEntry(), alreadyImported: false }]
    assert.equal(buildImportInput(entries, new Set()).length, 0)
  })

  it('includes selected entries not in the filtered view', () => {
    // Regression: import must include selected entries even when hidden by filters.
    const fullList: LibraryEntryState[] = [
      { ...makeEntry({ key: 'e1', name: 'Visible' }), alreadyImported: false },
      { ...makeEntry({ key: 'e2', name: 'Hidden' }), alreadyImported: false },
    ]
    const selectedKeys = new Set(['e2'])
    const result = buildImportInput(fullList, selectedKeys)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.name, 'Hidden')
  })

  it('produces input compatible with importTools', () => {
    const entries: LibraryEntryState[] = [{ ...makeEntry({ key: 'k' }), alreadyImported: false }]
    const [result] = buildImportInput(entries, new Set(['k']))
    assert.ok(result !== undefined)
    const requiredToolKeys: Array<keyof Omit<Tool, 'id'>> = [
      'name', 'units', 'type', 'diameter', 'vBitAngle', 'flutes', 'material',
      'defaultRpm', 'defaultFeed', 'defaultPlungeFeed', 'defaultStepdown',
      'defaultStepover', 'maxCutDepth',
    ]
    for (const k of requiredToolKeys) {
      assert.ok(k in result, `missing key ${k}`)
    }
    assert.ok(!('key' in result))
  })
})
