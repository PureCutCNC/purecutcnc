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

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFPage, PDFFont } from 'pdf-lib'
import { translate } from '../../i18n/store'
import { buildOperationBookletReport } from './report'
import type { OperationBookletInput, OperationBookletReport, OperationBookletRow } from './types'

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 42
const BODY_SIZE = 9
const SECTION_SIZE = 11
const SECTION_COLUMN_GAP = 22
const ROW_LABEL_WIDTH = 82
const ROW_LABEL_GAP = 7
const BODY_TOP = PAGE_HEIGHT - MARGIN
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const SECTION_COLUMN_WIDTH = (CONTENT_WIDTH - SECTION_COLUMN_GAP) / 2
const LINE_HEIGHT = BODY_SIZE + 4

const COLORS = {
  accent: rgb(0.12, 0.34, 0.54),
  accentSoft: rgb(0.9, 0.95, 0.98),
  body: rgb(0.1, 0.13, 0.17),
  border: rgb(0.73, 0.78, 0.83),
  footer: rgb(0.42, 0.46, 0.5),
  muted: rgb(0.3, 0.34, 0.39),
  panel: rgb(0.97, 0.98, 0.99),
  rowRule: rgb(0.88, 0.91, 0.94),
}

interface DrawState {
  pdfDoc: PDFDocument
  page: PDFPage
  y: number
  regular: PDFFont
  bold: PDFFont
}

function pdfSafeText(text: string): string {
  return text
}

type BookletUnicodeFontWeight = 'regular' | 'bold'

interface BookletUnicodeFonts {
  regular: Uint8Array
  bold: Uint8Array
}

function bookletUnicodeFontUrl(weight: BookletUnicodeFontWeight): string {
  const suffix = weight === 'bold' ? '-bold' : ''
  return `${import.meta.env?.BASE_URL ?? './'}fonts/noto-sans-sc-booklet${suffix}.ttf`
}

let unicodeFonts: Promise<BookletUnicodeFonts> | undefined

