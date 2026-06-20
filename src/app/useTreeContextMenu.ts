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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { validQuickOperationsForFeature, type QuickOperation } from '../components/cam/operationValidity'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { useProjectStore } from '../store/projectStore'
import { getDefinitionId, getInstanceIdsForDefinition } from '../store/helpers/featureDefinitions'
import type { Clamp, Project, SketchFeature, Tab } from '../types/project'

export interface TreeContextMenuState {
  entityType: 'feature' | 'tab' | 'clamp'
  ids: string[]
  primaryId: string
  x: number
  y: number
}

export interface MenuPosition {
  left: number
  top: number
}

export interface QuickOpsSubmenuPosition {
  top: number
  left: number
  side: 'right' | 'left'
}

const CONTEXT_MENU_VIEWPORT_PADDING = 8
const CONTEXT_MENU_INITIAL_WIDTH = 188
const CONTEXT_MENU_INITIAL_HEIGHT = 300

function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): MenuPosition {
  const minLeft = CONTEXT_MENU_VIEWPORT_PADDING
  const minTop = CONTEXT_MENU_VIEWPORT_PADDING
  const maxLeft = Math.max(minLeft, viewportWidth - menuWidth - CONTEXT_MENU_VIEWPORT_PADDING)
  const maxTop = Math.max(minTop, viewportHeight - menuHeight - CONTEXT_MENU_VIEWPORT_PADDING)

  return {
    left: Math.min(Math.max(x, minLeft), maxLeft),
    top: Math.min(Math.max(y, minTop), maxTop),
  }
}

interface UseTreeContextMenuArgs {
  project: Project
}

