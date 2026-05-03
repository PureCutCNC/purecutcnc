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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { SelectionState } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { loadBundledToolLibrary, type ToolLibraryEntry } from '../../toolLibrary'
import type {
  CutDirection,
  DrillType,
  MachiningOrder,
  OperationKind,
  OperationPass,
  PocketPattern,
  OperationTarget,
  Project,
  Tool,
  ToolType,
} from '../../types/project'
import { featureHasClosedGeometry } from '../../text'
import { convertToolUnits, formatLength, parseLengthInput } from '../../utils/units'
import { PanelSplit } from './PanelSplit'

interface CAMPanelProps {
  mode: 'operations' | 'tools'
  selectedOperationId: string | null
  onSelectedOperationIdChange: (operationId: string | null) => void
  onExport: () => void
  toolpathWarnings?: string[] | null
}

interface DraftTextInputProps {
  value: string
  onCommit: (value: string) => void
}

function DraftTextInput({ value, onCommit }: DraftTextInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = value
  }

  function commit(element: HTMLInputElement) {
    if (element.value !== value) {
      onCommit(element.value)
    } else {
      reset(element)
    }
  }

  return (
    <input
      type="text"
      defaultValue={value}
      spellCheck={false}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
          return
        }

        if (event.key === 'Escape') {
          reset(event.currentTarget)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

interface DraftLengthInputProps {
  value: number
  units: 'mm' | 'inch'
  min?: number
  max?: number
  onCommit: (value: number) => void
}

function DraftLengthInput({ value, units, min, max, onCommit }: DraftLengthInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = formatLength(value, units)
  }

  function commit(element: HTMLInputElement) {
    const next = parseLengthInput(element.value, units)
    if (next === null || !Number.isFinite(next)) {
      reset(element)
      return
    }
    if (min !== undefined && next < min) {
      reset(element)
      return
    }
    if (max !== undefined && next > max) {
      reset(element)
      return
    }

    if (next !== value) {
      onCommit(next)
    } else {
      reset(element)
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      defaultValue={formatLength(value, units)}
      spellCheck={false}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
          return
        }

        if (event.key === 'Escape') {
          reset(event.currentTarget)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

interface DraftNumberInputProps {
  value: number
  min?: number
  max?: number
  onCommit: (value: number) => void
}

function DraftNumberInput({ value, min, max, onCommit }: DraftNumberInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = String(value)
  }

  function commit(element: HTMLInputElement) {
    const next = Number(element.value)
    if (!Number.isFinite(next)) {
      reset(element)
      return
    }
    if (min !== undefined && next < min) {
      reset(element)
      return
    }
    if (max !== undefined && next > max) {
      reset(element)
      return
    }

    if (next !== value) {
      onCommit(next)
    } else {
      reset(element)
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      defaultValue={String(value)}
      spellCheck={false}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
          return
        }

        if (event.key === 'Escape') {
          reset(event.currentTarget)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function toolTypeLabel(type: ToolType): string {
  switch (type) {
    case 'flat_endmill':
      return 'Flat Endmill'
    case 'ball_endmill':
      return 'Ball Endmill'
    case 'v_bit':
      return 'V-Bit'
    case 'drill':
      return 'Drill'
  }
}

function toolUnitsLabel(units: Tool['units']): string {
  return units === 'inch' ? 'in' : 'mm'
}

function toolMatchesLibraryEntry(tool: Tool, libraryEntry: ToolLibraryEntry): boolean {
  return (
    tool.name === libraryEntry.name
    && tool.units === libraryEntry.units
    && tool.type === libraryEntry.type
    && tool.diameter === libraryEntry.diameter
    && tool.vBitAngle === libraryEntry.vBitAngle
    && tool.flutes === libraryEntry.flutes
    && tool.material === libraryEntry.material
    && tool.defaultRpm === libraryEntry.defaultRpm
    && tool.defaultFeed === libraryEntry.defaultFeed
    && tool.defaultPlungeFeed === libraryEntry.defaultPlungeFeed
    && tool.defaultStepdown === libraryEntry.defaultStepdown
    && tool.defaultStepover === libraryEntry.defaultStepover
  )
}

function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return 'Pocket'
    case 'v_carve':
      return 'V-Carve offset'
    case 'v_carve_recursive':
      return 'V-Carve skeleton'
    case 'edge_route_inside':
      return 'Edge route inside'
    case 'edge_route_outside':
      return 'Edge route outside'
    case 'surface_clean':
      return 'Surface clean'
    case 'rough_surface':
      return '3D Surface rough'
    case 'finish_surface':
      return '3D Surface finish'
    case 'follow_line':
      return 'Engrave'
    case 'drilling':
      return 'Drill'
    default:
      return 'Unknown'
  }
}

function operationAddButtonLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return 'Pocket'
    case 'v_carve':
      return 'V-Carve offset'
    case 'v_carve_recursive':
      return 'V-Carve skeleton'
    case 'edge_route_inside':
      return 'Edge in'
    case 'edge_route_outside':
      return 'Edge out'
    case 'surface_clean':
      return 'Surface'
    case 'rough_surface':
      return '3D Surface rough'
    case 'finish_surface':
      return '3D Surface finish'
    case 'follow_line':
      return 'Engrave'
    case 'drilling':
      return 'Drill'
  }
}

function operationSupportsPassSelection(kind: OperationKind): boolean {
  return kind !== 'follow_line' && kind !== 'v_carve' && kind !== 'v_carve_recursive' && kind !== 'drilling' && kind !== 'rough_surface' && kind !== 'finish_surface'
}

function drillTypeLabel(type: DrillType): string {
  switch (type) {
    case 'simple':
      return 'Simple (G81)'
    case 'peck':
      return 'Peck (G83)'
    case 'dwell':
      return 'Dwell (G82)'
    case 'chip_breaking':
      return 'Chip breaking (G73)'
  }
}

function operationTargetSummary(project: Project, target: OperationTarget): string {
  if (target.source === 'stock') {
    return 'Stock'
  }

  const features = target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is Project['features'][number] => feature !== null)
  const names = features
    .filter((feature) => feature.operation !== 'region')
    .map((feature) => feature.name)
  const regionNames = features
    .filter((feature) => feature.operation === 'region')
    .map((feature) => feature.name)

  if (names.length === 0 && regionNames.length === 0) {
    return 'No features'
  }

  const machiningSummary = names.length > 0 ? names.join(', ') : 'No machining target'
  return regionNames.length > 0
    ? `${machiningSummary}; filters: ${regionNames.join(', ')}`
    : machiningSummary
}

function pocketPatternLabel(pattern: PocketPattern): string {
  switch (pattern) {
    case 'offset':
      return 'Offset'
    case 'parallel':
      return 'Parallel'
  }
}

function operationRequiresClosedProfiles(kind: OperationKind): boolean {
  return kind === 'pocket' || kind === 'v_carve' || kind === 'v_carve_recursive' || kind === 'edge_route_inside' || kind === 'edge_route_outside' || kind === 'surface_clean'
}

