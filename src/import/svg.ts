import { circleProfile, polygonProfile, type Point, type Segment, type SketchProfile } from '../types/project'
import { convertLength } from '../utils/units'
import {
  identityMatrix,
  isProfileDegenerate,
  multiplyMatrix,
  transformProfile,
  type AffineMatrix2D,
} from './normalize'
import type { ImportContext, ImportedShape, ImportInspection, ImportParseResult } from './types'

const KAPPA = 0.5522847498307936

interface SvgUnitContext {
  sourceUnits: ImportContext['targetUnits']
  targetUnits: ImportContext['targetUnits']
  userUnitScale: number
}

function convertSvgUserValue(value: number, units: SvgUnitContext): number {
  return convertLength(value * units.userUnitScale, units.sourceUnits, units.targetUnits)
}

function parseExplicitLength(value: string | null | undefined): { value: number; units: ImportContext['targetUnits'] } | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }

  const unit = trimmed.slice(String(parsed).length).trim().toLowerCase()
  if (unit === 'mm') {
    return { value: parsed, units: 'mm' }
  }
  if (unit === 'in') {
    return { value: parsed, units: 'inch' }
  }
  if (unit === 'cm') {
    return { value: parsed * 10, units: 'mm' }
  }

  return null
}

function parseSvgLength(value: string | null | undefined, units: SvgUnitContext): number {
  if (!value) {
    return 0
  }

  const trimmed = value.trim()
  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed)) {
    return 0
  }

  const explicit = parseExplicitLength(trimmed)
  if (explicit) {
    return convertLength(explicit.value, explicit.units, units.targetUnits)
  }

  return convertSvgUserValue(parsed, units)
}

function parseTransform(transformText: string | null | undefined, units: SvgUnitContext): AffineMatrix2D {
  if (!transformText) {
    return identityMatrix()
  }

  const transformPattern = /([a-zA-Z]+)\(([^)]*)\)/g
  let matrix = identityMatrix()

  for (const match of transformText.matchAll(transformPattern)) {
    const [, operation, rawArgs] = match
    const args = rawArgs
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => Number.parseFloat(entry))
      .filter((entry) => Number.isFinite(entry))

    let next = identityMatrix()
    switch (operation) {
      case 'translate':
        next = {
          a: 1,
          b: 0,
          c: 0,
          d: 1,
          e: convertSvgUserValue(args[0] ?? 0, units),
          f: convertSvgUserValue(args[1] ?? 0, units),
        }
        break
      case 'scale':
        next = { a: args[0] ?? 1, b: 0, c: 0, d: args[1] ?? args[0] ?? 1, e: 0, f: 0 }
        break
      case 'rotate': {
        const angle = ((args[0] ?? 0) * Math.PI) / 180
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        const cx = convertSvgUserValue(args[1] ?? 0, units)
        const cy = convertSvgUserValue(args[2] ?? 0, units)
        next = multiplyMatrix(
          multiplyMatrix(
            { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy },
            { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 },
          ),
          { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy },
        )
        break
      }
      case 'matrix':
        next = {
          a: args[0] ?? 1,
          b: args[1] ?? 0,
          c: args[2] ?? 0,
          d: args[3] ?? 1,
          e: convertSvgUserValue(args[4] ?? 0, units),
          f: convertSvgUserValue(args[5] ?? 0, units),
        }
        break
      default:
        continue
    }

    matrix = multiplyMatrix(matrix, next)
  }

  return matrix
}

function lineProfile(start: Point, end: Point): SketchProfile {
  return {
    start,
    segments: [{ type: 'line', to: end }],
    closed: false,
  }
}

function polylineProfile(points: Point[], closed: boolean): SketchProfile | null {
  if (points.length < 2) {
    return null
  }
  if (closed && points.length >= 3) {
    return polygonProfile(points)
  }
  return {
    start: points[0],
    segments: points.slice(1).map((point) => ({ type: 'line' as const, to: point })),
    closed: false,
  }
}

