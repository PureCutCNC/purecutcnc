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

import type { RefObject } from 'react'
import type { QuickOperation } from '../cam/operationValidity'
import type { MenuPosition, QuickOpsSubmenuPosition } from '../../app/useTreeContextMenu'
import type { Clamp, SketchFeature, Tab } from '../../types/project'

interface FeatureContextMenuProps {
  menuRef: RefObject<HTMLDivElement | null>
  position: MenuPosition | null
  menuFeature: SketchFeature | null
  menuTab: Tab | null
  menuClamp: Clamp | null
  menuHasMultipleSelection: boolean
  menuCanUseAsStock: boolean
  menuHasLockedSelection: boolean
  menuQuickOperations: QuickOperation[]
  quickOpsSubmenu: QuickOpsSubmenuPosition | null
  tabletShell: boolean
  primaryId: string | null
  ids: readonly string[]
  onEditSketch: (featureId: string) => void
  onConstraint: (featureId: string) => void
  onCopyFeature: (featureId: string) => void
  onMoveFeature: (featureId: string) => void
  onResizeFeature: (featureId: string) => void
  onRotateFeature: (featureId: string) => void
  onMirrorFeature: (featureId: string) => void
  onOffsetFeatures: () => void
  onJoinFeatures: () => void
  onCutFeatures: () => void
  onUseAsStock: (featureId: string) => void
  onDeleteFeatures: (featureIds: string[]) => void
  onCreateQuickOperation: (featureId: string, quickOp: QuickOperation) => void
  onOpenQuickOpsSubmenu: (trigger: HTMLElement) => void
  onCloseQuickOpsSubmenu: () => void
  onEditTab: (tabId: string) => void
  onCopyTab: (tabId: string) => void
  onMoveTab: (tabId: string) => void
  onDeleteTab: (tabId: string) => void
  onEditClamp: (clampId: string) => void
  onCopyClamp: (clampId: string) => void
  onMoveClamp: (clampId: string) => void
  onDeleteClamp: (clampId: string) => void
}

export function FeatureContextMenu({
  menuRef,
  position,
  menuFeature,
  menuTab,
  menuClamp,
  menuHasMultipleSelection,
  menuCanUseAsStock,
  menuHasLockedSelection,
  menuQuickOperations,
  quickOpsSubmenu,
  tabletShell,
  primaryId,
  ids,
  onEditSketch,
  onConstraint,
  onCopyFeature,
  onMoveFeature,
  onResizeFeature,
  onRotateFeature,
  onMirrorFeature,
  onOffsetFeatures,
  onJoinFeatures,
  onCutFeatures,
  onUseAsStock,
  onDeleteFeatures,
  onCreateQuickOperation,
  onOpenQuickOpsSubmenu,
  onCloseQuickOpsSubmenu,
  onEditTab,
  onCopyTab,
  onMoveTab,
  onDeleteTab,
  onEditClamp,
  onCopyClamp,
  onMoveClamp,
  onDeleteClamp,
}: FeatureContextMenuProps) {
  if (!position || !primaryId || (!menuFeature && !menuTab && !menuClamp)) {
    return null
  }

  return (
    <div
      ref={menuRef}
      className="feature-context-menu"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menuFeature ? (
        <>
          {menuQuickOperations.length > 0 ? (
            <>
              <div
                className="feature-context-menu__submenu-host"
                onMouseEnter={tabletShell ? undefined : (event) => onOpenQuickOpsSubmenu(event.currentTarget)}
                onMouseLeave={tabletShell ? undefined : onCloseQuickOpsSubmenu}
              >
                <button
                  className="feature-context-menu__item feature-context-menu__item--submenu"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={quickOpsSubmenu !== null}
                  onClick={(event) => {
                    // Touch has no hover, so tap toggles the flyout. On desktop
                    // hover drives it and a click just keeps it open.
                    if (tabletShell && quickOpsSubmenu) {
                      onCloseQuickOpsSubmenu()
                    } else {
                      onOpenQuickOpsSubmenu(event.currentTarget)
                    }
                  }}
                >
                  <span>Create operation</span>
                  <span className="feature-context-menu__submenu-caret" aria-hidden="true">›</span>
                </button>
                {quickOpsSubmenu ? (
                  <div
                    className={`feature-context-menu feature-context-menu__submenu feature-context-menu__submenu--${quickOpsSubmenu.side}`}
                    style={{ top: quickOpsSubmenu.top, left: quickOpsSubmenu.left }}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    {menuQuickOperations.map((quickOp) => (
                      <button
                        key={quickOp.kind}
                        className="feature-context-menu__item"
                        type="button"
                        onClick={() => onCreateQuickOperation(menuFeature.id, quickOp)}
                      >
                        {quickOp.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="feature-context-menu__separator" />
            </>
          ) : null}
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onEditSketch(menuFeature.id)}
            disabled={menuHasMultipleSelection}
            title={menuHasMultipleSelection ? 'Edit Sketch is only available for a single selected feature' : undefined}
          >
            Edit Sketch
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onConstraint(menuFeature.id)}
            disabled={menuHasMultipleSelection || menuHasLockedSelection}
          >
            Add Constraint
          </button>
          <div className="feature-context-menu__separator" />
          <button className="feature-context-menu__item" type="button" onClick={() => onCopyFeature(menuFeature.id)}>
            {menuHasMultipleSelection ? 'Copy Selected' : 'Copy'}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onMoveFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
            title={menuHasLockedSelection ? 'Locked features cannot be moved' : undefined}
          >
            {menuHasMultipleSelection ? 'Move Selected' : 'Move'}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onResizeFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            Resize
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onRotateFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            Rotate
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onMirrorFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            Mirror
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onOffsetFeatures()}
            disabled={menuHasLockedSelection}
          >
            Offset
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onJoinFeatures()}
            disabled={!menuHasMultipleSelection || menuHasLockedSelection}
            title={!menuHasMultipleSelection ? 'Select two or more features to join' : undefined}
          >
            Join
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onCutFeatures()}
            disabled={menuHasLockedSelection}
          >
            Cut
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => onUseAsStock(primaryId)}
            disabled={!menuCanUseAsStock}
            title={!menuCanUseAsStock ? 'Feature must be an add operation with a closed profile' : undefined}
          >
            Use as Stock
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => onDeleteFeatures([...ids])}
          >
            {menuHasMultipleSelection ? 'Delete Selected' : 'Delete'}
          </button>
        </>
      ) : menuTab ? (
        <>
          <button className="feature-context-menu__item" type="button" onClick={() => onEditTab(menuTab.id)}>
            Edit Sketch
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => onCopyTab(menuTab.id)}>
            Copy
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => onMoveTab(menuTab.id)}>
            Move
          </button>
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => onDeleteTab(menuTab.id)}
          >
            Delete
          </button>
        </>
      ) : menuClamp ? (
        <>
          <button className="feature-context-menu__item" type="button" onClick={() => onEditClamp(menuClamp.id)}>
            Edit Sketch
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => onCopyClamp(menuClamp.id)}>
            Copy
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => onMoveClamp(menuClamp.id)}>
            Move
          </button>
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => onDeleteClamp(menuClamp.id)}
          >
            Delete
          </button>
        </>
      ) : null}
    </div>
  )
}
