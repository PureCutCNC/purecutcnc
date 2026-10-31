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

import { readFileSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject, rowByName } from './helpers'
import { defaultTool, rectProfile, roundStock, type Project, type Tool } from '../src/types/project'

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control'

async function seed(page: Page, bottomFeature = true, machineId = 'grbl') {
  await seedGcodeExportProject(page, { machineId })
  const project = await getProject(page) as unknown as Project
  project.meta.name = 'Two sides'
  project.stock.profile = rectProfile(0,0,6,4)
  project.stock.thickness = 2
  project.origin = { ...project.origin,x:0,y:4,z:2 }
  const template = project.features[0]
  const definition = project.featureDefinitions[template.definitionId]
  project.featureDefinitions = {
    body: { ...definition,id:'body',operation:'add',profile:rectProfile(0,0,6,4) },
    blind: { ...definition,id:'blind',operation:'subtract',profile:rectProfile(0,0,1,1) },
    through: { ...definition,id:'through',operation:'subtract',profile:rectProfile(0,0,1,1) },
    bottom: { ...definition,id:'bottom',operation:'subtract',profile:rectProfile(0,0,1,1) },
  }
  project.features = [
    { ...template,id:'body',name:'Stock body',definitionId:'body',authoringFace:'top',z_top:2,z_bottom:0,transform:{ a:1,b:0,c:0,d:1,e:0,f:0 } },
    { ...template,id:'blind',name:'Top blind',definitionId:'blind',authoringFace:'top',z_top:2,z_bottom:1,transform:{ a:1,b:0,c:0,d:1,e:0.5,f:0.5 } },
    { ...template,id:'through',name:'Through hole',definitionId:'through',authoringFace:'top',z_top:2,z_bottom:0,transform:{ a:1,b:0,c:0,d:1,e:2,f:1 } },
    ...(bottomFeature ? [{ ...template,id:'bottom',name:'Bottom pocket',definitionId:'bottom',authoringFace:'bottom' as const,z_top:0.5,z_bottom:0,transform:{ a:1,b:0,c:0,d:1,e:4,f:1 } }] : []),
  ]
  project.featureTree = []
  project.operations = [{ ...project.operations[0], name:'Top pass',kind:'pocket',target:{ source:'features',featureIds:['blind','through'] },stepdown:0.5 }]
  project.setups = [project.setups[0]]
  project.activeSetupId = project.setups[0].id
  await seedProject(page,JSON.stringify(project))
}

function e2eTool(id: string, name: string, type: Tool['type'], diameter: number, maxCutDepth: number): Tool {
  return {
    ...defaultTool('mm', 1),
    id,
    name,
    type,
    diameter,
    maxCutDepth,
    vBitAngle: type === 'v_bit' ? 60 : null,
    defaultStepdown: 0.4,
    defaultStepover: 0.4,
  }
}

/**
 * The bolt's starting bar: a 20 mm round bar in a rotary project with the
 * cutters CAM Plan may choose. The Polygon/Turn/Thread rows themselves are
 * created through the drawer's own store actions after the face is switched.
 */
async function seedAroundBar(page: Page): Promise<void> {
  await seedGcodeExportProject(page)
  const project = await getProject(page) as unknown as Project
  project.meta.name = 'Around bolt'
  project.meta.units = 'mm'
  project.meta.projectType = 'rotary'
  project.meta.maxTravelZ = 30
  project.stock = roundStock(20, 120, 'x')
  project.origin = { ...project.origin, x: 0, y: 0, z: 20 }
  project.features = []
  project.featureDefinitions = {}
  project.featureTree = []
  project.featureFolders = []
  project.operations = []
  project.tabs = []
  project.clamps = []
  project.tools = [
    e2eTool('t-ball', 'Ball 2mm', 'ball_endmill', 2, 30),
    e2eTool('t-flat', 'Flat 2mm', 'flat_endmill', 2, 30),
    e2eTool('t-vbit', 'V-bit 3mm', 'v_bit', 3, 10),
  ]
  await seedProject(page, JSON.stringify(project))
}