function getValidOperationTarget(project: Project, selection: SelectionState, kind: OperationKind): OperationTarget | null {
  if (kind === 'drilling') {
    if (selection.selectedFeatureIds.length === 0) {
      return null
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return null
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.kind === 'circle')
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? { source: 'features', featureIds: features.map((feature) => feature.id) }
      : null
  }

  if (kind === 'follow_line') {
    if (selection.selectedFeatureIds.length === 0) {
      return null
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return features.length === selection.selectedFeatureIds.length
      && machiningFeatures.length > 0
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? { source: 'features', featureIds: features.map((feature) => feature.id) }
      : null
  }

  if (kind === 'surface_clean') {
    if (selection.selectedFeatureIds.length === 0) {
      return null
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return null
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => (feature.operation === 'add' || feature.operation === 'model') && (!operationRequiresClosedProfiles(kind) || featureHasClosedGeometry(feature)))
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? { source: 'features', featureIds: features.map((feature) => feature.id) }
      : null
  }

  if (kind === 'v_carve' || kind === 'v_carve_recursive') {
    if (selection.selectedFeatureIds.length === 0) {
      return null
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return null
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.operation === 'subtract' && featureHasClosedGeometry(feature))
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? { source: 'features', featureIds: features.map((feature) => feature.id) }
      : null
  }

  if (kind === 'rough_surface') {
    if (selection.selectedFeatureIds.length === 0) {
      return null
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return null
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    const hasModel = machiningFeatures.some((f) => f.operation === 'model' && f.kind === 'stl')
    return hasModel && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? { source: 'features', featureIds: features.map((f) => f.id) }
      : null
  }

  if (kind === 'finish_surface') {
    if (selection.selectedFeatureIds.length === 0) {
      return null
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return null
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    const hasModel = machiningFeatures.some((f) => f.operation === 'model' && f.kind === 'stl')
    return hasModel && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? { source: 'features', featureIds: features.map((f) => f.id) }
      : null
  }

  if (selection.selectedFeatureIds.length === 0) {
    return null
  }

  const features = selection.selectedFeatureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is Project['features'][number] => feature !== null)

  if (features.length !== selection.selectedFeatureIds.length) {
    return null
  }

  const wantsSubtract = kind === 'pocket' || kind === 'edge_route_inside'
  const expectedOperation = wantsSubtract ? 'subtract' : 'add'
  const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
  const regionFeatures = features.filter((feature) => feature.operation === 'region')
  if (machiningFeatures.length === 0) {
    return null
  }
  if (!machiningFeatures.every((feature) => feature.operation === expectedOperation || (!wantsSubtract && feature.operation === 'model'))) {
    return null
  }
  if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
    return null
  }

  if (operationRequiresClosedProfiles(kind) && !features.every((feature) => featureHasClosedGeometry(feature))) {
    return null
  }

  return { source: 'features', featureIds: features.map((feature) => feature.id) }
}

function getOperationAddHint(project: Project, selection: SelectionState, kind: OperationKind): string | null {
  if (kind === 'drilling') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more circle features first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.kind === 'circle')
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : 'Drilling requires circle features; closed regions are optional filters'
  }

  if (kind === 'follow_line') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more open or closed features first; closed regions are optional filters'
    }
    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)
    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0 && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : 'Engrave requires at least one path feature; closed regions are optional filters'
  }

  if (kind === 'surface_clean') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more add/model features first; closed regions are optional filters'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    if (machiningFeatures.length === 0) {
      return 'Surface clean requires at least one add/model feature; regions are only filters'
    }
    if (!machiningFeatures.every((feature) => feature.operation === 'add' || feature.operation === 'model')) {
      return 'Surface clean only accepts add/model features plus optional closed regions'
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return 'Region filters must be closed profiles'
    }

    return machiningFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : 'Surface clean only accepts closed profiles'
  }

  if (kind === 'v_carve' || kind === 'v_carve_recursive') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more closed subtract features first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    if (machiningFeatures.length === 0) {
      return `${operationKindLabel(kind)} requires at least one subtract feature; regions are only filters`
    }
    if (!machiningFeatures.every((feature) => feature.operation === 'subtract')) {
      return `${operationKindLabel(kind)} only accepts subtract features plus optional closed regions`
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return 'Region filters must be closed profiles'
    }

    return machiningFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : `${operationKindLabel(kind)} only accepts closed profiles`
  }

  if (kind === 'rough_surface') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select a model (STL) feature first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return 'One or more selected features not found'
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    const hasModel = machiningFeatures.some((f) => f.operation === 'model' && f.kind === 'stl')

    if (!hasModel) {
      return 'Rough surface requires at least one model (STL) feature; closed regions are optional filters'
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return 'Region filters must be closed profiles'
    }

    return null
  }

  if (kind === 'finish_surface') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select a model (STL) feature first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return 'One or more selected features not found'
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    const hasModel = machiningFeatures.some((f) => f.operation === 'model' && f.kind === 'stl')

    if (!hasModel) {
      return 'Finish surface requires at least one model (STL) feature; closed regions are optional filters'
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return 'Region filters must be closed profiles'
    }

    return null
  }

  if (selection.selectedFeatureIds.length === 0) {
    return 'Select one or more compatible features first'
  }

  const features = selection.selectedFeatureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is Project['features'][number] => feature !== null)

  const wantsSubtract = kind === 'pocket' || kind === 'edge_route_inside'
  const expectedOperation = wantsSubtract ? 'subtract' : 'add'
  const acceptsOperation = (feature: Project['features'][number]) => (
    feature.operation === expectedOperation
    || (kind === 'edge_route_outside' && feature.operation === 'model')
  )
  const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
  const regionFeatures = features.filter((feature) => feature.operation === 'region')
  if (machiningFeatures.length === 0) {
    return wantsSubtract
      ? 'Select at least one subtract feature; closed regions are optional filters'
      : kind === 'edge_route_outside'
        ? 'Select at least one add/model feature; closed regions are optional filters'
        : 'Select at least one add feature; closed regions are optional filters'
  }
  if (!machiningFeatures.every(acceptsOperation)) {
    return wantsSubtract
      ? 'This operation only accepts subtract features plus optional closed regions'
      : kind === 'edge_route_outside'
        ? 'This operation only accepts add/model features plus optional closed regions'
        : 'This operation only accepts add features plus optional closed regions'
  }
  if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
    return 'Region filters must be closed profiles'
  }

  if (operationRequiresClosedProfiles(kind) && !machiningFeatures.every((feature) => featureHasClosedGeometry(feature))) {
    return `${operationKindLabel(kind)} only accepts closed profiles`
  }

  return null
}

function getOperationTargetUpdateHint(project: Project, selection: SelectionState, operation: Project['operations'][number]): string | null {
  const nextTarget = getValidOperationTarget(project, selection, operation.kind)
  if (nextTarget) {
    return null
  }

  if (selection.selectedFeatureIds.length === 0) {
    return 'Select one or more compatible features in the tree or sketch'
  }

  return getOperationAddHint(project, selection, operation.kind)
}

