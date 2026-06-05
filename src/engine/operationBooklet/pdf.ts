import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFPage, PDFFont } from 'pdf-lib'
import { buildOperationBookletReport } from './report'
import type { OperationBookletInput, OperationBookletReport, OperationBookletRow } from './types'

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 42
const BODY_SIZE = 9
const SECTION_SIZE = 11
const COLUMN_GAP = 24
const BODY_TOP = PAGE_HEIGHT - MARGIN
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2

interface DrawState {
  pdfDoc: PDFDocument
  page: PDFPage
  y: number
  regular: PDFFont
  bold: PDFFont
  columns: boolean
  column: 0 | 1
  columnTopY: number
}

function pdfSafeText(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, '?')
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = pdfSafeText(text).split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']

  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || current.length === 0) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function currentX(state: DrawState): number {
  return state.columns && state.column === 1
    ? MARGIN + COLUMN_WIDTH + COLUMN_GAP
    : MARGIN
}

function currentWidth(state: DrawState): number {
  return state.columns ? COLUMN_WIDTH : CONTENT_WIDTH
}

function ensureSpace(state: DrawState, required: number): void {
  if (state.y - required >= MARGIN) return

  if (state.columns && state.column === 0) {
    state.column = 1
    state.y = state.columnTopY
    return
  }

  state.page = state.pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  state.y = BODY_TOP
  if (state.columns) {
    state.column = 0
    state.columnTopY = BODY_TOP
  }
}

function drawLine(state: DrawState, text: string, x: number, size = BODY_SIZE, bold = false): void {
  const font = bold ? state.bold : state.regular
  state.page.drawText(pdfSafeText(text), {
    x,
    y: state.y,
    size,
    font,
    color: rgb(0.12, 0.14, 0.18),
  })
  state.y -= size + 4
}

function drawWrapped(state: DrawState, text: string, x: number, width: number, size = BODY_SIZE): void {
  const effectiveWidth = state.columns ? currentWidth(state) : width
  const lines = wrapText(text, state.regular, size, effectiveWidth)
  ensureSpace(state, lines.length * (size + 4))
  const effectiveX = state.columns ? currentX(state) : x
  for (const line of lines) {
    drawLine(state, line, effectiveX, size)
  }
}

function drawSection(state: DrawState, title: string): void {
  ensureSpace(state, 28)
  const x = currentX(state)
  const width = currentWidth(state)
  state.y -= 8
  drawLine(state, title, x, SECTION_SIZE, true)
  state.page.drawLine({
    start: { x, y: state.y + 6 },
    end: { x: x + width, y: state.y + 6 },
    thickness: 0.5,
    color: rgb(0.68, 0.72, 0.76),
  })
}

function drawRows(state: DrawState, rows: OperationBookletRow[]): void {
  for (const row of rows) {
    const width = currentWidth(state)
    const labelW = state.columns ? 104 : 136
    const gapW = 8
    const valueW = width - labelW - gapW
    const labelLines = wrapText(row.label, state.bold, BODY_SIZE, labelW)
    const valueLines = wrapText(row.value, state.regular, BODY_SIZE, valueW)
    const lineCount = Math.max(1, labelLines.length, valueLines.length)
    ensureSpace(state, lineCount * (BODY_SIZE + 4) + 2)
    const x = currentX(state)
    const labelX = x
    const valueX = x + labelW + gapW
    for (let index = 0; index < labelLines.length; index += 1) {
      state.page.drawText(labelLines[index], {
        x: labelX,
        y: state.y - index * (BODY_SIZE + 4),
        size: BODY_SIZE,
        font: state.bold,
        color: rgb(0.28, 0.32, 0.36),
      })
    }
    for (let index = 0; index < valueLines.length; index += 1) {
      state.page.drawText(valueLines[index], {
        x: valueX,
        y: state.y - index * (BODY_SIZE + 4),
        size: BODY_SIZE,
        font: state.regular,
        color: rgb(0.12, 0.14, 0.18),
      })
    }
    state.y -= lineCount * (BODY_SIZE + 4) + 2
  }
}

function descriptionRows(report: OperationBookletReport): OperationBookletRow[] {
  return [
    { label: 'Project', value: report.projectName },
    { label: 'Generated', value: report.generatedDate },
    { label: 'Units', value: report.units },
    { label: 'Stock Size', value: report.stockSizeSummary },
    { label: 'Origin Z', value: report.originZSummary },
    { label: 'Target', value: report.targetSummary },
  ]
}

function beginColumns(state: DrawState): void {
  state.columns = true
  state.column = 0
  state.columnTopY = state.y
}

function drawPageNumbers(pdfDoc: PDFDocument, font: PDFFont): void {
  const pages = pdfDoc.getPages()
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    const label = `Page ${index + 1} of ${pages.length}`
    const size = 8
    const width = font.widthOfTextAtSize(label, size)
    page.drawText(label, {
      x: (PAGE_WIDTH - width) / 2,
      y: 22,
      size,
      font,
      color: rgb(0.42, 0.46, 0.5),
    })
  }
}

export async function createOperationBookletPdf(input: OperationBookletInput): Promise<Uint8Array> {
  const report = buildOperationBookletReport(input)
  const pdfDoc = await PDFDocument.create()
  pdfDoc.setTitle(`${report.projectName} - ${report.operationName}`)
  pdfDoc.setSubject('PureCutCNC operation booklet')
  pdfDoc.setProducer('PureCutCNC')

  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const state: DrawState = {
    pdfDoc,
    page: pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
    regular,
    bold,
    columns: false,
    column: 0,
    columnTopY: PAGE_HEIGHT - MARGIN,
  }

  drawLine(state, report.operationName, MARGIN, 18, true)
  drawLine(state, 'Operation Booklet', MARGIN, 11)

  if (report.operationDescription.trim().length > 0) {
    state.y -= 4
    drawWrapped(state, report.operationDescription, MARGIN, PAGE_WIDTH - MARGIN * 2, 10)
  }

  if (input.snapshotPng) {
    const image = await pdfDoc.embedPng(input.snapshotPng)
    const maxW = PAGE_WIDTH - MARGIN * 2
    const maxH = 260
    const scale = Math.min(maxW / image.width, maxH / image.height)
    const width = image.width * scale
    const height = image.height * scale
    ensureSpace(state, height + 18)
    state.y -= 10
    state.page.drawImage(image, {
      x: MARGIN + (maxW - width) / 2,
      y: state.y - height,
      width,
      height,
    })
    state.y -= height + 8
  }

  beginColumns(state)

  drawSection(state, 'Overview')
  drawRows(state, descriptionRows(report))

  drawSection(state, 'Target Features')
  drawWrapped(state, report.targetFeatureNames.join(', '), MARGIN, PAGE_WIDTH - MARGIN * 2)

  drawSection(state, 'Tool')
  drawRows(state, report.toolRows)

  drawSection(state, 'Operation Settings')
  drawRows(state, report.settingRows)

  drawSection(state, 'Toolpath')
  drawRows(state, report.toolpathStats)

  if (report.warnings.length > 0) {
    drawSection(state, 'Warnings')
    for (const warning of report.warnings) {
      drawWrapped(state, `- ${warning}`, MARGIN, PAGE_WIDTH - MARGIN * 2)
    }
  }

  drawPageNumbers(pdfDoc, regular)

  return pdfDoc.save()
}