/** Open the creation drawer on desktop; the tablet rail already shows the entries. */
async function openCreationDrawer(page: Page): Promise<void> {
  const drawerButton = page.locator('.toolbar-creation-picker__drawer-btn')
  if (await drawerButton.count() === 0) return
  const drawer = page.locator('.toolbar-creation-picker__drawer')
  if ((await drawer.count()) === 0 || !(await drawer.isVisible())) {
    await drawerButton.click()
  }
}

/**
 * Polygon head, turned shank and one thread through the drawer's rotary group,
 * as a user creates them — not through store calls. The dialog writes one
 * canned feature each; the ids are read back from the saved project afterwards.
 */
async function createAroundBolt(page: Page, ui: typeof import('./selectors')): Promise<{ polygonId: string; turnId: string; threadId: string }> {
  await openCreationDrawer(page)
  await ui.rotarySolid.polygonButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.field(page, 'start').fill('10')
  await ui.rotarySolid.field(page, 'length').fill('12')
  await ui.rotarySolid.field(page, 'sides').fill('6')
  await ui.rotarySolid.field(page, 'across-flats').fill('15')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()

  await openCreationDrawer(page)
  await ui.rotarySolid.turnButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.field(page, 'start').fill('22')
  await ui.rotarySolid.field(page, 'length').fill('30')
  await ui.rotarySolid.field(page, 'diameter').fill('14')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()

  await openCreationDrawer(page)
  await ui.rotary.threadButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeVisible()
  await ui.rotary.field(page, 'start').fill('25')
  await ui.rotary.field(page, 'length').fill('20')
  await ui.rotary.field(page, 'pitch').fill('1.5')
  await ui.rotary.field(page, 'starts').fill('1')
  await ui.rotary.field(page, 'depth').fill('0.9')
  await ui.rotary.createButton(page).click()
  await expect(ui.rotary.dialog(page)).toBeHidden()

  const project = await getProject(page) as unknown as Project
  const cannedKind = (featureId: string) => {
    const feature = project.features.find((entry) => entry.id === featureId)
    return feature ? project.featureDefinitions[feature.definitionId]?.canned?.kind : null
  }
  const polygon = project.features.find((feature) => cannedKind(feature.id) === 'polygon')
  const turn = project.features.find((feature) => cannedKind(feature.id) === 'turn')
  const thread = project.features.find((feature) => cannedKind(feature.id) === 'thread')
  if (!polygon || !turn || !thread) throw new Error('e2e: the rotary dialogs did not create all three features')
  return { polygonId: polygon.id, turnId: turn.id, threadId: thread.id }
}

interface GeneratedOperationReadout {
  moveCount: number
  errorCount: number
  warnings: string[]
}

/** Compute one operation in the page: "up to date" is not proof of motion. */
async function generatedOperation(page: Page, operationId: string): Promise<GeneratedOperationReadout> {
  return page.evaluate(async (id) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import('/src/engine/toolpaths/generateOperation.ts') as typeof import('../src/engine/toolpaths/generateOperation')
    const { warningSeverity } = await import('/src/engine/toolpaths/warningCodes.ts') as typeof import('../src/engine/toolpaths/warningCodes')
    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`e2e: the project has no operation ${id}`)
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`e2e: ${id} did not generate`)
    return {
      moveCount: envelope.result.moves.length,
      errorCount: envelope.result.warnings.filter((warning) => warningSeverity(warning.code) === 'error').length,
      warnings: envelope.result.warnings.map((warning) => warning.code),
    }
  }, operationId)
}

