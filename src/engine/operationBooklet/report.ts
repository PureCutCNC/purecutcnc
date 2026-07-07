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

import type { Operation, OperationKind, OperationPass, OperationTarget, Project } from '../../types/project'
import { getStockBounds } from '../../types/project'
import { formatLength } from '../../utils/units'
import type { Units } from '../../utils/units'
import type { NormalizedTool, ToolpathResult } from '../toolpaths/types'
import type { OperationBookletInput, OperationBookletReport, OperationBookletRow } from './types'

function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket': return 'Pocket'
    case 'v_carve': return 'V-carve'
    case 'v_carve_recursive': return 'V-carve Recursive'
    case 'edge_route_inside': return 'Inside Edge Route'
    case 'edge_route_outside': return 'Outside Edge Route'
    case 'surface_clean': return 'Surface Clean'
    case 'rough_surface': return 'Rough Surface'
    case 'finish_surface': return 'Finish Surface'
    case 'finish_surface_cleanup': return 'Finish Surface Cleanup'
    case 'follow_line': return 'Follow Line'
    case 'drilling': return 'Drilling'
  }
}

function operationPassLabel(pass: OperationPass): string {
  return pass === 'finish' ? 'Finish' : 'Rough'
}

function cutDirectionLabel(direction: NonNullable<Operation['cutDirection']>): string {
  return direction === 'climb' ? 'Climb' : 'Conventional'
}

function machiningOrderLabel(order: NonNullable<Operation['machiningOrder']>): string {
  return order === 'feature_first' ? 'Feature first' : 'Level first'
}

function operationSupportsCutDirection(kind: OperationKind): boolean {
  return (
    kind === 'pocket'
    || kind === 'edge_route_inside'
    || kind === 'edge_route_outside'
    || kind === 'v_carve'
    || kind === 'surface_clean'
    || kind === 'rough_surface'
    || kind === 'finish_surface'
    || kind === 'finish_surface_cleanup'
  )
}

function operationSupportsMachiningOrder(kind: OperationKind): boolean {
  return kind === 'pocket' || kind === 'edge_route_inside' || kind === 'edge_route_outside'
}

function operationUsesRoundOutsideCorners(operation: Operation): boolean {
  return (
    operation.kind === 'edge_route_outside'
    || (operation.kind === 'pocket' && operation.pass === 'finish' && operation.finishWalls)
  )
}

function targetSummary(project: Project, target: OperationTarget): string {
  if (target.source === 'stock') {
    return 'Stock'
  }

  return targetFeatureNames(project, target).join(', ')
}

function targetFeatureNames(project: Project, target: OperationTarget): string[] {
  if (target.source === 'stock') {
    return ['Stock']
  }

  return target.featureIds.map((id) => (
    project.features.find((feature) => feature.id === id)?.name ?? `Missing feature ${id}`
  ))
}

function lengthWithUnits(value: number, units: Units): string {
  return `${formatLength(value, units)} ${units === 'inch' ? 'in' : 'mm'}`
}

function travelDistanceWithUnits(value: number, units: Units): string {
  return `${formatLength(value, units, { maximumFractionDigits: 2 })} ${units === 'inch' ? 'in' : 'mm'}`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function generatedTimestamp(date: Date): string {
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

function formatNumber(value: number, maximumFractionDigits = 3): string {
  return value.toFixed(maximumFractionDigits).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '')
}

function feedWithUnits(value: number, units: Units): string {
  return `${lengthWithUnits(value, units)}/min`
}

function distance3d(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
}

function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unavailable'
  if (seconds < 60) return `${formatNumber(seconds, 1)} s`

  const roundedSeconds = Math.round(seconds)
  const hours = Math.floor(roundedSeconds / 3600)
  const minutes = Math.floor((roundedSeconds % 3600) / 60)
  const remainingSeconds = roundedSeconds % 60

  if (hours > 0) {
    return `${hours} h ${minutes} min ${remainingSeconds} s`
  }
  return `${minutes} min ${remainingSeconds} s`
}

