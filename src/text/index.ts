import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import helvetikerRegular from 'three/examples/fonts/helvetiker_regular.typeface.json'
import helvetikerBold from 'three/examples/fonts/helvetiker_bold.typeface.json'
import optimerRegular from 'three/examples/fonts/optimer_regular.typeface.json'
import optimerBold from 'three/examples/fonts/optimer_bold.typeface.json'
import gentilisRegular from 'three/examples/fonts/gentilis_regular.typeface.json'
import gentilisBold from 'three/examples/fonts/gentilis_bold.typeface.json'
import droidSansRegular from 'three/examples/fonts/droid/droid_sans_regular.typeface.json'
import droidSansBold from 'three/examples/fonts/droid/droid_sans_bold.typeface.json'
import droidSerifRegular from 'three/examples/fonts/droid/droid_serif_regular.typeface.json'
import droidSerifBold from 'three/examples/fonts/droid/droid_serif_bold.typeface.json'
import {
  getProfileBounds,
  profileVertices,
  rectProfile,
  type FeatureOperation,
  type Point,
  type SketchFeature,
  type SketchProfile,
  type TextFontId,
  type TextFontStyle,
} from '../types/project'

export interface TextToolConfig {
  text: string
  style: TextFontStyle
  fontId: TextFontId
  size: number
  operation: FeatureOperation
}

export interface GeneratedTextShape {
  name: string
  profile: SketchProfile
  operation: FeatureOperation
}

interface GlyphDefinition {
  advance: number
  strokes: Array<Array<[number, number]>>
}

interface TextFontDefinition {
  id: TextFontId
  label: string
  style: TextFontStyle
}

interface TextTemplate {
  shapes: GeneratedTextShape[]
  bounds: {
    minX: number
    maxX: number
    minY: number
    maxY: number
    width: number
    height: number
  }
}

const DEFAULT_TEXT = 'TEXT'

const LETTER_SPACING_RATIO = 0.18
const LINE_HEIGHT_RATIO = 1.45
const TEXT_FONTS: TextFontDefinition[] = [
  { id: 'simple_stroke', label: 'Simple Stroke', style: 'skeleton' },
  { id: 'helvetiker_regular', label: 'Helvetiker Regular', style: 'outline' },
  { id: 'helvetiker_bold', label: 'Helvetiker Bold', style: 'outline' },
  { id: 'optimer_regular', label: 'Optimer Regular', style: 'outline' },
  { id: 'optimer_bold', label: 'Optimer Bold', style: 'outline' },
  { id: 'gentilis_regular', label: 'Gentilis Regular', style: 'outline' },
  { id: 'gentilis_bold', label: 'Gentilis Bold', style: 'outline' },
  { id: 'droid_sans_regular', label: 'Droid Sans Regular', style: 'outline' },
  { id: 'droid_sans_bold', label: 'Droid Sans Bold', style: 'outline' },
  { id: 'droid_serif_regular', label: 'Droid Serif Regular', style: 'outline' },
  { id: 'droid_serif_bold', label: 'Droid Serif Bold', style: 'outline' },
]

const fontLoader = new FontLoader()
const OUTLINE_FONTS = {
  helvetiker_regular: fontLoader.parse(helvetikerRegular as any),
  helvetiker_bold: fontLoader.parse(helvetikerBold as any),
  optimer_regular: fontLoader.parse(optimerRegular as any),
  optimer_bold: fontLoader.parse(optimerBold as any),
  gentilis_regular: fontLoader.parse(gentilisRegular as any),
  gentilis_bold: fontLoader.parse(gentilisBold as any),
  droid_sans_regular: fontLoader.parse(droidSansRegular as any),
  droid_sans_bold: fontLoader.parse(droidSansBold as any),
  droid_serif_regular: fontLoader.parse(droidSerifRegular as any),
  droid_serif_bold: fontLoader.parse(droidSerifBold as any),
} as const

