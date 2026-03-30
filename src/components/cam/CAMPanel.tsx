import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { SelectionState } from '../../store/projectStore'
import { useProjectStore } from '../../store/projectStore'
import { loadBundledToolLibrary, type ToolLibraryEntry } from '../../toolLibrary'
import type {
  OperationKind,
  OperationPass,
  OperationTarget,
  Project,
  Tool,
  ToolType,
} from '../../types/project'
import { convertToolUnits, formatLength, parseLengthInput } from '../../utils/units'

interface CAMPanelProps {
  mode: 'operations' | 'tools'
  selectedOperationId: string | null
  onSelectedOperationIdChange: (operationId: string | null) => void
  toolpathWarnings?: string[] | null
}

type NewOperationMode = OperationPass | 'pair'

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
    case 'edge_route_inside':
      return 'Edge Route Inside'
    case 'edge_route_outside':
      return 'Edge Route Outside'
    case 'surface_clean':
      return 'Surface Clean'
  }
}

function operationTargetSummary(project: Project, target: OperationTarget): string {
  if (target.source === 'stock') {
    return 'Stock'
  }

  const names = target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId)?.name ?? null)
    .filter((name): name is string => Boolean(name))

  return names.length > 0 ? names.join(', ') : 'No features'
}

function getValidOperationTarget(project: Project, selection: SelectionState, kind: OperationKind): OperationTarget | null {
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

    return features.every((feature) => feature.operation === 'add')
      ? { source: 'features', featureIds: features.map((feature) => feature.id) }
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
  if (!features.every((feature) => feature.operation === expectedOperation)) {
    return null
  }

  return { source: 'features', featureIds: features.map((feature) => feature.id) }
}