function feedControlledTimeSeconds(
  toolpath: ToolpathResult,
  operation: Operation,
): { seconds: number | null; feedDistance: number; rapidDistance: number } {
  let seconds = 0
  let feedDistance = 0
  let rapidDistance = 0
  let hasInvalidFeed = false

  for (const move of toolpath.moves) {
    const distance = distance3d(move.from, move.to)
    switch (move.kind) {
      case 'cut':
      case 'lead_in':
      case 'lead_out': {
        feedDistance += distance
        // Slot-feed pocket fragments carry a feedScale multiplier and run
        // slower than the operation feed — price them at the effective feed
        // the postprocessor emits.
        const effectiveFeed = operation.feed * (move.feedScale ?? 1)
        if (effectiveFeed > 0) {
          seconds += (distance / effectiveFeed) * 60
        } else {
          hasInvalidFeed = true
        }
        break
      }
      case 'plunge':
        feedDistance += distance
        if (operation.plungeFeed > 0) {
          seconds += (distance / operation.plungeFeed) * 60
        } else {
          hasInvalidFeed = true
        }
        break
      case 'rapid':
        rapidDistance += distance
        break
    }
  }

  return {
    seconds: hasInvalidFeed ? null : seconds,
    feedDistance,
    rapidDistance,
  }
}

function toolRows(tool: NormalizedTool | null, units: Units): OperationBookletRow[] {
  if (!tool) {
    return [{ label: 'Tool', value: 'No tool selected' }]
  }

  return [
    { label: 'Name', value: tool.name },
    { label: 'Type', value: tool.type.replace(/_/g, ' ') },
    { label: 'Diameter', value: lengthWithUnits(tool.diameter, units) },
    ...(tool.vBitAngle ? [{ label: 'V-bit Angle', value: `${formatNumber(tool.vBitAngle, 2)} deg` }] : []),
    { label: 'Flutes', value: String(tool.flutes) },
    { label: 'Material', value: tool.material },
    { label: 'Max Cut Depth', value: lengthWithUnits(tool.maxCutDepth, units) },
  ]
}

function originZSummary(project: Project): string {
  return lengthWithUnits(project.origin.z, project.meta.units)
}

function stockSizeSummary(project: Project): string {
  const bounds = getStockBounds(project.stock)
  const units = project.meta.units
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  return `${lengthWithUnits(width, units)} x ${lengthWithUnits(height, units)} x ${lengthWithUnits(project.stock.thickness, units)}`
}

function settingRows(operation: Operation, project: Project): OperationBookletRow[] {
  const units = project.meta.units
  const rows: OperationBookletRow[] = [
    { label: 'Kind', value: operationKindLabel(operation.kind) },
    { label: 'Pass', value: operationPassLabel(operation.pass) },
    { label: 'Target', value: targetSummary(project, operation.target) },
    { label: 'Feed', value: feedWithUnits(operation.feed, units) },
    { label: 'Plunge Feed', value: feedWithUnits(operation.plungeFeed, units) },
    { label: 'RPM', value: `${Math.round(operation.rpm)} rpm` },
  ]

  if (operation.kind !== 'follow_line' && operation.kind !== 'drilling') {
    rows.push(
      { label: 'Stepdown', value: lengthWithUnits(operation.stepdown, units) },
      { label: 'Stepover', value: formatLength(operation.stepover, units, { maximumFractionDigits: 4 }) },
    )
  }

  if (operationSupportsCutDirection(operation.kind)) {
    rows.push({ label: 'Cut Direction', value: cutDirectionLabel(operation.cutDirection ?? 'conventional') })
  }

  if (operationSupportsMachiningOrder(operation.kind)) {
    rows.push({ label: 'Machining Order', value: machiningOrderLabel(operation.machiningOrder ?? 'level_first') })
  }

  if ((operation.roundOutsideCorners ?? false) && operationUsesRoundOutsideCorners(operation)) {
    rows.push({ label: 'Round Outside Corners', value: 'Enabled' })
  }

  if (operation.kind === 'pocket' || operation.kind === 'surface_clean' || operation.kind === 'finish_surface' || operation.kind === 'finish_surface_cleanup') {
    rows.push(
      { label: 'Pattern', value: operation.pocketPattern },
      { label: 'Pocket Angle', value: `${formatNumber(operation.pocketAngle, 2)} deg` },
    )
  }

  if (operation.kind === 'pocket' && (operation.pocketSlotFeedPercent ?? 100) < 100) {
    rows.push({ label: 'Slot Feed', value: `${formatNumber(operation.pocketSlotFeedPercent ?? 100, 0)} % of feed` })
  }

  if (operation.kind === 'drilling') {
    rows.push(
      { label: 'Drill Type', value: operation.drillType ?? 'simple' },
      { label: 'Peck Depth', value: lengthWithUnits(operation.peckDepth ?? 0, units) },
      { label: 'Dwell Time', value: `${formatNumber(operation.dwellTime ?? 0, 3)} s` },
      { label: 'Retract Height', value: lengthWithUnits(operation.retractHeight ?? 0, units) },
    )
  }

  if (operation.kind === 'follow_line') {
    rows.push({ label: 'Carve Depth', value: lengthWithUnits(operation.carveDepth, units) })
  }

  if (operation.kind !== 'follow_line' && operation.kind !== 'drilling') {
    rows.push(
      { label: 'Stock To Leave Radial', value: lengthWithUnits(operation.stockToLeaveRadial, units) },
      { label: 'Stock To Leave Axial', value: lengthWithUnits(operation.stockToLeaveAxial, units) },
    )
  }

  return rows
}