test('CAM Plan on Bottom proposes its pocket and explains Top-covered through work (#1106)', async ({ app, ui }, testInfo) => {
  const { page } = app
  await seed(page)
  const seeded = await getProject(page) as unknown as Project
  seeded.tools = seeded.tools.map(tool => ({ ...tool, maxCutDepth: 3 }))
  await seedProject(page, JSON.stringify(seeded))
  await ui.face.switchTo(page, 'Bottom')
  await expect(ui.setupCam.planButton(page)).toBeEnabled()
  await ui.setupCam.planButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'CAM Plan', exact: true })
  const pocketProposals = dialog.getByRole('button').filter({ hasText: 'Bottom pocket' })
  await expect(pocketProposals.first()).toBeVisible()
  const covered = dialog.locator('.cam-plan-field-note').filter({ hasText: 'Through hole' })
  await expect(covered).toContainText('Covered by the Top setup.')
  await expect(covered.locator('button, input, [tabindex]')).toHaveCount(0)
  await expect(covered).not.toHaveAttribute('role', 'button')
  await expect(dialog.getByRole('button').filter({ hasText: 'Through hole' })).toHaveCount(0)
  await expect(dialog.locator('.cam-plan-coverage')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('bottom-cam-plan.png') })
  const before = await getProject(page) as unknown as Project
  const create = dialog.getByRole('button', { name: /^Create \d+ operations$/ })
  await expect(create).toBeEnabled()
  await create.click()
  await expect(dialog).not.toBeVisible()
  await expect(ui.setupCam.section(page, 'bottom')).toContainText('Pocket')
  const after = await getProject(page) as unknown as Project
  const bottom = after.setups.find(setup => setup.id === after.activeSetupId)!
  expect(bottom.orientation.angleDeg).toBe(180)
  const added = after.operations.filter(operation => !before.operations.some(existing => existing.id === operation.id))
  expect(added.length).toBeGreaterThan(0)
  expect(added.every(operation => operation.setupId === bottom.id && bottom.operationIds.includes(operation.id))).toBe(true)
  expect(added.some(operation => operation.kind === 'pocket' && operation.target.source === 'features'
    && operation.target.featureIds.includes('bottom'))).toBe(true)
  expect(added.some(operation => operation.target.source === 'features' && operation.target.featureIds.includes('through'))).toBe(false)
  expect(after.operations.find(operation => operation.id === before.operations[0].id)).toEqual(before.operations[0])
})

/**
 * CAM Plan on Around (#1112 slice J, decision 3).
 *
 * The acceptance bolt — Polygon head + turned shank + Thread — is created
 * through the drawer's rotary group dialogs (Turn/Polygon and Thread), then
 * planned on Around. It asserts:
 * - the Plan button is enabled on Around and carries no "not available" reason;
 * - the dialog proposes two Rotary rough and two Rotary finish rows (one pair
 *   per model) plus one Engrave for the Thread, with the model names and the
 *   V-bit/ball-endmill choices;
 * - the Engrave's editable Carve depth is the pattern's 0.9 mm, not 1 mm;
 * - nothing is created before Create is pressed;
 * - applying creates exactly five Around operations;
 * - every one of the five generates motion with no blocking warning;
 * - one undo removes the five operations and keeps the three features.
 */
