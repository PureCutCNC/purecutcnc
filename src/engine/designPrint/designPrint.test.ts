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
 * Unit tests for the design-print engine: layout math, scale conversion,
 * clipping detection, and SVG/HTML smoke tests on a deterministic project.
 * Run with: npx tsx src/engine/designPrint/designPrint.test.ts
 */

import { newProject, rectProfile, circleProfile } from '../../types/project'
import type { DimensionAnnotation, Project, SketchFeature } from '../../types/project'
import { resetI18nStoreForTests, setActiveLocale, translate } from '../../i18n/store'
import { replaceProjectFeatures } from '../../test/projectFixtures'
import {
  FOOTER_HEIGHT_MM,
  computeDesignPrintLayout,
  formatScaleRatio,
  parseCustomScale,
  resolvePrintBounds,
} from './layout'
import { buildDesignPrintSvg, buildDesignSvgExport, profileToPathD } from './svg'
import { buildDesignPrintHtml } from './html'
import { defaultDesignPrintOptions, defaultDesignSvgExportOptions } from './types'
import type {
  DesignPrintContent,
  DesignPrintOptions,
  DesignSvgExportContent,
  DesignSvgExportOptions,
} from './types'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertClose(actual: number, expected: number, message: string, epsilon = 1e-6) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`Assertion failed: ${message} — expected ${expected}, got ${actual}`)
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function makeFeature(id: string, overrides: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, 10, 30, 20),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -5,
    visible: true,
    locked: false,
    ...overrides,
  }
}

function appendFeature(project: Project, feature: SketchFeature): void {
  replaceProjectFeatures(project, [...project.features, feature])
}

type TestOptionOverrides = Omit<Partial<DesignPrintOptions>, 'content'> & {
  content?: Partial<DesignPrintContent>
}

function makeOptions(project: Project, overrides: TestOptionOverrides = {}): DesignPrintOptions {
  const bounds = resolvePrintBounds(project, 'visible', null)
  const base = defaultDesignPrintOptions(project, bounds)
  return { ...base, ...overrides, content: { ...base.content, ...(overrides.content ?? {}) } }
}

// ── Printable-area math ──────────────────────────────────────

{
  const project = newProject('LayoutTest', 'mm')
  const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 80 }
  const options = makeOptions(project, {
    paper: 'letter',
    orientation: 'portrait',
    margin: 10,
    content: { footer: false },
  })
  const layout = computeDesignPrintLayout(options, bounds, 'mm')
  assertClose(layout.paperWidthMm, 215.9, 'letter portrait width')
  assertClose(layout.paperHeightMm, 279.4, 'letter portrait height')
  assertClose(layout.printableWidthMm, 195.9, 'letter printable width (10mm margins)')
  assertClose(layout.printableHeightMm, 259.4, 'letter printable height (10mm margins)')
  assert(layout.footerHeightMm === 0, 'footer disabled reserves no space')
  assertClose(layout.drawableHeightMm, 259.4, 'drawable equals printable without footer')
}

{
  const project = newProject('LayoutTestA4', 'mm')
  const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 80 }
  const options = makeOptions(project, {
    paper: 'a4',
    orientation: 'portrait',
    margin: 10,
    content: { footer: true },
  })
  const layout = computeDesignPrintLayout(options, bounds, 'mm')
  assertClose(layout.paperWidthMm, 210, 'a4 portrait width')
  assertClose(layout.paperHeightMm, 297, 'a4 portrait height')
  assertClose(layout.printableWidthMm, 190, 'a4 printable width')
  assertClose(layout.printableHeightMm, 277, 'a4 printable height')
  assertClose(layout.footerHeightMm, FOOTER_HEIGHT_MM, 'footer reserves its strip')
  assertClose(layout.drawableHeightMm, 277 - FOOTER_HEIGHT_MM, 'drawable excludes footer')
}

{
  // Landscape swaps paper dimensions.
  const project = newProject('Landscape', 'mm')
  const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 80 }
  const options = makeOptions(project, { paper: 'a4', orientation: 'landscape', margin: 10 })
  const layout = computeDesignPrintLayout(options, bounds, 'mm')
  assertClose(layout.paperWidthMm, 297, 'a4 landscape width')
  assertClose(layout.paperHeightMm, 210, 'a4 landscape height')
}

// ── Actual-size scale conversion ─────────────────────────────