async function loadUnicodeFontBytes(weight: BookletUnicodeFontWeight): Promise<Uint8Array> {
  const response = await fetch(bookletUnicodeFontUrl(weight))
  if (!response.ok) throw new Error(`Unable to load booklet ${weight} font: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

function loadUnicodeFonts(): Promise<BookletUnicodeFonts> {
  if (unicodeFonts) return unicodeFonts

  const retryableLoad = Promise.all([
    loadUnicodeFontBytes('regular'),
    loadUnicodeFontBytes('bold'),
  ]).then(([regular, bold]) => ({ regular, bold })).catch((error: unknown) => {
    if (unicodeFonts === retryableLoad) unicodeFonts = undefined
    throw error
  })
  unicodeFonts = retryableLoad
  return retryableLoad
}

function reportText(report: OperationBookletReport): string[] {
  return [
    ...descriptionRows(report).flatMap((row) => [row.label, row.value]),
    translate('booklet.pdf.page', { page: 1, total: 1 }),
    report.projectName,
    report.operationName,
    report.operationDescription,
    report.generatedDate,
    report.units,
    report.originZSummary,
    report.stockSizeSummary,
    report.targetSummary,
    ...report.targetFeatureNames,
    ...report.toolRows.flatMap((row) => [row.label, row.value]),
    ...report.settingRows.flatMap((row) => [row.label, row.value]),
    ...report.toolpathStats.flatMap((row) => [row.label, row.value]),
    ...report.warnings,
    translate('booklet.pdf.title'),
    translate('booklet.pdf.snapshot'),
    translate('booklet.section.overview'),
    translate('booklet.section.tool'),
    translate('booklet.section.operationSettings'),
    translate('booklet.section.toolpath'),
    translate('booklet.section.warnings'),
  ]
}

function requiresUnicodeFont(font: PDFFont, text: readonly string[]): boolean {
  return text.some((value) => {
    try {
      font.encodeText(value)
      return false
    } catch {
      return true
    }
  })
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = pdfSafeText(text).split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']

  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate
    } else if (current.length === 0) {
      current = word
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function truncateToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const safe = pdfSafeText(text)
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe

  const ellipsis = '...'
  let truncated = safe
  while (truncated.length > 0 && font.widthOfTextAtSize(`${truncated}${ellipsis}`, size) > maxWidth) {
    truncated = truncated.slice(0, -1)
  }
  return `${truncated}${ellipsis}`
}

function ensureSpace(state: DrawState, required: number): void {
  if (state.y - required >= MARGIN) return

  state.page = state.pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  state.y = BODY_TOP
}

function drawLine(state: DrawState, text: string, x: number, size = BODY_SIZE, bold = false): void {
  const font = bold ? state.bold : state.regular
  state.page.drawText(pdfSafeText(text), {
    x,
    y: state.y,
    size,
    font,
    color: COLORS.body,
  })
  state.y -= size + 4
}

function drawWrapped(state: DrawState, text: string, x: number, width: number, size = BODY_SIZE): void {
  const lines = wrapText(text, state.regular, size, width)
  ensureSpace(state, lines.length * (size + 4))
  for (const line of lines) {
    drawLine(state, line, x, size)
  }
}

function drawSection(state: DrawState, title: string): void {
  ensureSpace(state, 28)
  state.y -= 10
  const titleY = state.y
  state.page.drawRectangle({
    x: MARGIN,
    y: titleY - 1,
    width: 4,
    height: SECTION_SIZE + 3,
    color: COLORS.accent,
  })
  state.page.drawText(pdfSafeText(title.toUpperCase()), {
    x: MARGIN + 10,
    y: titleY,
    size: SECTION_SIZE,
    font: state.bold,
    color: COLORS.accent,
  })
  state.y -= SECTION_SIZE + 8
}

interface PreparedCell {
  labelLines: string[]
  valueLines: string[]
  height: number
  stackedLabel: boolean
}

export function shouldStackRowLabel(label: string, font: PDFFont): boolean {
  return font.widthOfTextAtSize(label, BODY_SIZE) > ROW_LABEL_WIDTH
}

function prepareRowCell(state: DrawState, row: OperationBookletRow): PreparedCell {
  const stackedLabel = shouldStackRowLabel(row.label, state.bold)
  const labelWidth = stackedLabel ? SECTION_COLUMN_WIDTH : ROW_LABEL_WIDTH
  const valueWidth = stackedLabel ? SECTION_COLUMN_WIDTH : SECTION_COLUMN_WIDTH - ROW_LABEL_WIDTH - ROW_LABEL_GAP
  const labelLines = wrapText(row.label, state.bold, BODY_SIZE, labelWidth)
  const valueLines = wrapText(row.value, state.regular, BODY_SIZE, valueWidth)
  const lineCount = stackedLabel
    ? labelLines.length + valueLines.length
    : Math.max(1, labelLines.length, valueLines.length)
  return {
    labelLines,
    valueLines,
    height: lineCount * LINE_HEIGHT + 6,
    stackedLabel,
  }
}

function drawPreparedCell(state: DrawState, cell: PreparedCell, x: number, y: number): void {
  const valueX = cell.stackedLabel ? x : x + ROW_LABEL_WIDTH + ROW_LABEL_GAP
  const valueY = cell.stackedLabel ? y - cell.labelLines.length * LINE_HEIGHT : y
  for (let index = 0; index < cell.labelLines.length; index += 1) {
    state.page.drawText(cell.labelLines[index], {
      x,
      y: y - index * LINE_HEIGHT,
      size: BODY_SIZE,
      font: state.bold,
      color: COLORS.muted,
    })
  }
  for (let index = 0; index < cell.valueLines.length; index += 1) {
    state.page.drawText(cell.valueLines[index], {
      x: valueX,
      y: valueY - index * LINE_HEIGHT,
      size: BODY_SIZE,
      font: state.regular,
      color: COLORS.body,
    })
  }
}

function drawRows(state: DrawState, rows: OperationBookletRow[]): void {
  for (let index = 0; index < rows.length; index += 2) {
    const left = prepareRowCell(state, rows[index])
    const right = rows[index + 1] ? prepareRowCell(state, rows[index + 1]) : null
    const rowHeight = Math.max(left.height, right?.height ?? 0)
    ensureSpace(state, rowHeight)
    const rowTop = state.y
    drawPreparedCell(state, left, MARGIN, rowTop)
    if (right) drawPreparedCell(state, right, MARGIN + SECTION_COLUMN_WIDTH + SECTION_COLUMN_GAP, rowTop)
    state.y -= rowHeight + 1
  }
}

function descriptionRows(report: OperationBookletReport): OperationBookletRow[] {
  return [
    { label: translate('booklet.label.project'), value: report.projectName },
    { label: translate('booklet.label.generated'), value: report.generatedDate },
    { label: translate('booklet.label.units'), value: report.units },
    { label: translate('booklet.label.stockSize'), value: report.stockSizeSummary },
    { label: translate('booklet.label.originZ'), value: report.originZSummary },
  ]
}

function drawPageFooters(pdfDoc: PDFDocument, font: PDFFont, report: OperationBookletReport): void {
  const pages = pdfDoc.getPages()
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    const label = translate('booklet.pdf.page', { page: index + 1, total: pages.length })
    const size = 8
    const footerText = truncateToWidth(`${report.projectName} - ${report.operationName}`, font, size, 300)
    page.drawLine({
      start: { x: MARGIN, y: 36 },
      end: { x: PAGE_WIDTH - MARGIN, y: 36 },
      thickness: 0.35,
      color: COLORS.rowRule,
    })
    page.drawText(footerText, {
      x: MARGIN,
      y: 22,
      size,
      font,
      color: COLORS.footer,
    })
    page.drawText(label, {
      x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(label, size),
      y: 22,
      size,
      font,
      color: COLORS.footer,
    })
  }
}

function drawHeader(state: DrawState, report: OperationBookletReport): void {
  state.page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - 16,
    width: PAGE_WIDTH,
    height: 16,
    color: COLORS.accent,
  })

  const titleLines = wrapText(report.operationName, state.bold, 20, 390)
  let y = PAGE_HEIGHT - MARGIN - 2
  for (const line of titleLines.slice(0, 2)) {
    state.page.drawText(line, {
      x: MARGIN,
      y,
      size: 20,
      font: state.bold,
      color: COLORS.body,
    })
    y -= 23
  }

  state.page.drawText(translate('booklet.pdf.title'), {
    x: MARGIN,
    y,
    size: 10,
    font: state.regular,
    color: COLORS.muted,
  })

  const projectLabel = truncateToWidth(report.projectName, state.regular, 9, 160)
  state.page.drawText(projectLabel, {
    x: PAGE_WIDTH - MARGIN - state.regular.widthOfTextAtSize(projectLabel, 9),
    y: PAGE_HEIGHT - MARGIN,
    size: 9,
    font: state.regular,
    color: COLORS.muted,
  })
  state.page.drawText(report.generatedDate, {
    x: PAGE_WIDTH - MARGIN - state.regular.widthOfTextAtSize(report.generatedDate, 8),
    y: PAGE_HEIGHT - MARGIN - 15,
    size: 8,
    font: state.regular,
    color: COLORS.footer,
  })

  state.page.drawLine({
    start: { x: MARGIN, y: y - 12 },
    end: { x: PAGE_WIDTH - MARGIN, y: y - 12 },
    thickness: 0.75,
    color: COLORS.border,
  })
  state.y = y - 30
}

function drawDescriptionBlock(state: DrawState, text: string): void {
  const lines = wrapText(text, state.regular, 10, CONTENT_WIDTH - 24)
  const height = lines.length * 14 + 20
  ensureSpace(state, height + 8)
  const top = state.y
  const y = top - height

  state.page.drawRectangle({
    x: MARGIN,
    y,
    width: CONTENT_WIDTH,
    height,
    color: COLORS.accentSoft,
  })
  state.page.drawRectangle({
    x: MARGIN,
    y,
    width: CONTENT_WIDTH,
    height,
    borderColor: COLORS.border,
    borderWidth: 0.5,
  })

  let lineY = top - 16
  for (const line of lines) {
    state.page.drawText(line, {
      x: MARGIN + 12,
      y: lineY,
      size: 10,
      font: state.regular,
      color: COLORS.body,
    })
    lineY -= 14
  }
  state.y = y - 10
}

async function drawSnapshotFrame(state: DrawState, input: OperationBookletInput): Promise<void> {
  if (!input.snapshotPng) return

  const image = await state.pdfDoc.embedPng(input.snapshotPng)
  const maxW = CONTENT_WIDTH - 20
  const maxH = 240
  const scale = Math.min(maxW / image.width, maxH / image.height)
  const width = image.width * scale
  const height = image.height * scale
  const frameHeight = height + 32

  ensureSpace(state, frameHeight + 10)
  const frameY = state.y - frameHeight
  state.page.drawRectangle({
    x: MARGIN,
    y: frameY,
    width: CONTENT_WIDTH,
    height: frameHeight,
    color: COLORS.panel,
  })
  state.page.drawRectangle({
    x: MARGIN,
    y: frameY,
    width: CONTENT_WIDTH,
    height: frameHeight,
    borderColor: COLORS.border,
    borderWidth: 0.5,
  })
  state.page.drawText(translate('booklet.pdf.snapshot'), {
    x: MARGIN + 12,
    y: state.y - 16,
    size: 9,
    font: state.bold,
    color: COLORS.muted,
  })
  state.page.drawImage(image, {
    x: MARGIN + (CONTENT_WIDTH - width) / 2,
    y: frameY + 10,
    width,
    height,
  })
  state.y = frameY - 12
}

export async function createOperationBookletPdf(input: OperationBookletInput): Promise<Uint8Array> {
  const report = buildOperationBookletReport(input)
  const pdfDoc = await PDFDocument.create()
  pdfDoc.setTitle(`${report.projectName} - ${report.operationName}`)
  pdfDoc.setSubject('PureCutCNC operation booklet')
  pdfDoc.setProducer('PureCutCNC')

  let regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  let bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  if (requiresUnicodeFont(regular, reportText(report))) {
    const { default: fontkit } = await import('@pdf-lib/fontkit')
    pdfDoc.registerFontkit(fontkit)
    // The fetched assets are pre-subset to the shipped Chinese catalog and
    // Latin extensions. Embed them as-is: fontkit's runtime subsets of these
    // variable fonts omit glyphs in some PDF viewers.
    const unicodeFonts = await loadUnicodeFonts()
    regular = await pdfDoc.embedFont(unicodeFonts.regular, { subset: false })
    bold = await pdfDoc.embedFont(unicodeFonts.bold, { subset: false })
  }
  const state: DrawState = {
    pdfDoc,
    page: pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
    regular,
    bold,
  }

  drawHeader(state, report)

  if (report.operationDescription.trim().length > 0) {
    drawDescriptionBlock(state, report.operationDescription)
  }

  await drawSnapshotFrame(state, input)

  drawSection(state, translate('booklet.section.overview'))
  drawRows(state, descriptionRows(report))

  drawSection(state, translate('booklet.section.tool'))
  drawRows(state, report.toolRows)

  drawSection(state, translate('booklet.section.operationSettings'))
  drawRows(state, report.settingRows)

  drawSection(state, translate('booklet.section.toolpath'))
  drawRows(state, report.toolpathStats)

  if (report.warnings.length > 0) {
    drawSection(state, translate('booklet.section.warnings'))
    for (const warning of report.warnings) {
      drawWrapped(state, `- ${warning}`, MARGIN, PAGE_WIDTH - MARGIN * 2)
    }
  }

  drawPageFooters(pdfDoc, regular, report)

  return pdfDoc.save()
}