test('CAM Plan on Around plans the bolt: rotary rough/finish and a V-bit engraving (#1112 J)', async ({ app, ui }, testInfo) => {
  test.setTimeout(120_000)
  const { page } = app
  await seedAroundBar(page)
  await ui.face.switchTo(page, 'Around')
  const ids = await createAroundBolt(page, ui)

  const planButton = ui.setupCam.planButton(page)
  await expect(planButton).toBeEnabled()
  await expect(planButton).not.toHaveAttribute('title', /not available/i)
  await planButton.click()
  const dialog = page.getByRole('dialog', { name: 'CAM Plan', exact: true })
  await expect(dialog).toBeVisible()

  const rough = dialog.locator('.cam-plan-row').filter({ hasText: 'Rotary rough · Rough' })
  const finish = dialog.locator('.cam-plan-row').filter({ hasText: 'Rotary finish · Finish' })
  const engrave = dialog.locator('.cam-plan-row').filter({ hasText: 'Engrave · Rough' })
  await expect(rough).toHaveCount(2)
  await expect(finish).toHaveCount(2)
  await expect(engrave).toHaveCount(1)
  await expect(rough.filter({ hasText: 'Hex' })).toHaveCount(1)
  await expect(rough.filter({ hasText: 'Turn' })).toHaveCount(1)
  await expect(engrave).toContainText('Thread')
  await expect(engrave).toContainText('V-bit 3mm')
  await expect(rough.first()).toContainText('Ball 2mm')
  await expect(finish.first()).toContainText('Ball 2mm')

  // The plan is a proposal: nothing exists until it is applied.
  const before = await getProject(page) as unknown as Project
  expect(before.operations).toEqual([])

  await engrave.click()
  const carveDepth = dialog.locator('.cam-plan-field').filter({ hasText: 'Carve depth' }).locator('input')
  await expect(carveDepth).toHaveValue('0.9')
  await dialog.screenshot({ path: testInfo.outputPath('around-cam-plan.png') })

  const create = dialog.getByRole('button', { name: /^Create \d+ operations$/ })
  await expect(create).toBeEnabled()
  await expect(create).toHaveText('Create 5 operations')
  await create.click()
  await expect(dialog).not.toBeVisible()

  const after = await getProject(page) as unknown as Project
  expect(after.operations).toHaveLength(5)
  const around = after.setups.find((setup) => setup.kind === 'around')
  expect(around).toBeDefined()
  expect(after.operations.every((operation) => operation.setupId === around!.id)).toBe(true)
  expect(after.operations.filter((operation) => operation.kind === 'rotary_rough')).toHaveLength(2)
  expect(after.operations.filter((operation) => operation.kind === 'rotary_finish')).toHaveLength(2)
  expect(after.operations.find((operation) => operation.kind === 'follow_line')).toBeDefined()
  const engraveOperation = after.operations.find((operation) => operation.kind === 'follow_line')!
  expect(engraveOperation.carveDepth).toBeCloseTo(0.9, 9)
  expect(engraveOperation.target.source).toBe('features')
  if (engraveOperation.target.source === 'features') {
    expect(engraveOperation.target.featureIds).toEqual([ids.threadId])
  }
  expect(after.tools.find((tool) => tool.id === engraveOperation.toolRef)?.type).toBe('v_bit')

  // Generation: all five operations really produce motion, with no warning
  // that blocks them. The gear settling is the app's own queue; the compute
  // below is the same generator the preview and export run.
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
  for (const operation of after.operations) {
    const generated = await generatedOperation(page, operation.id)
    expect(generated.moveCount, `${operation.name} generated no motion`).toBeGreaterThan(0)
    expect(generated.errorCount, `${operation.name} blocked: ${generated.warnings.join(', ')}`).toBe(0)
  }

  // The whole plan is one history step: one undo removes the five operations
  // and leaves the three features the dialogs created.
  await page.keyboard.press(`${modKey}+z`)
  const undone = await getProject(page) as unknown as Project
  expect(undone.operations).toEqual([])
  expect(undone.features).toHaveLength(3)
})

