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

import { useRef, useState } from 'react'
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { FeatureOperation } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'

interface FeatureTreeProps {
  onFeatureContextMenu?: (featureId: string, x: number, y: number) => void
  onTabContextMenu?: (tabId: string, x: number, y: number) => void
  onClampContextMenu?: (clampId: string, x: number, y: number) => void
  onEditTab?: (tabId: string) => void
  onEditClamp?: (clampId: string) => void
}

export function FeatureTree({ onFeatureContextMenu, onTabContextMenu, onClampContextMenu, onEditTab, onEditClamp }: FeatureTreeProps) {
  const {
    project,
    selection,
    startAddTabPlacement,
    startAddClampPlacement,
    setGrid,
    setOrigin,
    setStock,
    addFeatureFolder,
    moveFeatureTreeFeature,
    reorderFeatureTreeEntries,
    setAllFeaturesVisible,
    setAllRegionsVisible,
    toggleFolderVisible,
    toggleRegionFolderVisible,
    selectFolderFeatures,
    selectFeatures,
    setAllTabsVisible,
    setAllClampsVisible,
    updateFeatureFolder,
    updateFeature,
    updateTab,
    updateClamp,
    updateBackdrop,
    selectProject,
    selectGrid,
    selectOrigin,
    selectBackdrop,
    selectFeaturesRoot,
    selectRegionsRoot,
    selectTabsRoot,
    selectClampsRoot,
    selectFeatureFolder,
    selectFeature,
    selectTab,
    selectClamp,
    selectStock,
    hoverFeature,
  } = useProjectStore()

  const [dragItem, setDragItem] = useState<{ kind: 'feature' | 'folder'; id: string } | null>(null)
  const [featuresCollapsed, setFeaturesCollapsed] = useState(false)
  const [regionsCollapsed, setRegionsCollapsed] = useState(false)
  const [tabsCollapsed, setTabsCollapsed] = useState(false)
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

  // Warn if first 2.5D feature is not 'add' — imported STL models may be first.
  // since the store enforces it, but a loaded file could be malformed.
  const machiningFeatures = project.features.filter((feature) => feature.operation !== 'region')
  const regionFeatures = project.features.filter((feature) => feature.operation === 'region')
  const featureFolders = project.featureFolders.filter((folder) => (folder.section ?? 'features') !== 'regions')
  const regionFolders = project.featureFolders.filter((folder) => (folder.section ?? 'features') === 'regions')
  const firstMachiningFeature = machiningFeatures[0] ?? null
  const firstFeatureInvalid =
    !!firstMachiningFeature
    && firstMachiningFeature.operation !== 'add'
    && !(firstMachiningFeature.kind === 'stl' && firstMachiningFeature.operation === 'model')

  const rootEntries = project.featureTree.filter((entry) => {
    if (entry.type === 'folder') {
      const folder = project.featureFolders.find((item) => item.id === entry.folderId)
      return (folder?.section ?? 'features') !== 'regions'
    }
    const feature = project.features.find((item) => item.id === entry.featureId)
    return feature?.operation !== 'region'
  })

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
        onToggleOperation={(op) =>
          updateFeature(feature.id, {
            operation: op,
          })
        }
        onContextMenu={(event) => {
          event.preventDefault()
          if (!selection.selectedFeatureIds.includes(feature.id)) {
            selectFeature(feature.id)
          }
          onFeatureContextMenu?.(feature.id, event.clientX, event.clientY)
        }}
        onMoreMenu={onFeatureContextMenu ? (x, y) => {
          if (!selection.selectedFeatureIds.includes(feature.id)) {
            selectFeature(feature.id)
          }
          onFeatureContextMenu(feature.id, x, y)
        } : undefined}
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
          label="Origin"
          kind="origin"
          isSelected={selection.selectedNode?.type === 'origin'}
          isDragging={false}
          visible={project.origin.visible}
          onClick={selectOrigin}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onToggleVisible={() => setOrigin({ ...project.origin, visible: !project.origin.visible })}
        />
        <TreeRow
          label={project.backdrop?.name ?? 'Backdrop'}
          kind="backdrop"
          isSelected={selection.selectedNode?.type === 'backdrop'}
          isDragging={false}
          visible={project.backdrop?.visible}
          onClick={selectBackdrop}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onToggleVisible={project.backdrop ? () => updateBackdrop({ visible: !project.backdrop!.visible }) : undefined}
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
          onAddFolder={() => addFeatureFolder('features')}
          onToggleCollapse={() => setFeaturesCollapsed((value) => !value)}
          onShowAll={() => setAllFeaturesVisible(true)}
          onHideAll={() => setAllFeaturesVisible(false)}
          onDragOver={(event) => handleDragOver(event, { kind: 'features' })}
          onDrop={handleDrop}
        />
        {featuresCollapsed ? null : machiningFeatures.length === 0 && featureFolders.length === 0 ? (
          <div className="feature-tree-empty">No feature nodes yet.</div>
        ) : (
          <div className="tree-children">
            {firstFeatureInvalid && (
              <div className="feature-tree-warning" role="alert">
                ⚠ First 2.5D feature must be <strong>Add</strong>. The 3D model will not build until this is fixed.
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

              const folderFeatures = project.features.filter((feature) => feature.folderId === folder.id && feature.operation !== 'region')
              const folderVisible = folderFeatures.some((f) => f.visible)
              return (
                <div key={folder.id}>
                  <TreeRow
                    label={folder.name}
                    kind="folder"
                    depth={1}
                    isSelected={selection.selectedNode?.type === 'folder' && selection.selectedNode.folderId === folder.id}
                    isDragging={dragItem?.kind === 'folder' && dragItem.id === folder.id}
                    collapsed={folder.collapsed}
                    visible={folderVisible}
                    onClick={() => selectFeatureFolder(folder.id)}
                    onMouseEnter={() => hoverFeature(null)}
                    onMouseLeave={() => hoverFeature(null)}
                    onToggleCollapse={() => updateFeatureFolder(folder.id, { collapsed: !folder.collapsed })}
                    onSelectAllFeatures={folderFeatures.length > 0 ? () => selectFolderFeatures(folder.id) : undefined}
                    onToggleVisible={folderFeatures.length > 0 ? () => toggleFolderVisible(folder.id) : undefined}
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
          label="Regions"
          kind="regions"
          depth={0}
          isSelected={selection.selectedNode?.type === 'regions_root'}
          isDragging={false}
          collapsed={regionsCollapsed}
          onClick={selectRegionsRoot}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddFolder={() => addFeatureFolder('regions')}
          onToggleCollapse={() => setRegionsCollapsed((value) => !value)}
          onShowAll={() => setAllRegionsVisible(true)}
          onHideAll={() => setAllRegionsVisible(false)}
        />
        {regionsCollapsed ? null : regionFeatures.length === 0 && regionFolders.length === 0 ? (
          <div className="feature-tree-empty">No regions yet.</div>
        ) : (
          <div className="tree-children">
            {project.featureTree.map((entry) => {
              if (entry.type === 'feature') {
                const feature = project.features.find((item) => item.id === entry.featureId)
                return feature?.operation === 'region' && feature.folderId === null
                  ? renderFeatureRow(entry.featureId, 1)
                  : null
              }

              const folder = project.featureFolders.find((item) => item.id === entry.folderId)
              if (!folder) {
                return null
              }
              if ((folder.section ?? 'features') !== 'regions') {
                return null
              }

              const folderFeatures = project.features.filter((feature) => feature.folderId === folder.id && feature.operation === 'region')
              const folderVisible = folderFeatures.some((f) => f.visible)
              return (
                <div key={`regions-${folder.id}`}>
                  <TreeRow
                    label={folder.name}
                    kind="folder"
                    depth={1}
                    isSelected={selection.selectedNode?.type === 'folder' && selection.selectedNode.folderId === folder.id}
                    isDragging={dragItem?.kind === 'folder' && dragItem.id === folder.id}
                    collapsed={folder.collapsed}
                    visible={folderVisible}
                    onClick={() => selectFeatureFolder(folder.id)}
                    onMouseEnter={() => hoverFeature(null)}
                    onMouseLeave={() => hoverFeature(null)}
                    onToggleCollapse={() => updateFeatureFolder(folder.id, { collapsed: !folder.collapsed })}
                    onSelectAllFeatures={folderFeatures.length > 0 ? () => selectFeatures(folderFeatures.map((feature) => feature.id)) : undefined}
                    onToggleVisible={folderFeatures.length > 0 ? () => toggleRegionFolderVisible(folder.id) : undefined}
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
          label="Tabs"
          kind="tabs"
          depth={0}
          isSelected={selection.selectedNode?.type === 'tabs_root'}
          isDragging={false}
          collapsed={tabsCollapsed}
          onClick={selectTabsRoot}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddTab={() => startAddTabPlacement()}
          onToggleCollapse={() => setTabsCollapsed((value) => !value)}
          onShowAll={() => setAllTabsVisible(true)}
          onHideAll={() => setAllTabsVisible(false)}
        />
        {tabsCollapsed ? null : project.tabs.length === 0 ? (
          <div className="feature-tree-empty">No tabs yet.</div>
        ) : (
          <div className="tree-children">
            {project.tabs.map((tab) => (
              <TreeRow
                key={tab.id}
                label={tab.name}
                kind="tab"
                depth={1}
                isSelected={selection.selectedNode?.type === 'tab' && selection.selectedNode.tabId === tab.id}
                isDragging={false}
                visible={tab.visible}
                onClick={() => selectTab(tab.id)}
                onMouseEnter={() => hoverFeature(null)}
                onMouseLeave={() => hoverFeature(null)}
                onToggleVisible={() => updateTab(tab.id, { visible: !tab.visible })}
                onContextMenu={(event) => {
                  event.preventDefault()
                  selectTab(tab.id)
                  onTabContextMenu?.(tab.id, event.clientX, event.clientY)
                }}
                onEditEntry={onEditTab ? () => onEditTab(tab.id) : undefined}
                onMoreMenu={onTabContextMenu ? (x, y) => {
                  selectTab(tab.id)
                  onTabContextMenu(tab.id, x, y)
                } : undefined}
              />
            ))}
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
                onEditEntry={onEditClamp ? () => onEditClamp(clamp.id) : undefined}
                onMoreMenu={onClampContextMenu ? (x, y) => {
                  selectClamp(clamp.id)
                  onClampContextMenu(clamp.id, x, y)
                } : undefined}
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
  kind: 'project' | 'grid' | 'stock' | 'origin' | 'backdrop' | 'features' | 'regions' | 'tabs' | 'clamps' | 'folder' | 'feature' | 'tab' | 'clamp'
  depth?: number
  isSelected: boolean
  isDragging: boolean
  visible?: boolean
  operation?: FeatureOperation
  isFirstFeature?: boolean
  collapsed?: boolean
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onToggleVisible?: () => void
  onSelectAllFeatures?: () => void
  onToggleOperation?: (operation: FeatureOperation) => void
  onToggleCollapse?: () => void
  onAddFolder?: () => void
  onAddTab?: () => void
  onAddClamp?: () => void
  onShowAll?: () => void
  onHideAll?: () => void
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void
  onEditEntry?: () => void
  onMoreMenu?: (x: number, y: number) => void
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
  onSelectAllFeatures,
  onToggleOperation,
  onToggleCollapse,
  onAddFolder,
  onAddTab,
  onAddClamp,
  onShowAll,
  onHideAll,
  onContextMenu,
  onEditEntry,
  onMoreMenu,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: TreeRowProps) {
  // First feature's operation toggle is locked to 'add' — disable it
  const operationLocked = isFirstFeature && operation === 'add'

  // Popup menu state for operation selector
  const operationBtnRef = useRef<HTMLButtonElement>(null)
  const [showOperationMenu, setShowOperationMenu] = useState(false)

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
      onMouseDown={(event) => {
        if (event.shiftKey) {
          event.preventDefault()
        }
      }}
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
                : kind === 'origin'
                  ? 'orig'
                : kind === 'backdrop'
                  ? 'back'
                : kind === 'features'
                  ? 'feat'
                  : kind === 'regions'
                    ? 'regn'
                  : kind === 'tabs'
                    ? 'root'
                  : kind === 'clamps'
                    ? 'clmp'
                    : kind === 'tab'
                      ? 'node'
                    : kind === 'clamp'
                      ? 'node'
                      : 'node'
        )}
      </span>
      <span className="tree-label" title={label}>{label}</span>
      <div className="tree-row-actions">
        {(kind === 'features' || kind === 'regions' || kind === 'tabs' || kind === 'clamps') && onShowAll ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onShowAll()
            }}
            title={kind === 'features' ? 'Show all features' : kind === 'regions' ? 'Show all regions' : kind === 'tabs' ? 'Show all tabs' : 'Show all clamps'}
            aria-label={kind === 'features' ? 'Show all features' : kind === 'regions' ? 'Show all regions' : kind === 'tabs' ? 'Show all tabs' : 'Show all clamps'}
          >
            ◉
          </button>
        ) : null}
        {(kind === 'features' || kind === 'regions' || kind === 'tabs' || kind === 'clamps') && onHideAll ? (
          <button
            type="button"
            className="tree-action-btn tree-action-btn--muted"
            onClick={(event) => {
              event.stopPropagation()
              onHideAll()
            }}
            title={kind === 'features' ? 'Hide all features' : kind === 'regions' ? 'Hide all regions' : kind === 'tabs' ? 'Hide all tabs' : 'Hide all clamps'}
            aria-label={kind === 'features' ? 'Hide all features' : kind === 'regions' ? 'Hide all regions' : kind === 'tabs' ? 'Hide all tabs' : 'Hide all clamps'}
          >
            ○
          </button>
        ) : null}
        {(kind === 'features' || kind === 'regions') && onAddFolder ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onAddFolder()
            }}
            title={kind === 'regions' ? 'Add region folder' : 'Add folder'}
            aria-label={kind === 'regions' ? 'Add region folder' : 'Add folder'}
          >
            <svg viewBox="0 0 16 12" width="14" height="11" focusable="false" aria-hidden="true" style={{ display: 'block' }}>
              <path fill="currentColor" d="M1.5 3.25h3.2l1-1.35h2.15c.43 0 .8.15 1.09.44.29.29.44.66.44 1.09v.32h3.05c.43 0 .8.15 1.09.44.29.29.44.66.44 1.09v4.97c0 .43-.15.8-.44 1.09-.29.29-.66.44-1.09.44H1.75c-.43 0-.8-.15-1.09-.44-.29-.29-.44-.66-.44-1.09V4.78c0-.43.15-.8.44-1.09.29-.29.66-.44 1.09-.44Z" />
            </svg>
          </button>
        ) : null}
        {kind === 'tabs' && onAddTab ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onAddTab()
            }}
            title="Add tab"
            aria-label="Add tab"
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
        {(kind === 'folder' || kind === 'features' || kind === 'regions' || kind === 'tabs' || kind === 'clamps') && onToggleCollapse ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onToggleCollapse()
            }}
            title={collapsed ? 'Expand section' : 'Collapse section'}
            aria-label={collapsed ? 'Expand section' : 'Collapse section'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : null}
        {kind === 'feature' && onToggleOperation ? (
          <div className="tree-operation-wrapper">
            <button
              ref={operationBtnRef}
              type="button"
              className={[
                'tree-action-btn',
                'tree-action-btn--operation',
                `tree-action-btn--${operation}`,
                operationLocked || operation === 'model' ? 'tree-action-btn--locked' : '',
              ].join(' ')}
              onClick={(event) => {
                event.stopPropagation()
                if (!operationLocked && operation !== 'model') setShowOperationMenu((prev) => !prev)
              }}
              title={
                operationLocked
                  ? 'First 2.5D feature must be Add (base solid)'
                  : operation === 'model'
                  ? 'Model — imported 3D object (locked)'
                  : operation === 'add'
                  ? 'Feature adds material'
                  : operation === 'subtract'
                  ? 'Feature subtracts material'
                  : 'Feature outlines machining region'
              }
              aria-label={
                operationLocked ? 'Operation locked to Add'
                : operation === 'model' ? 'Model — operation locked'
                : 'Change operation'
              }
              aria-haspopup={operationLocked || operation === 'model' ? undefined : 'true'}
              aria-expanded={showOperationMenu}
              aria-disabled={operationLocked || operation === 'model'}
            >
              {operationLocked ? '🔒' : operation === 'model' ? (
                <svg viewBox="0 0 24 24" className="tree-operation-icon" focusable="false" aria-hidden="true">
                  <path d="M 12 2 L 22 7 L 12 12 L 2 7 L 12 2 Z" />
                  <path d="M 2 7 L 12 12 L 12 22 L 2 17 L 2 7 Z" />
                  <path d="M 22 7 L 12 12 L 12 22 L 22 17 L 22 7 Z" />
                </svg>
              ) : operation === 'add' ? '+' : operation === 'subtract' ? '−' : (
                <svg viewBox="0 0 24 24" className="tree-operation-icon" focusable="false" aria-hidden="true">
                  <path d="M 3 3 L 21 3 L 21 21 L 3 21 L 3 3 Z" />
                </svg>
              )}
            </button>
            {showOperationMenu && !operationLocked && operation !== 'model' ? (
              <>
                <div className="tree-operation-overlay" onClick={() => setShowOperationMenu(false)} />
                <div className="tree-operation-menu">
                  <button
                    type="button"
                    className={['tree-operation-menu__item', operation === 'add' ? 'tree-operation-menu__item--active' : ''].join(' ')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleOperation('add')
                      setShowOperationMenu(false)
                    }}
                    title="Add — feature adds material"
                  >
                    <span className="tree-operation-menu__icon">+</span>
                    <span>Add</span>
                  </button>
                  <button
                    type="button"
                    className={['tree-operation-menu__item', operation === 'subtract' ? 'tree-operation-menu__item--active' : ''].join(' ')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleOperation('subtract')
                      setShowOperationMenu(false)
                    }}
                    title="Subtract — feature removes material"
                  >
                    <span className="tree-operation-menu__icon">−</span>
                    <span>Subtract</span>
                  </button>
                  <button
                    type="button"
                    className={['tree-operation-menu__item', operation === 'region' ? 'tree-operation-menu__item--active' : ''].join(' ')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleOperation('region')
                      setShowOperationMenu(false)
                    }}
                    title="Region — feature filters machining operations"
                  >
                    <span className="tree-operation-menu__icon tree-operation-menu__icon--region">□</span>
                    <span>Region</span>
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {onSelectAllFeatures ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onSelectAllFeatures()
            }}
            title="Select all features in folder"
            aria-label="Select all features in folder"
          >
            <svg viewBox="0 0 14 14" width="12" height="12" focusable="false" aria-hidden="true" style={{ display: 'block' }}>
              <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 1.5" />
            </svg>
          </button>
        ) : null}
        {onEditEntry && kind !== 'feature' ? (
          <button
            type="button"
            className="tree-action-btn tree-action-btn--edit"
            onClick={(event) => {
              event.stopPropagation()
              onEditEntry()
            }}
            title="Edit sketch"
            aria-label="Edit sketch"
          >
            <svg viewBox="0 0 14 14" width="12" height="12" focusable="false" aria-hidden="true" style={{ display: 'block' }}>
              <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M1.5 12.5h2.5l7-7-2.5-2.5-7 7v2.5Zm7.5-9.5 2-2 2.5 2.5-2 2" />
            </svg>
          </button>
        ) : null}
        {onMoreMenu ? (
          <button
            type="button"
            className="tree-action-btn tree-action-btn--more"
            onClick={(event) => {
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              onMoreMenu(rect.left, rect.bottom)
            }}
            title="More actions"
            aria-label="More actions"
          >
            ⋮
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
