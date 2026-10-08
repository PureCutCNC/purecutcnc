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

import type { Locator, Page } from '@playwright/test'
import type { SetupFace, SketchFeature } from '../src/types/project'
import { canvasWorldPoint } from './overlapFeatureSelection.helpers'
import { seedProject, getProject } from './helpers'

function rectProfile(x: number, y: number, w: number, h: number) {
  return { start: { x, y }, segments: [{ type: 'line' as const, to: { x: x + w, y } }, { type: 'line' as const, to: { x: x + w, y: y + h } }, { type: 'line' as const, to: { x, y: y + h } }, { type: 'line' as const, to: { x, y } }], closed: true }
}

export interface ReferenceFixtureOptions { face: SetupFace; axis: 'x' | 'y'; hidden?: boolean; role?: 'construction' | 'line'; locked?: boolean; subjectEnd?: number; overlap?: boolean }

/** Canonical profiles; the guide lives on the opposite authoring face. */
export async function seedConstructionReferences(page: Page, options: ReferenceFixtureOptions): Promise<Record<string, unknown>> {
  await page.evaluate(() => localStorage.setItem('camcam.snapSettings', JSON.stringify({ enabled: true, modes: ['point'], pixelRadius: 8 })))
  await page.reload()
  await page.waitForSelector('canvas.sketch-canvas')
  const { face, axis } = options
  const foreign = face === 'top' ? 'bottom' : 'top'
  const row = (id: string, authoringFace: SetupFace, profile: SketchFeature['sketch']['profile'], operation: SketchFeature['operation']): SketchFeature => ({
    id, name: id, kind: 'polygon', operation, authoringFace, folderId: null, visible: true, locked: false, z_top: 2, z_bottom: 0,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  })
  const guide = row('reference-guide', foreign, rectProfile(0, 0, 30, 10), options.role ?? 'construction')
  guide.visible = !options.hidden
  guide.locked = options.locked ?? true
  const cutter = row('reference-cutter', foreign, { start: { x: 45, y: 40 }, segments: [{ type: 'line', to: { x: 45, y: 60 } }], closed: false }, 'construction')
  const subject = row('reference-subject', face, { start: { x: 25, y: 50 }, segments: [{ type: 'line', to: { x: options.subjectEnd ?? 55, y: 50 } }], closed: false }, 'line')
  const source = row('reference-source', face, rectProfile(80, 40, 5, 5), 'add')
  const run = { ...row('reference-run', face, rectProfile(70, 70, 10, 5), 'subtract'), kind: 'text' as const,
    text: { text: 'ABC', style: 'skeleton' as const, fontId: 'simple_stroke', size: 5 } }
  const base = await getProject(page)
  const drafts = [source, guide, cutter, subject, run]
  if (options.overlap) drafts.splice(1, 0, row('reference-shadow', face, rectProfile(35, 15, 30, 10), 'construction'))
  const topId = (base.setups as Array<{ id: string }>)[0].id
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const project = { ...base, meta: { ...(base.meta as object), units: 'mm' },
    stock: { ...(base.stock as object), profile: rectProfile(0, 0, 120, 90), thickness: 2 },
    featureDefinitions: Object.fromEntries(drafts.map(f => [f.id, { id: f.id, kind: f.kind,
      profile: f.sketch.profile, operation: f.operation, dimensions: [], text: f.text ?? null, stl: null }])),
    features: drafts.map(f => ({ id: f.id, name: f.name, definitionId: f.id,
      authoringFace: f.authoringFace, folderId: null, constraints: [], z_top: 2, z_bottom: 0,
      visible: f.visible, locked: f.locked, transform: f.id === guide.id ? { ...identity, e: 20, f: 15 } : identity })),
    featureTree: [], featureFolders: [], annotations: [], operations: [],
    setups: [ (base.setups as unknown[])[0], { id: 'reference-bottom', name: 'Bottom', orientation: { axis, angleDeg: 180 }, indexing: 'manual', registration: [], notes: '', operationIds: [] } ],
    activeSetupId: face === 'top' ? topId : 'reference-bottom',
  }
  await seedProject(page, JSON.stringify(project))
  return project
}

export async function referenceCanvasPoint(canvas: Locator, options: ReferenceFixtureOptions, x: number, y: number) {
  return canvasWorldPoint(canvas, options.face === 'bottom' && options.axis === 'y' ? 120 - x : x,
    options.face === 'bottom' && options.axis === 'x' ? 90 - y : y)
}

export async function pickReference(canvas: Locator, options: ReferenceFixtureOptions, x: number, y: number, touch = false) {
  const position = await referenceCanvasPoint(canvas, options, x, y)
  if (touch) await canvas.tap({ position })
  else await canvas.click({ position })
}

export function referenceSnapshot(project: Record<string, unknown>) {
  const rows = project.features as Array<{ id: string; definitionId: string }>
  const definitions = project.featureDefinitions as Record<string, unknown>
  return rows.filter(row => row.id === 'reference-guide' || row.id === 'reference-cutter').map(row => ({ row, definition: definitions[row.definitionId] }))
}

export function referenceSnapIndicator(page: Page) {
  return page.locator('.toolbar-group--snap .toolbar-icon-btn--live, .snap-popover-host--snap .toolbar-icon-btn--live')
}
