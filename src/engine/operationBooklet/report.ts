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
// Presentation exception: the booklet report is a user-facing document, so
// it maps structured warnings to localized text here via the i18n layer.
import { translate } from '../../i18n/store'
import { toolpathWarningTexts } from '../../i18n/warningText'
import { getStockBounds } from '../../types/project'
import { formatLength } from '../../utils/units'
import type { Units } from '../../utils/units'
import type { NormalizedTool, ToolpathResult } from '../toolpaths/types'
import type { OperationBookletInput, OperationBookletReport, OperationBookletRow } from './types'

function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket': return translate('booklet.operation.pocket')
    case 'v_carve': return translate('booklet.operation.vCarve')
    case 'v_carve_medial': return translate('booklet.operation.vCarveMedial')
    case 'edge_route_inside': return translate('booklet.operation.insideEdgeRoute')
    case 'edge_route_outside': return translate('booklet.operation.outsideEdgeRoute')
    case 'surface_clean': return translate('booklet.operation.surfaceClean')
    case 'rough_surface': return translate('booklet.operation.roughSurface')
    case 'finish_surface': return translate('booklet.operation.finishSurface')
    case 'finish_surface_cleanup': return translate('booklet.operation.finishSurfaceCleanup')
    case 'follow_line': return translate('booklet.operation.followLine')
    case 'drilling': return translate('booklet.operation.drilling')
  }
}

function operationPassLabel(pass: OperationPass): string {
  return pass === 'finish' ? translate('booklet.pass.finish') : translate('booklet.pass.rough')
}

function cutDirectionLabel(direction: NonNullable<Operation['cutDirection']>): string {
  return direction === 'climb' ? translate('booklet.cutDirection.climb') : translate('booklet.cutDirection.conventional')
}

function machiningOrderLabel(order: NonNullable<Operation['machiningOrder']>): string {
  return order === 'feature_first' ? translate('booklet.machiningOrder.featureFirst') : translate('booklet.machiningOrder.levelFirst')
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
    || operation.kind === 'pocket'
    || operation.kind === 'surface_clean'
    || operation.kind === 'rough_surface'
  )
}

function targetSummary(project: Project, target: OperationTarget): string {
  if (target.source === 'stock') {
    return translate('booklet.target.stock')
  }

  return targetFeatureNames(project, target).join(', ')
}