{
  // mm project: 1 world unit = 1 mm on paper.
  const project = newProject('ActualMm', 'mm')
  const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 80 }
  const options = makeOptions(project, { scaleMode: 'actual', content: { footer: false } })
  const layout = computeDesignPrintLayout(options, bounds, 'mm')
  assertClose(layout.scale, 1, 'mm actual-size scale is 1 mm per unit')
  assertClose(layout.outputWidthMm, 100, 'mm actual-size output width')
  assertClose(layout.outputHeightMm, 80, 'mm actual-size output height')
  assertClose(layout.scaleRatio, 1, 'actual size ratio is 1')
}

{
  // inch project: 1 world unit = 25.4 mm on paper.
  const project = newProject('ActualInch', 'inch')
  const bounds = { minX: 0, maxX: 4, minY: 0, maxY: 3 }
  const options = makeOptions(project, {
    scaleMode: 'actual',
    paper: 'letter',
    margin: 0.5,
    content: { footer: false },
  })
  const layout = computeDesignPrintLayout(options, bounds, 'inch')
  assertClose(layout.scale, 25.4, 'inch actual-size scale is 25.4 mm per unit')
  assertClose(layout.outputWidthMm, 101.6, 'inch actual-size output width (4in)')
  assertClose(layout.marginMm, 12.7, '0.5in margin converts to 12.7mm')
  assertClose(layout.scaleRatio, 1, 'inch actual size ratio is 1')
}

// ── Fit-to-page preserves aspect ratio ───────────────────────

{
  const project = newProject('Fit', 'mm')
  const bounds = { minX: 0, maxX: 200, minY: 0, maxY: 100 }
  const options = makeOptions(project, {
    paper: 'a4',
    orientation: 'portrait',
    margin: 10,
    scaleMode: 'fit',
    content: { footer: false },
  })
  const layout = computeDesignPrintLayout(options, bounds, 'mm')
  assertClose(layout.scale, 190 / 200, 'fit scale limited by width')
  assertClose(
    layout.outputWidthMm / layout.outputHeightMm,
    200 / 100,
    'fit preserves aspect ratio',
  )
  assert(!layout.clipped, 'fit never clips')
  // Centered on the drawable area.
  assertClose(layout.originXMm, 10, 'fit output starts at left margin when width-limited')
  assertClose(
    layout.originYMm,
    10 + (277 - 95) / 2,
    'fit output vertically centered',
  )
}

// ── Custom scale parsing ─────────────────────────────────────

{
  assertClose(parseCustomScale('1:2') ?? NaN, 0.5, 'ratio 1:2')
  assertClose(parseCustomScale('2:1') ?? NaN, 2, 'ratio 2:1')
  assertClose(parseCustomScale('1/4') ?? NaN, 0.25, 'ratio 1/4')
  assertClose(parseCustomScale('50%') ?? NaN, 0.5, 'percent 50%')
  assertClose(parseCustomScale('150 %') ?? NaN, 1.5, 'percent with space')
  assertClose(parseCustomScale('0.75') ?? NaN, 0.75, 'plain factor')
  assert(parseCustomScale('') === null, 'empty is invalid')
  assert(parseCustomScale('abc') === null, 'garbage is invalid')
  assert(parseCustomScale('0') === null, 'zero is invalid')
  assert(parseCustomScale('-1') === null, 'negative is invalid')
  assert(parseCustomScale('1:0') === null, 'divide-by-zero ratio is invalid')
  assert(formatScaleRatio(0.5) === '1:2', 'format 0.5 as 1:2')
  assert(formatScaleRatio(2) === '2:1', 'format 2 as 2:1')
  assert(formatScaleRatio(1) === '1:1', 'format 1 as 1:1')
}

{
  // Custom scale drives the layout; invalid text is flagged.
  const project = newProject('Custom', 'mm')
  const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 80 }
  const half = computeDesignPrintLayout(
    makeOptions(project, { scaleMode: 'custom', customScale: '1:2' }),
    bounds,
    'mm',
  )
  assertClose(half.scale, 0.5, 'custom 1:2 halves the scale')
  assertClose(half.outputWidthMm, 50, 'custom 1:2 output width')
  assert(half.customScaleValid, 'valid custom scale is flagged valid')

  const bad = computeDesignPrintLayout(
    makeOptions(project, { scaleMode: 'custom', customScale: 'nope' }),
    bounds,
    'mm',
  )
  assert(!bad.customScaleValid, 'invalid custom scale is flagged')
  assertClose(bad.scaleRatio, 1, 'invalid custom scale falls back to 1:1')
}