function ellipseProfile(cx: number, cy: number, rx: number, ry: number): SketchProfile {
  return {
    start: { x: cx + rx, y: cy },
    closed: true,
    segments: [
      {
        type: 'bezier',
        control1: { x: cx + rx, y: cy + ry * KAPPA },
        control2: { x: cx + rx * KAPPA, y: cy + ry },
        to: { x: cx, y: cy + ry },
      },
      {
        type: 'bezier',
        control1: { x: cx - rx * KAPPA, y: cy + ry },
        control2: { x: cx - rx, y: cy + ry * KAPPA },
        to: { x: cx - rx, y: cy },
      },
      {
        type: 'bezier',
        control1: { x: cx - rx, y: cy - ry * KAPPA },
        control2: { x: cx - rx * KAPPA, y: cy - ry },
        to: { x: cx, y: cy - ry },
      },
      {
        type: 'bezier',
        control1: { x: cx + rx * KAPPA, y: cy - ry },
        control2: { x: cx + rx, y: cy - ry * KAPPA },
        to: { x: cx + rx, y: cy },
      },
    ],
  }
}

function tokenizePathData(pathData: string): string[] {
  const matches = pathData.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)
  return matches ?? []
}

function quadraticToBezier(current: Point, control: Point, end: Point): Extract<Segment, { type: 'bezier' }> {
  return {
    type: 'bezier',
    control1: {
      x: current.x + (2 / 3) * (control.x - current.x),
      y: current.y + (2 / 3) * (control.y - current.y),
    },
    control2: {
      x: end.x + (2 / 3) * (control.x - end.x),
      y: end.y + (2 / 3) * (control.y - end.y),
    },
    to: end,
  }
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
  if (len <= 1e-9) {
    return 0
  }
  const sign = ux * vy - uy * vx < 0 ? -1 : 1
  const value = Math.min(1, Math.max(-1, dot / len))
  return sign * Math.acos(value)
}

