import type { Tool, ToolType } from './types/project'

export interface ToolLibraryEntry extends Omit<Tool, 'id'> {
  key: string
}

export interface ToolLibraryFile {
  name: string
  version: string
  tools: ToolLibraryEntry[]
}

const TOOL_TYPES: ToolType[] = ['flat_endmill', 'ball_endmill', 'v_bit', 'drill']
const TOOL_MATERIALS: Tool['material'][] = ['carbide', 'hss']
const TOOL_UNITS: Tool['units'][] = ['mm', 'inch']

let bundledToolLibraryPromise: Promise<ToolLibraryFile> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function parseToolLibraryEntry(value: unknown, index: number): ToolLibraryEntry | null {
  if (!isRecord(value)) {
    return null
  }

  const key = readString(value.key, `tool_${index + 1}`)
  const name = readString(value.name, `Library Tool ${index + 1}`)
  const units = TOOL_UNITS.includes(value.units as Tool['units']) ? (value.units as Tool['units']) : null
  const type = TOOL_TYPES.includes(value.type as ToolType) ? (value.type as ToolType) : null
  const material = TOOL_MATERIALS.includes(value.material as Tool['material'])
    ? (value.material as Tool['material'])
    : null

  if (!units || !type || !material) {
    return null
  }

  const diameter = isFiniteNumber(value.diameter) && value.diameter > 0 ? value.diameter : null
  const vBitAngle = isFiniteNumber(value.vBitAngle) && value.vBitAngle > 0 && value.vBitAngle < 180
    ? value.vBitAngle
    : null
  const flutes = isFiniteNumber(value.flutes) && value.flutes >= 1 ? Math.round(value.flutes) : null
  const defaultRpm = isFiniteNumber(value.defaultRpm) && value.defaultRpm > 0 ? Math.round(value.defaultRpm) : null
  const defaultFeed = isFiniteNumber(value.defaultFeed) && value.defaultFeed > 0 ? value.defaultFeed : null
  const defaultPlungeFeed =
    isFiniteNumber(value.defaultPlungeFeed) && value.defaultPlungeFeed > 0 ? value.defaultPlungeFeed : null
  const defaultStepdown =
    isFiniteNumber(value.defaultStepdown) && value.defaultStepdown > 0 ? value.defaultStepdown : null
  const defaultStepover =
    isFiniteNumber(value.defaultStepover) && value.defaultStepover > 0 && value.defaultStepover <= 1
      ? value.defaultStepover
      : null

  if (
    diameter === null
    || flutes === null
    || defaultRpm === null
    || defaultFeed === null
    || defaultPlungeFeed === null
    || defaultStepdown === null
    || defaultStepover === null
  ) {
    return null
  }

  return {
    key,
    name,
    units,
    type,
    diameter,
    vBitAngle: type === 'v_bit' ? (vBitAngle ?? 60) : null,
    flutes,
    material,
    defaultRpm,
    defaultFeed,
    defaultPlungeFeed,
    defaultStepdown,
    defaultStepover,
  }
}

function parseToolLibraryFile(value: unknown): ToolLibraryFile {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new Error('Tool library JSON is missing a valid tools array.')
  }

  const tools = value.tools
    .map((entry, index) => parseToolLibraryEntry(entry, index))
    .filter((entry): entry is ToolLibraryEntry => entry !== null)

  return {
    name: readString(value.name, 'Bundled Tool Library'),
    version: readString(value.version, '1'),
    tools,
  }
}

export async function loadBundledToolLibrary(): Promise<ToolLibraryFile> {
  if (!bundledToolLibraryPromise) {
    bundledToolLibraryPromise = fetch('/tool-library.json')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load tool library (${response.status}).`)
        }

        const payload = await response.json()
        return parseToolLibraryFile(payload)
      })
      .catch((error) => {
        bundledToolLibraryPromise = null
        throw error instanceof Error ? error : new Error('Failed to load tool library.')
      })
  }

  return bundledToolLibraryPromise
}