for (const machine of ['grbl','shopbot']) {
  test(`Bottom Add, cross-face target and two downloaded ${machine} programs`, async ({ app, ui },testInfo) => {
    const { page } = app
    await seed(page,true,machine)
    writeFileSync(testInfo.outputPath('two-sides.camj'),JSON.stringify(await getProject(page),null,2))
    await ui.face.switchTo(page, 'Bottom')
    await expect(ui.setupCam.planButton(page)).toBeEnabled()
    await expect(ui.setupCam.planButton(page)).not.toHaveAttribute('title',/top face only/)
    // Select both targets before Add: a through feature is an ordinary
    // selectable row on Bottom now, so plain selection expresses the cross-face
    // target the checklist used to add (issue #1112 I).
    await rowByName(page,'Bottom pocket').click()
    await rowByName(page,'Through hole').click({ modifiers:['Shift'] })
    await ui.setupCam.add(page).click()
    await ui.setupCam.addMenu(page).getByText('Pocket',{ exact:true }).first().click()
    // Pass controls operate on the Bottom sketch selection.
    await ui.setupCam.addMenu(page).getByRole('button',{ name:'Rough',exact:true }).first().click()
    await expect(ui.setupCam.section(page,'bottom')).toContainText('Pocket')
    // A one-line card header shows the short chip; the toggle keeps the full
    // wording as its accessible name (issue #1102).
    await expect(ui.setupCam.section(page,'bottom')).toContainText('P02')
    await expect(ui.setupCam.section(page,'bottom').getByRole('button',{ name:/^Bottom operations 1 PROGRAM 02$/ })).toBeVisible()
    await expect(ui.setupCam.section(page,'bottom')).toHaveAttribute('data-active','true')
    const panel = await page.locator('.cam-panel').boundingBox()
    // Every toolbar control, the eye and gear in their own group included (#1102).
    for (const control of await page.locator('.cam-operations-toolbar button').all()) {
      const box = await control.boundingBox()
      expect(box!.x+box!.width).toBeLessThanOrEqual(panel!.x+panel!.width+1)
    }
    // The Cuts list names both targets, and the through one is marked
    // cross-face on the setup card (issue #1112 I).
    const cuts = ui.setupCam.properties(page).locator('[data-operation-cuts]')
    await expect(cuts).toContainText('Bottom pocket')
    await expect(cuts).toContainText('Through hole')
    // Each row's own name is visible, not squeezed out by its remove ×
    // (issue #1112 rt3-a, item 25).
    for (const id of ['bottom', 'through']) {
      const row = cuts.locator(`[data-cut-feature-id="${id}"]`)
      await expect(row.locator('.cam-cuts__name')).toBeVisible()
      await expect(row.locator('.cam-cuts__icon')).toBeVisible()
    }
    await expect(ui.setupCam.section(page,'bottom')).toContainText('⇄ CROSS-FACE')
    // Only the through target is cut from both setups, so only it gets a reach
    // card; the one-sided Bottom pocket gets none and no check is offered for it
    // (issue #1112 item 38).
    const reachSection = ui.setupCam.properties(page).locator('.cam-setup-reach')
    const reach = reachSection.locator('.cam-setup-reach__target')
    await expect(reach).toHaveCount(1)
    await expect(reach).toContainText('Through hole')
    await expect(reach).not.toContainText('Bottom pocket')
    // The explanation is the section's intro line, above the cards, not text
    // inside a card (issue #1112 item 38).
    await expect(reachSection.locator('.cam-setup-reach__intro')).toHaveText('This feature is cut from both sides. Check that the two passes meet in the middle.')
    await expect(reach).not.toContainText('This feature is cut from both sides.')
    await ui.setupCam.properties(page).getByRole('button',{ name:'Check the passes meet' }).click()
    await expect(ui.setupCam.properties(page)).toContainText('Generated reach in stock Z:')
    await expect(ui.setupCam.properties(page)).toContainText('Meets the other pass')
    await page.screenshot({ path:testInfo.outputPath('bottom-cam.png') })
    await page.evaluate(() => { Object.defineProperty(window,'showSaveFilePicker',{ value:undefined,configurable:true }) })
    await ui.operations.headerExportButton(page).click()
    await expect(ui.exportDialog.exportButton(page)).toBeEnabled()
    const downloads: string[] = []
    page.on('download',download => downloads.push(download.suggestedFilename()))
    await ui.exportDialog.exportButton(page).click()
    const ext = machine === 'shopbot' ? 'sbp' : 'nc'
    await expect.poll(() => downloads.sort()).toEqual([`Two_sides_01_top.${ext}`,`Two_sides_02_bottom.${ext}`])
    await ui.setupCam.section(page,'bottom').getByRole('button',{ name:'Export setup: Bottom',exact:true }).click()
    await expect(page.getByRole('checkbox',{ name:/Top pass/ })).not.toBeChecked()
    await expect(page.getByRole('checkbox',{ name:/Pocket Rough/ })).toBeChecked()
    await expect(ui.exportDialog.exportButton(page)).toBeEnabled()
    await ui.exportDialog.exportButton(page).click()
    await expect.poll(() => downloads.length).toBe(3)
    expect(downloads.at(-1)).toBe(`Two_sides_02_bottom_Pocket_Rough.${ext}`)

  })
}

