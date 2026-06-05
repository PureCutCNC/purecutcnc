/**
 * Tests for operation booklet report and PDF generation.
 *
 * Run with: npx tsx src/engine/operationBooklet/operationBooklet.test.ts
 */

import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
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
  project.features = [feature]
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
    warnings: ['Test warning'],
    bounds: { minX: 5, minY: 5, minZ: 0, maxX: 25, maxY: 21, maxZ: 5 },
    moves: [
      { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 5, y: 5, z: 5 } },
      { kind: 'plunge', from: { x: 5, y: 5, z: 5 }, to: { x: 5, y: 5, z: 0 } },
      { kind: 'cut', from: { x: 5, y: 5, z: 0 }, to: { x: 25, y: 5, z: 0 } },
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
  assert(report.settingRows.some((row) => row.label === 'Cut Direction' && row.value === 'Climb'), 'cut direction should be included')
  assert(report.settingRows.some((row) => row.label === 'Machining Order' && row.value === 'Feature first'), 'machining order should be included')
  assert(report.toolpathStats.some((row) => row.label === 'Moves' && row.value === '3'), 'toolpath move count should be included')
  assert(report.toolpathStats.some((row) => row.label === 'Estimated Feed Time' && row.value === '2.9 s (excludes G0 rapid time)'), 'estimated feed time should be included')
  assert(report.toolpathStats.some((row) => row.label === 'Rapid Travel' && row.value.includes('G0 speed machine-defined')), 'rapid travel should be included')
  assert(report.toolpathStats.some((row) => row.label === 'Top Z' && row.value === '5 mm'), 'top Z should be included')
  assert(report.toolpathStats.some((row) => row.label === 'Bottom Z' && row.value === '0 mm'), 'bottom Z should be included')
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

testReportContent()
await testPdfSmoke()
console.log('operation booklet tests passed')
