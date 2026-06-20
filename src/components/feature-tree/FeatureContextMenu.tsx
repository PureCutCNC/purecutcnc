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
import type { FeatureTreeActions } from '../../app/useFeatureTreeActions'
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
  menuFeatureHasLinkedInstances: boolean
  menuQuickOperations: QuickOperation[]
  quickOpsSubmenu: QuickOpsSubmenuPosition | null
  tabletShell: boolean
  primaryId: string | null
  ids: readonly string[]
  actions: FeatureTreeActions
  onOpenQuickOpsSubmenu: (trigger: HTMLElement) => void
  onCloseQuickOpsSubmenu: () => void
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
  menuFeatureHasLinkedInstances,
  menuQuickOperations,
  quickOpsSubmenu,
  tabletShell,
  primaryId,
  ids,
  actions,
  onOpenQuickOpsSubmenu,
  onCloseQuickOpsSubmenu,
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
                        onClick={() => actions.createQuickOperation(menuFeature.id, quickOp)}
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
            onClick={() => actions.editSketch(menuFeature.id)}
            disabled={menuHasMultipleSelection}
            title={menuHasMultipleSelection ? 'Edit Sketch is only available for a single selected feature' : undefined}
          >
            Edit Sketch
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.constraint(menuFeature.id)}
            disabled={menuHasMultipleSelection || menuHasLockedSelection}
          >
            Add Constraint
          </button>
          <div className="feature-context-menu__separator" />
          <button className="feature-context-menu__item" type="button" onClick={() => actions.copyFeature(menuFeature.id)}>
            {menuHasMultipleSelection ? 'Copy Selected' : 'Copy'}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.moveFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
            title={menuHasLockedSelection ? 'Locked features cannot be moved' : undefined}
          >
            {menuHasMultipleSelection ? 'Move Selected' : 'Move'}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.resizeFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            Resize
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.rotateFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            Rotate
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.mirrorFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            Mirror
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.duplicateAsReference(menuFeature.id)}
          >
            {menuHasMultipleSelection ? 'Duplicate Selected as Reference' : 'Duplicate as Reference'}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.duplicateIndependent(menuFeature.id)}
          >
            {menuHasMultipleSelection ? 'Duplicate Selected Independent' : 'Duplicate Independent'}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.makeUnique(menuFeature.id)}
            disabled={!menuFeatureHasLinkedInstances}
            title={!menuFeatureHasLinkedInstances ? 'Feature is already unique' : undefined}
          >
            Make Unique
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.selectLinkedInstances(menuFeature.id)}
            disabled={!menuFeatureHasLinkedInstances}
            title={!menuFeatureHasLinkedInstances ? 'No linked instances' : undefined}
          >
            Select Linked Instances
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.offsetFeatures()}
            disabled={menuHasLockedSelection}
          >
            Offset
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.joinFeatures()}
            disabled={!menuHasMultipleSelection || menuHasLockedSelection}
            title={!menuHasMultipleSelection ? 'Select two or more features to join' : undefined}
          >
            Join
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.cutFeatures()}
            disabled={menuHasLockedSelection}
          >
            Cut
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.useAsStock(primaryId)}
            disabled={!menuCanUseAsStock}
            title={!menuCanUseAsStock ? 'Feature must be an add operation with a closed profile' : undefined}
          >
            Use as Stock
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => actions.deleteFeatures([...ids])}
          >
            {menuHasMultipleSelection ? 'Delete Selected' : 'Delete'}
          </button>
        </>
      ) : menuTab ? (
        <>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.editTab(menuTab.id)}>
            Edit Sketch
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.copyTab(menuTab.id)}>
            Copy
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.moveTab(menuTab.id)}>
            Move
          </button>
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => actions.deleteTab(menuTab.id)}
          >
            Delete
          </button>
        </>
      ) : menuClamp ? (
        <>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.editClamp(menuClamp.id)}>
            Edit Sketch
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.copyClamp(menuClamp.id)}>
            Copy
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.moveClamp(menuClamp.id)}>
            Move
          </button>
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => actions.deleteClamp(menuClamp.id)}
          >
            Delete
          </button>
        </>
      ) : null}
    </div>
  )
}