function svgArcToBeziers(
  start: Point,
  rx: number,
  ry: number,
  xAxisRotation: number,
  largeArc: boolean,
  sweep: boolean,
  end: Point,
): Array<Extract<Segment, { type: 'bezier' }>> {
  if (rx <= 1e-9 || ry <= 1e-9) {
    return [{
      type: 'bezier',
      control1: start,
      control2: end,
      to: end,
    }]
  }

  const phi = (xAxisRotation * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx2 = (start.x - end.x) / 2
  const dy2 = (start.y - end.y) / 2

  let x1p = cosPhi * dx2 + sinPhi * dy2
  let y1p = -sinPhi * dx2 + cosPhi * dy2
  let adjustedRx = Math.abs(rx)
  let adjustedRy = Math.abs(ry)

  const lambda = (x1p * x1p) / (adjustedRx * adjustedRx) + (y1p * y1p) / (adjustedRy * adjustedRy)
  if (lambda > 1) {
    const scale = Math.sqrt(lambda)
    adjustedRx *= scale
    adjustedRy *= scale
  }

  const numerator =
    adjustedRx * adjustedRx * adjustedRy * adjustedRy
    - adjustedRx * adjustedRx * y1p * y1p
    - adjustedRy * adjustedRy * x1p * x1p
  const denominator =
    adjustedRx * adjustedRx * y1p * y1p
    + adjustedRy * adjustedRy * x1p * x1p
  const factor = denominator <= 1e-9 ? 0 : Math.sqrt(Math.max(0, numerator / denominator)) * (largeArc === sweep ? -1 : 1)

  const cxp = factor * ((adjustedRx * y1p) / adjustedRy)
  const cyp = factor * (-(adjustedRy * x1p) / adjustedRx)

  const cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2

  const startAngle = vectorAngle(1, 0, (x1p - cxp) / adjustedRx, (y1p - cyp) / adjustedRy)
  let sweepAngle = vectorAngle(
    (x1p - cxp) / adjustedRx,
    (y1p - cyp) / adjustedRy,
    (-x1p - cxp) / adjustedRx,
    (-y1p - cyp) / adjustedRy,
  )

  if (!sweep && sweepAngle > 0) {
    sweepAngle -= Math.PI * 2
  } else if (sweep && sweepAngle < 0) {
    sweepAngle += Math.PI * 2
  }

  const segmentCount = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)))
  const step = sweepAngle / segmentCount
  const segments: Array<Extract<Segment, { type: 'bezier' }>> = []

  for (let index = 0; index < segmentCount; index += 1) {
    const angle0 = startAngle + step * index
    const angle1 = angle0 + step
    const alpha = (4 / 3) * Math.tan((angle1 - angle0) / 4)
    const cos0 = Math.cos(angle0)
    const sin0 = Math.sin(angle0)
    const cos1 = Math.cos(angle1)
    const sin1 = Math.sin(angle1)

    const p0 = {
      x: cx + adjustedRx * cosPhi * cos0 - adjustedRy * sinPhi * sin0,
      y: cy + adjustedRx * sinPhi * cos0 + adjustedRy * cosPhi * sin0,
    }
    const p1 = {
      x: p0.x + alpha * (-adjustedRx * cosPhi * sin0 - adjustedRy * sinPhi * cos0),
      y: p0.y + alpha * (-adjustedRx * sinPhi * sin0 + adjustedRy * cosPhi * cos0),
    }
    const p3 = {
      x: cx + adjustedRx * cosPhi * cos1 - adjustedRy * sinPhi * sin1,
      y: cy + adjustedRx * sinPhi * cos1 + adjustedRy * cosPhi * sin1,
    }
    const p2 = {
      x: p3.x + alpha * (adjustedRx * cosPhi * sin1 + adjustedRy * sinPhi * cos1),
      y: p3.y + alpha * (adjustedRx * sinPhi * sin1 - adjustedRy * cosPhi * cos1),
    }

    segments.push({
      type: 'bezier',
      control1: index === 0 ? p1 : p1,
      control2: p2,
      to: p3,
    })
  }

  return segments
}