function targetFeatureNames(project: Project, target: OperationTarget): string[] {
  if (target.source === 'stock') {
    return [translate('booklet.target.stock')]
  }

  return target.featureIds.map((id) => (
    project.features.find((feature) => feature.id === id)?.name ?? translate('booklet.target.missingFeature', { id })
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
  if (!Number.isFinite(seconds) || seconds < 0) return translate('booklet.value.unavailable')
  if (seconds < 60) return translate('booklet.duration.seconds', { seconds: formatNumber(seconds, 1) })

  const roundedSeconds = Math.round(seconds)
  const hours = Math.floor(roundedSeconds / 3600)
  const minutes = Math.floor((roundedSeconds % 3600) / 60)
  const remainingSeconds = roundedSeconds % 60

  if (hours > 0) {
    return translate('booklet.duration.hoursMinutesSeconds', { hours, minutes, seconds: remainingSeconds })
  }
  return translate('booklet.duration.minutesSeconds', { minutes, seconds: remainingSeconds })
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
    return [{ label: translate('booklet.label.tool'), value: translate('booklet.value.noToolSelected') }]
  }

  return [
    { label: translate('booklet.label.name'), value: tool.name },
    { label: translate('booklet.label.type'), value: tool.type.replace(/_/g, ' ') },
    { label: translate('booklet.label.diameter'), value: lengthWithUnits(tool.diameter, units) },
    ...(tool.vBitAngle ? [{ label: translate('booklet.label.vBitAngle'), value: `${formatNumber(tool.vBitAngle, 2)} deg` }] : []),
    { label: translate('booklet.label.flutes'), value: String(tool.flutes) },
    { label: translate('booklet.label.material'), value: tool.material },
    { label: translate('booklet.label.maxCutDepth'), value: lengthWithUnits(tool.maxCutDepth, units) },
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
    { label: translate('booklet.label.kind'), value: operationKindLabel(operation.kind) },
    { label: translate('booklet.label.pass'), value: operationPassLabel(operation.pass) },
    { label: translate('booklet.label.target'), value: targetSummary(project, operation.target) },
    { label: translate('booklet.label.feed'), value: feedWithUnits(operation.feed, units) },
    { label: translate('booklet.label.plungeFeed'), value: feedWithUnits(operation.plungeFeed, units) },
    { label: translate('booklet.label.rpm'), value: `${Math.round(operation.rpm)} rpm` },
  ]

  if (operation.kind !== 'follow_line' && operation.kind !== 'drilling') {
    rows.push(
      { label: translate('booklet.label.stepdown'), value: lengthWithUnits(operation.stepdown, units) },
      { label: translate('booklet.label.stepover'), value: formatLength(operation.stepover, units, { maximumFractionDigits: 4 }) },
    )
  }

  if (operationSupportsCutDirection(operation.kind)) {
    rows.push({ label: translate('booklet.label.cutDirection'), value: cutDirectionLabel(operation.cutDirection ?? 'conventional') })
  }

  if (operationSupportsMachiningOrder(operation.kind)) {
    rows.push({ label: translate('booklet.label.machiningOrder'), value: machiningOrderLabel(operation.machiningOrder ?? 'level_first') })
  }

  if ((operation.roundOutsideCorners ?? false) && operationUsesRoundOutsideCorners(operation)) {
    rows.push({ label: translate('booklet.label.roundOutsideCorners'), value: translate('booklet.value.enabled') })
  }

  if (operation.kind === 'pocket' || operation.kind === 'surface_clean' || operation.kind === 'finish_surface' || operation.kind === 'finish_surface_cleanup') {
    rows.push(
      { label: translate('booklet.label.pattern'), value: operation.pocketPattern },
      { label: translate('booklet.label.pocketAngle'), value: `${formatNumber(operation.pocketAngle, 2)} deg` },
    )
  }

  if (operation.kind === 'pocket' && (operation.pocketSlotFeedPercent ?? 100) < 100) {
    rows.push({ label: translate('booklet.label.slotFeed'), value: translate('booklet.value.slotFeed', { percent: formatNumber(operation.pocketSlotFeedPercent ?? 100, 0) }) })
  }

  if (operation.kind === 'drilling') {
    rows.push(
      { label: translate('booklet.label.drillType'), value: operation.drillType ?? 'simple' },
      { label: translate('booklet.label.peckDepth'), value: lengthWithUnits(operation.peckDepth ?? 0, units) },
      { label: translate('booklet.label.dwellTime'), value: `${formatNumber(operation.dwellTime ?? 0, 3)} s` },
      { label: translate('booklet.label.retractHeight'), value: lengthWithUnits(operation.retractHeight ?? 0, units) },
    )
  }

  if (operation.kind === 'follow_line') {
    rows.push({ label: translate('booklet.label.carveDepth'), value: lengthWithUnits(operation.carveDepth, units) })
  }

  if (operation.kind !== 'follow_line' && operation.kind !== 'drilling') {
    rows.push(
      { label: translate('booklet.label.stockToLeaveRadial'), value: lengthWithUnits(operation.stockToLeaveRadial, units) },
      { label: translate('booklet.label.stockToLeaveAxial'), value: lengthWithUnits(operation.stockToLeaveAxial, units) },
    )
  }

  return rows
}

function statsRows(toolpath: ToolpathResult | null, operation: Operation, units: Units): OperationBookletRow[] {
  if (!toolpath) {
    return [{ label: translate('booklet.label.toolpath'), value: translate('booklet.value.notGenerated') }]
  }

  const cutMoves = toolpath.moves.filter((move) => move.kind === 'cut' || move.kind === 'lead_in' || move.kind === 'lead_out').length
  const rapidMoves = toolpath.moves.filter((move) => move.kind === 'rapid').length
  const plungeMoves = toolpath.moves.filter((move) => move.kind === 'plunge').length
  const timeEstimate = feedControlledTimeSeconds(toolpath, operation)
  const rows: OperationBookletRow[] = [
    { label: translate('booklet.label.moves'), value: String(toolpath.moves.length) },
    { label: translate('booklet.label.cutMoves'), value: String(cutMoves) },
    { label: translate('booklet.label.rapidMoves'), value: String(rapidMoves) },
    { label: translate('booklet.label.plungeMoves'), value: String(plungeMoves) },
    {
      label: translate('booklet.label.estimatedFeedTime'),
      value: timeEstimate.seconds === null
        ? translate('booklet.value.unavailableInvalidFeed')
        : translate('booklet.value.estimatedFeedTime', { duration: durationLabel(timeEstimate.seconds) }),
    },
    {
      label: translate('booklet.label.feedTravel'),
      value: translate('booklet.value.feedTravel', { distance: travelDistanceWithUnits(timeEstimate.feedDistance, units) }),
    },
    {
      label: translate('booklet.label.rapidTravel'),
      value: translate('booklet.value.rapidTravel', { distance: travelDistanceWithUnits(timeEstimate.rapidDistance, units) }),
    },
  ]

  if (toolpath.bounds) {
    rows.push(
      { label: translate('booklet.label.topZ'), value: lengthWithUnits(toolpath.bounds.maxZ, units) },
      { label: translate('booklet.label.bottomZ'), value: lengthWithUnits(toolpath.bounds.minZ, units) },
    )
  }

  return rows
}

function reportWarnings(tool: NormalizedTool | null, toolpath: ToolpathResult | null): string[] {
  const warnings = toolpathWarningTexts(toolpath?.warnings ?? [])
  if (!tool) {
    warnings.unshift(translate('warnings.bookletNoTool'))
  }
  if (!toolpath) {
    warnings.unshift(translate('warnings.bookletNoToolpath'))
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
    units: input.project.meta.units === 'inch' ? translate('booklet.units.inch') : translate('booklet.units.millimeter'),
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
