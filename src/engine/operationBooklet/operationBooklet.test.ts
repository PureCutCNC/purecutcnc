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
 * Tests for operation booklet report and PDF generation.
 *
 * Run with: npx tsx src/engine/operationBooklet/operationBooklet.test.ts
 */

import { readFile } from 'node:fs/promises'
import { resetI18nStoreForTests, setActiveLocale, translate } from '../../i18n/store'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
import { replaceProjectFeatures } from '../../test/projectFixtures'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathResult } from '../toolpaths/types'
import { createOperationBookletPdf } from './pdf'
import { buildOperationBookletReport } from './report'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function expectedLocalTimestamp(date: Date): string {
  const timezoneOffsetMinutes = -date.getTimezoneOffset()
  const offsetSign = timezoneOffsetMinutes >= 0 ? '+' : '-'
  const absOffsetMinutes = Math.abs(timezoneOffsetMinutes)
  const offsetHours = Math.floor(absOffsetMinutes / 60)
  const offsetMinutes = absOffsetMinutes % 60
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
    `UTC${offsetSign}${pad2(offsetHours)}:${pad2(offsetMinutes)}`,
  ].join(' ')
}

function fixture(): { project: Project; operation: Operation; toolpath: ToolpathResult } {
  const project = newProject('Booklet Test', 'mm')
  project.origin = { name: 'Work Zero', x: 2, y: 4, z: 6, visible: true }
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }]
  const feature: SketchFeature = {
    id: 'f-pocket',
    name: 'Pocket Region',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(5, 5, 20, 16),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: project.stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  replaceProjectFeatures(project, [feature])
  const operation: Operation = {
    id: 'op1',
    name: 'Rough pocket',
    description: 'Clear pocket before finish pass',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [feature.id] },
    toolRef: project.tools[0].id,
    stepdown: 1,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 220,
    rpm: 14000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0.2,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'climb',
    machiningOrder: 'feature_first',
  }
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [{ code: 'debug' as const, params: { text: 'Test warning' } }],
    bounds: { minX: 5, minY: 5, minZ: 0, maxX: 25, maxY: 21, maxZ: 5 },
    moves: [
      { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 5, y: 5, z: 5 } },
      { kind: 'plunge', from: { x: 5, y: 5, z: 5 }, to: { x: 5, y: 5, z: 0 } },
      { kind: 'cut', from: { x: 5, y: 5, z: 0 }, to: { x: 25.1234, y: 5, z: 0 } },
    ],
  }
  return { project, operation, toolpath }
}

function testReportContent(): void {
  console.log('Testing operation booklet report content...')
  const { project, operation, toolpath } = fixture()
  const generatedAt = new Date('2026-06-04T12:00:00Z')
  const report = buildOperationBookletReport({
    project,
    operation,
    tool: normalizeToolForProject(project.tools[0], project),
    toolpath,
    generatedAt,
  })

  assert(report.projectName === 'Booklet Test', 'project name should be included')
  assert(report.operationName === 'Rough pocket', 'operation name should be included')
  assert(report.operationDescription === 'Clear pocket before finish pass', 'description should be included')
  assert(report.generatedDate === expectedLocalTimestamp(generatedAt), 'generated date should use local time with offset')
  assert(report.stockSizeSummary === '100 mm x 80 mm x 20 mm', 'stock size should be included')
  assert(report.originZSummary === '6 mm', 'origin Z should be included')
  assert(report.targetSummary === 'Pocket Region', 'target summary should list target feature names')
  assert(report.targetFeatureNames.includes('Pocket Region'), 'target feature name should be included')
  assert(report.warnings.includes('Test warning'), 'toolpath warnings should be included')
  assert(report.settingRows.some((row) => row.label === translate('booklet.label.cutDirection') && row.value === translate('booklet.cutDirection.climb')), 'cut direction should be included')
  assert(report.settingRows.some((row) => row.label === translate('booklet.label.machiningOrder') && row.value === translate('booklet.machiningOrder.featureFirst')), 'machining order should be included')
  assert(!report.settingRows.some((row) => row.label === translate('booklet.label.roundOutsideCorners')), 'disabled round outside corners should not be included')
  assert(report.toolpathStats.some((row) => row.label === translate('booklet.label.moves') && row.value === '3'), 'toolpath move count should be included')
  assert(report.toolpathStats.some((row) => row.label === translate('booklet.label.estimatedFeedTime') && row.value === translate('booklet.value.estimatedFeedTime', { duration: '2.9 s' })), 'estimated feed time should be included')
  assert(report.toolpathStats.some((row) => row.label === translate('booklet.label.feedTravel') && row.value === translate('booklet.value.feedTravel', { distance: '25.12 mm' })), 'feed travel should be rounded to 2 decimals')
  assert(report.toolpathStats.some((row) => row.label === translate('booklet.label.rapidTravel') && row.value.includes('G0')), 'rapid travel should be included')
  assert(report.toolpathStats.some((row) => row.label === translate('booklet.label.topZ') && row.value === '5 mm'), 'top Z should be included')
  assert(report.toolpathStats.some((row) => row.label === translate('booklet.label.bottomZ') && row.value === '0 mm'), 'bottom Z should be included')
}

function testReportIncludesEnabledRoundOutsideCorners(): void {
  console.log('Testing operation booklet reports enabled round outside corners...')
  const { project, operation, toolpath } = fixture()
  const report = buildOperationBookletReport({
    project,
    operation: {
      ...operation,
      kind: 'edge_route_outside',
      roundOutsideCorners: true,
    },
    tool: normalizeToolForProject(project.tools[0], project),
    toolpath,
    generatedAt: new Date('2026-06-04T12:00:00Z'),
  })

  assert(
    report.settingRows.some((row) => row.label === translate('booklet.label.roundOutsideCorners') && row.value === translate('booklet.value.enabled')),
    'enabled round outside corners should be reported for outside edge routes',
  )
}