const GLYPHS: Record<string, GlyphDefinition> = {
  A: { advance: 1, strokes: [[[0, 1], [0.5, 0], [1, 1]], [[0.2, 0.58], [0.8, 0.58]]] },
  B: { advance: 1, strokes: [[[0, 0], [0, 1]], [[0, 0], [0.7, 0], [0.9, 0.18], [0.9, 0.38], [0.7, 0.5], [0, 0.5]], [[0, 0.5], [0.72, 0.5], [0.92, 0.68], [0.92, 0.9], [0.72, 1], [0, 1]]] },
  C: { advance: 1, strokes: [[[0.92, 0.14], [0.7, 0], [0.2, 0], [0, 0.2], [0, 0.8], [0.2, 1], [0.7, 1], [0.92, 0.86]]] },
  D: { advance: 1, strokes: [[[0, 0], [0, 1]], [[0, 0], [0.6, 0], [0.94, 0.28], [0.94, 0.72], [0.6, 1], [0, 1]]] },
  E: { advance: 1, strokes: [[[0.95, 0], [0, 0], [0, 1], [0.95, 1]], [[0, 0.5], [0.7, 0.5]]] },
  F: { advance: 1, strokes: [[[0, 0], [0, 1]], [[0, 0], [0.95, 0]], [[0, 0.5], [0.7, 0.5]]] },
  G: { advance: 1, strokes: [[[0.92, 0.16], [0.72, 0], [0.2, 0], [0, 0.2], [0, 0.8], [0.2, 1], [0.72, 1], [0.92, 0.82], [0.92, 0.58], [0.56, 0.58]]] },
  H: { advance: 1, strokes: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]] },
  I: { advance: 0.72, strokes: [[[0.1, 0], [0.62, 0]], [[0.36, 0], [0.36, 1]], [[0.1, 1], [0.62, 1]]] },
  J: { advance: 1, strokes: [[[0.1, 0], [0.92, 0]], [[0.72, 0], [0.72, 0.82], [0.56, 1], [0.22, 1], [0.06, 0.82]]] },
  K: { advance: 1, strokes: [[[0, 0], [0, 1]], [[0.96, 0], [0, 0.56], [1, 1]]] },
  L: { advance: 1, strokes: [[[0, 0], [0, 1], [0.95, 1]]] },
  M: { advance: 1.2, strokes: [[[0, 1], [0, 0], [0.6, 0.58], [1.2, 0], [1.2, 1]]] },
  N: { advance: 1.08, strokes: [[[0, 1], [0, 0], [1.08, 1], [1.08, 0]]] },
  O: { advance: 1, strokes: [[[0.2, 0], [0.8, 0], [1, 0.2], [1, 0.8], [0.8, 1], [0.2, 1], [0, 0.8], [0, 0.2], [0.2, 0]]] },
  P: { advance: 1, strokes: [[[0, 1], [0, 0], [0.72, 0], [0.92, 0.18], [0.92, 0.42], [0.72, 0.58], [0, 0.58]]] },
  Q: { advance: 1, strokes: [[[0.2, 0], [0.8, 0], [1, 0.2], [1, 0.8], [0.8, 1], [0.2, 1], [0, 0.8], [0, 0.2], [0.2, 0]], [[0.56, 0.68], [1.04, 1.08]]] },
  R: { advance: 1, strokes: [[[0, 1], [0, 0], [0.72, 0], [0.92, 0.18], [0.92, 0.42], [0.72, 0.58], [0, 0.58]], [[0.42, 0.58], [1, 1]]] },
  S: { advance: 1, strokes: [[[0.92, 0.14], [0.72, 0], [0.2, 0], [0, 0.18], [0, 0.42], [0.2, 0.54], [0.72, 0.54], [0.92, 0.68], [0.92, 0.86], [0.72, 1], [0.2, 1], [0, 0.86]]] },
  T: { advance: 1, strokes: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]] },
  U: { advance: 1, strokes: [[[0, 0], [0, 0.8], [0.2, 1], [0.8, 1], [1, 0.8], [1, 0]]] },
  V: { advance: 1, strokes: [[[0, 0], [0.5, 1], [1, 0]]] },
  W: { advance: 1.25, strokes: [[[0, 0], [0.24, 1], [0.62, 0.48], [1, 1], [1.25, 0]]] },
  X: { advance: 1, strokes: [[[0, 0], [1, 1]], [[1, 0], [0, 1]]] },
  Y: { advance: 1, strokes: [[[0, 0], [0.5, 0.54], [1, 0]], [[0.5, 0.54], [0.5, 1]]] },
  Z: { advance: 1, strokes: [[[0, 0], [1, 0], [0, 1], [1, 1]]] },
  '0': { advance: 1, strokes: [[[0.2, 0], [0.8, 0], [1, 0.2], [1, 0.8], [0.8, 1], [0.2, 1], [0, 0.8], [0, 0.2], [0.2, 0]], [[0.2, 0.86], [0.8, 0.14]]] },
  '1': { advance: 0.72, strokes: [[[0.36, 0], [0.36, 1]], [[0.12, 0.24], [0.36, 0], [0.58, 0]], [[0.1, 1], [0.62, 1]]] },
  '2': { advance: 1, strokes: [[[0.08, 0.2], [0.28, 0], [0.76, 0], [0.96, 0.18], [0.96, 0.38], [0.06, 1], [0.96, 1]]] },
  '3': { advance: 1, strokes: [[[0.08, 0.14], [0.28, 0], [0.76, 0], [0.96, 0.18], [0.96, 0.4], [0.74, 0.52], [0.96, 0.64], [0.96, 0.86], [0.76, 1], [0.28, 1], [0.08, 0.86]]] },
  '4': { advance: 1, strokes: [[[0.82, 0], [0.82, 1]], [[0.82, 0], [0.08, 0.62], [1, 0.62]]] },
  '5': { advance: 1, strokes: [[[0.92, 0], [0.18, 0], [0.08, 0.46], [0.72, 0.46], [0.92, 0.62], [0.92, 0.86], [0.72, 1], [0.2, 1], [0.04, 0.84]]] },
  '6': { advance: 1, strokes: [[[0.92, 0.14], [0.72, 0], [0.22, 0], [0.02, 0.22], [0.02, 0.8], [0.22, 1], [0.72, 1], [0.92, 0.82], [0.92, 0.58], [0.72, 0.42], [0.22, 0.42], [0.02, 0.58]]] },
  '7': { advance: 1, strokes: [[[0.04, 0], [0.96, 0], [0.36, 1]]] },
  '8': { advance: 1, strokes: [[[0.22, 0], [0.76, 0], [0.94, 0.16], [0.94, 0.36], [0.76, 0.5], [0.22, 0.5], [0.04, 0.36], [0.04, 0.16], [0.22, 0]], [[0.22, 0.5], [0.76, 0.5], [0.96, 0.66], [0.96, 0.86], [0.76, 1], [0.22, 1], [0.04, 0.86], [0.04, 0.66], [0.22, 0.5]]] },
  '9': { advance: 1, strokes: [[[0.92, 0.42], [0.72, 0.58], [0.22, 0.58], [0.02, 0.42], [0.02, 0.2], [0.22, 0], [0.72, 0], [0.92, 0.2], [0.92, 0.78], [0.72, 1], [0.22, 1], [0.02, 0.84]]] },
  '.': { advance: 0.42, strokes: [[[0.2, 0.9], [0.22, 1]]] },
  '-': { advance: 0.72, strokes: [[[0.08, 0.5], [0.64, 0.5]]] },
  '_': { advance: 0.9, strokes: [[[0.04, 1], [0.86, 1]]] },
  '/': { advance: 0.9, strokes: [[[0.04, 1], [0.86, 0]]] },
  ' ': { advance: 0.6, strokes: [] },
  '?': { advance: 1, strokes: [[[0.08, 0.18], [0.28, 0], [0.74, 0], [0.94, 0.18], [0.94, 0.34], [0.72, 0.5], [0.5, 0.58], [0.5, 0.74]], [[0.5, 0.92], [0.5, 1]]] },
}