export function CAMPanel({
  mode,
  selectedOperationId: selectedOperationIdProp,
  onSelectedOperationIdChange,
  onExport,
  toolpathWarnings,
}: CAMPanelProps) {
  const [selectedToolIdState, setSelectedToolId] = useState<string | null>(null)
  const [libraryTools, setLibraryTools] = useState<ToolLibraryEntry[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [showLibraryBrowser, setShowLibraryBrowser] = useState(false)
  const [libraryTypeFilter, setLibraryTypeFilter] = useState<ToolType | 'all'>('all')
  const [libraryUnitsFilter, setLibraryUnitsFilter] = useState<Tool['units'] | 'all'>('all')
  const [showAddOperationMenu, setShowAddOperationMenu] = useState(false)
  const [selectedNewOperationKind, setSelectedNewOperationKind] = useState<OperationKind | null>(null)
  const [targetUpdateMessage, setTargetUpdateMessage] = useState<{
    operationId: string
    selectionKey: string
    text: string
  } | null>(null)
  const [operationActionMessage, setOperationActionMessage] = useState<{
    operationId: string
    text: string
  } | null>(null)
  const [dragOperationId, setDragOperationId] = useState<string | null>(null)
  const addOperationMenuRef = useRef<HTMLDivElement>(null)
  const dragOverOperationId = useRef<string | null>(null)
  const {
    project,
    selection,
    selectFeatures,
    selectStock,
    addTool,
    importTools,
    updateTool,
    deleteTool,
    duplicateTool,
    addOperation,
    updateOperation,
    setAllOperationToolpathVisibility,
    deleteOperation,
    duplicateOperation,
    reorderOperations,
    autoPlaceTabsForOperation,
    createPocketRestOperation,
  } = useProjectStore()

  const selectedToolId =
    selectedToolIdState && project.tools.some((tool) => tool.id === selectedToolIdState)
      ? selectedToolIdState
      : project.tools[0]?.id ?? null

  const selectedTool = selectedToolId
    ? project.tools.find((tool) => tool.id === selectedToolId) ?? null
    : null

  const filteredLibraryTools = useMemo(
    () => libraryTools.filter((libraryTool) => {
      if (libraryTypeFilter !== 'all' && libraryTool.type !== libraryTypeFilter) return false
      if (libraryUnitsFilter !== 'all' && libraryTool.units !== libraryUnitsFilter) return false
      return true
    }),
    [libraryTools, libraryTypeFilter, libraryUnitsFilter]
  )

  const selectedOperationId =
    selectedOperationIdProp && project.operations.some((operation) => operation.id === selectedOperationIdProp)
      ? selectedOperationIdProp
      : null

  const selectedOperation = selectedOperationId
    ? project.operations.find((operation) => operation.id === selectedOperationId) ?? null
    : null
  const selectionKey = `${selection.selectedNode?.type ?? 'none'}:${selection.selectedFeatureIds.join(',')}`

  useEffect(() => {
    if (selectedOperationId !== selectedOperationIdProp) {
      onSelectedOperationIdChange(selectedOperationId)
    }
  }, [onSelectedOperationIdChange, selectedOperationId, selectedOperationIdProp])

  const ensureBundledLibraryLoaded = useCallback(async (): Promise<ToolLibraryEntry[]> => {
    if (libraryLoading) {
      return libraryTools
    }

    if (libraryTools.length > 0) {
      return libraryTools
    }

    setLibraryLoading(true)
    try {
      const library = await loadBundledToolLibrary()
      setLibraryTools(library.tools)
      setLibraryError(null)
      return library.tools
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : 'Failed to load tool library.')
      return []
    } finally {
      setLibraryLoading(false)
    }
  }, [libraryLoading, libraryTools])

  useEffect(() => {
    if (mode !== 'tools' || libraryLoading || libraryTools.length > 0 || libraryError) {
      return
    }

    void ensureBundledLibraryLoaded()
  }, [ensureBundledLibraryLoaded, libraryError, libraryLoading, libraryTools.length, mode])

  const operationButtons = useMemo<Array<{ kind: OperationKind; label: string; hint?: string }>>(
    () => ([
      {
        kind: 'pocket',
        label: operationAddButtonLabel('pocket'),
        hint: getOperationAddHint(project, selection, 'pocket') ?? undefined,
      },
      {
        kind: 'v_carve',
        label: operationAddButtonLabel('v_carve'),
        hint: getOperationAddHint(project, selection, 'v_carve') ?? undefined,
      },
      {
        kind: 'v_carve_recursive',
        label: operationAddButtonLabel('v_carve_recursive'),
        hint: getOperationAddHint(project, selection, 'v_carve_recursive') ?? undefined,
      },
      {
        kind: 'edge_route_inside',
        label: operationAddButtonLabel('edge_route_inside'),
        hint: getOperationAddHint(project, selection, 'edge_route_inside') ?? undefined,
      },
      {
        kind: 'edge_route_outside',
        label: operationAddButtonLabel('edge_route_outside'),
        hint: getOperationAddHint(project, selection, 'edge_route_outside') ?? undefined,
      },
      {
        kind: 'surface_clean',
        label: operationAddButtonLabel('surface_clean'),
        hint: getOperationAddHint(project, selection, 'surface_clean') ?? undefined,
      },
      {
        kind: 'follow_line',
        label: operationAddButtonLabel('follow_line'),
        hint: getOperationAddHint(project, selection, 'follow_line') ?? undefined,
      },
      {
        kind: 'drilling',
        label: operationAddButtonLabel('drilling'),
        hint: getOperationAddHint(project, selection, 'drilling') ?? undefined,
      },
      {
        kind: 'rough_surface',
        label: operationAddButtonLabel('rough_surface'),
        hint: getOperationAddHint(project, selection, 'rough_surface') ?? undefined,
      },
      {
        kind: 'finish_surface',
        label: operationAddButtonLabel('finish_surface'),
        hint: getOperationAddHint(project, selection, 'finish_surface') ?? undefined,
      },
    ]),
    [project, selection]
  )

  const selectedNewOperationHint = selectedNewOperationKind
    ? getOperationAddHint(project, selection, selectedNewOperationKind)
    : null
  const selectedNewOperationSupportsPass = selectedNewOperationKind
    ? operationSupportsPassSelection(selectedNewOperationKind)
    : false
  const selectedNewOperationTarget = selectedNewOperationKind
    ? getValidOperationTarget(project, selection, selectedNewOperationKind)
    : null

  useEffect(() => {
    if (!showAddOperationMenu) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null
      if (addOperationMenuRef.current?.contains(target)) {
        return
      }
      setShowAddOperationMenu(false)
      setSelectedNewOperationKind(null)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setShowAddOperationMenu(false)
        setSelectedNewOperationKind(null)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [showAddOperationMenu])

  function handleAddTool() {
    const toolId = addTool()
    setSelectedToolId(toolId)
  }

  function handleDeleteTool(toolId?: string) {
    const id = toolId ?? selectedTool?.id
    if (!id) {
      return
    }

    const inUse = project.operations.some((op) => op.toolRef === id)
    if (inUse) {
      return
    }

    const currentIndex = project.tools.findIndex((tool) => tool.id === id)
    const fallback = project.tools[currentIndex - 1]?.id ?? project.tools[currentIndex + 1]?.id ?? null
    deleteTool(id)
    setSelectedToolId(fallback)
  }

  function handleDuplicateToolById(toolId: string) {
    const toolToDupe = project.tools.find((t) => t.id === toolId)
    if (!toolToDupe) return
    const newId = duplicateTool(toolId)
    if (newId) {
      setSelectedToolId(newId)
    }
  }

  async function handleOpenLibraryBrowser() {
    if (!showLibraryBrowser) {
      await ensureBundledLibraryLoaded()
    }
    setShowLibraryBrowser((prev) => !prev)
  }

  function handleImportLibraryTool(entry: ToolLibraryEntry) {
    const importedIds = importTools([{
      name: entry.name,
      units: entry.units,
      type: entry.type,
      diameter: entry.diameter,
      vBitAngle: entry.vBitAngle,
      flutes: entry.flutes,
      material: entry.material,
      defaultRpm: entry.defaultRpm,
      defaultFeed: entry.defaultFeed,
      defaultPlungeFeed: entry.defaultPlungeFeed,
      defaultStepdown: entry.defaultStepdown,
      defaultStepover: entry.defaultStepover,
      maxCutDepth: entry.maxCutDepth,
    }])
    if (importedIds.length > 0) {
      setSelectedToolId(importedIds[0] ?? null)
    }
  }

  function handleAddOperation(kind: OperationKind, mode: OperationPass | 'pair' = 'rough') {
    const target = getValidOperationTarget(project, selection, kind)
    if (!target) {
      setSelectedNewOperationKind(kind)
      return
    }

    if ((kind === 'follow_line' || kind === 'v_carve' || kind === 'v_carve_recursive' || kind === 'drilling' || kind === 'rough_surface' || kind === 'finish_surface') && mode === 'pair') {
      const operationId = addOperation(kind, 'rough', target)
      if (operationId) {
        onSelectedOperationIdChange(operationId)
        setShowAddOperationMenu(false)
        setSelectedNewOperationKind(null)
      }
      return
    }

    if (mode === 'pair') {
      const roughId = addOperation(kind, 'rough', target)
      const finishId = addOperation(kind, 'finish', target)
      const nextSelectedId = finishId ?? roughId
      if (nextSelectedId) {
        onSelectedOperationIdChange(nextSelectedId)
        setShowAddOperationMenu(false)
        setSelectedNewOperationKind(null)
      }
      return
    }

    const operationId = addOperation(kind, mode, target)
    if (operationId) {
      onSelectedOperationIdChange(operationId)
      setShowAddOperationMenu(false)
      setSelectedNewOperationKind(null)
    }
  }

  function handleChooseOperationForAdd(kind: OperationKind) {
    setSelectedNewOperationKind(kind)

    const target = getValidOperationTarget(project, selection, kind)
    if (!target) {
      return
    }

    if (!operationSupportsPassSelection(kind)) {
      handleAddOperation(kind, 'rough')
    }
  }

  function handleDuplicateOperation(operationId: string) {
    const newId = duplicateOperation(operationId)
    if (newId) {
      onSelectedOperationIdChange(newId)
    }
  }

  function handleDeleteOperation(operationId: string) {
    const currentIndex = project.operations.findIndex((operation) => operation.id === operationId)
    const fallback = project.operations[currentIndex - 1]?.id ?? project.operations[currentIndex + 1]?.id ?? null
    deleteOperation(operationId)
    onSelectedOperationIdChange(fallback)
  }

  function handleCreatePocketRestOperation() {
    if (!selectedOperation) {
      return
    }

    const result = createPocketRestOperation(selectedOperation.id)
    const text = result.operationId
      ? `Created rest operation with ${result.regionIds.length} region${result.regionIds.length === 1 ? '' : 's'}; choose a smaller tool`
      : result.warnings[0] ?? 'No unreachable pocket areas found for this tool'
    setOperationActionMessage({ operationId: result.operationId ?? selectedOperation.id, text })
    if (result.operationId) {
      onSelectedOperationIdChange(result.operationId)
    }
  }

  function handleSelectOperation(operationId: string) {
    if (selectedOperationId === operationId) {
      onSelectedOperationIdChange(null)
      return
    }

    onSelectedOperationIdChange(operationId)
    const operation = project.operations.find((item) => item.id === operationId)
    if (!operation) {
      return
    }

    if (operation.target.source === 'stock') {
      selectStock()
      return
    }

    selectFeatures(operation.target.featureIds)
  }

  function handleOperationDragStart(operationId: string) {
    setDragOperationId(operationId)
  }

  function handleOperationDragOver(event: DragEvent, operationId: string) {
    event.preventDefault()
    dragOverOperationId.current = operationId
  }

  function handleOperationDrop() {
    if (!dragOperationId || !dragOverOperationId.current || dragOperationId === dragOverOperationId.current) {
      setDragOperationId(null)
      dragOverOperationId.current = null
      return
    }

    const ids = project.operations.map((operation) => operation.id)
    const fromIndex = ids.indexOf(dragOperationId)
    const toIndex = ids.indexOf(dragOverOperationId.current)
    if (fromIndex === -1 || toIndex === -1) {
      setDragOperationId(null)
      dragOverOperationId.current = null
      return
    }

    const nextIds = [...ids]
    nextIds.splice(fromIndex, 1)
    nextIds.splice(toIndex, 0, dragOperationId)
    reorderOperations(nextIds)

    setDragOperationId(null)
    dragOverOperationId.current = null
  }

  function handleApplySelectionToOperation() {
    if (!selectedOperation) {
      return
    }

    const target = getValidOperationTarget(project, selection, selectedOperation.kind)
    if (!target) {
      setTargetUpdateMessage(
        {
          operationId: selectedOperation.id,
          selectionKey,
          text:
            getOperationTargetUpdateHint(project, selection, selectedOperation)
            ?? 'Current selection is not compatible with this operation',
        }
      )
      return
    }

    updateOperation(selectedOperation.id, { target })
    setTargetUpdateMessage(null)
  }

  function handleAutoPlaceTabs() {
    if (!selectedOperation || (selectedOperation.kind !== 'edge_route_inside' && selectedOperation.kind !== 'edge_route_outside')) {
      return
    }

    autoPlaceTabsForOperation(selectedOperation.id)
  }

  return (
    <div className="cam-panel">
      {mode === 'operations' ? (
        <div className="cam-operations-shell">
          <PanelSplit className="cam-operations-layout" storageKey="operations" initialRatio={0.54} minFirst={160} minSecond={160}>
            <section className="cam-section cam-section--tree">
              <div className="cam-section-header">
                <span>Operations</span>
                <span className="feature-count">{project.operations.length}</span>
              </div>
              <div className="cam-section-content cam-section-content--stack">
                <div className="cam-section-toolbar cam-section-toolbar--end">
                  <div className="cam-section-header-actions" ref={addOperationMenuRef}>
                  <button
                    className="tree-action-btn tree-action-btn--visibility"
                    type="button"
                    title="Show all toolpaths"
                    aria-label="Show all toolpaths"
                    disabled={project.operations.length === 0}
                    onClick={() => setAllOperationToolpathVisibility(true)}
                  >
                    ◉
                  </button>
                  <button
                    className="tree-action-btn tree-action-btn--visibility tree-action-btn--muted"
                    type="button"
                    title="Hide all toolpaths"
                    aria-label="Hide all toolpaths"
                    disabled={project.operations.length === 0}
                    onClick={() => setAllOperationToolpathVisibility(false)}
                  >
                    ○
                  </button>
                  <button
                    className="cam-header-action"
                    type="button"
                    onClick={onExport}
                  >
                    Export
                  </button>
                  <button
                    className="cam-header-action"
                    type="button"
                    aria-expanded={showAddOperationMenu}
                    aria-haspopup="dialog"
                    onClick={() => {
                      setSelectedNewOperationKind(null)
                      setShowAddOperationMenu((value) => !value)
                    }}
                  >
                    Add
                  </button>
                    {showAddOperationMenu ? (
                      <div className="cam-add-menu" role="dialog" aria-label="Add operation">
                        <div className="cam-add-menu__section">
                          <span className="cam-add-menu__label">Operation</span>
                          <div className="cam-add-menu__buttons">
                            {operationButtons.map((button) => (
                              <button
                                key={button.kind}
                                className={`feat-btn ${selectedNewOperationKind === button.kind ? 'feat-btn--active' : ''}`}
                                type="button"
                                title={button.hint}
                                onClick={() => handleChooseOperationForAdd(button.kind)}
                              >
                                {button.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        {selectedNewOperationKind && selectedNewOperationSupportsPass && selectedNewOperationTarget ? (
                          <div className="cam-add-menu__section">
                            <span className="cam-add-menu__label">Pass</span>
                            <div className="cam-pass-toggle">
                              <button
                                className="cam-subtab"
                                type="button"
                                onClick={() => handleAddOperation(selectedNewOperationKind, 'rough')}
                              >
                                Rough
                              </button>
                              <button
                                className="cam-subtab"
                                type="button"
                                onClick={() => handleAddOperation(selectedNewOperationKind, 'finish')}
                              >
                                Finish
                              </button>
                              <button
                                className="cam-subtab"
                                type="button"
                                onClick={() => handleAddOperation(selectedNewOperationKind, 'pair')}
                              >
                                Rough + finish
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {selectedNewOperationHint ? (
                          <div className="cam-field-message" role="status">
                            {selectedNewOperationHint}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="cam-section-body">
                {project.operations.length === 0 ? (
                  <div className="panel-empty">
                    Select compatible geometry, then add an operation. Pocket and inside route require subtract features.
                    Outside route requires add features. Surface clean accepts add features.
                  </div>
                ) : (
                  <div className="feature-tree-panel cam-operation-tree">
                    <div className="tree-root-label">CAM</div>
                    <div className="tree-list">
                      {project.operations.map((operation) => (
                        <div
                          key={operation.id}
                          className={[
                            'tree-row',
                            'tree-row--feature',
                            operation.id === selectedOperationId ? 'tree-row--selected' : '',
                            dragOperationId === operation.id ? 'tree-row--dragging' : '',
                          ].join(' ')}
                          onClick={() => handleSelectOperation(operation.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              handleSelectOperation(operation.id)
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          draggable
                          onDragStart={() => handleOperationDragStart(operation.id)}
                          onDragEnd={() => setDragOperationId(null)}
                          onDragOver={(event) => handleOperationDragOver(event, operation.id)}
                          onDrop={handleOperationDrop}
                        >
                          <span className="tree-branch" aria-hidden="true" />
                          <span className="tree-label">
                            {operation.name}
                          </span>
                          <span className="tree-row-actions">
                            <button
                              className="tree-action-btn"
                              type="button"
                              title={operation.showToolpath ? 'Hide toolpath' : 'Show toolpath'}
                              aria-label={`${operation.showToolpath ? 'Hide' : 'Show'} toolpath for ${operation.name}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                updateOperation(operation.id, { showToolpath: !operation.showToolpath })
                              }}
                            >
                              {operation.showToolpath ? '◉' : '○'}
                            </button>
                            {!operation.enabled ? <span className="cam-operation-badge">Off</span> : null}
                            <button
                              className="tree-action-btn"
                              type="button"
                              title="Duplicate operation"
                              aria-label="Duplicate operation"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleDuplicateOperation(operation.id)
                              }}
                            >
                              ⧉
                            </button>
                            <button
                              className="tree-action-btn tree-action-btn--delete"
                              type="button"
                              title="Delete operation"
                              aria-label="Delete operation"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleDeleteOperation(operation.id)
                              }}
                            >
                              ✕
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                </div>
              </div>
            </section>

            <section className="cam-section cam-section--properties">
              <div className="cam-section-header">
                <span>Properties</span>
              </div>
              <div className="cam-section-content cam-section-content--stack">
                <div className="cam-section-body">
                {selectedOperation ? (
                  <div key={`${selectedOperation.id}-${selectedOperation.toolRef ?? ''}`} className="properties-panel cam-tool-properties">
                    <div className="properties-group">
                  <label className="properties-field">
                    <span>Name</span>
                    <DraftTextInput value={selectedOperation.name} onCommit={(value) => updateOperation(selectedOperation.id, { name: value })} />
                  </label>
                  <label className="properties-field">
                    <span>Kind</span>
                    <input type="text" value={operationKindLabel(selectedOperation.kind)} readOnly />
                  </label>
                  {selectedOperation.kind !== 'v_carve' && selectedOperation.kind !== 'v_carve_recursive' && selectedOperation.kind !== 'drilling' && selectedOperation.kind !== 'rough_surface' && selectedOperation.kind !== 'finish_surface' ? (
                    <label className="properties-field">
                      <span>Pass</span>
                      <select
                        value={selectedOperation.pass}
                        onChange={(event) => updateOperation(selectedOperation.id, { pass: event.target.value as OperationPass })}
                      >
                        <option value="rough">Rough</option>
                        <option value="finish">Finish</option>
                      </select>
                    </label>
                  ) : null}
                  {selectedOperation.kind === 'v_carve' || selectedOperation.kind === 'v_carve_recursive' ? (
                    <label className="properties-field">
                      <span>Max Carve Depth</span>
                      <DraftLengthInput
                        value={selectedOperation.maxCarveDepth}
                        units={project.meta.units}
                        min={0.0001}
                        onCommit={(value) => updateOperation(selectedOperation.id, { maxCarveDepth: value })}
                      />
                    </label>
                  ) : null}
                  {selectedOperation.kind === 'pocket' || selectedOperation.kind === 'surface_clean' ? (
                    <label className="properties-field">
                      <span>Pattern</span>
                      <select
                        value={selectedOperation.pocketPattern}
                        onChange={(event) => updateOperation(selectedOperation.id, { pocketPattern: event.target.value as PocketPattern })}
                      >
                        <option value="offset">{pocketPatternLabel('offset')}</option>
                        <option value="parallel">{pocketPatternLabel('parallel')}</option>
                      </select>
                    </label>
                  ) : null}
                  {(selectedOperation.kind === 'pocket' || selectedOperation.kind === 'surface_clean' || selectedOperation.kind === 'finish_surface') && selectedOperation.pocketPattern === 'parallel' ? (
                    <label className="properties-field">
                      <span>Angle</span>
                      <DraftNumberInput
                        value={selectedOperation.pocketAngle}
                        onCommit={(value) => updateOperation(selectedOperation.id, { pocketAngle: value })}
                      />
                    </label>
                  ) : null}
                  {(selectedOperation.kind === 'pocket' || selectedOperation.kind === 'edge_route_inside' || selectedOperation.kind === 'edge_route_outside' || selectedOperation.kind === 'v_carve' || selectedOperation.kind === 'surface_clean' || selectedOperation.kind === 'rough_surface' || selectedOperation.kind === 'finish_surface') ? (
                    <label className="properties-field">
                      <span>Cut Direction</span>
                      <select
                        value={selectedOperation.cutDirection ?? 'conventional'}
                        onChange={(event) => updateOperation(selectedOperation.id, { cutDirection: event.target.value as CutDirection })}
                      >
                        <option value="conventional">Conventional</option>
                        <option value="climb">Climb</option>
                      </select>
                    </label>
                  ) : null}
                  {(selectedOperation.kind === 'pocket'
                    || selectedOperation.kind === 'v_carve'
                    || selectedOperation.kind === 'v_carve_recursive'
                    || selectedOperation.kind === 'edge_route_inside'
                    || selectedOperation.kind === 'edge_route_outside') ? (
                    <label className="properties-field">
                      <span>Machining Order</span>
                      <select
                        value={selectedOperation.machiningOrder ?? 'level_first'}
                        onChange={(event) => updateOperation(selectedOperation.id, { machiningOrder: event.target.value as MachiningOrder })}
                      >
                        <option value="feature_first">Feature first</option>
                        <option value="level_first">Level first</option>
                      </select>
                    </label>
                  ) : null}
                  {selectedOperation.kind === 'follow_line' ? (
                    <label className="properties-field">
                      <span>Carve Depth</span>
                      <DraftLengthInput
                        value={selectedOperation.carveDepth}
                        units={project.meta.units}
                        min={0.0001}
                        onCommit={(value) => updateOperation(selectedOperation.id, { carveDepth: value })}
                      />
                    </label>
                  ) : null}
                  {selectedOperation.kind === 'drilling' ? (
                    <>
                      <label className="properties-field">
                        <span>Drill Type</span>
                        <select
                          value={selectedOperation.drillType ?? 'simple'}
                          onChange={(event) => updateOperation(selectedOperation.id, { drillType: event.target.value as DrillType })}
                        >
                          <option value="simple">{drillTypeLabel('simple')}</option>
                          <option value="peck">{drillTypeLabel('peck')}</option>
                          <option value="dwell">{drillTypeLabel('dwell')}</option>
                          <option value="chip_breaking">{drillTypeLabel('chip_breaking')}</option>
                        </select>
                      </label>
                      {(selectedOperation.drillType === 'peck' || selectedOperation.drillType === 'chip_breaking') ? (
                        <label className="properties-field">
                          <span>Peck Depth</span>
                          <DraftLengthInput
                            value={selectedOperation.peckDepth ?? 0}
                            units={project.meta.units}
                            min={0}
                            onCommit={(value) => updateOperation(selectedOperation.id, { peckDepth: value })}
                          />
                        </label>
                      ) : null}
                      {selectedOperation.drillType === 'dwell' ? (
                        <label className="properties-field">
                          <span>Dwell Time (s)</span>
                          <DraftNumberInput
                            value={selectedOperation.dwellTime ?? 0}
                            min={0}
                            onCommit={(value) => updateOperation(selectedOperation.id, { dwellTime: value })}
                          />
                        </label>
                      ) : null}
                      <label className="properties-field">
                        <span>Retract Height</span>
                        <DraftLengthInput
                          value={selectedOperation.retractHeight ?? (project.stock.thickness + 1)}
                          units={project.meta.units}
                          min={0}
                          onCommit={(value) => updateOperation(selectedOperation.id, { retractHeight: value })}
                        />
                      </label>
                    </>
                  ) : null}
                  {(selectedOperation.kind === 'pocket' || selectedOperation.kind === 'surface_clean') && selectedOperation.pass === 'finish' ? (
                    <>
                      <label className="properties-check">
                        <input
                          type="checkbox"
                          checked={selectedOperation.finishWalls}
                          onChange={(event) => updateOperation(selectedOperation.id, { finishWalls: event.target.checked })}
                        />
                        <span>Finish Walls</span>
                      </label>
                      <label className="properties-check">
                        <input
                          type="checkbox"
                          checked={selectedOperation.finishFloor}
                          onChange={(event) => updateOperation(selectedOperation.id, { finishFloor: event.target.checked })}
                        />
                        <span>Finish Floor</span>
                      </label>
                    </>
                  ) : null}
                  <label className="properties-field">
                    <span>Target</span>
                    <input type="text" value={operationTargetSummary(project, selectedOperation.target)} readOnly />
                  </label>
                  <label className="properties-check">
                    <input
                      type="checkbox"
                      checked={selectedOperation.debugToolpath}
                      onChange={(event) => updateOperation(selectedOperation.id, { debugToolpath: event.target.checked })}
                    />
                    <span>Debug toolpath</span>
                  </label>
                  <div className="properties-field">
                    <span>Target Source</span>
                    <button
                      className="feat-btn"
                      type="button"
                      title={getOperationTargetUpdateHint(project, selection, selectedOperation) ?? undefined}
                      onClick={handleApplySelectionToOperation}
                    >
                      Use current selection
                    </button>
                    {targetUpdateMessage
                    && targetUpdateMessage.operationId === selectedOperation.id
                    && targetUpdateMessage.selectionKey === selectionKey ? (
                      <span className="cam-field-message">{targetUpdateMessage.text}</span>
                    ) : null}
                  </div>
                  {selectedOperation.kind === 'pocket' ? (
                    <div className="properties-field">
                      <span>Rest Machining</span>
                      <button className="feat-btn feat-btn--primary" type="button" onClick={handleCreatePocketRestOperation}>
                        Create rest operation
                      </button>
                      {operationActionMessage?.operationId === selectedOperation.id ? (
                        <span className="cam-field-message">{operationActionMessage.text}</span>
                      ) : null}
                    </div>
                  ) : null}
                  {(selectedOperation.kind === 'edge_route_inside' || selectedOperation.kind === 'edge_route_outside') ? (
                    <div className="properties-field">
                      <span>Tabs</span>
                      <button className="feat-btn" type="button" onClick={handleAutoPlaceTabs}>
                        Auto place tabs
                      </button>
                    </div>
                  ) : null}
                  {toolpathWarnings && toolpathWarnings.length > 0 ? (
                    <div className="properties-field">
                      <span>Toolpath warnings</span>
                      <div className="cam-field-note-list">
                        {toolpathWarnings.map((warning, index) => (
                          <div key={`${selectedOperation.id}-warning-${index}`} className="cam-field-note">
                            {warning}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <label className="properties-field">
                    <span>Tool</span>
                    <select
                      value={selectedOperation.toolRef ?? ''}
                      onChange={(event) => {
                        const newToolId = event.target.value || null
                        const newTool = newToolId ? project.tools.find((t) => t.id === newToolId) ?? null : null
                        const toolInProjectUnits = newTool && newTool.units !== project.meta.units
                          ? convertToolUnits(newTool, project.meta.units)
                          : newTool
                        const isVCarve = selectedOperation.kind === 'v_carve' || selectedOperation.kind === 'v_carve_recursive'
                        updateOperation(selectedOperation.id, {
                          toolRef: newToolId,
                          ...(toolInProjectUnits ? {
                            feed: toolInProjectUnits.defaultFeed,
                            plungeFeed: toolInProjectUnits.defaultPlungeFeed,
                            stepdown: toolInProjectUnits.defaultStepdown,
                            stepover: toolInProjectUnits.defaultStepover,
                            rpm: toolInProjectUnits.defaultRpm,
                            ...(isVCarve && toolInProjectUnits.maxCutDepth > 0 ? {
                              maxCarveDepth: toolInProjectUnits.maxCutDepth,
                            } : {}),
                          } : {}),
                        })
                      }}
                    >
                      <option value="">No Tool</option>
                      {(selectedOperation.kind === 'v_carve' || selectedOperation.kind === 'v_carve_recursive'
                        ? project.tools.filter((tool) => tool.type === 'v_bit')
                        : project.tools
                      ).map((tool) => (
                        <option key={tool.id} value={tool.id}>
                          {tool.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="properties-check">
                    <input
                      type="checkbox"
                      checked={selectedOperation.enabled}
                      onChange={(event) => updateOperation(selectedOperation.id, { enabled: event.target.checked })}
                    />
                    <span>Enabled</span>
                  </label>
                  {selectedOperation.kind !== 'v_carve' && selectedOperation.kind !== 'v_carve_recursive' && selectedOperation.kind !== 'drilling' ? (
                    <label className="properties-field">
                      <span>Stepdown</span>
                      <DraftLengthInput
                        value={selectedOperation.stepdown}
                        units={project.meta.units}
                        min={0.0001}
                        onCommit={(value) => updateOperation(selectedOperation.id, { stepdown: value })}
                      />
                    </label>
                  ) : null}
                  {selectedOperation.kind !== 'follow_line' && selectedOperation.kind !== 'drilling' ? (
                    <label className="properties-field">
                      <span>
                        {selectedOperation.kind === 'v_carve_recursive'
                          ? 'Step Size'
                          : selectedOperation.kind === 'v_carve'
                            ? 'Contour Spacing'
                            : 'Stepover Ratio'}
                      </span>
                      <DraftNumberInput
                        value={selectedOperation.stepover}
                        min={0.001}
                        onCommit={(value) => updateOperation(selectedOperation.id, { stepover: value })}
                      />
                    </label>
                  ) : null}
                  <label className="properties-field">
                    <span>Feed</span>
                    <DraftLengthInput
                      value={selectedOperation.feed}
                      units={project.meta.units}
                      min={0.0001}
                      onCommit={(value) => updateOperation(selectedOperation.id, { feed: value })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>Plunge Feed</span>
                    <DraftLengthInput
                      value={selectedOperation.plungeFeed}
                      units={project.meta.units}
                      min={0.0001}
                      onCommit={(value) => updateOperation(selectedOperation.id, { plungeFeed: value })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>RPM</span>
                    <DraftNumberInput
                      value={selectedOperation.rpm}
                      min={1}
                      onCommit={(value) => updateOperation(selectedOperation.id, { rpm: Math.round(value) })}
                    />
                  </label>
                  {selectedOperation.kind !== 'follow_line'
                    && selectedOperation.kind !== 'v_carve'
                    && selectedOperation.kind !== 'v_carve_recursive'
                    && selectedOperation.kind !== 'drilling'
                    && selectedOperation.kind !== 'finish_surface' ? (
                    <>
                      <label className="properties-field">
                        <span>Stock To Leave Radial</span>
                        <DraftLengthInput
                          value={selectedOperation.stockToLeaveRadial}
                          units={project.meta.units}
                          min={0}
                          onCommit={(value) => updateOperation(selectedOperation.id, { stockToLeaveRadial: value })}
                        />
                      </label>
                      <label className="properties-field">
                        <span>Stock To Leave Axial</span>
                        <DraftLengthInput
                          value={selectedOperation.stockToLeaveAxial}
                          units={project.meta.units}
                          min={0}
                          onCommit={(value) => updateOperation(selectedOperation.id, { stockToLeaveAxial: value })}
                        />
                      </label>
                    </>
                  ) : null}
                  {selectedOperation.kind === 'finish_surface' ? (
                    <label className="properties-field">
                      <span>Stock To Leave Axial</span>
                      <DraftLengthInput
                        value={selectedOperation.stockToLeaveAxial}
                        units={project.meta.units}
                        min={0}
                        onCommit={(value) => updateOperation(selectedOperation.id, { stockToLeaveAxial: value })}
                      />
                    </label>
                  ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="panel-empty">Select an operation to edit its parameters.</div>
                )}
                </div>
              </div>
            </section>
          </PanelSplit>
        </div>
      ) : (
        <div className="cam-tools">
          <PanelSplit className="cam-tools-layout" storageKey="tools" initialRatio={0.42} minFirst={140} minSecond={140}>
            <section className="cam-section">
              <div className="cam-section-header">
                <span>Tools</span>
                <span className="feature-count">{project.tools.length}</span>
              </div>
              <div className="cam-section-content cam-section-content--stack">
                <div className="cam-section-toolbar">
                  <button className="cam-header-action" type="button" onClick={handleAddTool}>
                    Add Tool
                  </button>
                  <button
                    className={['cam-header-action', showLibraryBrowser ? 'cam-header-action--active' : ''].join(' ')}
                    type="button"
                    onClick={handleOpenLibraryBrowser}
                    disabled={libraryLoading}
                    title={libraryLoading ? 'Loading bundled tool library...' : undefined}
                  >
                    {libraryLoading ? 'Loading...' : 'Import from Library'}
                  </button>
                </div>
                {showLibraryBrowser ? (
                  <div className="cam-library-browser">
                    <div className="cam-library-browser__filters">
                      <select
                        value={libraryTypeFilter}
                        onChange={(event) => setLibraryTypeFilter(event.target.value as ToolType | 'all')}
                      >
                        <option value="all">All Types</option>
                        <option value="flat_endmill">Flat Endmill</option>
                        <option value="ball_endmill">Ball Endmill</option>
                        <option value="v_bit">V-Bit</option>
                        <option value="drill">Drill</option>
                      </select>
                      <select
                        value={libraryUnitsFilter}
                        onChange={(event) => setLibraryUnitsFilter(event.target.value as Tool['units'] | 'all')}
                      >
                        <option value="all">All Units</option>
                        <option value="mm">mm</option>
                        <option value="inch">in</option>
                      </select>
                    </div>
                    {libraryError ? (
                      <div className="cam-section-note">{libraryError}</div>
                    ) : filteredLibraryTools.length === 0 ? (
                      <div className="cam-section-note">No tools match the selected filters.</div>
                    ) : (
                      <div className="cam-library-browser__list">
                        {filteredLibraryTools.map((entry) => {
                          const alreadyImported = project.tools.some((tool) => toolMatchesLibraryEntry(tool, entry))
                          return (
                            <div key={entry.key} className={['cam-library-tool', alreadyImported ? 'cam-library-tool--imported' : ''].join(' ')}>
                              <span className="cam-library-tool__name">{entry.name}</span>
                              <span className="cam-library-tool__meta">
                                {toolTypeLabel(entry.type)} · ⌀{formatLength(entry.diameter, entry.units)} {toolUnitsLabel(entry.units)}{entry.maxCutDepth > 0 ? ` · max ${formatLength(entry.maxCutDepth, entry.units)} ${toolUnitsLabel(entry.units)}` : ''}
                              </span>
                              <button
                                className="cam-header-action"
                                type="button"
                                disabled={alreadyImported}
                                onClick={() => handleImportLibraryTool(entry)}
                              >
                                {alreadyImported ? 'Imported' : 'Import'}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
                <div className="cam-section-body cam-section-body--stack">
                  <div className="feature-tree-panel cam-tool-tree">
                    {project.tools.length === 0 ? (
                      <div className="panel-empty">No tools yet. Add the first tool to start building the library.</div>
                    ) : (
                      <div className="tree-list">
                        {project.tools.map((tool) => {
                          const usedByOperation = project.operations.some((op) => op.toolRef === tool.id)
                          return (
                            <div
                              key={tool.id}
                              className={[
                                'tree-row',
                                'tree-row--feature',
                                tool.id === selectedToolId ? 'tree-row--selected' : '',
                              ].join(' ')}
                              onClick={() => setSelectedToolId(tool.id)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  setSelectedToolId(tool.id)
                                }
                              }}
                              role="button"
                              tabIndex={0}
                            >
                              <span className="tree-branch" aria-hidden="true" />
                              <span className="tree-label cam-tool-label" title={tool.name}>
                                <span className="cam-tool-label__name">{tool.name}</span>
                                <span className="cam-tool-label__meta">
                                  {toolTypeLabel(tool.type)} · ⌀{formatLength(tool.diameter, tool.units)} {toolUnitsLabel(tool.units)}{tool.maxCutDepth > 0 ? ` · max ${formatLength(tool.maxCutDepth, tool.units)} ${toolUnitsLabel(tool.units)}` : ''}
                                </span>
                              </span>
                              <div className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
                                <button
                                  type="button"
                                  className="tree-action-btn"
                                  title="Duplicate tool"
                                  aria-label="Duplicate tool"
                                  onClick={() => handleDuplicateToolById(tool.id)}
                                >
                                  ⧉
                                </button>
                                <button
                                  type="button"
                                  className={['tree-action-btn', usedByOperation ? 'tree-action-btn--muted' : 'tree-action-btn--delete'].join(' ')}
                                  title={usedByOperation ? 'Tool is used by an operation' : 'Delete tool'}
                                  aria-label={usedByOperation ? 'Tool is used by an operation' : 'Delete tool'}
                                  disabled={usedByOperation}
                                  onClick={() => handleDeleteTool(tool.id)}
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="cam-section cam-section--properties">
              <div className="cam-section-header">
                <span>Properties</span>
              </div>
              <div className="cam-section-content cam-section-content--stack">
                <div className="cam-section-body">
                  {selectedTool ? (
                    <div key={selectedTool.id} className="properties-panel cam-tool-properties">
                      <div className="properties-group">
                      <label className="properties-field">
                        <span>Name</span>
                        <DraftTextInput value={selectedTool.name} onCommit={(value) => updateTool(selectedTool.id, { name: value })} />
                      </label>
                      <label className="properties-field">
                        <span>Type</span>
                        <select
                          value={selectedTool.type}
                          onChange={(event) => {
                            const nextType = event.target.value as ToolType
                            updateTool(selectedTool.id, {
                              type: nextType,
                              vBitAngle: nextType === 'v_bit' ? (selectedTool.vBitAngle ?? 60) : null,
                            })
                          }}
                        >
                          <option value="flat_endmill">Flat Endmill</option>
                          <option value="ball_endmill">Ball Endmill</option>
                          <option value="v_bit">V-Bit</option>
                          <option value="drill">Drill</option>
                        </select>
                      </label>
                      <label className="properties-field">
                        <span>Units</span>
                        <select
                          value={selectedTool.units}
                          onChange={(event) => updateTool(selectedTool.id, convertToolUnits(selectedTool, event.target.value as Tool['units']))}
                        >
                          <option value="mm">Millimeters</option>
                          <option value="inch">Inches</option>
                        </select>
                      </label>
                      <label className="properties-field">
                        <span>Diameter</span>
                        <DraftLengthInput
                          value={selectedTool.diameter}
                          units={selectedTool.units}
                          min={0.0001}
                          onCommit={(value) => updateTool(selectedTool.id, { diameter: value })}
                        />
                      </label>
                      {selectedTool.type === 'v_bit' ? (
                        <label className="properties-field">
                          <span>V Angle</span>
                          <DraftNumberInput
                            value={selectedTool.vBitAngle ?? 60}
                            min={1}
                            max={179}
                            onCommit={(value) => updateTool(selectedTool.id, { vBitAngle: value })}
                          />
                        </label>
                      ) : null}
                      <label className="properties-field">
                        <span>Flutes</span>
                        <DraftNumberInput
                          value={selectedTool.flutes}
                          min={1}
                          max={12}
                          onCommit={(value) => updateTool(selectedTool.id, { flutes: Math.round(value) })}
                        />
                      </label>
                      <label className="properties-field">
                        <span>Material</span>
                        <select
                          value={selectedTool.material}
                          onChange={(event) => updateTool(selectedTool.id, { material: event.target.value as Tool['material'] })}
                        >
                          <option value="carbide">Carbide</option>
                          <option value="hss">HSS</option>
                        </select>
                      </label>
                      <label className="properties-field">
                        <span>Default RPM</span>
                        <DraftNumberInput
                          value={selectedTool.defaultRpm}
                          min={1}
                          onCommit={(value) => updateTool(selectedTool.id, { defaultRpm: Math.round(value) })}
                        />
                      </label>
                      <label className="properties-field">
                        <span>Default Feed</span>
                        <DraftLengthInput
                          value={selectedTool.defaultFeed}
                          units={selectedTool.units}
                          min={0.0001}
                          onCommit={(value) => updateTool(selectedTool.id, { defaultFeed: value })}
                        />
                      </label>
                      <label className="properties-field">
                        <span>Plunge Feed</span>
                        <DraftLengthInput
                          value={selectedTool.defaultPlungeFeed}
                          units={selectedTool.units}
                          min={0.0001}
                          onCommit={(value) => updateTool(selectedTool.id, { defaultPlungeFeed: value })}
                        />
                      </label>
                      <label className="properties-field">
                        <span>Stepdown</span>
                        <DraftLengthInput
                          value={selectedTool.defaultStepdown}
                          units={selectedTool.units}
                          min={0.0001}
                          onCommit={(value) => updateTool(selectedTool.id, { defaultStepdown: value })}
                        />
                      </label>
                      <label className="properties-field">
                        <span>Max Cut Depth</span>
                        <DraftLengthInput
                          value={selectedTool.maxCutDepth}
                          units={selectedTool.units}
                          min={0}
                          onCommit={(value) => updateTool(selectedTool.id, { maxCutDepth: value })}
                        />
                      </label>
                      <label className="properties-field">
                        <span>Stepover Ratio</span>
                        <DraftNumberInput
                          value={selectedTool.defaultStepover}
                          min={0.01}
                          max={1}
                          onCommit={(value) => updateTool(selectedTool.id, { defaultStepover: value })}
                        />
                      </label>
                      </div>
                    </div>
                  ) : (
                    <div className="panel-empty">Select a tool to edit its properties.</div>
                  )}
                </div>
              </div>
            </section>
          </PanelSplit>
        </div>
      )}
    </div>
  )
}