test('provisional Bottom Add reaches a through feature as a normal row', async ({ app, ui }) => {
  const { page } = app
  await seed(page,false)
  await ui.face.switchTo(page, 'Bottom')
  await expect(ui.setupCam.section(page,'bottom')).toContainText('No operations')
  // A through cut belongs to both flat faces: its row is selectable on Bottom,
  // never a ghost, and selecting it is how the cross-face target is expressed
  // now that the other-face checklist is gone (issue #1112 I).
  await rowByName(page,'Through hole').click()
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveAttribute('data-feature-id','through')
  await expect(page.locator('.tree-row--feature[data-ghost="true"].tree-row--selected')).toHaveCount(0)
  await ui.setupCam.add(page).click()
  await ui.setupCam.addMenu(page).getByRole('button',{ name:'Rough',exact:true }).first().click()
  await expect(ui.setupCam.section(page,'bottom')).toContainText('⇄ CROSS-FACE')
  const project = await getProject(page) as unknown as Project
  expect(project.operations.at(-1)?.target).toEqual({ source:'features',featureIds:['through'] })
  const bottom = project.setups.find(setup => setup.orientation.angleDeg === 180)!
  expect(project.operations.at(-1)?.setupId).toBe(bottom.id)
  expect(bottom.id).not.toBe('provisional-bottom')
})

test('Move lists removed targets and setup deletion lists its operations', async ({ app, ui }) => {
  const { page } = app
  await seed(page,false)
  // Operations are selected on their own face (issue #1102), and Move lists
  // only real setups from there: give Bottom its setup first by adding an
  // operation to it, then pick Top pass on Top.
  await ui.face.switchTo(page, 'Bottom')
  await rowByName(page,'Through hole').click()
  await ui.setupCam.add(page).click()
  await ui.setupCam.addMenu(page).getByRole('button',{ name:'Rough',exact:true }).first().click()
  await expect(ui.setupCam.section(page,'bottom')).toContainText('Pocket')
  await ui.face.switchTo(page, 'Top')
  // From Top, the Bottom operation is a ghost row: listed, dimmed, and
  // selectable (the click turns the workspace over to its face, issue #1112
  // F3). The inactive setup's card starts collapsed.
  await ui.setupCam.section(page,'bottom').getByRole('button',{ name:/Bottom operations/ }).click()
  await expect(ui.setupCam.section(page,'bottom').locator('.tree-row--ghost')).toHaveCount(1)
  await ui.operations.rowByName(page,'Top pass').click()
  await ui.setupCam.properties(page).getByRole('button',{ name:'Move…',exact:true }).click()
  const move = ui.setupCam.dialog(page)
  await expect(move).toContainText('Targets removed by this move:')
  await expect(move).toContainText('Top blind')
  await move.getByRole('button',{ name:'Move operation',exact:true }).click()
  await expect(ui.setupCam.section(page,'bottom')).toContainText('Top pass')
  await ui.setupCam.section(page,'bottom').getByRole('button',{ name:'Setup properties: Bottom',exact:true }).click()
  const properties = ui.setupCam.dialog(page)
  await properties.getByLabel('Name',{ exact:true }).fill('Back machining')
  await properties.getByRole('combobox',{ name:'Flip about',exact:true }).selectOption('y')
  await properties.getByLabel('Operator notes').fill('Seat on fixture pins')
  await properties.getByRole('combobox',{ name:'Feature',exact:true }).selectOption('through')
  await properties.getByRole('button',{ name:'Add reference',exact:true }).click()
  await properties.getByRole('button',{ name:'Save setup' }).click()
  await ui.setupCam.section(page,'bottom').getByRole('button',{ name:'Setup properties: Back machining',exact:true }).click()
  await ui.setupCam.dialog(page).getByRole('button',{ name:'Delete setup…' }).click()
  await expect(ui.setupCam.dialog(page)).toContainText('Top pass')
  await ui.setupCam.dialog(page).getByRole('button',{ name:'Delete setup and operations' }).click()
  await expect(ui.operations.rowByName(page,'Top pass')).toHaveCount(0)
})

