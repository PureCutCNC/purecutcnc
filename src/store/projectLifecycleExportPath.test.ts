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
 * G-code export destination lifecycle (issue #1081).
 *
 * A remembered export path belongs to the document that produced it. New,
 * template, load, and open transitions must forget it so the next G-code export
 * asks for a destination instead of silently overwriting another project's
 * file. Same-document edits and saves keep it; a failed open changes nothing.
 *
 * Run with: npx tsx src/store/projectLifecycleExportPath.test.ts
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject, type Project } from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'

const EXPORT_A = join(tmpdir(), 'part-a.nc')
const PROJECT_A = join(tmpdir(), 'part-a.camj')
const OPENED_PROJECT = join(tmpdir(), 'opened.camj')
const BROKEN_PROJECT = join(tmpdir(), 'broken.camj')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function store(): ProjectStore {
  return useProjectStore.getState()
}

function resetStore(project: Project = newProject('Part A', 'mm')): void {
  useProjectStore.setState({
    project,
    filePath: null,
    lastExportPath: null,
    dirty: false,
    projectKey: 0,
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
}

function projectJson(project: Project): string {
  return JSON.stringify(project)
}

// ── the marker is document state, not a global preference ─────────────────

{
  resetStore()
  store().markExported(EXPORT_A)
  assert(store().lastExportPath === EXPORT_A, 'markExported records the chosen destination')

  // Renaming or otherwise editing the same project does not invalidate the
  // path — only replacing the document does.
  store().setProjectName('Part A renamed')
  assert(store().lastExportPath === EXPORT_A, 'a same-project edit keeps the export marker')

  store().markSaved(PROJECT_A)
  assert(store().lastExportPath === EXPORT_A, 'saving the project keeps the export marker')
}

// ── every document-replacing transition clears it ─────────────────────────

{
  resetStore()
  store().markExported(EXPORT_A)
  store().createNewProject()
  assert(store().lastExportPath === null, 'a blank New project clears the export marker')
  assert(store().filePath === null, 'a blank New project starts without a project path')
}

{
  resetStore()
  const template = newProject('Template source', 'mm')
  store().markExported(EXPORT_A)
  store().createNewProject(template, 'From template')
  assert(store().lastExportPath === null, 'a template New project clears the export marker')
  assert(store().project.meta.name === 'From template', 'the template transition installed the new project')
}

{
  resetStore()
  store().markExported(EXPORT_A)
  store().loadProject(newProject('Loaded project', 'mm'))
  assert(store().lastExportPath === null, 'loadProject clears the export marker')
}

{
  resetStore()
  store().markExported(EXPORT_A)
  const opened = newProject('Opened project', 'mm')
  store().openProjectFromText(projectJson(opened), OPENED_PROJECT)
  assert(store().lastExportPath === null, 'openProjectFromText clears the export marker')
  assert(store().filePath === OPENED_PROJECT, 'openProjectFromText installs the opened path')
  assert(store().project.meta.name === 'Opened project', 'openProjectFromText installed the opened project')
}

// ── a failed open leaves the current document and marker alone ────────────

{
  resetStore(newProject('Part A', 'mm'))
  store().markExported(EXPORT_A)
  const projectKeyBefore = store().projectKey

  let threw = false
  try {
    store().openProjectFromText('{"version": "3.0",', BROKEN_PROJECT)
  } catch {
    threw = true
  }

  assert(threw, 'a malformed project file still fails the open')
  assert(store().lastExportPath === EXPORT_A, 'a failed open keeps the previous export marker')
  assert(store().project.meta.name === 'Part A', 'a failed open leaves the current project in place')
  assert(store().projectKey === projectKeyBefore, 'a failed open does not start a new document identity')
}

console.log('projectLifecycleExportPath tests passed')