// ── Clipping detection ───────────────────────────────────────

{
  const project = newProject('Clip', 'mm')
  // 300mm wide content on letter paper at 1:1 must clip.
  const bounds = { minX: 0, maxX: 300, minY: 0, maxY: 100 }
  const actual = computeDesignPrintLayout(
    makeOptions(project, { paper: 'letter', scaleMode: 'actual', content: { footer: false } }),
    bounds,
    'mm',
  )
  assert(actual.clipped, '300mm content at 1:1 clips on letter')

  const fit = computeDesignPrintLayout(
    makeOptions(project, { paper: 'letter', scaleMode: 'fit', content: { footer: false } }),
    bounds,
    'mm',
  )
  assert(!fit.clipped, 'same content fits with fit-to-page')

  // Registration offsets can push an otherwise fitting drawing off the page.
  const shoved = computeDesignPrintLayout(
    makeOptions(project, { paper: 'letter', scaleMode: 'fit', offsetX: 500, content: { footer: false } }),
    bounds,
    'mm',
  )
  assert(shoved.clipped, 'large X offset clips')
}

// ── Print-bounds resolution ──────────────────────────────────

{
  const project = newProject('Bounds', 'mm')
  appendFeature(project, makeFeature('f1', {
    sketch: {
      profile: rectProfile(-20, -10, 30, 20),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }))
  project.origin.visible = false

  const visible = resolvePrintBounds(project, 'visible', null)
  assertClose(visible.minX, -20, 'visible bounds include off-stock feature')
  const stock = resolvePrintBounds(project, 'stock', null)
  assertClose(stock.minX, 0, 'stock bounds ignore features')
  assertClose(stock.maxX, 100, 'stock bounds span the stock')
  const view = resolvePrintBounds(project, 'view', { minX: 5, maxX: 25, minY: 5, maxY: 20 })
  assertClose(view.minX, 5, 'view bounds pass through')
  const viewFallback = resolvePrintBounds(project, 'view', null)
  assertClose(viewFallback.minX, -20, 'view falls back to visible extents when unavailable')
}

{
  // Visible-extents bounds follow the enabled content layers, so the page is
  // never scaled to fit content the printout omits.
  const project = newProject('LayerBounds', 'mm')
  project.origin.visible = false
  project.backdrop = {
    name: 'trace.png',
    mimeType: 'image/png',
    imageDataUrl: 'data:image/png;base64,',
    intrinsicWidth: 100,
    intrinsicHeight: 100,
    center: { x: 50, y: 40 },
    width: 400,
    height: 400,
    orientationAngle: 90,
    opacity: 0.5,
    visible: true,
  }
  project.tabs.push({ id: 't1', name: 'Tab', x: -30, y: 0, w: 10, h: 5, z_top: 3, z_bottom: 0, visible: true })
  project.clamps.push({ id: 'c1', name: 'Clamp', type: 'step_clamp', x: 120, y: 0, w: 15, h: 15, height: 20, visible: true })

  const defaults = resolvePrintBounds(project, 'visible', null)
  assertClose(defaults.minX, -30, 'tabs count toward bounds by default')
  assertClose(defaults.maxX, 135, 'clamps count toward bounds by default')

  const withBackdrop = resolvePrintBounds(project, 'visible', null, { backdrop: true, tabs: true, clamps: true })
  assertClose(withBackdrop.minX, -150, 'enabled backdrop widens the bounds')
  assertClose(withBackdrop.maxY, 240, 'enabled backdrop widens the bounds vertically')

  // The backdrop toggle prints the image even when hidden in the sketch.
  project.backdrop.visible = false
  const hiddenBackdrop = resolvePrintBounds(project, 'visible', null, { backdrop: true, tabs: true, clamps: true })
  assertClose(hiddenBackdrop.minX, -150, 'backdrop bounds follow the print toggle, not sketch visibility')

  const noFixtures = resolvePrintBounds(project, 'visible', null, { backdrop: false, tabs: false, clamps: false })
  assertClose(noFixtures.minX, 0, 'disabled tabs are excluded from bounds')
  assertClose(noFixtures.maxX, 100, 'disabled clamps and backdrop are excluded from bounds')
}

// ── SVG smoke tests ──────────────────────────────────────────

function buildTestSvg(mutate?: (project: Project) => void, optionOverrides: TestOptionOverrides = {}) {
  const project = newProject('SvgTest', 'mm')
  appendFeature(project, makeFeature('visible-rect'))
  appendFeature(project, makeFeature('hidden-circle', {
    kind: 'circle',
    visible: false,
    sketch: {
      profile: circleProfile(70, 40, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }))
  mutate?.(project)
  const options = makeOptions(project, optionOverrides)
  const bounds = resolvePrintBounds(project, options.area, null)
  const layout = computeDesignPrintLayout(options, bounds, project.meta.units)
  return { project, options, layout, svg: buildDesignPrintSvg(project, options, layout) }
}

{
  const { svg, layout } = buildTestSvg()
  assert(svg.includes('class="pc-stock"'), 'stock outline is present')
  assert(count(svg, 'class="pc-feature"') === 1, 'only the visible feature prints')
  assert(svg.includes('class="pc-origin"'), 'origin marker prints when visible')
  assert(svg.includes(`width="${layout.paperWidthMm}mm"`), 'svg has physical width')
  assert(svg.includes(`viewBox="0 0 ${layout.paperWidthMm} ${layout.paperHeightMm}"`), 'viewBox matches paper size in mm')
  assert(svg.includes(`scale(${Math.round(layout.scale * 10000) / 10000})`), 'world group scales by the layout scale')
  assert(svg.includes('class="pc-footer"'), 'footer prints by default')
  assert(!svg.includes('class="pc-grid"'), 'grid is off by default')
}

{
  // Hidden stock and origin are omitted.
  const { svg } = buildTestSvg((project) => {
    project.stock.visible = false
    project.origin.visible = false
  })
  assert(!svg.includes('class="pc-stock"'), 'hidden stock is omitted')
  assert(!svg.includes('class="pc-origin"'), 'hidden origin is omitted')
}

{
  // Dimensions print only when showDimensions is enabled.
  const dimension: DimensionAnnotation = {
    id: 'dim1',
    type: 'aligned',
    a: { kind: 'free', point: { x: 10, y: 10 } },
    b: { kind: 'free', point: { x: 40, y: 10 } },
    offset: -6,
    visible: true,
    locked: false,
    textOverride: null,
    precisionOverride: null,
  }

  const withDims = buildTestSvg((project) => {
    project.annotations.push(dimension)
    project.meta.showDimensions = true
  })
  assert(withDims.svg.includes('class="pc-dimension"'), 'dimension prints when enabled')
  assert(withDims.svg.includes('>30<'), 'dimension label shows the measured value')

  const withoutDims = buildTestSvg((project) => {
    project.annotations.push(dimension)
    project.meta.showDimensions = false
  })
  assert(!withoutDims.svg.includes('class="pc-dimension"'), 'dimensions omitted when showDimensions is off')
}

{
  // Content toggles: grid, labels, tabs/clamps.
  const { svg } = buildTestSvg((project) => {
    project.tabs.push({ id: 't1', name: 'Tab 1', x: 5, y: 5, w: 8, h: 4, z_top: 3, z_bottom: 0, visible: true })
    project.clamps.push({ id: 'c1', name: 'Clamp 1', type: 'step_clamp', x: 80, y: 5, w: 10, h: 10, height: 20, visible: true })
  }, {
    content: { grid: true, featureLabels: true, tabs: true, clamps: true },
  })
  assert(svg.includes('class="pc-grid"'), 'grid prints when toggled on')
  assert(svg.includes('class="pc-feature-labels"'), 'feature labels print when toggled on')
  assert(svg.includes('visible-rect'), 'feature label text present')
  assert(svg.includes('class="pc-tab"'), 'tab footprint prints')
  assert(svg.includes('class="pc-clamp"'), 'clamp footprint prints')
}

{
  // Construction geometry prints as dashed, unfilled reference marks.
  const { svg } = buildTestSvg((project) => {
    appendFeature(project, makeFeature('construction-line', {
      operation: 'construction',
      sketch: {
        profile: { start: { x: 0, y: 40 }, segments: [{ type: 'line', to: { x: 100, y: 40 } }], closed: false },
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
    }))
  })
  assert(count(svg, 'class="pc-feature"') === 2, 'construction geometry prints alongside regular features')
  const constructionPath = svg.split('\n').find((line) => line.includes('data-op="construction"'))
  assert(constructionPath !== undefined, 'construction path carries its operation tag')
  assert(constructionPath!.includes('stroke-dasharray'), 'construction geometry is dashed')
  assert(constructionPath!.includes('fill="none"'), 'construction geometry is never filled')

  // Hidden construction geometry stays out of the printout.
  const hidden = buildTestSvg((project) => {
    appendFeature(project, makeFeature('construction-hidden', { operation: 'construction', visible: false }))
  })
  assert(count(hidden.svg, 'data-op="construction"') === 0, 'hidden construction geometry is omitted')
}

{
  // Monochrome mode uses no color fills.
  const color = buildTestSvg()
  assert(color.svg.includes('rgba('), 'color mode uses tinted fills')
  const mono = buildTestSvg(undefined, { colorMode: 'monochrome' })
  assert(!mono.svg.includes('rgba('), 'monochrome mode has no tinted fills')
}

{
  // Preview mode omits physical size attributes but keeps the viewBox.
  const { project, options, layout } = buildTestSvg()
  const preview = buildDesignPrintSvg(project, options, layout, { physicalSize: false })
  assert(!preview.includes('width="'.concat(String(layout.paperWidthMm), 'mm"')), 'preview omits physical width')
  assert(preview.includes(`viewBox="0 0 ${layout.paperWidthMm} ${layout.paperHeightMm}"`), 'preview keeps viewBox')
}

{
  // XML escaping of user-controlled text.
  const { svg } = buildTestSvg((project) => {
    project.meta.name = 'A <b> & "quote"'
  })
  assert(svg.includes('A &lt;b&gt; &amp; &quot;quote&quot;'), 'project name is XML-escaped in footer')
  assert(!svg.includes('A <b>'), 'raw markup never lands in the svg')
}

{
  // The print footer is a generated document surface, so its labels use the
  // active non-React i18n catalog while the unit symbol remains stable.
  setActiveLocale('zh-CN')
  try {
    const { svg, layout, options } = buildTestSvg()
    assert(svg.includes(translate('print.footer.units', { units: 'mm' })), 'footer localizes its units label')
    assert(svg.includes(translate('print.footer.scale', { scale: translate('print.scale.fit', { ratio: formatScaleRatio(layout.scaleRatio) }) })), 'footer localizes its scale label')
    const orientationKey = options.orientation === 'landscape' ? 'print.orientation.landscape' : 'print.orientation.portrait'
    assert(svg.includes(translate(orientationKey)), 'footer localizes its orientation')
  } finally {
    resetI18nStoreForTests()
  }
}

// ── Geometry-only SVG export (issue #257) ────────────────────

// Mirrors buildDesignPrintSvg's fmt() so expected attribute strings match.
function fmtNum(value: number): string {
  const rounded = Math.round(value * 10000) / 10000
  return String(rounded === 0 ? 0 : rounded)
}

type ExportOptionOverrides = Omit<Partial<DesignSvgExportOptions>, 'content'> & {
  content?: Partial<DesignSvgExportContent>
}

function buildTestExportSvg(
  units: 'mm' | 'inch' = 'mm',
  mutate?: (project: Project) => void,
  overrides: ExportOptionOverrides = {},
) {
  const project = newProject('SvgExportTest', units)
  appendFeature(project, makeFeature('visible-rect'))
  appendFeature(project, makeFeature('hidden-circle', {
    kind: 'circle',
    visible: false,
    sketch: {
      profile: circleProfile(70, 40, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }))
  mutate?.(project)
  const base = defaultDesignSvgExportOptions(project)
  const options: DesignSvgExportOptions = {
    ...base,
    ...overrides,
    content: { ...base.content, ...(overrides.content ?? {}) },
  }
  const bounds = resolvePrintBounds(project, options.area, null, {
    backdrop: false,
    tabs: options.content.tabs,
    clamps: options.content.clamps,
  })
  return { project, options, bounds, svg: buildDesignSvgExport(project, options) }
}

{
  // Tight viewBox around the exported bounds, physical mm size at true 1:1.
  const { svg, bounds } = buildTestExportSvg('mm')
  const w = bounds.maxX - bounds.minX
  const h = bounds.maxY - bounds.minY
  assert(
    svg.includes(`viewBox="${fmtNum(bounds.minX)} ${fmtNum(bounds.minY)} ${fmtNum(w)} ${fmtNum(h)}"`),
    'export viewBox equals the exported bounds',
  )
  assert(svg.includes(`width="${fmtNum(w)}mm"`), 'mm project: 1 unit = 1 mm')
  assert(svg.includes(`height="${fmtNum(h)}mm"`), 'mm project: physical height matches bounds')
}

{
  // Inch projects export at 1 unit = 25.4 mm.
  const { svg, bounds } = buildTestExportSvg('inch')
  const w = bounds.maxX - bounds.minX
  assert(svg.includes(`width="${fmtNum(w * 25.4)}mm"`), 'inch project: 1 unit = 25.4 mm')
}

{
  // No page scaffolding: footer, white background, and clipping are print-only.
  const { svg } = buildTestExportSvg('mm')
  assert(!svg.includes('pc-footer'), 'export has no footer/title block')
  assert(!svg.includes('fill="#ffffff"'), 'export has no background rect')
  assert(!svg.includes('clipPath'), 'export has no clip path')
  assert(!svg.includes('pc-print-clip'), 'export references no print clip')
}

{
  // Per-feature groups keep layers selectable in vector editors; hidden
  // features stay out; outlines only, even in color mode.
  const { svg } = buildTestExportSvg('mm')
  assert(
    svg.includes('<g id="feature-visible-rect" data-name="visible-rect">'),
    'visible feature gets an identified group',
  )
  assert(!svg.includes('hidden-circle'), 'hidden feature is omitted entirely')
  assert(!svg.includes('rgba('), 'export never uses tinted fills')
  assert(svg.includes('stroke="#1f6fb2"'), 'color mode keeps the color palette strokes')

  const mono = buildTestExportSvg('mm', undefined, { colorMode: 'monochrome' })
  assert(!mono.svg.includes('#1f6fb2'), 'monochrome mode drops color strokes')
}

{
  // Construction geometry: dashed, unfilled; hidden construction omitted.
  const { svg } = buildTestExportSvg('mm', (project) => {
    appendFeature(project, makeFeature('construction-line', {
      operation: 'construction',
      sketch: {
        profile: { start: { x: 0, y: 40 }, segments: [{ type: 'line', to: { x: 100, y: 40 } }], closed: false },
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
    }))
    appendFeature(project, makeFeature('construction-hidden', { operation: 'construction', visible: false }))
  })
  assert(count(svg, 'data-op="construction"') === 1, 'hidden construction geometry is omitted')
  const constructionLine = svg.split('\n').find((line) => line.includes('data-op="construction"'))
  assert(constructionLine !== undefined, 'construction geometry exports')
  assert(constructionLine!.includes('stroke-dasharray'), 'exported construction geometry is dashed')
  assert(constructionLine!.includes('fill="none"'), 'exported construction geometry is unfilled')
}

{
  // Dimensions follow project.meta.showDimensions, same as printing.
  const dimension: DimensionAnnotation = {
    id: 'dim1',
    type: 'aligned',
    a: { kind: 'free', point: { x: 10, y: 10 } },
    b: { kind: 'free', point: { x: 40, y: 10 } },
    offset: -6,
    visible: true,
    locked: false,
    textOverride: null,
    precisionOverride: null,
  }
  const withDims = buildTestExportSvg('mm', (project) => {
    project.annotations.push(dimension)
    project.meta.showDimensions = true
  })
  assert(withDims.svg.includes('class="pc-dimension"'), 'dimensions export when enabled')
  const withoutDims = buildTestExportSvg('mm', (project) => {
    project.annotations.push(dimension)
    project.meta.showDimensions = false
  })
  assert(!withoutDims.svg.includes('class="pc-dimension"'), 'dimensions omitted when showDimensions is off')
}

{
  // Content toggles and area modes; bounds follow the enabled layers.
  const addFixtures = (project: Project) => {
    project.tabs.push({ id: 't1', name: 'Tab 1', x: -30, y: 5, w: 8, h: 4, z_top: 3, z_bottom: 0, visible: true })
    project.clamps.push({ id: 'c1', name: 'Clamp 1', type: 'step_clamp', x: 120, y: 5, w: 10, h: 10, height: 20, visible: true })
  }

  const defaults = buildTestExportSvg('mm', addFixtures)
  assert(defaults.options.content.tabs, 'visible tabs default the toggle on')
  assert(defaults.svg.includes('class="pc-tab"'), 'tabs export when toggled on')
  assert(defaults.svg.includes('class="pc-clamp"'), 'clamps export when toggled on')
  assert(!defaults.svg.includes('class="pc-grid"'), 'grid is off by default')
  assert(!defaults.svg.includes('class="pc-feature-labels"'), 'labels are off by default')
  assertClose(defaults.bounds.minX, -30, 'enabled tabs widen the exported bounds')

  const bare = buildTestExportSvg('mm', addFixtures, {
    content: { tabs: false, clamps: false, grid: true, featureLabels: true },
  })
  assert(!bare.svg.includes('class="pc-tab"'), 'disabled tabs stay out of the export')
  assert(!bare.svg.includes('class="pc-clamp"'), 'disabled clamps stay out of the export')
  assert(bare.svg.includes('class="pc-grid"'), 'grid exports when toggled on')
  assert(bare.svg.includes('class="pc-feature-labels"'), 'labels export when toggled on')
  assertClose(bare.bounds.minX, 0, 'disabled fixtures are excluded from the exported bounds')

  const stock = buildTestExportSvg('mm', (project) => {
    project.origin.visible = false
  }, { area: 'stock' })
  assert(
    stock.svg.includes(`viewBox="0 0 ${fmtNum(stock.bounds.maxX)} ${fmtNum(stock.bounds.maxY)}"`),
    'stock area exports the stock extents',
  )
}

{
  // Annotation text (origin labels, feature labels, dimension values) is
  // emitted as lightweight single-stroke skeleton geometry, never <text>, so
  // the geometry export re-imports as a few line segments instead of dense
  // filled glyph outlines (issue #257 round-trip bloat).
  const { svg } = buildTestExportSvg('mm') // origin visible → X/Y labels present
  assert(!svg.includes('<text'), 'geometry export emits no <text> elements')
  assert(svg.includes('class="pc-text"'), 'origin axis labels render as skeleton strokes')

  const dimension: DimensionAnnotation = {
    id: 'dim-skel',
    type: 'aligned',
    a: { kind: 'free', point: { x: 10, y: 10 } },
    b: { kind: 'free', point: { x: 40, y: 10 } },
    offset: -6,
    visible: true,
    locked: false,
    textOverride: null,
    precisionOverride: null,
  }
  const annotated = buildTestExportSvg('mm', (project) => {
    project.annotations.push(dimension)
    project.meta.showDimensions = true
  }, { content: { featureLabels: true } })
  assert(!annotated.svg.includes('<text'), 'labels and dimensions never emit <text> in the export')
  // Skeleton strokes are open polylines, so the value is geometry, not a node.
  assert(!annotated.svg.includes('>30<'), 'dimension value is skeleton geometry, not a text node')

  // The print SVG keeps crisp native <text>; only the geometry export skeletonizes.
  const print = buildTestSvg()
  assert(print.svg.includes('<text'), 'print SVG still uses native <text>')
}

// ── Path data ────────────────────────────────────────────────

{
  const rect = profileToPathD(rectProfile(0, 0, 10, 5))
  assert(rect.startsWith('M 0 0'), 'rect path starts at origin')
  assert(rect.endsWith('Z'), 'closed profile emits Z')
  assert(count(rect, 'L ') === 4, 'rect has four line segments')

  const circle = profileToPathD(circleProfile(5, 5, 5))
  assert(count(circle, 'A ') === 2, 'circle uses two arc commands')
  assert(circle.includes('M 10 5'), 'circle starts at the radius handle')
}

// ── HTML wrapper ─────────────────────────────────────────────

{
  const { svg, layout } = buildTestSvg()
  const html = buildDesignPrintHtml({ svg, layout, title: 'Test & Title' })
  assert(html.includes(`@page { size: ${layout.paperWidthMm}mm ${layout.paperHeightMm}mm; margin: 0; }`), 'html sets @page to the paper size')
  assert(html.includes('<title>Test &amp; Title</title>'), 'html escapes the title')
  assert(html.includes(svg), 'html embeds the svg untouched')
  assert(!html.includes('class="app'), 'html carries no app shell markup')
}

console.log('designPrint tests passed')