function parsePathProfiles(pathData: string): SketchProfile[] {
  const tokens = tokenizePathData(pathData)
  const profiles: SketchProfile[] = []
  let index = 0
  let command = ''
  let current: Point = { x: 0, y: 0 }
  let subpathStart: Point = { x: 0, y: 0 }
  let currentSegments: Segment[] = []
  let isClosed = false
  let previousCubicControl: Point | null = null
  let previousQuadraticControl: Point | null = null

  const finishSubpath = () => {
    if (currentSegments.length === 0) {
      return
    }
    profiles.push({
      start: subpathStart,
      segments: currentSegments,
      closed: isClosed,
    })
    currentSegments = []
    isClosed = false
    previousCubicControl = null
    previousQuadraticControl = null
  }

  const nextNumber = () => Number.parseFloat(tokens[index++])
  const hasNumber = () => index < tokens.length && !/[A-Za-z]/.test(tokens[index])

  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index])) {
      command = tokens[index++]
    }

    const absolute = command === command.toUpperCase()
    switch (command.toUpperCase()) {
      case 'M': {
        const x = nextNumber()
        const y = nextNumber()
        if (currentSegments.length > 0) {
          finishSubpath()
        }
        current = absolute ? { x, y } : { x: current.x + x, y: current.y + y }
        subpathStart = current
        while (hasNumber()) {
          const lineX = nextNumber()
          const lineY = nextNumber()
          current = absolute ? { x: lineX, y: lineY } : { x: current.x + lineX, y: current.y + lineY }
          currentSegments.push({ type: 'line', to: current })
        }
        break
      }
      case 'L':
        while (hasNumber()) {
          const x = nextNumber()
          const y = nextNumber()
          current = absolute ? { x, y } : { x: current.x + x, y: current.y + y }
          currentSegments.push({ type: 'line', to: current })
        }
        previousCubicControl = null
        previousQuadraticControl = null
        break
      case 'H':
        while (hasNumber()) {
          const x = nextNumber()
          current = absolute ? { x, y: current.y } : { x: current.x + x, y: current.y }
          currentSegments.push({ type: 'line', to: current })
        }
        previousCubicControl = null
        previousQuadraticControl = null
        break
      case 'V':
        while (hasNumber()) {
          const y = nextNumber()
          current = absolute ? { x: current.x, y } : { x: current.x, y: current.y + y }
          currentSegments.push({ type: 'line', to: current })
        }
        previousCubicControl = null
        previousQuadraticControl = null
        break
      case 'C':
        while (hasNumber()) {
          const control1 = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          const control2 = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          const end = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          currentSegments.push({ type: 'bezier', control1, control2, to: end })
          current = end
          previousCubicControl = control2
          previousQuadraticControl = null
        }
        break
      case 'S':
        while (hasNumber()) {
          const control1 = previousCubicControl
            ? { x: current.x * 2 - previousCubicControl.x, y: current.y * 2 - previousCubicControl.y }
            : current
          const control2 = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          const end = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          currentSegments.push({ type: 'bezier', control1, control2, to: end })
          current = end
          previousCubicControl = control2
          previousQuadraticControl = null
        }
        break
      case 'Q':
        while (hasNumber()) {
          const control = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          const end = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          currentSegments.push(quadraticToBezier(current, control, end))
          current = end
          previousQuadraticControl = control
          previousCubicControl = null
        }
        break
      case 'T':
        while (hasNumber()) {
          const control: Point = previousQuadraticControl
            ? { x: current.x * 2 - previousQuadraticControl.x, y: current.y * 2 - previousQuadraticControl.y }
            : current
          const end = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          currentSegments.push(quadraticToBezier(current, control, end))
          current = end
          previousQuadraticControl = control
          previousCubicControl = null
        }
        break
      case 'A':
        while (hasNumber()) {
          const rx = nextNumber()
          const ry = nextNumber()
          const rotation = nextNumber()
          const largeArc = nextNumber() !== 0
          const sweep = nextNumber() !== 0
          const end = absolute
            ? { x: nextNumber(), y: nextNumber() }
            : { x: current.x + nextNumber(), y: current.y + nextNumber() }
          currentSegments.push(...svgArcToBeziers(current, rx, ry, rotation, largeArc, sweep, end))
          current = end
          previousQuadraticControl = null
          previousCubicControl = null
        }
        break
      case 'Z':
        if (current.x !== subpathStart.x || current.y !== subpathStart.y) {
          currentSegments.push({ type: 'line', to: subpathStart })
        }
        current = subpathStart
        isClosed = true
        finishSubpath()
        break
      default:
        index = tokens.length
        break
    }
  }

  finishSubpath()
  return profiles
}

function convertProfileFromSvgUserUnits(profile: SketchProfile, units: SvgUnitContext): SketchProfile {
  return {
    ...profile,
    start: {
      x: convertSvgUserValue(profile.start.x, units),
      y: convertSvgUserValue(profile.start.y, units),
    },
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc') {
        return {
          ...segment,
          to: {
            x: convertSvgUserValue(segment.to.x, units),
            y: convertSvgUserValue(segment.to.y, units),
          },
          center: {
            x: convertSvgUserValue(segment.center.x, units),
            y: convertSvgUserValue(segment.center.y, units),
          },
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: {
            x: convertSvgUserValue(segment.to.x, units),
            y: convertSvgUserValue(segment.to.y, units),
          },
          control1: {
            x: convertSvgUserValue(segment.control1.x, units),
            y: convertSvgUserValue(segment.control1.y, units),
          },
          control2: {
            x: convertSvgUserValue(segment.control2.x, units),
            y: convertSvgUserValue(segment.control2.y, units),
          },
        }
      }

      return {
        ...segment,
        to: {
          x: convertSvgUserValue(segment.to.x, units),
          y: convertSvgUserValue(segment.to.y, units),
        },
      }
    }),
  }
}

