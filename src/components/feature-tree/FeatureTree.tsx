import { useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useProjectStore } from '../../store/projectStore'

export function FeatureTree() {
  const {
    project,
    selection,
    setGrid,
    setStock,
    updateFeature,
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

  return (
    <div className="feature-tree-panel">
      <div className="tree-root-label">Project</div>
      <div className="tree-list">
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
          project.features.map((feature) => (
            <TreeRow
              key={feature.id}
              label={feature.name}
              kind="feature"
              isSelected={selection.selectedNode?.type === 'feature' && selection.selectedNode.featureId === feature.id}
              isDragging={dragId === feature.id}
              visible={feature.visible}
              operation={feature.operation}
              onClick={() => selectFeature(feature.id)}
              onMouseEnter={() => hoverFeature(feature.id)}
              onMouseLeave={() => hoverFeature(null)}
              onToggleVisible={() => updateFeature(feature.id, { visible: !feature.visible })}
              onToggleOperation={() =>
                updateFeature(feature.id, {
                  operation: feature.operation === 'add' ? 'subtract' : 'add',
                })
              }
              draggable
              onDragStart={() => handleDragStart(feature.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => handleDragOver(event, feature.id)}
              onDrop={handleDrop}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface TreeRowProps {
  label: string
  kind: 'grid' | 'stock' | 'feature'
  isSelected: boolean
  isDragging: boolean
  visible: boolean
  operation?: 'add' | 'subtract'
  onClick: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onToggleVisible: () => void
  onToggleOperation?: () => void
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
  onClick,
  onMouseEnter,
  onMouseLeave,
  onToggleVisible,
  onToggleOperation,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: TreeRowProps) {
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
    >
      <span className="tree-branch" aria-hidden="true">
        {kind === 'grid' ? 'grid' : kind === 'stock' ? 'root' : 'node'}
      </span>
      <span className="tree-label" title={label}>{label}</span>
      <div className="tree-row-actions">
        {kind === 'feature' && onToggleOperation ? (
          <button
            type="button"
            className={`tree-action-btn tree-action-btn--operation tree-action-btn--${operation}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleOperation()
            }}
            title={operation === 'add' ? 'Feature adds material' : 'Feature subtracts material'}
            aria-label={operation === 'add' ? 'Toggle to subtract' : 'Toggle to add'}
          >
            {operation === 'add' ? '+' : '-'}
          </button>
        ) : null}
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
      </div>
    </div>
  )
}
