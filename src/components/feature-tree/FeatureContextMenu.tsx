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
import type { MenuPosition, QuickOpsSubmenuPosition, FolderSubmenuPosition, MenuFolderEntry } from '../../app/useTreeContextMenu'
import type { Clamp, SketchFeature, Tab } from '../../types/project'
import { useI18n } from '../../i18n/i18nContext'

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
  menuFeatureFolders: MenuFolderEntry[]
  addToFolderSubmenu: FolderSubmenuPosition | null
  menuSelectionInGroupedFolder: boolean
  menuSelectionSectionsMixed: boolean
  menuSelectionIsGroup: boolean
  tabletShell: boolean
  primaryId: string | null
  ids: readonly string[]
  actions: FeatureTreeActions
  onOpenQuickOpsSubmenu: (trigger: HTMLElement) => void
  onCloseQuickOpsSubmenu: () => void
  onOpenAddToFolderSubmenu: (trigger: HTMLElement) => void
  onCloseAddToFolderSubmenu: () => void
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
  menuFeatureFolders,
  addToFolderSubmenu,
  menuSelectionInGroupedFolder,
  menuSelectionSectionsMixed,
  menuSelectionIsGroup,
  tabletShell,
  primaryId,
  ids,
  actions,
  onOpenQuickOpsSubmenu,
  onCloseQuickOpsSubmenu,
  onOpenAddToFolderSubmenu,
  onCloseAddToFolderSubmenu,
}: FeatureContextMenuProps) {
  const { t } = useI18n()

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
          {menuFeatureHasLinkedInstances ? (
            <>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => actions.makeUnique(menuFeature.id)}
              >
                {t('featureTree.contextMenu.makeUnique')}
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => actions.selectLinkedInstances(menuFeature.id)}
              >
                {t('featureTree.contextMenu.selectLinked')}
              </button>
              <div className="feature-context-menu__separator" />
            </>
          ) : null}
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
                  <span>{t('featureTree.contextMenu.createOperation')}</span>
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
          >
            {t('featureTree.contextMenu.editSketch')}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.constraint(menuFeature.id)}
            disabled={menuHasMultipleSelection || menuHasLockedSelection}
          >
            {t('featureTree.contextMenu.addConstraint')}
          </button>
          <div className="feature-context-menu__separator" />
          <button className="feature-context-menu__item" type="button" onClick={() => actions.copyFeature(menuFeature.id)}>
            {menuSelectionIsGroup ? t('featureTree.contextMenu.copyGroup') : menuHasMultipleSelection ? t('featureTree.contextMenu.copySelected') : t('featureTree.contextMenu.copy')}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.moveFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
            title={menuHasLockedSelection ? t('featureTree.contextMenu.lockedTooltip') : undefined}
          >
            {menuSelectionIsGroup ? t('featureTree.contextMenu.moveGroup') : menuHasMultipleSelection ? t('featureTree.contextMenu.moveSelected') : t('featureTree.contextMenu.move')}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.resizeFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            {t('featureTree.contextMenu.resize')}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.rotateFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            {t('featureTree.contextMenu.rotate')}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.mirrorFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
          >
            {t('featureTree.contextMenu.mirror')}
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.offsetFeatures()}
            disabled={menuHasLockedSelection}
          >
            {t('featureTree.contextMenu.offset')}
          </button>
          <div className="feature-context-menu__separator" />
          {!menuSelectionInGroupedFolder ? (
            <>
              <div
                className="feature-context-menu__submenu-host"
                onMouseEnter={tabletShell || menuSelectionSectionsMixed ? undefined : (event) => onOpenAddToFolderSubmenu(event.currentTarget)}
                onMouseLeave={tabletShell || menuSelectionSectionsMixed ? undefined : onCloseAddToFolderSubmenu}
              >
                <button
                  className="feature-context-menu__item feature-context-menu__item--submenu"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={addToFolderSubmenu !== null}
                  disabled={menuSelectionSectionsMixed}
                  title={menuSelectionSectionsMixed ? t('featureTree.contextMenu.addToFolderMixedTooltip') : undefined}
                  onClick={(event) => {
                    if (menuSelectionSectionsMixed) {
                      return
                    }
                    if (tabletShell && addToFolderSubmenu) {
                      onCloseAddToFolderSubmenu()
                    } else {
                      onOpenAddToFolderSubmenu(event.currentTarget)
                    }
                  }}
                >
                  <span>{t('featureTree.contextMenu.addToFolder')}</span>
                  <span className="feature-context-menu__submenu-caret" aria-hidden="true">›</span>
                </button>
                {addToFolderSubmenu ? (
                  <div
                    className={`feature-context-menu feature-context-menu__submenu feature-context-menu__submenu--${addToFolderSubmenu.side}`}
                    style={{ top: addToFolderSubmenu.top, left: addToFolderSubmenu.left }}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    {menuFeatureFolders.map((folder) => (
                      <button
                        key={folder.id}
                        className="feature-context-menu__item"
                        type="button"
                        onClick={() => actions.assignToFolder([...ids], folder.id)}
                      >
                        {folder.name}
                      </button>
                    ))}
                    <div className="feature-context-menu__separator" />
                    <button
                      className="feature-context-menu__item"
                      type="button"
                      onClick={() => actions.createNewFolderAndAssign([...ids])}
                    >
                      {t('featureTree.contextMenu.createNewFolder')}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="feature-context-menu__separator" />
            </>
          ) : null}
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.groupFeatures()}
            disabled={!menuHasMultipleSelection || menuSelectionSectionsMixed}
            title={
              !menuHasMultipleSelection
                ? t('featureTree.contextMenu.groupDisabledTooltip')
                : menuSelectionSectionsMixed
                  ? t('featureTree.contextMenu.sectionsMixedTooltip')
                  : undefined
            }
          >
            {t('featureTree.contextMenu.group')}
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.joinFeatures()}
            disabled={!menuHasMultipleSelection || menuHasLockedSelection}
            title={!menuHasMultipleSelection ? t('featureTree.contextMenu.joinDisabledTooltip') : undefined}
          >
            {t('featureTree.contextMenu.join')}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.cutFeatures()}
            disabled={menuHasLockedSelection}
          >
            {t('featureTree.contextMenu.cut')}
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => actions.useAsStock(primaryId)}
            disabled={!menuCanUseAsStock}
            title={!menuCanUseAsStock ? t('featureTree.contextMenu.useAsStockDisabledTooltip') : undefined}
          >
            {t('featureTree.contextMenu.useAsStock')}
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => actions.deleteFeatures([...ids])}
          >
            {menuSelectionIsGroup ? t('featureTree.contextMenu.deleteGroup') : menuHasMultipleSelection ? t('featureTree.contextMenu.deleteSelected') : t('featureTree.contextMenu.delete')}
          </button>
        </>
      ) : menuTab ? (
        <>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.editTab(menuTab.id)}>
            {t('featureTree.contextMenu.editSketch')}
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.copyTab(menuTab.id)}>
            {t('featureTree.contextMenu.copy')}
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.moveTab(menuTab.id)}>
            {t('featureTree.contextMenu.move')}
          </button>
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => actions.deleteTab(menuTab.id)}
          >
            {t('featureTree.contextMenu.delete')}
          </button>
        </>
      ) : menuClamp ? (
        <>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.editClamp(menuClamp.id)}>
            {t('featureTree.contextMenu.editSketch')}
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.copyClamp(menuClamp.id)}>
            {t('featureTree.contextMenu.copy')}
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => actions.moveClamp(menuClamp.id)}>
            {t('featureTree.contextMenu.move')}
          </button>
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => actions.deleteClamp(menuClamp.id)}
          >
            {t('featureTree.contextMenu.delete')}
          </button>
        </>
      ) : null}
    </div>
  )
}
