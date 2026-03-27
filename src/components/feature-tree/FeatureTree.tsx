import { useRef, useState } from 'react'
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useProjectStore } from '../../store/projectStore'

interface FeatureTreeProps {
  onFeatureContextMenu?: (featureId: string, x: number, y: number) => void
  onClampContextMenu?: (clampId: string, x: number, y: number) => void
}

export function FeatureTree({ onFeatureContextMenu, onClampContextMenu }: FeatureTreeProps) {
  const {
    project,
    selection,
    startAddClampPlacement,
    setGrid,
    setStock,
    addFeatureFolder,
    moveFeatureTreeFeature,
    reorderFeatureTreeEntries,
    setAllFeaturesVisible,
    setAllClampsVisible,
    updateFeatureFolder,
    updateFeature,
    updateClamp,
    selectProject,
    selectGrid,
    selectFeaturesRoot,
    selectClampsRoot,
    selectFeatureFolder,
    selectFeature,
    selectClamp,
    selectStock,
    hoverFeature,
  } = useProjectStore()

  const [dragItem, setDragItem] = useState<{ kind: 'feature' | 'folder'; id: string } | null>(null)
  const [featuresCollapsed, setFeaturesCollapsed] = useState(false)
  const [clampsCollapsed, setClampsCollapsed] = useState(false)
  const dragOverTarget = useRef<{ kind: 'features' | 'folder' | 'feature'; id?: string } | null>(null)

  function handleFeatureDragStart(id: string) {
    setDragItem({ kind: 'feature', id })
  }

  function handleFolderDragStart(id: string) {
    setDragItem({ kind: 'folder', id })
  }

  function handleDragOver(event: DragEvent, target: { kind: 'features' | 'folder' | 'feature'; id?: string }) {
    event.preventDefault()
    dragOverTarget.current = target
  }

  function handleDrop() {
    if (!dragItem || !dragOverTarget.current) {
      setDragItem(null)
      dragOverTarget.current = null
      return
    }

    const target = dragOverTarget.current

    if (dragItem.kind === 'feature') {
      if (target.kind === 'features') {
        moveFeatureTreeFeature(dragItem.id, null)
      } else if (target.kind === 'folder' && target.id) {
        moveFeatureTreeFeature(dragItem.id, target.id)
      } else if (target.kind === 'feature' && target.id && target.id !== dragItem.id) {
        const targetFeature = project.features.find((feature) => feature.id === target.id)
        if (targetFeature) {
          moveFeatureTreeFeature(dragItem.id, targetFeature.folderId ?? null, targetFeature.id)
        }
      }
    } else if (dragItem.kind === 'folder') {
      const draggedEntry: { type: 'folder'; folderId: string } = { type: 'folder', folderId: dragItem.id }
      const rootEntries = project.featureTree.filter((entry) => (
        entry.type === 'folder' ||
        (entry.type === 'feature' && project.features.some((feature) => feature.id === entry.featureId && feature.folderId === null))
      ))
      const filteredEntries = rootEntries.filter((entry) => !(entry.type === 'folder' && entry.folderId === dragItem.id))
      let insertIndex = filteredEntries.length

      if (target.kind === 'folder' && target.id && target.id !== dragItem.id) {
        insertIndex = filteredEntries.findIndex((entry) => entry.type === 'folder' && entry.folderId === target.id)
      } else if (target.kind === 'feature' && target.id) {
        const targetFeature = project.features.find((feature) => feature.id === target.id)
        if (targetFeature?.folderId === null) {
          insertIndex = filteredEntries.findIndex((entry) => entry.type === 'feature' && entry.featureId === target.id)
        }
      }

      if (insertIndex === -1) {
        insertIndex = filteredEntries.length
      }

      const nextEntries = [...filteredEntries]
      nextEntries.splice(insertIndex, 0, draggedEntry)
      reorderFeatureTreeEntries(nextEntries)
    }

    setDragItem(null)
    dragOverTarget.current = null
  }

  // Warn if first feature is not 'add' — this should not normally happen
  // since the store enforces it, but a loaded file could be malformed.
  const firstFeatureInvalid =
    project.features.length > 0 && project.features[0].operation !== 'add'

  const rootEntries = project.featureTree

  function renderFeatureRow(featureId: string, depth: number) {
    const feature = project.features.find((entry) => entry.id === featureId)
    if (!feature) {
      return null
    }

    const index = project.features.findIndex((entry) => entry.id === feature.id)
    return (
      <TreeRow
        key={feature.id}
        label={feature.name}
        kind="feature"
        depth={depth}
        isSelected={selection.selectedFeatureIds.includes(feature.id)}
        isDragging={dragItem?.kind === 'feature' && dragItem.id === feature.id}
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
        onDragStart={() => handleFeatureDragStart(feature.id)}
        onDragEnd={() => setDragItem(null)}
        onDragOver={(event) => handleDragOver(event, { kind: 'feature', id: feature.id })}
        onDrop={handleDrop}
      />
    )
  }

  return (
    <div className="feature-tree-panel">
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
        <TreeRow
          label="Features"
          kind="features"
          depth={0}
          isSelected={selection.selectedNode?.type === 'features_root'}
          isDragging={false}
          collapsed={featuresCollapsed}
          onClick={selectFeaturesRoot}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddFolder={() => addFeatureFolder()}
          onToggleCollapse={() => setFeaturesCollapsed((value) => !value)}
          onShowAll={() => setAllFeaturesVisible(true)}
          onHideAll={() => setAllFeaturesVisible(false)}
          onDragOver={(event) => handleDragOver(event, { kind: 'features' })}
          onDrop={handleDrop}
        />
        {featuresCollapsed ? null : project.features.length === 0 ? (
          <div className="feature-tree-empty">No feature nodes yet.</div>
        ) : (
          <div className="tree-children">
            {firstFeatureInvalid && (
              <div className="feature-tree-warning" role="alert">
                ⚠ First feature must be <strong>Add</strong>. The 3D model will not build until this is fixed.
              </div>
            )}
            {rootEntries.map((entry) => {
              if (entry.type === 'feature') {
                return renderFeatureRow(entry.featureId, 1)
              }

              const folder = project.featureFolders.find((item) => item.id === entry.folderId)
              if (!folder) {
                return null
              }

              const folderFeatures = project.features.filter((feature) => feature.folderId === folder.id)
              return (
                <div key={folder.id}>
                  <TreeRow
                    label={folder.name}
                    kind="folder"
                    depth={1}
                    isSelected={selection.selectedNode?.type === 'folder' && selection.selectedNode.folderId === folder.id}
                    isDragging={dragItem?.kind === 'folder' && dragItem.id === folder.id}
                    collapsed={folder.collapsed}
                    onClick={() => selectFeatureFolder(folder.id)}
                    onMouseEnter={() => hoverFeature(null)}
                    onMouseLeave={() => hoverFeature(null)}
                    onToggleCollapse={() => updateFeatureFolder(folder.id, { collapsed: !folder.collapsed })}
                    draggable
                    onDragStart={() => handleFolderDragStart(folder.id)}
                    onDragEnd={() => setDragItem(null)}
                    onDragOver={(event) => handleDragOver(event, { kind: 'folder', id: folder.id })}
                    onDrop={handleDrop}
                  />
                  {!folder.collapsed ? (
                    <div className="tree-children">
                      {folderFeatures.length === 0 ? (
                        <div className="feature-tree-empty">Empty folder.</div>
                      ) : (
                        folderFeatures.map((feature) => renderFeatureRow(feature.id, 2))
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
        <TreeRow
          label="Clamps"
          kind="clamps"
          depth={0}
          isSelected={selection.selectedNode?.type === 'clamps_root'}
          isDragging={false}
          collapsed={clampsCollapsed}
          onClick={selectClampsRoot}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddClamp={() => startAddClampPlacement()}
          onToggleCollapse={() => setClampsCollapsed((value) => !value)}
          onShowAll={() => setAllClampsVisible(true)}
          onHideAll={() => setAllClampsVisible(false)}
        />
        {clampsCollapsed ? null : project.clamps.length === 0 ? (
          <div className="feature-tree-empty">No clamps yet.</div>
        ) : (
          <div className="tree-children">
            {project.clamps.map((clamp) => (
              <TreeRow
                key={clamp.id}
                label={clamp.name}
                kind="clamp"
                depth={1}
                isSelected={selection.selectedNode?.type === 'clamp' && selection.selectedNode.clampId === clamp.id}
                isDragging={false}
                visible={clamp.visible}
                onClick={() => selectClamp(clamp.id)}
                onMouseEnter={() => hoverFeature(null)}
                onMouseLeave={() => hoverFeature(null)}
                onToggleVisible={() => updateClamp(clamp.id, { visible: !clamp.visible })}
                onContextMenu={(event) => {
                  event.preventDefault()
                  selectClamp(clamp.id)
                  onClampContextMenu?.(clamp.id, event.clientX, event.clientY)
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface TreeRowProps {
  label: string
  kind: 'project' | 'grid' | 'stock' | 'features' | 'clamps' | 'folder' | 'feature' | 'clamp'
  depth?: number
  isSelected: boolean
  isDragging: boolean
  visible?: boolean
  operation?: 'add' | 'subtract'
  isFirstFeature?: boolean
  collapsed?: boolean
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onToggleVisible?: () => void
  onToggleOperation?: () => void
  onToggleCollapse?: () => void
  onAddFolder?: () => void
  onAddClamp?: () => void
  onShowAll?: () => void
  onHideAll?: () => void
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
  depth = 0,
  isSelected,
  isDragging,
  visible,
  operation,
  isFirstFeature = false,
  collapsed = false,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onToggleVisible,
  onToggleOperation,
  onToggleCollapse,
  onAddFolder,
  onAddClamp,
  onShowAll,
  onHideAll,
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
        depth > 0 ? 'tree-row--nested' : '',
        depth > 1 ? 'tree-row--deep' : '',
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
      style={{ paddingLeft: `${depth * 12}px` }}
    >
      <span className={`tree-branch tree-branch--${kind}`} aria-hidden="true">
        {kind === 'folder' ? (
          <svg viewBox="0 0 16 12" className="tree-icon tree-icon--folder" focusable="false" aria-hidden="true">
            <path d="M1.5 3.25h3.2l1-1.35h2.15c.43 0 .8.15 1.09.44.29.29.44.66.44 1.09v.32h3.05c.43 0 .8.15 1.09.44.29.29.44.66.44 1.09v4.97c0 .43-.15.8-.44 1.09-.29.29-.66.44-1.09.44H1.75c-.43 0-.8-.15-1.09-.44-.29-.29-.44-.66-.44-1.09V4.78c0-.43.15-.8.44-1.09.29-.29.66-.44 1.09-.44Z" />
          </svg>
        ) : (
          kind === 'project'
            ? 'proj'
            : kind === 'grid'
              ? 'grid'
              : kind === 'stock'
                ? 'root'
                : kind === 'features'
                  ? 'feat'
                  : kind === 'clamps'
                    ? 'clmp'
                    : kind === 'clamp'
                      ? 'node'
                      : 'node'
        )}
      </span>
      <span className="tree-label" title={label}>{label}</span>
      <div className="tree-row-actions">
        {(kind === 'features' || kind === 'clamps') && onShowAll ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onShowAll()
            }}
            title={kind === 'features' ? 'Show all features' : 'Show all clamps'}
            aria-label={kind === 'features' ? 'Show all features' : 'Show all clamps'}
          >
            ◉
          </button>
        ) : null}
        {(kind === 'features' || kind === 'clamps') && onHideAll ? (
          <button
            type="button"
            className="tree-action-btn tree-action-btn--muted"
            onClick={(event) => {
              event.stopPropagation()
              onHideAll()
            }}
            title={kind === 'features' ? 'Hide all features' : 'Hide all clamps'}
            aria-label={kind === 'features' ? 'Hide all features' : 'Hide all clamps'}
          >
            ○
          </button>
        ) : null}
        {kind === 'features' && onAddFolder ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onAddFolder()
            }}
            title="Add folder"
            aria-label="Add folder"
          >
            +
          </button>
        ) : null}
        {kind === 'clamps' && onAddClamp ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onAddClamp()
            }}
            title="Add clamp"
            aria-label="Add clamp"
          >
            +
          </button>
        ) : null}
        {(kind === 'folder' || kind === 'features' || kind === 'clamps') && onToggleCollapse ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onToggleCollapse()
            }}
            title={collapsed ? 'Expand folder' : 'Collapse folder'}
            aria-label={collapsed ? 'Expand folder' : 'Collapse folder'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : null}
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
            {operationLocked ? '🔒' : operation === 'add' ? '+' : '−'}
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
