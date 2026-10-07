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
import { rectProfile, type Project } from '../src/types/project'

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

for (const machine of ['grbl','shopbot']) {
  test(`Bottom Add, cross-face target and two downloaded ${machine} programs`, async ({ app, ui },testInfo) => {
    const { page } = app
    await seed(page,true,machine)
    writeFileSync(testInfo.outputPath('two-sides.camj'),JSON.stringify(await getProject(page),null,2))
    await ui.face.segment(page,'Bottom').click()
    await rowByName(page,'Bottom pocket').click()
    await ui.setupCam.add(page).click()
    await ui.setupCam.addMenu(page).getByText('Pocket',{ exact:true }).first().click()
    // Pass controls operate on the Bottom sketch selection.
    await ui.setupCam.addMenu(page).getByRole('button',{ name:'Rough',exact:true }).first().click()
    await expect(ui.setupCam.section(page,'bottom')).toContainText('Pocket')
    await expect(ui.setupCam.section(page,'bottom')).toContainText('PROGRAM 02')
    await expect(ui.setupCam.section(page,'bottom')).toHaveAttribute('data-active','true')
    const panel = await page.locator('.cam-panel').boundingBox()
    for (const control of await page.locator('.cam-section-header-actions > button').all()) {
      const box = await control.boundingBox()
      expect(box!.x+box!.width).toBeLessThanOrEqual(panel!.x+panel!.width+1)
    }
    const checkbox = ui.setupCam.properties(page).getByRole('checkbox',{ name:/Through hole/ })
    await checkbox.check()
    await expect(ui.setupCam.section(page,'bottom')).toContainText('⇄ CROSS-FACE')
    await ui.setupCam.properties(page).getByRole('button',{ name:'Check generated reach' }).click()
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

test('provisional Bottom cross-face Add does not select a ghost', async ({ app, ui }) => {
  const { page } = app
  await seed(page,false)
  await ui.face.segment(page,'Bottom').click()
  await expect(ui.setupCam.section(page,'bottom')).toContainText('No operations')
  await ui.setupCam.add(page).click()
  await ui.setupCam.addMenu(page).getByRole('checkbox',{ name:/Through hole/ }).check()
  await ui.setupCam.addMenu(page).getByRole('button',{ name:'Rough',exact:true }).first().click()
  await expect(ui.setupCam.section(page,'bottom')).toContainText('⇄ CROSS-FACE')
  await expect(page.locator('.tree-row--feature[data-ghost="true"].tree-row--selected')).toHaveCount(0)
  const project = await getProject(page) as unknown as Project
  const bottom = project.setups.find(setup => setup.orientation.angleDeg === 180)!
  expect(project.operations.at(-1)?.setupId).toBe(bottom.id)
  expect(bottom.id).not.toBe('provisional-bottom')
})

test('Move lists removed targets and setup deletion lists its operations', async ({ app, ui }) => {
  const { page } = app
  await seed(page,false)
  await ui.face.segment(page,'Bottom').click()
  await ui.setupCam.section(page,'top').getByRole('button',{ name:/Top operations/ }).click()
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

test('Bottom Add explicitly targets an imported model without selecting its ghost', async ({ app, ui }) => {
  const { page } = app
  const imported = JSON.parse(readFileSync(new URL('../src/engine/test-fixtures/3d-imported-block-test3.camj',import.meta.url),'utf8')) as Project
  imported.operations = []
  await seedProject(page,JSON.stringify(imported))
  const loaded = await getProject(page) as unknown as Project
  const model = loaded.features.find((feature) => loaded.featureDefinitions[feature.definitionId].kind === 'stl')!
  await ui.face.segment(page,'Bottom').click()
  await ui.setupCam.add(page).click()
  await ui.setupCam.addMenu(page).locator('.cam-cross-face-picker label').filter({ hasText:model.name }).locator('input').check()
  const row = ui.setupCam.addMenu(page).locator('.cam-operation-item').filter({ has:page.getByRole('button',{ name:'3D surface rough',exact:true }) })
  await row.getByRole('button',{ name:'Add',exact:true }).click()
  await expect(ui.setupCam.section(page,'bottom')).toContainText('⇄ CROSS-FACE')
  const after = await getProject(page) as unknown as Project
  expect(after.operations[0].kind).toBe('rough_surface')
  expect(after.operations[0].target).toEqual({ source:'features',featureIds:[model.id] })
  expect(after.operations[0].setupId).toBe(after.setups.find((setup) => setup.orientation.angleDeg === 180)!.id)
  await expect(page.locator('.tree-row--feature[data-ghost="true"].tree-row--selected')).toHaveCount(0)
})

test.describe('landscape touch tablet', () => {
  test.use({ viewport:{ width:1024,height:768 },hasTouch:true })

test('setup properties fit a landscape tablet and keyboard cancel restores focus', async ({ app, ui },testInfo) => {
  const { page } = app
  await page.setViewportSize({ width:1024,height:768 })
  await seed(page,false)
  await ui.face.segment(page,'Bottom').tap()
  await page.getByRole('button',{ name:'Open operations panel',exact:true }).tap()
  const trigger = ui.setupCam.section(page,'bottom').getByRole('button',{ name:'Setup properties: Bottom',exact:true })
  await trigger.click()
  const dialog = ui.setupCam.dialog(page)
  await expect(dialog).toContainText('No registration references')
  const box = await dialog.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y+box!.height).toBeLessThanOrEqual(768)
  const topFaceBox = await dialog.getByRole('button',{ name:'Top',exact:true }).boundingBox()
  const bottomFaceBox = await dialog.getByRole('button',{ name:'Bottom',exact:true }).boundingBox()
  expect(topFaceBox!.y).toBe(bottomFaceBox!.y)
  const saveBox = await dialog.getByRole('button',{ name:'Save setup' }).boundingBox()
  expect(saveBox!.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path:testInfo.outputPath('tablet-dialog.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  const project = await getProject(page) as unknown as Project
  expect(project.setups).toHaveLength(1)
})

})