function invertOperation(operation: FeatureOperation): FeatureOperation {
  return operation === 'add' ? 'subtract' : 'add'
}

export function defaultTextToolConfig(units: 'mm' | 'inch'): TextToolConfig {
  return {
    text: DEFAULT_TEXT,
    style: 'skeleton',
    fontId: 'simple_stroke',
    size: units === 'inch' ? 0.4 : 10,
    operation: 'subtract',
  }
}

export function getTextFontOptions(style?: TextFontStyle): TextFontDefinition[] {
  return style ? TEXT_FONTS.filter((font) => font.style === style) : TEXT_FONTS
}

export function normalizeTextFontId(fontId: string | null | undefined, style: TextFontStyle): TextFontId {
  if (fontId && getTextFontOptions(style).some((font) => font.id === fontId)) {
    return fontId as TextFontId
  }

  return defaultFontIdForStyle(style)
}

export function defaultFontIdForStyle(style: TextFontStyle): TextFontId {
  if (style === 'outline') {
    return 'helvetiker_bold'
  }
  return 'simple_stroke'
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

function lineProfile(points: Point[]): SketchProfile | null {
  if (points.length < 2) {
    return null
  }
  return {
    start: clonePoint(points[0]),
    segments: points.slice(1).map((point) => ({ type: 'line' as const, to: clonePoint(point) })),
    closed: false,
  }
}

function closedProfile(points: Point[]): SketchProfile | null {
  if (points.length < 3) {
    return null
  }
  const unique = points.slice()
  if (unique.length > 1) {
    const first = unique[0]
    const last = unique[unique.length - 1]
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
      unique.pop()
    }
  }
  if (unique.length < 3) {
    return null
  }
  return {
    start: clonePoint(unique[0]),
    segments: [...unique.slice(1).map((point) => ({ type: 'line' as const, to: clonePoint(point) })), { type: 'line' as const, to: clonePoint(unique[0]) }],
    closed: true,
  }
}