export function useTreeContextMenu({ project }: UseTreeContextMenuArgs): {
  treeContextMenu: TreeContextMenuState | null
  menuRef: RefObject<HTMLDivElement | null>
  resolvedMenuPosition: MenuPosition | null
  menuFeature: SketchFeature | null
  menuTab: Tab | null
  menuClamp: Clamp | null
  menuQuickOperations: QuickOperation[]
  quickOpsSubmenu: QuickOpsSubmenuPosition | null
  setQuickOpsSubmenu: Dispatch<SetStateAction<QuickOpsSubmenuPosition | null>>
  menuHasMultipleSelection: boolean
  menuCanUseAsStock: boolean
  menuHasLockedSelection: boolean
  menuFeatureHasLinkedInstances: boolean
  openFeatureContextMenu: (featureId: string, x: number, y: number) => void
  openClampContextMenu: (clampId: string, x: number, y: number) => void
  openTabContextMenu: (tabId: string, x: number, y: number) => void
  closeTreeContextMenu: () => void
  openQuickOpsSubmenu: (trigger: HTMLElement) => void
} {
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenuState | null>(null)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const [quickOpsSubmenu, setQuickOpsSubmenu] = useState<QuickOpsSubmenuPosition | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const menuFeature = useMemo(
    () =>
      treeContextMenu?.entityType === 'feature'
        ? project.features.find((feature) => feature.id === treeContextMenu.primaryId) ?? null
        : null,
    [treeContextMenu, project.features]
  )

  const menuClamp = useMemo(
    () =>
      treeContextMenu?.entityType === 'clamp'
        ? project.clamps.find((clamp) => clamp.id === treeContextMenu.primaryId) ?? null
        : null,
    [treeContextMenu, project.clamps]
  )

  const menuTab = useMemo(
    () =>
      treeContextMenu?.entityType === 'tab'
        ? project.tabs.find((tab) => tab.id === treeContextMenu.primaryId) ?? null
        : null,
    [treeContextMenu, project.tabs]
  )

  const menuQuickOperations = useMemo<QuickOperation[]>(
    () =>
      menuFeature && (treeContextMenu?.ids.length ?? 1) <= 1
        ? validQuickOperationsForFeature(project, menuFeature.id)
        : [],
    [menuFeature, treeContextMenu, project]
  )

  const openFeatureContextMenu = useCallback((featureId: string, x: number, y: number) => {
    const nextSelection = useProjectStore.getState().selection
    const featureIds = nextSelection.selectedFeatureIds.includes(featureId)
      ? nextSelection.selectedFeatureIds
      : [featureId]
    setMenuPosition(null)
    setTreeContextMenu({ entityType: 'feature', ids: featureIds, primaryId: featureId, x, y })
  }, [])

  const openClampContextMenu = useCallback((clampId: string, x: number, y: number) => {
    setMenuPosition(null)
    setTreeContextMenu({ entityType: 'clamp', ids: [clampId], primaryId: clampId, x, y })
  }, [])

  const openTabContextMenu = useCallback((tabId: string, x: number, y: number) => {
    setMenuPosition(null)
    setTreeContextMenu({ entityType: 'tab', ids: [tabId], primaryId: tabId, x, y })
  }, [])

  const closeTreeContextMenu = useCallback(() => {
    setTreeContextMenu(null)
    setMenuPosition(null)
    setQuickOpsSubmenu(null)
  }, [])

  const openQuickOpsSubmenu = useCallback((trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect()
    const openLeft = rect.right + 200 > window.innerWidth
    setQuickOpsSubmenu({
      top: rect.top,
      left: openLeft ? rect.left : rect.right,
      side: openLeft ? 'left' : 'right',
    })
  }, [])

  useOutsideDismiss({
    open: treeContextMenu !== null,
    refs: menuRef,
    target: 'window',
    onDismiss: closeTreeContextMenu,
  })

  const menuHasMultipleSelection = treeContextMenu?.entityType === 'feature' && (treeContextMenu?.ids.length ?? 0) > 1
  const menuCanUseAsStock =
    treeContextMenu?.entityType === 'feature' &&
    !menuHasMultipleSelection &&
    menuFeature !== null &&
    menuFeature.operation === 'add' &&
    menuFeature.sketch.profile.closed === true &&
    menuFeature.kind !== 'text' &&
    menuFeature.kind !== 'stl'
  const menuHasLockedSelection =
    treeContextMenu?.entityType === 'feature' && (treeContextMenu?.ids.some((featureId) =>
      project.features.some((feature) => feature.id === featureId && feature.locked)
    ) ?? false)

  const menuFeatureHasLinkedInstances = useMemo(() => {
    if (treeContextMenu?.entityType !== 'feature' || !menuFeature) return false
    const defId = getDefinitionId(menuFeature)
    return getInstanceIdsForDefinition(project, defId).length > 1
  }, [treeContextMenu, menuFeature, project])

  const fallbackMenuPosition = treeContextMenu && typeof window !== 'undefined'
    ? clampMenuPosition(
        treeContextMenu.x,
        treeContextMenu.y,
        CONTEXT_MENU_INITIAL_WIDTH,
        CONTEXT_MENU_INITIAL_HEIGHT,
        window.innerWidth,
        window.innerHeight,
      )
    : null
  const resolvedMenuPosition = menuPosition ?? fallbackMenuPosition

  const updateTreeContextMenuPosition = useCallback(() => {
    if (!treeContextMenu || !menuRef.current || typeof window === 'undefined') {
      return
    }

    const rect = menuRef.current.getBoundingClientRect()
    const nextPosition = clampMenuPosition(
      treeContextMenu.x,
      treeContextMenu.y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    )
    setMenuPosition((previous) => (
      previous?.left === nextPosition.left && previous.top === nextPosition.top
        ? previous
        : nextPosition
    ))
  }, [treeContextMenu])

  useLayoutEffect(() => {
    updateTreeContextMenuPosition()
  }, [
    updateTreeContextMenuPosition,
    menuFeature,
    menuTab,
    menuClamp,
    menuHasMultipleSelection,
    menuCanUseAsStock,
    menuHasLockedSelection,
  ])

  useEffect(() => {
    if (!treeContextMenu) {
      return
    }

    window.addEventListener('resize', updateTreeContextMenuPosition)
    return () => window.removeEventListener('resize', updateTreeContextMenuPosition)
  }, [treeContextMenu, updateTreeContextMenuPosition])

  return {
    treeContextMenu,
    menuRef,
    resolvedMenuPosition,
    menuFeature,
    menuTab,
    menuClamp,
    menuQuickOperations,
    quickOpsSubmenu,
    setQuickOpsSubmenu,
    menuHasMultipleSelection,
    menuCanUseAsStock,
    menuHasLockedSelection,
    menuFeatureHasLinkedInstances,
    openFeatureContextMenu,
    openClampContextMenu,
    openTabContextMenu,
    closeTreeContextMenu,
    openQuickOpsSubmenu,
  }
}
