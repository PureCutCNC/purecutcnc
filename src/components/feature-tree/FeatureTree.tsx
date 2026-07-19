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

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { FeatureOperation, RegionMaskMode } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { getDefinitionId, getInstanceIdsForDefinition } from '../../store/helpers/featureDefinitions'
import { isConstruction, isMachinable, isRegion, isSolid, sectionForOperation } from '../../store/helpers/featureRoles'
import { Icon } from '../Icon'
import { isTabletMode, useShellMode } from '../layout/useShellMode'
import { resolveFeatureInstance, resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { useI18n } from '../../i18n/i18nContext'

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
    setAllConstructionVisible,
    toggleFolderVisible,
    toggleRegionFolderVisible,
    toggleConstructionFolderVisible,
    toggleFolderGrouped,
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
    selectConstructionRoot,
    selectTabsRoot,
    selectClampsRoot,
    selectFeatureFolder,
    selectFeature,
    selectTab,
    selectClamp,
    selectStock,
    hoverFeature,
  } = useProjectStore()
  const features = useMemo(() => resolvedProjectFeatures(project), [project])
  const { t } = useI18n()

  const shellMode = useShellMode()
  const tabletShell = isTabletMode(shellMode)

  const [dragItem, setDragItem] = useState<{ kind: 'feature' | 'folder'; id: string } | null>(null)
  const [featuresCollapsed, setFeaturesCollapsed] = useState(false)
  const [regionsCollapsed, setRegionsCollapsed] = useState(false)
  const [constructionCollapsed, setConstructionCollapsed] = useState(false)
  const [tabsCollapsed, setTabsCollapsed] = useState(false)
  const [clampsCollapsed, setClampsCollapsed] = useState(false)
  const dragOverTarget = useRef<{ kind: 'features' | 'folder' | 'feature'; id?: string } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const pendingScrollFeatureId = useRef<string | null>(null)

  // #276: selection can originate outside the tree (sketch canvas click, sketch-edit
  // entry) — bring the primary selected row into view. Keyed on selectedNode's object
  // identity, not the feature id: every selection action builds a fresh selectedNode
  // (hover does not), so re-selecting the same feature — or another member of a
  // grouped folder, which keeps the same primary id — still scrolls. block:'nearest'
  // keeps clicks on an already-visible row from scrolling. If the row is hidden
  // inside a collapsed folder or section, expand it (revealFeatureFolder skips undo
  // history) and let the follow-up effect below scroll once the row is rendered.
  const selectedNode = selection.selectedNode
  useEffect(() => {
    pendingScrollFeatureId.current = null
    if (selectedNode?.type !== 'feature') return
    const row = panelRef.current?.querySelector(`[data-feature-id="${CSS.escape(selectedNode.featureId)}"]`)
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      return
    }
    const { project: currentProject, revealFeatureFolder } = useProjectStore.getState()
    const feature = resolveFeatureInstance(currentProject, selectedNode.featureId)
    if (!feature) return
    pendingScrollFeatureId.current = feature.id
    const section = sectionForOperation(feature.operation)
    // Intentional setState-in-effect: the effect reacts to an external event
    // (store selection change) and must expand the hidden row's section before
    // the deferred scroll below can find it. Fires only on the collapsed path.
    if (section === 'regions') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRegionsCollapsed(false)
    } else if (section === 'construction') {
      setConstructionCollapsed(false)
    } else {
      setFeaturesCollapsed(false)
    }
    if (feature.folderId) {
      revealFeatureFolder(feature.folderId)
    }
  }, [selectedNode])

  // Deferred half of the reveal-then-scroll: runs after every commit and scrolls
  // once the newly expanded row is actually in the DOM.
  useEffect(() => {
    const id = pendingScrollFeatureId.current
    if (!id) return
    const row = panelRef.current?.querySelector(`[data-feature-id="${CSS.escape(id)}"]`)
    if (!row) return
    pendingScrollFeatureId.current = null
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })

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

    // P2-1: skip move when dragging a feature out of its grouped folder (store would reject it).
    // Reordering within the same grouped folder stays allowed.
    if (dragItem.kind === 'feature') {
      const sourceFeature = features.find((f) => f.id === dragItem.id)
      const sourceFolder = sourceFeature?.folderId
        ? project.featureFolders.find((f) => f.id === sourceFeature.folderId)
        : null
      if (sourceFeature && sourceFolder?.grouped) {
        let targetFolder: string | null = null
        if (target.kind === 'features') {
          targetFolder = null
        } else if (target.kind === 'folder') {
          targetFolder = target.id ?? null
        } else if (target.kind === 'feature' && target.id) {
          const targetFeature = features.find((f) => f.id === target.id)
          targetFolder = targetFeature?.folderId ?? null
        }
        if (targetFolder !== sourceFeature.folderId) {
          setDragItem(null)
          dragOverTarget.current = null
          return
        }
      }
    }

    if (dragItem.kind === 'feature') {
      if (target.kind === 'features') {
        moveFeatureTreeFeature(dragItem.id, null)
      } else if (target.kind === 'folder' && target.id) {
        moveFeatureTreeFeature(dragItem.id, target.id)
      } else if (target.kind === 'feature' && target.id && target.id !== dragItem.id) {
        const targetFeature = features.find((feature) => feature.id === target.id)
        if (targetFeature) {
          moveFeatureTreeFeature(dragItem.id, targetFeature.folderId ?? null, targetFeature.id)
        }
      }
    } else if (dragItem.kind === 'folder') {
      const draggedEntry: { type: 'folder'; folderId: string } = { type: 'folder', folderId: dragItem.id }
      const rootEntries = project.featureTree.filter((entry) => (
        entry.type === 'folder' ||
        (entry.type === 'feature' && features.some((feature) => feature.id === entry.featureId && feature.folderId === null))
      ))
      const filteredEntries = rootEntries.filter((entry) => !(entry.type === 'folder' && entry.folderId === dragItem.id))
      let insertIndex = filteredEntries.length

      if (target.kind === 'folder' && target.id && target.id !== dragItem.id) {
        insertIndex = filteredEntries.findIndex((entry) => entry.type === 'folder' && entry.folderId === target.id)
      } else if (target.kind === 'feature' && target.id) {
        const targetFeature = features.find((feature) => feature.id === target.id)
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

  function handleMoveFeature(featureId: string, direction: -1 | 1) {
    const feature = features.find((f) => f.id === featureId)
    if (!feature) return

    if (feature.folderId === null) {
      const featureSection = sectionForOperation(feature.operation)
      const sectionEntries = project.featureTree.filter((entry) => {
        if (entry.type === 'folder') {
          const folder = project.featureFolders.find((f) => f.id === entry.folderId)
          return (folder?.section ?? 'features') === featureSection
        }
        const f = features.find((item) => item.id === entry.featureId)
        return sectionForOperation(f?.operation) === featureSection
      })
      const entryIndex = sectionEntries.findIndex((e) => e.type === 'feature' && e.featureId === featureId)
      const swapIndex = entryIndex + direction
      if (entryIndex === -1 || swapIndex < 0 || swapIndex >= sectionEntries.length) return

      const fullTree = [...project.featureTree]
      const aIdx = fullTree.findIndex((e) => e === sectionEntries[entryIndex])
      const bIdx = fullTree.findIndex((e) => e === sectionEntries[swapIndex])
      if (aIdx === -1 || bIdx === -1) return
      ;[fullTree[aIdx], fullTree[bIdx]] = [fullTree[bIdx], fullTree[aIdx]]
      reorderFeatureTreeEntries(fullTree)
    } else {
      const siblings = features.filter((f) =>
        f.folderId === feature.folderId && sectionForOperation(f.operation) === sectionForOperation(feature.operation)
      )
      const sibIndex = siblings.findIndex((f) => f.id === featureId)
      if (sibIndex === -1) return

      if (direction === -1 && sibIndex > 0) {
        moveFeatureTreeFeature(featureId, feature.folderId, siblings[sibIndex - 1].id)
      } else if (direction === 1 && sibIndex < siblings.length - 1) {
        if (sibIndex + 2 < siblings.length) {
          moveFeatureTreeFeature(featureId, feature.folderId, siblings[sibIndex + 2].id)
        } else {
          moveFeatureTreeFeature(featureId, feature.folderId)
        }
      }
    }
  }

  function handleMoveFolder(folderId: string, direction: -1 | 1) {
    const folder = project.featureFolders.find((f) => f.id === folderId)
    if (!folder) return

    const section = folder.section ?? 'features'
    const sectionEntries = project.featureTree.filter((entry) => {
      if (entry.type === 'folder') {
        const f = project.featureFolders.find((item) => item.id === entry.folderId)
        return (f?.section ?? 'features') === section
      }
      const f = features.find((item) => item.id === entry.featureId)
      return sectionForOperation(f?.operation) === section
    })
    const entryIndex = sectionEntries.findIndex((e) => e.type === 'folder' && e.folderId === folderId)
    const swapIndex = entryIndex + direction
    if (entryIndex === -1 || swapIndex < 0 || swapIndex >= sectionEntries.length) return

    const fullTree = [...project.featureTree]
    const aIdx = fullTree.findIndex((e) => e === sectionEntries[entryIndex])
    const bIdx = fullTree.findIndex((e) => e === sectionEntries[swapIndex])
    if (aIdx === -1 || bIdx === -1) return
    ;[fullTree[aIdx], fullTree[bIdx]] = [fullTree[bIdx], fullTree[aIdx]]
    reorderFeatureTreeEntries(fullTree)
  }

  // Warn if first solid feature is not 'add' — imported STL models may be first.
  // Line features are path geometry and never the base solid, so a Lines-only
  // project is valid with no warning. The store enforces this, but a loaded file
  // could be malformed.
  const machiningFeatures = features.filter(isMachinable)
  const solidFeatures = features.filter(isSolid)
  const regionFeatures = features.filter(isRegion)
  const constructionFeatures = features.filter(isConstruction)
  const featureFolders = project.featureFolders.filter((folder) => (folder.section ?? 'features') === 'features')
  const regionFolders = project.featureFolders.filter((folder) => (folder.section ?? 'features') === 'regions')
  const constructionFolders = project.featureFolders.filter((folder) => (folder.section ?? 'features') === 'construction')
  const firstSolidFeature = solidFeatures[0] ?? null
  const firstFeatureInvalid =
    !!firstSolidFeature
    && firstSolidFeature.operation !== 'add'
    && !(firstSolidFeature.kind === 'stl' && firstSolidFeature.operation === 'model')

  const rootEntries = project.featureTree.filter((entry) => {
    if (entry.type === 'folder') {
      const folder = project.featureFolders.find((item) => item.id === entry.folderId)
      return (folder?.section ?? 'features') === 'features'
    }
    const feature = features.find((item) => item.id === entry.featureId)
    return feature !== undefined && isMachinable(feature)
  })

  const regionRootEntries = project.featureTree.filter((entry) => {
    if (entry.type === 'folder') {
      const folder = project.featureFolders.find((item) => item.id === entry.folderId)
      return (folder?.section ?? 'features') === 'regions'
    }
    const feature = features.find((item) => item.id === entry.featureId)
    return feature?.operation === 'region' && feature.folderId === null
  })

  const constructionRootEntries = project.featureTree.filter((entry) => {
    if (entry.type === 'folder') {
      const folder = project.featureFolders.find((item) => item.id === entry.folderId)
      return (folder?.section ?? 'features') === 'construction'
    }
    const feature = features.find((item) => item.id === entry.featureId)
    return feature !== undefined && isConstruction(feature) && feature.folderId === null
  })

  function renderFeatureRow(featureId: string, depth: number, siblingIndex?: number, siblingCount?: number) {
    const feature = features.find((entry) => entry.id === featureId)
    if (!feature) {
      return null
    }

    const defId = getDefinitionId(feature)
    const linkedCount = getInstanceIdsForDefinition(project, defId).length
    const canMoveUp = tabletShell && siblingIndex !== undefined && siblingIndex > 0
    const canMoveDown = tabletShell && siblingIndex !== undefined && siblingCount !== undefined && siblingIndex < siblingCount - 1
    return (
      <TreeRow
        key={feature.id}
        label={feature.name}
        kind="feature"
        depth={depth}
        isSelected={selection.selectedFeatureIds.includes(feature.id)}
        isGroupSelected={
          selection.groupFolderId != null &&
          feature.folderId === selection.groupFolderId &&
          selection.selectedFeatureIds.includes(feature.id)
        }
        isDragging={dragItem?.kind === 'feature' && dragItem.id === feature.id}
        dataFeatureId={feature.id}
        visible={feature.visible}
        operation={feature.operation}
        profileClosed={feature.sketch.profile.closed}
        regionMaskMode={feature.regionMaskMode ?? 'include'}
        isFirstFeature={feature.id === firstSolidFeature?.id}
        linkedCount={linkedCount}
        onClick={(event) => selectFeature(feature.id, event.metaKey || event.ctrlKey || event.shiftKey, false)}
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
            selectFeature(feature.id, false, false)
          }
          onFeatureContextMenu?.(feature.id, event.clientX, event.clientY)
        }}
        onMoreMenu={tabletShell && onFeatureContextMenu ? (x, y) => {
          if (!selection.selectedFeatureIds.includes(feature.id)) {
            selectFeature(feature.id, false, false)
          }
          onFeatureContextMenu(feature.id, x, y)
        } : undefined}
        onMoveUp={canMoveUp ? () => handleMoveFeature(feature.id, -1) : undefined}
        onMoveDown={canMoveDown ? () => handleMoveFeature(feature.id, 1) : undefined}
        draggable
        onDragStart={() => handleFeatureDragStart(feature.id)}
        onDragEnd={() => setDragItem(null)}
        onDragOver={(event) => handleDragOver(event, { kind: 'feature', id: feature.id })}
        onDrop={handleDrop}
      />
    )
  }

  return (
    <div className="feature-tree-panel" ref={panelRef}>
      <div className="tree-list">
        <TreeRow
          label={t('featureTree.tree.project')}
          kind="project"
          isSelected={selection.selectedNode?.type === 'project'}
          isDragging={false}
          onClick={selectProject}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
        />
        <TreeRow
          label={t('featureTree.tree.grid')}
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
          label={t('featureTree.tree.stock')}
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
          label={t('featureTree.tree.origin')}
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
          label={project.backdrop?.name ?? t('featureTree.tree.backdrop')}
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
          label={t('featureTree.tree.features')}
          kind="features"
          depth={0}
          isSelected={selection.selectedNode?.type === 'features_root'}
          isDragging={false}

          onClick={() => { selectFeaturesRoot(); setFeaturesCollapsed((value) => !value) }}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddFolder={() => addFeatureFolder('features')}
          onShowAll={() => setAllFeaturesVisible(true)}
          onHideAll={() => setAllFeaturesVisible(false)}
          onDragOver={(event) => handleDragOver(event, { kind: 'features' })}
          onDrop={handleDrop}
        />
        {featuresCollapsed ? null : machiningFeatures.length === 0 && featureFolders.length === 0 ? (
          <div className="feature-tree-empty">{t('featureTree.tree.empty.features')}</div>
        ) : (
          <div className="tree-children">
            {firstFeatureInvalid && (
              <div className="feature-tree-warning" role="alert">
                {t('featureTree.tree.warning.firstFeaturePrefix')}<strong>{t('featureTree.operation.add')}</strong>{t('featureTree.tree.warning.firstFeatureSuffix')}
              </div>
            )}
            {rootEntries.map((entry, rootIdx) => {
              if (entry.type === 'feature') {
                return renderFeatureRow(entry.featureId, 1, rootIdx, rootEntries.length)
              }

              const folder = project.featureFolders.find((item) => item.id === entry.folderId)
              if (!folder) {
                return null
              }

              const folderFeatures = features.filter((feature) => feature.folderId === folder.id && isMachinable(feature))
              const folderVisible = folderFeatures.some((f) => f.visible)
              const canMoveFolderUp = tabletShell && rootIdx > 0
              const canMoveFolderDown = tabletShell && rootIdx < rootEntries.length - 1
              return (
                <div key={folder.id}>
                  <TreeRow
                    label={folder.name}
                    kind="folder"
                    depth={1}
                    isSelected={selection.selectedNode?.type === 'folder' && selection.selectedNode.folderId === folder.id}
                    isDragging={dragItem?.kind === 'folder' && dragItem.id === folder.id}

                    visible={folderVisible}
                    onClick={() => { if (folder.grouped) { selectFolderFeatures(folder.id) } else { selectFeatureFolder(folder.id) } }}
                    collapsed={folder.collapsed}
                    onToggleCollapsed={() => updateFeatureFolder(folder.id, { collapsed: !folder.collapsed })}
                    onMouseEnter={() => hoverFeature(null)}
                    onMouseLeave={() => hoverFeature(null)}
                    onSelectAllFeatures={folderFeatures.length > 0 ? () => selectFolderFeatures(folder.id) : undefined}
                    onToggleVisible={folderFeatures.length > 0 ? () => toggleFolderVisible(folder.id) : undefined}
                    grouped={folder.grouped ?? false}
                    onToggleGrouped={() => toggleFolderGrouped(folder.id)}
                    onMoveUp={canMoveFolderUp ? () => handleMoveFolder(folder.id, -1) : undefined}
                    onMoveDown={canMoveFolderDown ? () => handleMoveFolder(folder.id, 1) : undefined}
                    draggable
                    onDragStart={() => handleFolderDragStart(folder.id)}
                    onDragEnd={() => setDragItem(null)}
                    onDragOver={(event) => handleDragOver(event, { kind: 'folder', id: folder.id })}
                    onDrop={handleDrop}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      if (folder.grouped && folderFeatures.length > 0) {
                        if (selection.groupFolderId !== folder.id) {
                          selectFolderFeatures(folder.id)
                        }
                        onFeatureContextMenu?.(folderFeatures[0].id, event.clientX, event.clientY)
                      }
                    }}
                    onMoreMenu={tabletShell && onFeatureContextMenu && folder.grouped && folderFeatures.length > 0 ? (x, y) => {
                      if (selection.groupFolderId !== folder.id) {
                        selectFolderFeatures(folder.id)
                      }
                      onFeatureContextMenu(folderFeatures[0].id, x, y)
                    } : undefined}
                  />
                  {!folder.collapsed ? (
                    <div className="tree-children">
                      {folderFeatures.length === 0 ? (
                        <div className="feature-tree-empty">{t('featureTree.tree.empty.folder')}</div>
                      ) : (
                        folderFeatures.map((feature, fIdx) => renderFeatureRow(feature.id, 2, fIdx, folderFeatures.length))
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
        <TreeRow
          label={t('featureTree.tree.regions')}
          kind="regions"
          depth={0}
          isSelected={selection.selectedNode?.type === 'regions_root'}
          isDragging={false}

          onClick={() => { selectRegionsRoot(); setRegionsCollapsed((value) => !value) }}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddFolder={() => addFeatureFolder('regions')}
          onShowAll={() => setAllRegionsVisible(true)}
          onHideAll={() => setAllRegionsVisible(false)}
        />
        {regionsCollapsed ? null : regionFeatures.length === 0 && regionFolders.length === 0 ? (
          <div className="feature-tree-empty">{t('featureTree.tree.empty.regions')}</div>
        ) : (
          <div className="tree-children">
            {regionRootEntries.map((entry, regionIdx) => {
              if (entry.type === 'feature') {
                return renderFeatureRow(entry.featureId, 1, regionIdx, regionRootEntries.length)
              }

              const folder = project.featureFolders.find((item) => item.id === entry.folderId)
              if (!folder) {
                return null
              }

              const folderFeatures = features.filter((feature) => feature.folderId === folder.id && feature.operation === 'region')
              const folderVisible = folderFeatures.some((f) => f.visible)
              const canMoveFolderUp = tabletShell && regionIdx > 0
              const canMoveFolderDown = tabletShell && regionIdx < regionRootEntries.length - 1
              return (
                <div key={`regions-${folder.id}`}>
                  <TreeRow
                    label={folder.name}
                    kind="folder"
                    depth={1}
                    isSelected={selection.selectedNode?.type === 'folder' && selection.selectedNode.folderId === folder.id}
                    isDragging={dragItem?.kind === 'folder' && dragItem.id === folder.id}

                    visible={folderVisible}
                    onClick={() => { if (folder.grouped) { selectFolderFeatures(folder.id) } else { selectFeatureFolder(folder.id) } }}
                    collapsed={folder.collapsed}
                    onToggleCollapsed={() => updateFeatureFolder(folder.id, { collapsed: !folder.collapsed })}
                    onMouseEnter={() => hoverFeature(null)}
                    onMouseLeave={() => hoverFeature(null)}
                    onSelectAllFeatures={folderFeatures.length > 0 ? () => selectFeatures(folderFeatures.map((feature) => feature.id)) : undefined}
                    onToggleVisible={folderFeatures.length > 0 ? () => toggleRegionFolderVisible(folder.id) : undefined}
                    grouped={folder.grouped ?? false}
                    onToggleGrouped={() => toggleFolderGrouped(folder.id)}
                    onMoveUp={canMoveFolderUp ? () => handleMoveFolder(folder.id, -1) : undefined}
                    onMoveDown={canMoveFolderDown ? () => handleMoveFolder(folder.id, 1) : undefined}
                    draggable
                    onDragStart={() => handleFolderDragStart(folder.id)}
                    onDragEnd={() => setDragItem(null)}
                    onDragOver={(event) => handleDragOver(event, { kind: 'folder', id: folder.id })}
                    onDrop={handleDrop}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      if (folder.grouped && folderFeatures.length > 0) {
                        if (selection.groupFolderId !== folder.id) {
                          selectFolderFeatures(folder.id)
                        }
                        onFeatureContextMenu?.(folderFeatures[0].id, event.clientX, event.clientY)
                      }
                    }}
                    onMoreMenu={tabletShell && onFeatureContextMenu && folder.grouped && folderFeatures.length > 0 ? (x, y) => {
                      if (selection.groupFolderId !== folder.id) {
                        selectFolderFeatures(folder.id)
                      }
                      onFeatureContextMenu(folderFeatures[0].id, x, y)
                    } : undefined}
                  />
                  {!folder.collapsed ? (
                    <div className="tree-children">
                      {folderFeatures.length === 0 ? (
                        <div className="feature-tree-empty">{t('featureTree.tree.empty.folder')}</div>
                      ) : (
                        folderFeatures.map((feature, fIdx) => renderFeatureRow(feature.id, 2, fIdx, folderFeatures.length))
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
        <TreeRow
          label={t('featureTree.tree.construction')}
          kind="constructions"
          depth={0}
          isSelected={selection.selectedNode?.type === 'construction_root'}
          isDragging={false}

          onClick={() => { selectConstructionRoot(); setConstructionCollapsed((value) => !value) }}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddFolder={() => addFeatureFolder('construction')}
          onShowAll={() => setAllConstructionVisible(true)}
          onHideAll={() => setAllConstructionVisible(false)}
        />
        {constructionCollapsed ? null : constructionFeatures.length === 0 && constructionFolders.length === 0 ? (
          <div className="feature-tree-empty">{t('featureTree.tree.empty.construction')}</div>
        ) : (
          <div className="tree-children">
            {constructionRootEntries.map((entry, constructionIdx) => {
              if (entry.type === 'feature') {
                return renderFeatureRow(entry.featureId, 1, constructionIdx, constructionRootEntries.length)
              }

              const folder = project.featureFolders.find((item) => item.id === entry.folderId)
              if (!folder) {
                return null
              }

              const folderFeatures = features.filter((feature) => feature.folderId === folder.id && isConstruction(feature))
              const folderVisible = folderFeatures.some((f) => f.visible)
              const canMoveFolderUp = tabletShell && constructionIdx > 0
              const canMoveFolderDown = tabletShell && constructionIdx < constructionRootEntries.length - 1
              return (
                <div key={`construction-${folder.id}`}>
                  <TreeRow
                    label={folder.name}
                    kind="folder"
                    depth={1}
                    isSelected={selection.selectedNode?.type === 'folder' && selection.selectedNode.folderId === folder.id}
                    isDragging={dragItem?.kind === 'folder' && dragItem.id === folder.id}

                    visible={folderVisible}
                    onClick={() => { if (folder.grouped) { selectFolderFeatures(folder.id) } else { selectFeatureFolder(folder.id) } }}
                    collapsed={folder.collapsed}
                    onToggleCollapsed={() => updateFeatureFolder(folder.id, { collapsed: !folder.collapsed })}
                    onMouseEnter={() => hoverFeature(null)}
                    onMouseLeave={() => hoverFeature(null)}
                    onSelectAllFeatures={folderFeatures.length > 0 ? () => selectFeatures(folderFeatures.map((feature) => feature.id)) : undefined}
                    onToggleVisible={folderFeatures.length > 0 ? () => toggleConstructionFolderVisible(folder.id) : undefined}
                    grouped={folder.grouped ?? false}
                    onToggleGrouped={() => toggleFolderGrouped(folder.id)}
                    onMoveUp={canMoveFolderUp ? () => handleMoveFolder(folder.id, -1) : undefined}
                    onMoveDown={canMoveFolderDown ? () => handleMoveFolder(folder.id, 1) : undefined}
                    draggable
                    onDragStart={() => handleFolderDragStart(folder.id)}
                    onDragEnd={() => setDragItem(null)}
                    onDragOver={(event) => handleDragOver(event, { kind: 'folder', id: folder.id })}
                    onDrop={handleDrop}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      if (folder.grouped && folderFeatures.length > 0) {
                        if (selection.groupFolderId !== folder.id) {
                          selectFolderFeatures(folder.id)
                        }
                        onFeatureContextMenu?.(folderFeatures[0].id, event.clientX, event.clientY)
                      }
                    }}
                    onMoreMenu={tabletShell && onFeatureContextMenu && folder.grouped && folderFeatures.length > 0 ? (x, y) => {
                      if (selection.groupFolderId !== folder.id) {
                        selectFolderFeatures(folder.id)
                      }
                      onFeatureContextMenu(folderFeatures[0].id, x, y)
                    } : undefined}
                  />
                  {!folder.collapsed ? (
                    <div className="tree-children">
                      {folderFeatures.length === 0 ? (
                        <div className="feature-tree-empty">{t('featureTree.tree.empty.folder')}</div>
                      ) : (
                        folderFeatures.map((feature, fIdx) => renderFeatureRow(feature.id, 2, fIdx, folderFeatures.length))
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
        <TreeRow
          label={t('featureTree.tree.tabs')}
          kind="tabs"
          depth={0}
          isSelected={selection.selectedNode?.type === 'tabs_root'}
          isDragging={false}

          onClick={() => { selectTabsRoot(); setTabsCollapsed((value) => !value) }}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddTab={() => startAddTabPlacement()}
          onShowAll={() => setAllTabsVisible(true)}
          onHideAll={() => setAllTabsVisible(false)}
        />
        {tabsCollapsed ? null : project.tabs.length === 0 ? (
          <div className="feature-tree-empty">{t('featureTree.tree.empty.tabs')}</div>
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
                onMoreMenu={tabletShell && onTabContextMenu ? (x, y) => {
                  selectTab(tab.id)
                  onTabContextMenu(tab.id, x, y)
                } : undefined}
              />
            ))}
          </div>
        )}
        <TreeRow
          label={t('featureTree.tree.clamps')}
          kind="clamps"
          depth={0}
          isSelected={selection.selectedNode?.type === 'clamps_root'}
          isDragging={false}

          onClick={() => { selectClampsRoot(); setClampsCollapsed((value) => !value) }}
          onMouseEnter={() => hoverFeature(null)}
          onMouseLeave={() => hoverFeature(null)}
          onAddClamp={() => startAddClampPlacement()}
          onShowAll={() => setAllClampsVisible(true)}
          onHideAll={() => setAllClampsVisible(false)}
        />
        {clampsCollapsed ? null : project.clamps.length === 0 ? (
          <div className="feature-tree-empty">{t('featureTree.tree.empty.clamps')}</div>
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
                onMoreMenu={tabletShell && onClampContextMenu ? (x, y) => {
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
  kind: 'project' | 'grid' | 'stock' | 'origin' | 'backdrop' | 'features' | 'regions' | 'constructions' | 'tabs' | 'clamps' | 'folder' | 'feature' | 'tab' | 'clamp'
  depth?: number
  isSelected: boolean
  isDragging: boolean
  dataFeatureId?: string
  visible?: boolean
  operation?: FeatureOperation
  profileClosed?: boolean
  regionMaskMode?: RegionMaskMode
  isFirstFeature?: boolean
  linkedCount?: number
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onToggleVisible?: () => void
  isGroupSelected?: boolean
  grouped?: boolean
  onToggleGrouped?: () => void
  onSelectAllFeatures?: () => void
  onToggleOperation?: (operation: FeatureOperation) => void
  onAddFolder?: () => void
  onAddTab?: () => void
  onAddClamp?: () => void
  onShowAll?: () => void
  onHideAll?: () => void
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void
  onEditEntry?: () => void
  onMoreMenu?: (x: number, y: number) => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  collapsed?: boolean
  onToggleCollapsed?: () => void
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
  dataFeatureId,
  visible,
  operation,
  profileClosed = true,
  regionMaskMode,
  isFirstFeature = false,
  linkedCount,
  onClick,
  onMouseEnter,
  onMouseLeave,
  isGroupSelected,
  grouped,
  onToggleGrouped,
  onToggleVisible,
  onSelectAllFeatures,
  onToggleOperation,
  onAddFolder,
  onAddTab,
  onAddClamp,
  onShowAll,
  onHideAll,
  onContextMenu,
  onEditEntry,
  onMoreMenu,
  onMoveUp,
  onMoveDown,
  collapsed,
  onToggleCollapsed,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: TreeRowProps) {
  // The first solid feature must be Add (base-solid rule), but it can be
  // converted to a non-solid role (Line, Region, Construction). Only Subtract
  // is disabled on that row — the rest of the menu is available.
  // Open profiles (line / construction) get a reduced menu of Line +
  // Construction; closed profiles get the full menu including Line.
  const subtractDisabled = isFirstFeature && operation === 'add'
  const openProfileOperations = (operation === 'line' && !profileClosed) || (operation === 'construction' && !profileClosed)

  // Popup menu state for operation selector — stores viewport position for fixed positioning
  const operationBtnRef = useRef<HTMLButtonElement>(null)
  const [operationMenuPos, setOperationMenuPos] = useState<{ top: number; left: number } | null>(null)
  const gripDragRef = useRef<{ lastSwapY: number; pointerId: number } | null>(null)
  const hasGrip = onMoveUp || onMoveDown
  const { t } = useI18n()

  const showAllLabel = kind === 'features' ? t('featureTree.treeRow.showAll.features')
    : kind === 'regions' ? t('featureTree.treeRow.showAll.regions')
    : kind === 'constructions' ? t('featureTree.treeRow.showAll.construction')
    : kind === 'tabs' ? t('featureTree.treeRow.showAll.tabs')
    : t('featureTree.treeRow.showAll.clamps')
  const hideAllLabel = kind === 'features' ? t('featureTree.treeRow.hideAll.features')
    : kind === 'regions' ? t('featureTree.treeRow.hideAll.regions')
    : kind === 'constructions' ? t('featureTree.treeRow.hideAll.construction')
    : kind === 'tabs' ? t('featureTree.treeRow.hideAll.tabs')
    : t('featureTree.treeRow.hideAll.clamps')

  return (
    <div
      className={[
        'tree-row',
        `tree-row--${kind}`,
        depth > 0 ? 'tree-row--nested' : '',
        depth > 1 ? 'tree-row--deep' : '',
        isSelected ? 'tree-row--selected' : '',
        isGroupSelected ? 'tree-row--group-selected' : '',
        isDragging ? 'tree-row--dragging' : '',
        kind === 'feature' && operation === 'region' ? 'tree-row--region' : '',
        kind === 'feature' && operation === 'construction' ? 'tree-row--construction' : '',
      ].join(' ')}
      data-feature-id={dataFeatureId}
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
      style={{ paddingLeft: `${depth * 8}px` }}
    >
      <span className={`tree-branch tree-branch--${kind}`}>
        {kind === 'folder' ? (
          <>
            {onToggleCollapsed ? (
              <button
                type="button"
                className="tree-folder-chevron"
                onClick={(e) => { e.stopPropagation(); onToggleCollapsed() }}
                aria-label={collapsed ? t('featureTree.treeRow.folder.expand') : t('featureTree.treeRow.folder.collapse')}
                tabIndex={0}
              >
                <Icon id="chevron-down" className={`tree-chevron-icon${collapsed ? ' tree-chevron-icon--collapsed' : ''}`} size={14} />
              </button>
            ) : null}
            <Icon id="folder" className="tree-icon--folder" />
          </>
        ) : (
          kind === 'project'
            ? t('featureTree.tree.branch.project')
            : kind === 'grid'
              ? t('featureTree.tree.branch.grid')
              : kind === 'stock'
                ? t('featureTree.tree.branch.stock')
                : kind === 'origin'
                  ? t('featureTree.tree.branch.origin')
                : kind === 'backdrop'
                  ? t('featureTree.tree.branch.backdrop')
                : kind === 'features'
                  ? t('featureTree.tree.branch.features')
                  : kind === 'regions'
                    ? t('featureTree.tree.branch.regions')
                  : kind === 'constructions'
                    ? t('featureTree.tree.branch.construction')
                  : kind === 'tabs'
                    ? t('featureTree.tree.branch.tabs')
                  : kind === 'clamps'
                    ? t('featureTree.tree.branch.clamps')
                    : kind === 'tab'
                      ? t('featureTree.tree.branch.tab')
                    : kind === 'clamp'
                      ? t('featureTree.tree.branch.clamp')
                      : t('featureTree.tree.branch.feature')
        )}
      </span>
      {hasGrip ? (
        <button
          type="button"
          className="tree-action-btn tree-drag-grip"
          title={t('featureTree.treeRow.grip.dragToReorder')}
          aria-label={t('featureTree.treeRow.grip.dragToReorder')}
          onPointerDown={(e) => {
            if (e.pointerType !== 'touch') return
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            gripDragRef.current = { lastSwapY: e.clientY, pointerId: e.pointerId }
          }}
          onPointerMove={(e) => {
            const state = gripDragRef.current
            if (!state || state.pointerId !== e.pointerId) return
            e.preventDefault()
            const delta = e.clientY - state.lastSwapY
            const threshold = 36
            if (delta > threshold && onMoveDown) {
              onMoveDown()
              state.lastSwapY = e.clientY
            } else if (delta < -threshold && onMoveUp) {
              onMoveUp()
              state.lastSwapY = e.clientY
            }
          }}
          onPointerUp={(e) => {
            gripDragRef.current = null
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          }}
          onPointerCancel={(e) => {
            gripDragRef.current = null
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          }}
        >
          <svg viewBox="0 0 14 14" width="12" height="12" focusable="false" aria-hidden="true" style={{ display: 'block' }}>
            <circle cx="5" cy="3.5" r="1.2" fill="currentColor" /><circle cx="9" cy="3.5" r="1.2" fill="currentColor" />
            <circle cx="5" cy="7" r="1.2" fill="currentColor" /><circle cx="9" cy="7" r="1.2" fill="currentColor" />
            <circle cx="5" cy="10.5" r="1.2" fill="currentColor" /><circle cx="9" cy="10.5" r="1.2" fill="currentColor" />
          </svg>
        </button>
      ) : null}
      <div className="tree-label-wrap">
        <span className="tree-label" title={label}>{label}</span>
        {kind === 'feature' && operation === 'region' ? (
          <span
            className={`tree-region-badge${regionMaskMode === 'exclude' ? ' tree-region-badge--exclude' : ''}`}
            title={
              regionMaskMode === 'exclude'
                ? t('featureTree.treeRow.badge.region.excludeTooltip')
                : t('featureTree.treeRow.badge.region.includeTooltip')
            }
          >
            {regionMaskMode === 'exclude' ? t('featureTree.treeRow.badge.region.exclude') : t('featureTree.treeRow.badge.region.include')}
          </span>
        ) : null}
        {kind === 'feature' && operation === 'construction' ? (
          <span
            className="tree-construction-badge"
            title={t('featureTree.treeRow.badge.construction.tooltip')}
          >
            {t('featureTree.treeRow.badge.construction.label')}
          </span>
        ) : null}
        {kind === 'feature' && linkedCount && linkedCount > 1 ? (
          <span
            className="tree-linked-badge"
            title={t('featureTree.treeRow.badge.linked', { count: linkedCount })}
          >
            <Icon id="link" className="tree-icon--link" />
          </span>
        ) : null}
      </div>
      <div className="tree-row-actions">
        {(kind === 'features' || kind === 'regions' || kind === 'constructions' || kind === 'tabs' || kind === 'clamps') && onShowAll ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onShowAll()
            }}
            title={showAllLabel}
            aria-label={showAllLabel}
          >
            <Icon id="eye" />
          </button>
        ) : null}
        {(kind === 'features' || kind === 'regions' || kind === 'constructions' || kind === 'tabs' || kind === 'clamps') && onHideAll ? (
          <button
            type="button"
            className="tree-action-btn tree-action-btn--muted"
            onClick={(event) => {
              event.stopPropagation()
              onHideAll()
            }}
            title={hideAllLabel}
            aria-label={hideAllLabel}
          >
            <Icon id="eye-off" />
          </button>
        ) : null}
        {(kind === 'features' || kind === 'regions' || kind === 'constructions') && onAddFolder ? (
          <button
            type="button"
            className="tree-action-btn"
            onClick={(event) => {
              event.stopPropagation()
              onAddFolder()
            }}
            title={kind === 'regions' ? t('featureTree.treeRow.addFolder.regions') : kind === 'constructions' ? t('featureTree.treeRow.addFolder.construction') : t('featureTree.treeRow.addFolder.default')}
            aria-label={kind === 'regions' ? t('featureTree.treeRow.addFolder.regions') : kind === 'constructions' ? t('featureTree.treeRow.addFolder.construction') : t('featureTree.treeRow.addFolder.default')}
          >
            <Icon id="folder" />
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
            title={t('featureTree.treeRow.addEntry.tab')}
            aria-label={t('featureTree.treeRow.addEntry.tab')}
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
            title={t('featureTree.treeRow.addEntry.clamp')}
            aria-label={t('featureTree.treeRow.addEntry.clamp')}
          >
            +
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
                operation === 'model' ? 'tree-action-btn--locked' : '',
              ].join(' ')}
              onClick={(event) => {
                event.stopPropagation()
                if (operation !== 'model') {
                  const rect = operationBtnRef.current?.getBoundingClientRect()
                  if (rect) {
                    setOperationMenuPos(
                      operationMenuPos
                        ? null
                        : { top: rect.bottom + 4, left: rect.left + rect.width / 2 }
                    )
                  }
                }
              }}
              title={
                operation === 'line'
                  ? (profileClosed
                    ? t('featureTree.treeRow.operation.lineClosedTooltip')
                    : t('featureTree.treeRow.operation.lineOpenTooltip'))
                  : operation === 'model'
                  ? t('featureTree.treeRow.operation.modelTooltip')
                  : operation === 'add'
                  ? subtractDisabled
                    ? t('featureTree.treeRow.operation.addFirstSolidTooltip')
                    : t('featureTree.treeRow.operation.addTooltip')
                  : operation === 'subtract'
                  ? t('featureTree.treeRow.operation.subtractTooltip')
                  : operation === 'construction'
                  ? t('featureTree.treeRow.operation.constructionTooltip')
                  : t('featureTree.treeRow.operation.regionTooltip')
              }
              aria-label={
                operation === 'model' ? t('featureTree.treeRow.operation.modelLockedAria')
                : t('featureTree.treeRow.operation.changeAria')
              }
              aria-haspopup={operation === 'model' ? undefined : 'true'}
              aria-expanded={operationMenuPos !== null}
              aria-disabled={operation === 'model'}
            >
              {operation === 'line' ? (
                <svg viewBox="0 0 24 24" className="tree-operation-icon" focusable="false" aria-hidden="true">
                  <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              ) : operation === 'model' ? (
                <svg viewBox="0 0 24 24" className="tree-operation-icon" focusable="false" aria-hidden="true">
                  <path d="M 12 2 L 22 7 L 12 12 L 2 7 L 12 2 Z" />
                  <path d="M 2 7 L 12 12 L 12 22 L 2 17 L 2 7 Z" />
                  <path d="M 22 7 L 12 12 L 12 22 L 22 17 L 22 7 Z" />
                </svg>
              ) : operation === 'construction' ? (
                <svg viewBox="0 0 24 24" className="tree-operation-icon" focusable="false" aria-hidden="true">
                  <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="4 3.4" />
                </svg>
              ) : operation === 'add' ? '+' : operation === 'subtract' ? '−' : (
                <svg viewBox="0 0 24 24" className="tree-operation-icon" focusable="false" aria-hidden="true">
                  <path d="M 3 3 L 21 3 L 21 21 L 3 21 L 3 3 Z" />
                </svg>
              )}
            </button>
            {operationMenuPos && operation !== 'model' ? (
              <>
                <div className="tree-operation-overlay" onClick={() => setOperationMenuPos(null)} />
                <div className="tree-operation-menu" style={{ top: operationMenuPos.top, left: operationMenuPos.left, transform: 'translateX(-50%)' }}>
                  {openProfileOperations ? (
                    <button
                      type="button"
                      className={['tree-operation-menu__item', operation === 'line' ? 'tree-operation-menu__item--active' : ''].join(' ')}
                      onClick={(event) => {
                        event.stopPropagation()
                        onToggleOperation('line')
                        setOperationMenuPos(null)
                      }}
                      title={t('featureTree.treeRow.operation.menuLineOpenTooltip')}
                    >
                      <span className="tree-operation-menu__icon">
                        <svg viewBox="0 0 24 24" width="12" height="12" focusable="false" aria-hidden="true">
                          <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                        </svg>
                      </span>
                      <span>{t('featureTree.operation.line')}</span>
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={['tree-operation-menu__item', operation === 'add' ? 'tree-operation-menu__item--active' : ''].join(' ')}
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleOperation('add')
                          setOperationMenuPos(null)
                        }}
                        title={t('featureTree.treeRow.operation.menuAddTooltip')}
                      >
                        <span className="tree-operation-menu__icon">+</span>
                        <span>{t('featureTree.operation.add')}</span>
                      </button>
                      <button
                        type="button"
                        className={['tree-operation-menu__item', operation === 'subtract' ? 'tree-operation-menu__item--active' : '', subtractDisabled ? 'tree-operation-menu__item--disabled' : ''].join(' ')}
                        disabled={subtractDisabled}
                        onClick={subtractDisabled ? undefined : (event) => {
                          event.stopPropagation()
                          onToggleOperation('subtract')
                          setOperationMenuPos(null)
                        }}
                        title={subtractDisabled ? t('featureTree.treeRow.operation.menuSubtractDisabledTooltip') : t('featureTree.treeRow.operation.menuSubtractTooltip')}
                      >
                        <span className="tree-operation-menu__icon">−</span>
                        <span>{t('featureTree.operation.subtract')}</span>
                      </button>
                      <button
                        type="button"
                        className={['tree-operation-menu__item', operation === 'line' ? 'tree-operation-menu__item--active' : ''].join(' ')}
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleOperation('line')
                          setOperationMenuPos(null)
                        }}
                        title={t('featureTree.treeRow.operation.menuLineClosedTooltip')}
                      >
                        <span className="tree-operation-menu__icon">
                          <svg viewBox="0 0 24 24" width="12" height="12" focusable="false" aria-hidden="true">
                            <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                          </svg>
                        </span>
                        <span>{t('featureTree.operation.line')}</span>
                      </button>
                      <button
                        type="button"
                        className={['tree-operation-menu__item', operation === 'region' ? 'tree-operation-menu__item--active' : ''].join(' ')}
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleOperation('region')
                          setOperationMenuPos(null)
                        }}
                        title={t('featureTree.treeRow.operation.menuRegionTooltip')}
                      >
                        <span className="tree-operation-menu__icon tree-operation-menu__icon--region">□</span>
                        <span>{t('featureTree.operation.region')}</span>
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={['tree-operation-menu__item', operation === 'construction' ? 'tree-operation-menu__item--active' : ''].join(' ')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleOperation('construction')
                      setOperationMenuPos(null)
                    }}
                    title={t('featureTree.treeRow.operation.menuConstructionTooltip')}
                  >
                    <span className="tree-operation-menu__icon tree-operation-menu__icon--construction">
                      <svg viewBox="0 0 24 24" width="12" height="12" focusable="false" aria-hidden="true">
                        <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="4 3.4" />
                      </svg>
                    </span>
                    <span>{t('featureTree.operation.construction')}</span>
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
            title={t('featureTree.treeRow.selectAllInFolder')}
            aria-label={t('featureTree.treeRow.selectAllInFolder')}
          >
            <svg viewBox="0 0 14 14" width="12" height="12" focusable="false" aria-hidden="true" style={{ display: 'block' }}>
              <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 1.5" />
            </svg>
          </button>
        ) : null}
        {onToggleGrouped ? (
          <button
            type="button"
            className={[
              'tree-action-btn',
              grouped ? 'tree-action-btn--grouped' : '',
            ].join(' ')}
            onClick={(event) => {
              event.stopPropagation()
              onToggleGrouped()
            }}
            title={grouped ? t('featureTree.treeRow.ungroup') : t('featureTree.treeRow.group')}
            aria-label={grouped ? t('featureTree.treeRow.ungroup') : t('featureTree.treeRow.group')}
          >
            <Icon id="group" />
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
            title={t('featureTree.treeRow.editSketch')}
            aria-label={t('featureTree.treeRow.editSketch')}
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
            title={t('featureTree.treeRow.moreActions')}
            aria-label={t('featureTree.treeRow.moreActions')}
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
            title={visible ? t('featureTree.treeRow.hideEntry') : t('featureTree.treeRow.showEntry')}
            aria-label={visible ? t('featureTree.treeRow.hideEntry') : t('featureTree.treeRow.showEntry')}
          >
            <Icon id={visible ? 'eye' : 'eye-off'} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