function parsePointsAttribute(value: string | null | undefined, units: SvgUnitContext): Point[] {
  if (!value) {
    return []
  }
  const numbers = value
    .trim()
    .split(/[\s,]+/)
    .map((entry) => Number.parseFloat(entry))
    .filter((entry) => Number.isFinite(entry))

  const points: Point[] = []
  for (let index = 0; index < numbers.length - 1; index += 2) {
    points.push({
      x: convertSvgUserValue(numbers[index], units),
      y: convertSvgUserValue(numbers[index + 1], units),
    })
  }
  return points
}

function shapeName(element: Element, fallback: string): string {
  return element.getAttribute('id') || element.getAttribute('inkscape:label') || fallback
}

function parseElementProfiles(
  element: Element,
  units: SvgUnitContext,
  matrix: AffineMatrix2D,
): Array<{ name: string; profile: SketchProfile }> {
  const tagName = element.tagName.toLowerCase()
  const profiles: Array<{ name: string; profile: SketchProfile }> = []
  const name = shapeName(element, tagName)

  if (tagName === 'rect') {
    const x = parseSvgLength(element.getAttribute('x'), units)
    const y = parseSvgLength(element.getAttribute('y'), units)
    const w = parseSvgLength(element.getAttribute('width'), units)
    const h = parseSvgLength(element.getAttribute('height'), units)
    if (w > 0 && h > 0) {
      profiles.push({ name, profile: transformProfile(polygonProfile([
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ]), matrix) })
    }
    return profiles
  }

  if (tagName === 'circle') {
    const cx = parseSvgLength(element.getAttribute('cx'), units)
    const cy = parseSvgLength(element.getAttribute('cy'), units)
    const r = parseSvgLength(element.getAttribute('r'), units)
    if (r > 0) {
      const profile = transformProfile(circleProfile(cx, cy, r), matrix)
      profiles.push({ name, profile })
    }
    return profiles
  }

  if (tagName === 'ellipse') {
    const cx = parseSvgLength(element.getAttribute('cx'), units)
    const cy = parseSvgLength(element.getAttribute('cy'), units)
    const rx = parseSvgLength(element.getAttribute('rx'), units)
    const ry = parseSvgLength(element.getAttribute('ry'), units)
    if (rx > 0 && ry > 0) {
      profiles.push({ name, profile: transformProfile(ellipseProfile(cx, cy, rx, ry), matrix) })
    }
    return profiles
  }

  if (tagName === 'line') {
    const x1 = parseSvgLength(element.getAttribute('x1'), units)
    const y1 = parseSvgLength(element.getAttribute('y1'), units)
    const x2 = parseSvgLength(element.getAttribute('x2'), units)
    const y2 = parseSvgLength(element.getAttribute('y2'), units)
    profiles.push({ name, profile: transformProfile(lineProfile({ x: x1, y: y1 }, { x: x2, y: y2 }), matrix) })
    return profiles
  }

  if (tagName === 'polygon' || tagName === 'polyline') {
    const points = parsePointsAttribute(element.getAttribute('points'), units)
    const profile = polylineProfile(points, tagName === 'polygon')
    if (profile) {
      profiles.push({ name, profile: transformProfile(profile, matrix) })
    }
    return profiles
  }

  if (tagName === 'path') {
    const pathData = element.getAttribute('d') ?? ''
    const pathProfiles = parsePathProfiles(pathData)
    pathProfiles.forEach((profile, index) => {
      profiles.push({
        name: pathProfiles.length > 1 ? `${name} ${index + 1}` : name,
        profile: transformProfile(convertProfileFromSvgUserUnits(profile, units), matrix),
      })
    })
  }

  return profiles
}

