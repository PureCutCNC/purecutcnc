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
 * The Around feature in the 3D model (issue #395 slice G1).
 *
 * A round bar with a rotary machine and an Around subtract: the 3D view's model
 * mesh really exists (its triangle count is published on the panel), so the
 * wrapped feature is drawn in the model rather than only in the toolpath.
 * Screenshots are taken from the default view and after a short drag to a low
 * angle.
 *
 * The fixture is copied from `around3d.smoke.spec.ts` rather than imported —
 * that spec and `e2e/selectors.ts` belong to the other slice. What this spec
 * assumes about the page:
 * - the 3D panel's attribute holder is `#workspace-panel-preview3d .viewport-3d`,
 *   the same element the toolpath `data-toolpath-*` attributes live on;
 * - `data-model-triangles` is the triangle count of the model mesh after the
 *   scene build, and absent when there is no model;
 * - the generation gear reads "up to date" only once every operation generated;
 * - a left-drag of about −60 px on the canvas orbits the camera (the angle is
 *   not asserted, only that the live scene survives it).
 *
 * Run in the `test:e2e:workflow-ui` lane.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject } from './helpers'
import {
  defaultTool,
  roundStock,
  type Project,
  type RoundStock,
  type SketchProfile,
} from '../src/types/project'
import type { MachineDefinition } from '../src/engine/gcode/types'

const BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const SHEET_START = BAR.profile.start.y
/** Flat coordinates of the Around pocket: x along the bar, y across the sheet. */
const POCKET = { x: 50, y: SHEET_START + 12, w: 60, h: 10 }

/** A 3 mm flat endmill in mm, referenced by its real id. */
const TOOL = { ...defaultTool('mm', 1), id: 't1', name: '3 mm Flat Endmill', diameter: 3, maxCutDepth: 40 }

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function rect(x: number, y: number, w: number, h: number): SketchProfile {
  return {
    start: { x, y },
    segments: [
      { type: 'line', to: { x: x + w, y } },
      { type: 'line', to: { x: x + w, y: y + h } },
      { type: 'line', to: { x, y: y + h } },
      { type: 'line', to: { x, y } },
    ],
    closed: true,
  }
}

/** A complete bundled definition plus a rotary axis about x, as the sibling spec. */
function rotaryMachine(): MachineDefinition {
  // Read as a file: importing the definitions module would pull JSON imports
  // into the Playwright runner, which Node refuses without an attribute.
  const grbl = JSON.parse(
    readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
  ) as MachineDefinition
  return {
    ...structuredClone(grbl),
    id: 'e2e-rotary',
    name: 'E2E Rotary Mill',
    builtin: false,
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  }
}

/**
 * Seed the bar, the rotary machine, a Top setup and an Around setup whose only
 * feature is a subtract — the model needs just that one wrapped cut.
 */
async function seedAroundModelProject(page: Page): Promise<Project> {
  await seedGcodeExportProject(page)
  const seeded = await getProject(page) as unknown as Project
  const project = structuredClone(seeded)
  project.meta.name = 'Around model'
  project.meta.units = 'mm'
  project.stock = BAR
  project.origin = { ...project.origin, x: BAR.profile.start.x, y: BAR.profile.start.y, z: BAR.thickness }
  project.meta.machineDefinitions = project.meta.machineDefinitions ?? []
  project.meta.machineDefinitions = [...project.meta.machineDefinitions, rotaryMachine()]
  project.meta.selectedMachineId = 'e2e-rotary'
  project.tools = [TOOL]
  const template = project.features[0]
  const definition = project.featureDefinitions[template.definitionId]
  project.featureDefinitions = {
    ...project.featureDefinitions,
    'around-pocket': {
      ...definition,
      id: 'around-pocket',
      operation: 'subtract',
      profile: rect(POCKET.x, POCKET.y, POCKET.w, POCKET.h),
    },
  }
  project.features = [
    {
      ...template, id: 'around-pocket', name: 'Around pocket', definitionId: 'around-pocket',
      authoringFace: 'around', z_top: BAR.thickness, z_bottom: BAR.thickness - 4, transform: IDENTITY,
    },
  ]
  project.featureTree = []
  const top = { ...project.setups[0], name: 'Top', operationIds: [] }
  project.setups = [
    top,
    {
      id: 'setup-around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
      indexing: 'manual', registration: [], notes: '', operationIds: ['op-around'],
    },
  ]
  project.activeSetupId = 'setup-around'
  const base = project.operations[0]
  project.operations = [
    {
      ...base, id: 'op-around', name: 'Around pocket', kind: 'pocket',
      target: { source: 'features', featureIds: ['around-pocket'] },
      setupId: 'setup-around', toolRef: TOOL.id, stepdown: 2, stepover: 0.4,
      feed: 600, plungeFeed: 180, rpm: 18000, enabled: true, showToolpath: true,
    },
  ]
  await seedProject(page, JSON.stringify(project))
  return await getProject(page) as unknown as Project
}

test('the 3D model carries the wrapped Around feature', async ({ app, ui }, testInfo) => {
  const { page } = app
  const project = await seedAroundModelProject(page)
  expect((project.stock as RoundStock).shape).toBe('round')

  // Wait for generation before reading the scene back: an operation with no
  // tool generates nothing and the model assertions would then be vacuous.
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

  await ui.viewMenu.tab3d(page).click()
  const canvas = page.locator('#workspace-panel-preview3d canvas')
  await expect(canvas).toBeVisible()
  const overlay = page.locator('#workspace-panel-preview3d .viewport-3d')

  // The model mesh exists and carries triangles — the wrapped Around cut is in
  // the model, not only in the toolpath overlay.
  await expect.poll(
    async () => Number(await overlay.getAttribute('data-model-triangles')),
    { timeout: 15_000 },
  ).toBeGreaterThan(0)

  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('around-model-default.png') })

  // A low angle: drag the panel down and sideways so the camera drops towards
  // the bar's underside.
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const centrePx = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  await page.mouse.move(centrePx.x, centrePx.y)
  await page.mouse.down()
  await page.mouse.move(centrePx.x - 60, centrePx.y - 40, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('around-model-low-angle.png') })

  // The view is still the live scene, with the model still there, after the drag.
  await expect(canvas).toBeVisible()
  await expect.poll(
    async () => Number(await overlay.getAttribute('data-model-triangles')),
    { timeout: 5_000 },
  ).toBeGreaterThan(0)
})