test('Bottom Add targets an imported model as a normal selectable row', async ({ app, ui }) => {
  const { page } = app
  const imported = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj',import.meta.url),'utf8')) as Project
  imported.operations = []
  await seedProject(page,JSON.stringify(imported))
  const loaded = await getProject(page) as unknown as Project
  const model = loaded.features.find((feature) => loaded.featureDefinitions[feature.definitionId].kind === 'stl')!
  await ui.face.switchTo(page, 'Bottom')
  // An imported model is not tied to a face: its row is selectable on Bottom,
  // never a ghost, and selection is the only target route now (issue #1112 I).
  await rowByName(page,model.name).click()
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveAttribute('data-feature-id',model.id)
  await expect(page.locator('.tree-row--feature[data-ghost="true"].tree-row--selected')).toHaveCount(0)
  await ui.setupCam.add(page).click()
  const row = ui.setupCam.addMenu(page).locator('.cam-operation-item').filter({ has:page.getByRole('button',{ name:'3D surface rough',exact:true }) })
  await row.getByRole('button',{ name:'Add',exact:true }).click()
  await expect(ui.setupCam.section(page,'bottom')).toContainText('⇄ CROSS-FACE')
  const after = await getProject(page) as unknown as Project
  expect(after.operations[0].kind).toBe('rough_surface')
  expect(after.operations[0].target).toEqual({ source:'features',featureIds:[model.id] })
  expect(after.operations[0].setupId).toBe(after.setups.find((setup) => setup.orientation.angleDeg === 180)!.id)
})

test.describe('landscape touch tablet', () => {
  test.use({ viewport:{ width:1024,height:768 },hasTouch:true })

test('setup properties fit a landscape tablet and keyboard cancel restores focus', async ({ app, ui },testInfo) => {
  const { page } = app
  await page.setViewportSize({ width:1024,height:768 })
  await seed(page,false)
  await ui.face.switchTo(page, 'Bottom')
  await page.getByRole('button',{ name:'Open operations panel',exact:true }).tap()
  const trigger = ui.setupCam.section(page,'bottom').getByRole('button',{ name:'Setup properties: Bottom',exact:true })
  await trigger.click()
  const dialog = ui.setupCam.dialog(page)
  await expect(dialog).toContainText('No registration references')
  const box = await dialog.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y+box!.height).toBeLessThanOrEqual(768)
  // Face up is one read-only chip, and Delete setup… shares the footer row
  // with Save (issue #1102).
  await expect(dialog.locator('.face-chip--bottom')).toHaveText('Bottom')
  await expect(dialog.getByRole('button',{ name:'Top',exact:true })).toHaveCount(0)
  const saveBox = await dialog.getByRole('button',{ name:'Save setup' }).boundingBox()
  expect(saveBox!.height).toBeGreaterThanOrEqual(44)
  const deleteBox = await dialog.getByRole('button',{ name:'Delete setup…' }).boundingBox()
  expect(Math.abs(deleteBox!.y-saveBox!.y)).toBeLessThanOrEqual(1)
  expect(deleteBox!.x).toBeLessThan(saveBox!.x)
  await page.screenshot({ path:testInfo.outputPath('tablet-dialog.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  const project = await getProject(page) as unknown as Project
  expect(project.setups).toHaveLength(1)
})

})