function getOperationAddHint(project: Project, selection: SelectionState, kind: OperationKind): string | null {
  if (kind === 'surface_clean') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more add features first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    return features.every((feature) => feature.operation === 'add')
      ? null
      : 'Surface clean only accepts add features'
  }

  if (selection.selectedFeatureIds.length === 0) {
    return 'Select one or more compatible features first'
  }

  const features = selection.selectedFeatureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is Project['features'][number] => feature !== null)

  const wantsSubtract = kind === 'pocket' || kind === 'edge_route_inside'
  const expectedOperation = wantsSubtract ? 'subtract' : 'add'
  if (!features.every((feature) => feature.operation === expectedOperation)) {
    return wantsSubtract
      ? 'This operation only accepts subtract features'
      : 'This operation only accepts add features'
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
  toolpathWarnings,
}: CAMPanelProps) {
  const [selectedToolIdState, setSelectedToolId] = useState<string | null>(null)
  const [libraryTools, setLibraryTools] = useState<ToolLibraryEntry[]>([])
  const [libraryName, setLibraryName] = useState('Bundled Tool Library')
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [newOperationMode, setNewOperationMode] = useState<NewOperationMode>('rough')
  const [showAddOperationMenu, setShowAddOperationMenu] = useState(false)
  const [targetUpdateMessage, setTargetUpdateMessage] = useState<{
    operationId: string
    selectionKey: string
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
  } = useProjectStore()

  const selectedToolId =
    selectedToolIdState && project.tools.some((tool) => tool.id === selectedToolIdState)
      ? selectedToolIdState
      : project.tools[0]?.id ?? null

  const selectedTool = selectedToolId
    ? project.tools.find((tool) => tool.id === selectedToolId) ?? null
    : null

  const missingLibraryTools = useMemo(
    () => libraryTools.filter((libraryTool) => !project.tools.some((tool) => toolMatchesLibraryEntry(tool, libraryTool))),
    [libraryTools, project.tools]
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
      setLibraryName(library.name)
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

  const operationButtons = useMemo<Array<{ kind: OperationKind; label: string; disabled: boolean; hint?: string }>>(
    () => ([
      {
        kind: 'pocket',
        label: 'Pocket',
        hint: getOperationAddHint(project, selection, 'pocket') ?? undefined,
        disabled: getValidOperationTarget(project, selection, 'pocket') === null,
      },
      {
        kind: 'edge_route_inside',
        label: 'Edge In',
        hint: getOperationAddHint(project, selection, 'edge_route_inside') ?? undefined,
        disabled: getValidOperationTarget(project, selection, 'edge_route_inside') === null,
      },
      {
        kind: 'edge_route_outside',
        label: 'Edge Out',
        hint: getOperationAddHint(project, selection, 'edge_route_outside') ?? undefined,
        disabled: getValidOperationTarget(project, selection, 'edge_route_outside') === null,
      },
      {
        kind: 'surface_clean',
        label: 'Surface',
        hint: getOperationAddHint(project, selection, 'surface_clean') ?? undefined,
        disabled: getValidOperationTarget(project, selection, 'surface_clean') === null,
      },
    ]),
    [project, selection]
  )

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
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setShowAddOperationMenu(false)
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

  function handleDuplicateTool() {
    if (!selectedTool) {
      return
    }

    const toolId = duplicateTool(selectedTool.id)
    if (toolId) {
      setSelectedToolId(toolId)
    }
  }

  function handleDeleteTool() {
    if (!selectedTool) {
      return
    }

    const currentIndex = project.tools.findIndex((tool) => tool.id === selectedTool.id)
    const fallback = project.tools[currentIndex - 1]?.id ?? project.tools[currentIndex + 1]?.id ?? null
    deleteTool(selectedTool.id)
    setSelectedToolId(fallback)
  }

  async function handleImportLibrary() {
    const sourceTools = libraryTools.length > 0 ? libraryTools : await ensureBundledLibraryLoaded()
    const importCandidates = sourceTools.filter((libraryTool) => !project.tools.some((tool) => toolMatchesLibraryEntry(tool, libraryTool)))

    if (importCandidates.length === 0) {
      return
    }

    const importedIds = importTools(importCandidates.map((tool) => ({
      name: tool.name,
      units: tool.units,
      type: tool.type,
      diameter: tool.diameter,
      flutes: tool.flutes,
      material: tool.material,
      defaultRpm: tool.defaultRpm,
      defaultFeed: tool.defaultFeed,
      defaultPlungeFeed: tool.defaultPlungeFeed,
      defaultStepdown: tool.defaultStepdown,
      defaultStepover: tool.defaultStepover,
    })))
    if (importedIds.length > 0) {
      setSelectedToolId(importedIds[importedIds.length - 1] ?? null)
    }
  }

  function handleAddOperation(kind: OperationKind) {
    const target = getValidOperationTarget(project, selection, kind)
    if (!target) {
      return
    }

    if (newOperationMode === 'pair') {
      const roughId = addOperation(kind, 'rough', target)
      const finishId = addOperation(kind, 'finish', target)
      const nextSelectedId = finishId ?? roughId
      if (nextSelectedId) {
        onSelectedOperationIdChange(nextSelectedId)
        setShowAddOperationMenu(false)
      }
      return
    }

    const operationId = addOperation(kind, newOperationMode, target)
    if (operationId) {
      onSelectedOperationIdChange(operationId)
      setShowAddOperationMenu(false)
    }
  }

  function handleDuplicateOperation() {
    if (!selectedOperation) {
      return
    }

    const operationId = duplicateOperation(selectedOperation.id)
    if (operationId) {
      onSelectedOperationIdChange(operationId)
    }
  }

  function handleDeleteOperation() {
    if (!selectedOperation) {
      return
    }

    const currentIndex = project.operations.findIndex((operation) => operation.id === selectedOperation.id)
    const fallback = project.operations[currentIndex - 1]?.id ?? project.operations[currentIndex + 1]?.id ?? null
    deleteOperation(selectedOperation.id)
    onSelectedOperationIdChange(fallback)
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
          <div className="cam-operations-layout">
            <section className="cam-section cam-section--tree">
              <div className="cam-section-header">
                <span>Operations</span>
                <div className="cam-section-header-actions" ref={addOperationMenuRef}>
                  <span className="feature-count">{project.operations.length}</span>
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
                    aria-expanded={showAddOperationMenu}
                    aria-haspopup="dialog"
                    onClick={() => setShowAddOperationMenu((value) => !value)}
                  >
                    Add
                  </button>
                  {showAddOperationMenu ? (
                    <div className="cam-add-menu" role="dialog" aria-label="Add operation">
                      <div className="cam-add-menu__section">
                        <span className="cam-add-menu__label">Pass</span>
                        <div className="cam-pass-toggle">
                          <button
                            className={`cam-subtab ${newOperationMode === 'rough' ? 'cam-subtab--active' : ''}`}
                            type="button"
                            onClick={() => setNewOperationMode('rough')}
                          >
                            Rough
                          </button>
                          <button
                            className={`cam-subtab ${newOperationMode === 'finish' ? 'cam-subtab--active' : ''}`}
                            type="button"
                            onClick={() => setNewOperationMode('finish')}
                          >
                            Finish
                          </button>
                          <button
                            className={`cam-subtab ${newOperationMode === 'pair' ? 'cam-subtab--active' : ''}`}
                            type="button"
                            onClick={() => setNewOperationMode('pair')}
                          >
                            Rough + Finish
                          </button>
                        </div>
                      </div>
                      <div className="cam-add-menu__section">
                        <span className="cam-add-menu__label">Operation</span>
                        <div className="cam-add-menu__buttons">
                          {operationButtons.map((button) => (
                            <button
                              key={button.kind}
                              className="feat-btn"
                              type="button"
                              disabled={button.disabled}
                              title={button.hint}
                              onClick={() => handleAddOperation(button.kind)}
                            >
                              {button.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="cam-section-content">
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
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section className="cam-section cam-section--properties">
              <div className="cam-section-header">
                <span>Properties</span>
                <div className="cam-section-header-actions">
                  <button className="cam-header-action" type="button" onClick={handleDuplicateOperation} disabled={!selectedOperation}>
                    Duplicate
                  </button>
                  <button className="cam-header-action cam-header-action--danger" type="button" onClick={handleDeleteOperation} disabled={!selectedOperation}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="cam-section-content">
                {selectedOperation ? (
                  <div key={selectedOperation.id} className="properties-panel cam-tool-properties">
                    <div className="properties-group">
                  <label className="properties-field">
                    <span>Name</span>
                    <DraftTextInput value={selectedOperation.name} onCommit={(value) => updateOperation(selectedOperation.id, { name: value })} />
                  </label>
                  <label className="properties-field">
                    <span>Kind</span>
                    <input type="text" value={operationKindLabel(selectedOperation.kind)} readOnly />
                  </label>
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
                      onChange={(event) =>
                        updateOperation(selectedOperation.id, {
                          toolRef: event.target.value || null,
                        })
                      }
                    >
                      <option value="">No Tool</option>
                      {project.tools.map((tool) => (
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
                  <label className="properties-field">
                    <span>Stepdown</span>
                    <DraftLengthInput
                      value={selectedOperation.stepdown}
                      units={project.meta.units}
                      min={0.0001}
                      onCommit={(value) => updateOperation(selectedOperation.id, { stepdown: value })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>Stepover Ratio</span>
                    <DraftNumberInput
                      value={selectedOperation.stepover}
                      min={0.01}
                      max={1}
                      onCommit={(value) => updateOperation(selectedOperation.id, { stepover: value })}
                    />
                  </label>
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
                    </div>
                  </div>
                ) : (
                  <div className="panel-empty">Select an operation to edit its parameters.</div>
                )}
              </div>
            </section>
          </div>
        </div>
      ) : (
        <div className="cam-tools">
          <div className="cam-toolbar">
            <button className="feat-btn" type="button" onClick={handleAddTool}>
              Add Tool
            </button>
            <button
              className="feat-btn"
              type="button"
              onClick={handleImportLibrary}
              disabled={libraryLoading || (libraryTools.length > 0 && missingLibraryTools.length === 0)}
              title={libraryLoading ? 'Loading bundled tool library' : undefined}
            >
              Import Library
            </button>
            <button className="feat-btn" type="button" onClick={handleDuplicateTool} disabled={!selectedTool}>
              Duplicate
            </button>
            <button className="feat-btn feat-btn--delete" type="button" onClick={handleDeleteTool} disabled={!selectedTool}>
              Delete
            </button>
          </div>

          <div className="cam-toolbar-note">
            {libraryLoading
              ? 'Loading bundled tool library...'
              : libraryError
                ? `Tool library: ${libraryError}`
                : libraryTools.length > 0
                  ? `${libraryName}: ${libraryTools.length} tools, ${missingLibraryTools.length} missing from project.`
                  : 'Bundled tool library not loaded yet.'}
          </div>

          <div className="cam-tools-layout">
            <section className="cam-section">
              <div className="cam-section-header">
                <span>Tools</span>
              </div>
              <div className="cam-section-content">
                <div className="cam-tool-list">
                  {project.tools.length === 0 ? (
                    <div className="panel-empty">No tools yet. Add the first tool to start building the library.</div>
                  ) : (
                    project.tools.map((tool) => (
                      <button
                        key={tool.id}
                        className={`cam-tool-row ${tool.id === selectedToolId ? 'cam-tool-row--active' : ''}`}
                        type="button"
                        onClick={() => setSelectedToolId(tool.id)}
                      >
                        <span className="cam-tool-row__name">{tool.name}</span>
                        <span className="cam-tool-row__meta">
                          {toolTypeLabel(tool.type)} · {formatLength(tool.diameter, tool.units)} {toolUnitsLabel(tool.units)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section className="cam-section cam-section--properties">
              <div className="cam-section-header">
                <span>Properties</span>
              </div>
              <div className="cam-section-content">
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
                          onChange={(event) => updateTool(selectedTool.id, { type: event.target.value as ToolType })}
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
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