async function testPdfSmoke(): Promise<void> {
  console.log('Testing operation booklet PDF smoke output...')
  const { project, operation, toolpath } = fixture()
  const pdfBytes = await createOperationBookletPdf({
    project,
    operation,
    tool: normalizeToolForProject(project.tools[0], project),
    toolpath,
    generatedAt: new Date('2026-06-04T12:00:00Z'),
  })

  assert(pdfBytes.byteLength > 500, `expected non-empty PDF, got ${pdfBytes.byteLength} bytes`)
  const header = new TextDecoder().decode(pdfBytes.slice(0, 5))
  assert(header === '%PDF-', `expected PDF header, got ${header}`)
}

function testLocalizedReportContent(): void {
  console.log('Testing localized operation booklet report content...')
  const { project, operation, toolpath } = fixture()
  setActiveLocale('zh-CN')
  try {
    const report = buildOperationBookletReport({
      project,
      operation,
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath,
      generatedAt: new Date('2026-06-04T12:00:00Z'),
    })
    assert(report.units === translate('booklet.units.millimeter'), 'unit word should use the active catalog')
    assert(report.settingRows.some((row) => row.label === translate('booklet.label.cutDirection') && row.value === translate('booklet.cutDirection.climb')), 'localized cut-direction row should be present')
    assert(report.toolpathStats.some((row) => row.label === translate('booklet.label.estimatedFeedTime')), 'localized toolpath rows should be present')
  } finally {
    resetI18nStoreForTests()
  }
}

async function testPdfUnicodeFontRetriesAndUsesBold(): Promise<void> {
  console.log('Testing operation booklet Unicode PDF font retry and bold output...')
  const { project, operation, toolpath } = fixture()
  const originalFetch = globalThis.fetch
  let fontRequests = 0
  const requestedUrls: string[] = []
  globalThis.fetch = async (input) => {
    fontRequests += 1
    requestedUrls.push(String(input))
    if (fontRequests === 1) return new Response(null, { status: 503 })
    const fontPath = String(input).includes('-bold.ttf')
      ? '../../../public/fonts/noto-sans-sc-booklet-bold.ttf'
      : '../../../public/fonts/noto-sans-sc-booklet.ttf'
    return new Response(await readFile(new URL(fontPath, import.meta.url)))
  }
  setActiveLocale('zh-CN')
  try {
    project.meta.name = '中文项目'
    toolpath.warnings = [{ code: 'debug', params: { text: translate('warnings.noToolAssigned') } }]
    let firstAttemptFailed = false
    try {
      await createOperationBookletPdf({
        project,
        operation,
        tool: normalizeToolForProject(project.tools[0], project),
        toolpath,
        generatedAt: new Date('2026-06-04T12:00:00Z'),
      })
    } catch {
      firstAttemptFailed = true
    }
    assert(firstAttemptFailed, 'failed font fetch should reject the first PDF attempt')

    const pdfBytes = await createOperationBookletPdf({
      project,
      operation,
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath,
      generatedAt: new Date('2026-06-04T12:00:00Z'),
    })
    assert(fontRequests === 4, `expected retry to request both fonts again, got ${fontRequests} requests`)
    assert(requestedUrls.some((url) => url.includes('noto-sans-sc-booklet.ttf')), 'regular Unicode font should be requested')
    assert(requestedUrls.some((url) => url.includes('noto-sans-sc-booklet-bold.ttf')), 'bold Unicode font should be requested')
    assert(pdfBytes.byteLength > 200_000, `expected both embedded Unicode font assets, got ${pdfBytes.byteLength} bytes`)
    assert(new TextDecoder().decode(pdfBytes.slice(0, 5)) === '%PDF-', 'Unicode output should be a PDF')
  } finally {
    globalThis.fetch = originalFetch
    resetI18nStoreForTests()
  }
}

function testFeedTimeUsesScaledSlotFeed(): void {
  console.log('Testing estimated feed time prices slot-feed fragments at the scaled feed...')
  const { project, operation } = fixture()
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves: [
      // 20 mm at the full 800 mm/min = 1.5 s, plus 20 mm slotting at 10%
      // (80 mm/min) = 15 s. Pricing both at the full feed would report 3 s.
      { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 } },
      { kind: 'cut', from: { x: 20, y: 0, z: 0 }, to: { x: 40, y: 0, z: 0 }, feedScale: 0.1 },
    ],
  }
  const report = buildOperationBookletReport({
    project,
    operation: { ...operation, pocketSlotFeedPercent: 10 },
    tool: normalizeToolForProject(project.tools[0], project),
    toolpath,
    generatedAt: new Date('2026-06-04T12:00:00Z'),
  })

  assert(
    report.toolpathStats.some((row) => row.label === translate('booklet.label.estimatedFeedTime') && row.value === translate('booklet.value.estimatedFeedTime', { duration: '16.5 s' })),
    'feed time should price feedScale fragments at the scaled feed',
  )
  assert(
    report.settingRows.some((row) => row.label === translate('booklet.label.slotFeed') && row.value === translate('booklet.value.slotFeed', { percent: 10 })),
    'slot feed setting should be reported',
  )
}

testReportContent()
testFeedTimeUsesScaledSlotFeed()
testReportIncludesEnabledRoundOutsideCorners()
testLocalizedReportContent()
await testPdfSmoke()
await testPdfUnicodeFontRetriesAndUsesBold()
console.log('operation booklet tests passed')