function parseSvgDocument(text: string): Document {
  const parser = new DOMParser()
  const document = parser.parseFromString(text, 'image/svg+xml')
  const parserError = document.querySelector('parsererror')
  if (parserError) {
    throw new Error('Failed to parse SVG file.')
  }
  if (document.documentElement.tagName.toLowerCase() !== 'svg') {
    throw new Error('File is not a valid SVG document.')
  }
  return document
}

function inspectSvgRoot(root: Element): ImportInspection {
  const warnings: string[] = []
  const width = parseExplicitLength(root.getAttribute('width'))
  const height = parseExplicitLength(root.getAttribute('height'))
  const viewBox = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map((entry) => Number.parseFloat(entry))
    .filter((entry) => Number.isFinite(entry))

  const rootUnits = width?.units ?? height?.units ?? null
  if (width && height && width.units !== height.units) {
    warnings.push('SVG width and height use different units. Review the source units before importing.')
  }

  if (rootUnits && viewBox.length === 4) {
    const scales: number[] = []
    const viewBoxWidth = Math.abs(viewBox[2])
    const viewBoxHeight = Math.abs(viewBox[3])

    if (width && viewBoxWidth > 1e-9) {
      scales.push(width.value / viewBoxWidth)
    }
    if (height && viewBoxHeight > 1e-9) {
      scales.push(height.value / viewBoxHeight)
    }

    if (scales.length > 0) {
      const scale = scales[0]
      if (scales.some((entry) => Math.abs(entry - scale) > Math.max(1e-6, Math.abs(scale) * 0.01))) {
        warnings.push('SVG width/viewBox and height/viewBox imply different scales. Using the first detected scale.')
      }

      return {
        detectedUnits: rootUnits,
        sourceUnitScale: scale,
        unitsReliable: true,
        summary: 'Detected source units from SVG size and viewBox.',
        warnings,
      }
    }
  }

  if (rootUnits) {
    warnings.push('SVG declares physical size but no usable viewBox. Unitless geometry will be treated as the detected units.')
    return {
      detectedUnits: rootUnits,
      sourceUnitScale: 1,
      unitsReliable: false,
      summary: 'Detected source units from SVG size attributes.',
      warnings,
    }
  }

  warnings.push('Could not detect SVG source units from the file.')
  return {
    detectedUnits: null,
    sourceUnitScale: 1,
    unitsReliable: false,
    summary: 'No explicit physical SVG units detected.',
    warnings,
  }
}

export function inspectSvgString(text: string): ImportInspection {
  const document = parseSvgDocument(text)
  return inspectSvgRoot(document.documentElement)
}

export function importSvgString(text: string, context: ImportContext): ImportParseResult {
  const document = parseSvgDocument(text)
  const inspection = inspectSvgRoot(document.documentElement)
  const units: SvgUnitContext = {
    sourceUnits: context.sourceUnits ?? inspection.detectedUnits ?? context.targetUnits,
    targetUnits: context.targetUnits,
    userUnitScale: context.sourceUnitScale ?? inspection.sourceUnitScale,
  }

  const warnings: string[] = []
  const shapes: ImportedShape[] = []

  const visit = (element: Element, inheritedMatrix: AffineMatrix2D) => {
    const nextMatrix = multiplyMatrix(inheritedMatrix, parseTransform(element.getAttribute('transform'), units))
    const tagName = element.tagName.toLowerCase()

    if (['svg', 'g'].includes(tagName)) {
      for (const child of Array.from(element.children)) {
        visit(child, nextMatrix)
      }
      return
    }

    const profiles = parseElementProfiles(element, units, nextMatrix)
    if (profiles.length === 0) {
      warnings.push(`Skipped unsupported or empty SVG element <${tagName}>.`)
      return
    }

    for (const entry of profiles) {
      if (isProfileDegenerate(entry.profile)) {
        warnings.push(`Skipped degenerate SVG shape "${entry.name}".`)
        continue
      }

      shapes.push({
        name: entry.name,
        sourceType: 'svg',
        layerName: null,
        profile: entry.profile,
      })
    }
  }

  visit(document.documentElement, identityMatrix())
  return { shapes, warnings }
}