function statsRows(toolpath: ToolpathResult | null, operation: Operation, units: Units): OperationBookletRow[] {
  if (!toolpath) {
    return [{ label: 'Toolpath', value: 'Not generated' }]
  }

  const cutMoves = toolpath.moves.filter((move) => move.kind === 'cut' || move.kind === 'lead_in' || move.kind === 'lead_out').length
  const rapidMoves = toolpath.moves.filter((move) => move.kind === 'rapid').length
  const plungeMoves = toolpath.moves.filter((move) => move.kind === 'plunge').length
  const timeEstimate = feedControlledTimeSeconds(toolpath, operation)
  const rows: OperationBookletRow[] = [
    { label: 'Moves', value: String(toolpath.moves.length) },
    { label: 'Cut Moves', value: String(cutMoves) },
    { label: 'Rapid Moves', value: String(rapidMoves) },
    { label: 'Plunge Moves', value: String(plungeMoves) },
    {
      label: 'Estimated Feed Time',
      value: timeEstimate.seconds === null
        ? 'Unavailable (invalid feed)'
        : `${durationLabel(timeEstimate.seconds)} (excludes G0 rapid time)`,
    },
    {
      label: 'Feed Travel',
      value: `${travelDistanceWithUnits(timeEstimate.feedDistance, units)} (feed and plunge moves)`,
    },
    {
      label: 'Rapid Travel',
      value: `${travelDistanceWithUnits(timeEstimate.rapidDistance, units)} (G0 speed machine-defined)`,
    },
  ]

  if (toolpath.bounds) {
    rows.push(
      { label: 'Top Z', value: lengthWithUnits(toolpath.bounds.maxZ, units) },
      { label: 'Bottom Z', value: lengthWithUnits(toolpath.bounds.minZ, units) },
    )
  }

  return rows
}

function reportWarnings(tool: NormalizedTool | null, toolpath: ToolpathResult | null): string[] {
  const warnings = [...(toolpath?.warnings ?? [])]
  if (!tool) {
    warnings.unshift('No tool is selected for this operation.')
  }
  if (!toolpath) {
    warnings.unshift('Toolpath could not be generated for this operation.')
  }
  return warnings
}

export function buildOperationBookletReport(input: OperationBookletInput): OperationBookletReport {
  const generatedAt = input.generatedAt ?? new Date()
  return {
    projectName: input.project.meta.name,
    operationName: input.operation.name,
    operationDescription: input.operation.description ?? '',
    generatedDate: generatedTimestamp(generatedAt),
    units: input.project.meta.units === 'inch' ? 'Inch' : 'Millimeter',
    originZSummary: originZSummary(input.project),
    stockSizeSummary: stockSizeSummary(input.project),
    targetSummary: targetSummary(input.project, input.operation.target),
    targetFeatureNames: targetFeatureNames(input.project, input.operation.target),
    toolRows: toolRows(input.tool, input.project.meta.units),
    settingRows: settingRows(input.operation, input.project),
    warnings: reportWarnings(input.tool, input.toolpath),
    toolpathStats: statsRows(input.toolpath, input.operation, input.project.meta.units),
  }
}