function signedArea(points: Point[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area * 0.5
}

function normalizeClosedPoints(points: Point[]): Point[] {
  if (points.length < 3) {
    return points
  }
  const normalized = points.map(clonePoint)
  const first = normalized[0]
  const last = normalized[normalized.length - 1]
  if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
    normalized.pop()
  }
  return normalized
}

function shapePointsToProfile(points: Point[]): SketchProfile | null {
  const normalized = normalizeClosedPoints(points)
  if (normalized.length < 3) {
    return null
  }
  return closedProfile(normalized)
}

function flipProfileY(profile: SketchProfile, maxY: number): SketchProfile {
  return transformProfile(profile, (point) => ({ x: point.x, y: maxY - point.y }))
}

function outlineProfilesFromFont(text: string, size: number, fontId: TextFontId): Array<{ profile: SketchProfile; depth: number }> {
  const font = OUTLINE_FONTS[fontId as keyof typeof OUTLINE_FONTS] ?? OUTLINE_FONTS.helvetiker_bold
  const shapes = font.generateShapes(normalizeText(text), size)
  const rawProfiles: Array<{ profile: SketchProfile; depth: number }> = []

  for (const shape of shapes) {
    const extracted = shape.extractPoints(20)
    const outerProfile = shapePointsToProfile(extracted.shape)
    if (outerProfile) {
      rawProfiles.push({ profile: outerProfile, depth: 0 })
    }
    for (const hole of extracted.holes) {
      const holeProfile = shapePointsToProfile(hole)
      if (holeProfile) {
        rawProfiles.push({ profile: holeProfile, depth: 1 })
      }
    }
  }

  if (rawProfiles.length === 0) {
    return []
  }

  const sourceBounds = rawProfiles
    .map(({ profile }) => getProfileBounds(profile))
    .reduce(
      (acc, next) => ({
        minX: Math.min(acc.minX, next.minX),
        maxX: Math.max(acc.maxX, next.maxX),
        minY: Math.min(acc.minY, next.minY),
        maxY: Math.max(acc.maxY, next.maxY),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    )

  const flippedProfiles = rawProfiles.map(({ profile, depth }) => ({
    profile: flipProfileY(profile, sourceBounds.maxY),
    depth,
  }))

  const flippedBounds = flippedProfiles
    .map(({ profile }) => getProfileBounds(profile))
    .reduce(
      (acc, next) => ({
        minX: Math.min(acc.minX, next.minX),
        maxX: Math.max(acc.maxX, next.maxX),
        minY: Math.min(acc.minY, next.minY),
        maxY: Math.max(acc.maxY, next.maxY),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    )

  return flippedProfiles
    .map(({ profile, depth }) => ({
      profile: translateProfile(profile, -flippedBounds.minX, -flippedBounds.minY),
      depth,
    }))
    .filter(({ profile }) => Math.abs(signedArea(profileVertices(profile))) > size * size * 0.001)
}

function normalizeText(text: string): string {
  const trimmed = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s*\n+\s*/g, ' ')
  return trimmed.trim().length > 0 ? trimmed : DEFAULT_TEXT
}

function glyphFor(char: string): GlyphDefinition {
  const normalized = char === '\n' ? char : char.toUpperCase()
  return GLYPHS[normalized] ?? GLYPHS['?']
}

function transformGlyphStroke(
  stroke: Array<[number, number]>,
  originX: number,
  originY: number,
  size: number,
): Point[] {
  return stroke.map(([x, y]) => ({
    x: originX + x * size,
    y: originY + y * size,
  }))
}

interface PositionedGlyph {
  char: string
  index: number
  polylines: Point[][]
}

const textShapeCache = new Map<string, TextTemplate>()

function cloneProfile(profile: SketchProfile): SketchProfile {
  return {
    ...profile,
    start: clonePoint(profile.start),
    segments: profile.segments.map((segment) => ({
      ...segment,
      to: clonePoint(segment.to),
      ...(segment.type === 'arc' ? { center: clonePoint(segment.center) } : {}),
      ...(segment.type === 'bezier'
        ? {
          control1: clonePoint(segment.control1),
          control2: clonePoint(segment.control2),
        }
        : {}),
    })),
  }
}

function layoutGlyphs(text: string, size: number, anchor: Point): PositionedGlyph[] {
  const normalized = normalizeText(text)
  const lines = normalized.split('\n')
  const glyphs: PositionedGlyph[] = []
  let glyphIndex = 1

  lines.forEach((line, lineIndex) => {
    let cursorX = anchor.x
    const baselineY = anchor.y + lineIndex * size * LINE_HEIGHT_RATIO

    for (const char of line) {
      const glyph = glyphFor(char)
      const polylines = glyph.strokes.map((stroke) => transformGlyphStroke(stroke, cursorX, baselineY, size))
      if (polylines.length > 0) {
        glyphs.push({ char, index: glyphIndex, polylines })
      }
      glyphIndex += 1
      cursorX += size * (glyph.advance + LETTER_SPACING_RATIO)
    }
  })

  return glyphs
}

function displayLabelForText(text: string): string {
  const normalized = normalizeText(text).replace(/\s+/g, ' ').trim()
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized
}

function translateProfile(profile: SketchProfile, dx: number, dy: number): SketchProfile {
  return {
    ...profile,
    start: { x: profile.start.x + dx, y: profile.start.y + dy },
    segments: profile.segments.map((segment) => ({
      ...segment,
      to: { x: segment.to.x + dx, y: segment.to.y + dy },
      ...(segment.type === 'arc'
        ? { center: { x: segment.center.x + dx, y: segment.center.y + dy } }
        : {}),
      ...(segment.type === 'bezier'
        ? {
          control1: { x: segment.control1.x + dx, y: segment.control1.y + dy },
          control2: { x: segment.control2.x + dx, y: segment.control2.y + dy },
        }
        : {}),
    })),
  }
}

function transformProfile(profile: SketchProfile, mapPoint: (point: Point) => Point): SketchProfile {
  return {
    ...profile,
    start: mapPoint(profile.start),
    segments: profile.segments.map((segment) => ({
      ...segment,
      to: mapPoint(segment.to),
      ...(segment.type === 'arc' ? { center: mapPoint(segment.center) } : {}),
      ...(segment.type === 'bezier'
        ? {
          control1: mapPoint(segment.control1),
          control2: mapPoint(segment.control2),
        }
        : {}),
    })),
  }
}

function buildTextTemplate(config: TextToolConfig): TextTemplate {
  const glyphs = layoutGlyphs(config.text, config.size, { x: 0, y: 0 })
  const baseLabel = displayLabelForText(config.text)

  const shapes =
    config.style === 'skeleton'
      ? glyphs.flatMap((glyph) =>
      glyph.polylines
        .map((polyline, strokeIndex) => {
          const profile = lineProfile(polyline)
          if (!profile) {
            return null
          }
          return {
            name: `${baseLabel} ${glyph.index}${glyph.polylines.length > 1 ? String.fromCharCode(97 + strokeIndex) : ''}`,
            profile,
            operation: config.operation,
          }
        })
        .filter((shape): shape is GeneratedTextShape => shape !== null)
    )
      : outlineProfilesFromFont(config.text, config.size, config.fontId).map(({ profile, depth }, contourIndex) => ({
        name: `${baseLabel} ${contourIndex + 1}`,
        profile,
        operation: depth % 2 === 0 ? config.operation : invertOperation(config.operation),
      }))

  const profiles = shapes.map((shape) => shape.profile)
  const bounds =
    profiles.length > 0
      ? profiles
        .map((profile) => getProfileBounds(profile))
        .reduce(
          (acc, next) => ({
            minX: Math.min(acc.minX, next.minX),
            maxX: Math.max(acc.maxX, next.maxX),
            minY: Math.min(acc.minY, next.minY),
            maxY: Math.max(acc.maxY, next.maxY),
          }),
          { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
        )
      : { minX: 0, maxX: config.size, minY: 0, maxY: config.size }

  return {
    shapes: shapes.map((shape) => ({ ...shape, profile: cloneProfile(shape.profile) })),
    bounds: {
      ...bounds,
      width: Math.max(bounds.maxX - bounds.minX, config.size * 0.1),
      height: Math.max(bounds.maxY - bounds.minY, config.size * 0.1),
    },
  }
}

function getTextTemplate(config: TextToolConfig): TextTemplate {
  const cacheKey = `${config.style}|${config.fontId}|${config.operation}|${config.size}|${normalizeText(config.text)}`
  const cached = textShapeCache.get(cacheKey)
  if (cached) {
    return {
      shapes: cached.shapes.map((shape) => ({ ...shape, profile: cloneProfile(shape.profile) })),
      bounds: { ...cached.bounds },
    }
  }

  const template = buildTextTemplate(config)
  textShapeCache.set(cacheKey, template)
  return {
    shapes: template.shapes.map((shape) => ({ ...shape, profile: cloneProfile(shape.profile) })),
    bounds: { ...template.bounds },
  }
}

export function getTextFrameProfile(config: TextToolConfig, anchor: Point): SketchProfile {
  const template = getTextTemplate(config)
  return rectProfile(anchor.x + template.bounds.minX, anchor.y + template.bounds.minY, template.bounds.width, template.bounds.height)
}

export function generateTextShapes(config: TextToolConfig, anchor: Point): GeneratedTextShape[] {
  const template = getTextTemplate(config)
  return template.shapes.map((shape) => ({
    ...shape,
    profile: translateProfile(shape.profile, anchor.x, anchor.y),
  }))
}

export function isTextFeature(feature: SketchFeature): boolean {
  return feature.kind === 'text' && !!feature.text
}

export function resolveTextFeatureShapes(feature: SketchFeature): GeneratedTextShape[] {
  if (!feature.text) {
    return []
  }

  const frameVertices = profileVertices(feature.sketch.profile)
  if (frameVertices.length < 4) {
    return []
  }

  const config: TextToolConfig = {
    text: feature.text.text,
    style: feature.text.style,
    fontId: feature.text.fontId,
    size: feature.text.size,
    operation: feature.operation,
  }
  const template = getTextTemplate(config)
  const origin = frameVertices[0]
  const xAxis = {
    x: frameVertices[1].x - frameVertices[0].x,
    y: frameVertices[1].y - frameVertices[0].y,
  }
  const yAxis = {
    x: frameVertices[3].x - frameVertices[0].x,
    y: frameVertices[3].y - frameVertices[0].y,
  }

  const mapPoint = (point: Point): Point => {
    const u = (point.x - template.bounds.minX) / template.bounds.width
    const v = (point.y - template.bounds.minY) / template.bounds.height
    return {
      x: origin.x + xAxis.x * u + yAxis.x * v,
      y: origin.y + xAxis.y * u + yAxis.y * v,
    }
  }

  return template.shapes.map((shape) => ({
    ...shape,
    operation: shape.operation,
    profile: transformProfile(shape.profile, mapPoint),
  }))
}

export function getFeatureGeometryProfiles(feature: SketchFeature): SketchProfile[] {
  return isTextFeature(feature)
    ? resolveTextFeatureShapes(feature).map((shape) => shape.profile)
    : [feature.sketch.profile]
}

export function featureHasClosedGeometry(feature: SketchFeature): boolean {
  return getFeatureGeometryProfiles(feature).every((profile) => profile.closed)
}

export function getFeatureGeometryBounds(feature: SketchFeature) {
  const profiles = getFeatureGeometryProfiles(feature)
  if (profiles.length === 0) {
    return getProfileBounds(feature.sketch.profile)
  }
  return profiles
    .map((profile) => getProfileBounds(profile))
    .reduce(
      (acc, next) => ({
        minX: Math.min(acc.minX, next.minX),
        maxX: Math.max(acc.maxX, next.maxX),
        minY: Math.min(acc.minY, next.minY),
        maxY: Math.max(acc.maxY, next.maxY),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    )
}

export function expandFeatureGeometry(feature: SketchFeature): SketchFeature[] {
  if (!isTextFeature(feature)) {
    return [feature]
  }

  return resolveTextFeatureShapes(feature).map((shape, index) => ({
    ...feature,
    id: `${feature.id}:text:${index}`,
    name: feature.name,
    kind: 'composite',
    text: null,
    sketch: {
      ...feature.sketch,
      profile: shape.profile,
    },
    operation: shape.operation,
  }))
}
