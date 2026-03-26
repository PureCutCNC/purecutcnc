import { useRef, useState } from 'react'
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useProjectStore } from '../../store/projectStore'

interface FeatureTreeProps {
  onFeatureContextMenu?: (featureId: string, x: number, y: number) => void
}

export function FeatureTree({ onFeatureContextMenu }: FeatureTreeProps) {
  const {
    project,
    selection,
    setGrid,
    setStock,
    updateFeature,
    selectProject,
    selectGrid,
    selectFeature,
    selectStock,
    hoverFeature,
    reorderFeatures,
  } = useProjectStore()

  const [dragId, setDragId] = useState<string | null>(null)
  const dragOverId = useRef<string | null>(null)

  function handleDragStart(id: string) {
    setDragId(id)
  }

  function handleDragOver(event: DragEvent, id: string) {
    event.preventDefault()
    dragOverId.current = id
  }

  function handleDrop() {
    if (!dragId || !dragOverId.current || dragId === dragOverId.current) {
      setDragId(null)
      dragOverId.current = null
      return
    }

    const ids = project.features.map((feature) => feature.id)
    const fromIndex = ids.indexOf(dragId)
    const toIndex = ids.indexOf(dragOverId.current)
    if (fromIndex === -1 || toIndex === -1) return

    const nextIds = [...ids]
    nextIds.splice(fromIndex, 1)
    nextIds.splice(toIndex, 0, dragId)
    reorderFeatures(nextIds)

    setDragId(null)
    dragOverId.current = null
  }

  // Warn if first feature is not 'add' — this should not normally happen
  // since the store enforces it, but a loaded file could be malformed.
  const firstFeatureInvalid =
    project.features.length > 0 && project.features[0].operation !== 'add'

  return (
    <div className="feature-tree-panel">
      <div className="tree-root-label">Project Tree</div>
      <div className="tree-list">
        <TreeRow
          label="Project"
          kind="project"
          isSelected={selection.selectedNode?.type === 'project'}
          isDragging={false}
          onClick={selectProject}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
        />
        <TreeRow
          label="Grid"
          kind="grid"
          isSelected={selection.selectedNode?.type === 'grid'}
          isDragging={false}
          visible={project.grid.visible}
          onClick={selectGrid}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onToggleVisible={() =>
            setGrid({
              ...project.grid,
              visible: !project.grid.visible,
            })
          }
        />
        <TreeRow
          label="Stock"
          kind="stock"
          isSelected={selection.selectedNode?.type === 'stock'}
          isDragging={false}
          visible={project.stock.visible}
          onClick={selectStock}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onToggleVisible={() =>
            setStock({
              ...project.stock,
              visible: !project.stock.visible,
            })
          }
        />
        {project.features.length === 0 ? (
          <div className="feature-tree-empty">No feature nodes yet.</div>
        ) : (
          <>
            {firstFeatureInvalid && (
              <div className="feature-tree-warning" role="alert">
                ⚠ First feature must be <strong>Add</strong>. The 3D model will not build until this is fixed.
              </div>
            )}
            {project.features.map((feature, index) => (
              <TreeRow
                key={feature.id}
                label={feature.name}
                kind="feature"
                isSelected={selection.selectedFeatureIds.includes(feature.id)}
                isDragging={dragId === feature.id}
                visible={feature.visible}
                operation={feature.operation}
                isFirstFeature={index === 0}
                onClick={(event) => selectFeature(feature.id, event.metaKey || event.ctrlKey || event.shiftKey)}
                onMouseEnter={() => hoverFeature(feature.id)}
                onMouseLeave={() => hoverFeature(null)}
                onToggleVisible={() => updateFeature(feature.id, { visible: !feature.visible })}
                onToggleOperation={() =>
                  updateFeature(feature.id, {
                    operation: feature.operation === 'add' ? 'subtract' : 'add',
                  })
                }
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (!selection.selectedFeatureIds.includes(feature.id)) {
                    selectFeature(feature.id)
                  }
                  onFeatureContextMenu?.(feature.id, event.clientX, event.clientY)
                }}
                draggable
                onDragStart={() => handleDragStart(feature.id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(event) => handleDragOver(event, feature.id)}
                onDrop={handleDrop}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

interface TreeRowProps {
  label: string
  kind: 'project' | 'grid' | 'stock' | 'feature'
  isSelected: boolean
  isDragging: boolean
  visible?: boolean
  operation?: 'add' | 'subtract'
  isFirstFeature?: boolean
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onToggleVisible?: () => void
  onToggleOperation?: () => void
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void
  draggable?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragOver?: (event: DragEvent) => void
  onDrop?: () => void
}

function TreeRow({
  label,
  kind,
  isSelected,
  isDragging,
  visible,
  operation,
  isFirstFeature = false,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onToggleVisible,
  onToggleOperation,
  onContextMenu,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: TreeRowProps) {
  // First feature's operation toggle is locked to 'add' — disable it
  const operationLocked = isFirstFeature && operation === 'add'

  return (
    <div
      className={[
        'tree-row',
        `tree-row--${kind}`,
        isSelected ? 'tree-row--selected' : '',
        isDragging ? 'tree-row--dragging' : '',
      ].join(' ')}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
    >
      <span className="tree-branch" aria-hidden="true">
        {kind === 'project' ? 'proj' : kind === 'grid' ? 'grid' : kind === 'stock' ? 'root' : 'node'}
      </span>
      <span className="tree-label" title={label}>{label}</span>
      <div className="tree-row-actions">
        {kind === 'feature' && onToggleOperation ? (
          <button
            type="button"
            className={[
              'tree-action-btn',
              'tree-action-btn--operation',
              `tree-action-btn--${operation}`,
              operationLocked ? 'tree-action-btn--locked' : '',
            ].join(' ')}
            onClick={(event) => {
              event.stopPropagation()
              if (!operationLocked) onToggleOperation()
            }}
            title={
              operationLocked
                ? 'First feature must always be Add (base solid)'
                : operation === 'add'
                ? 'Feature adds material — click to toggle'
                : 'Feature subtracts material — click to toggle'
            }
            aria-label={
              operationLocked
                ? 'Operation locked to Add'
                : operation === 'add'
                ? 'Toggle to subtract'
                : 'Toggle to add'
            }
            aria-disabled={operationLocked}
          >
            {operation === 'add' ? '+' : '−'}
          </button>
        ) : null}
        {onToggleVisible ? (
          <button
            type="button"
            className={`tree-action-btn tree-action-btn--visibility ${visible ? '' : 'tree-action-btn--muted'}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleVisible()
            }}
            title={visible ? 'Hide entry' : 'Show entry'}
            aria-label={visible ? 'Hide entry' : 'Show entry'}
          >
            {visible ? '◉' : '○'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
