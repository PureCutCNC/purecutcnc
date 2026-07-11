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
 * revealFeatureFolder (#276) — expands a collapsed folder without recording
 * undo history, so selection-driven reveals never pollute Cmd+Z.
 *
 * Run with: npx tsx src/store/revealFeatureFolder.test.ts
 */

import { newProject, type Project } from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'

// ── Assertion helpers ──────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Store helpers ──────────────────────────────────────────────────

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
  } as unknown as Partial<ProjectStore>)
}

// ── Test runner ────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

console.log('\nrevealFeatureFolder — expands without undo history')

test('expands a collapsed folder', () => {
  resetStore()
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().updateFeatureFolder(folderId, { collapsed: true })

  useProjectStore.getState().revealFeatureFolder(folderId)
  const folder = useProjectStore.getState().project.featureFolders.find((f) => f.id === folderId)
  assert(folder !== undefined, 'folder should exist')
  assert(folder.collapsed === false, `expected collapsed === false, got ${folder.collapsed}`)
})

test('does not push an undo history entry', () => {
  resetStore()
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().updateFeatureFolder(folderId, { collapsed: true })
  const pastLengthBefore = useProjectStore.getState().history.past.length

  useProjectStore.getState().revealFeatureFolder(folderId)
  const { history } = useProjectStore.getState()
  assert(
    history.past.length === pastLengthBefore,
    `expected history.past to stay at ${pastLengthBefore}, got ${history.past.length}`,
  )
})

test('no-op when the folder is already expanded', () => {
  resetStore()
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  const projectBefore = useProjectStore.getState().project

  useProjectStore.getState().revealFeatureFolder(folderId)
  assert(
    useProjectStore.getState().project === projectBefore,
    'project reference should be unchanged for an already-expanded folder',
  )
})

test('no-op for an unknown folder id', () => {
  resetStore()
  const projectBefore = useProjectStore.getState().project

  useProjectStore.getState().revealFeatureFolder('fd-does-not-exist')
  assert(
    useProjectStore.getState().project === projectBefore,
    'project reference should be unchanged for an unknown folder id',
  )
})

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
}
