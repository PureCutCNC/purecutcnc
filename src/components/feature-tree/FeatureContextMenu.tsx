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

import { Fragment, type RefObject } from 'react'
import type { QuickOperation } from '../cam/operationValidity'
import type { RemoveFromOperationCandidate } from '../cam/operationTargetLists'
import { camT } from '../cam/camI18n'
import type { FeatureTreeActions } from '../../app/useFeatureTreeActions'
import type { MenuPosition, QuickOpsSubmenuPosition, FolderSubmenuPosition, OperationTargetSubmenuPosition, MenuFolderEntry } from '../../app/useTreeContextMenu'
import type { Clamp, Operation, SketchFeature, Tab } from '../../types/project'
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
  menuAddToOperationCandidates: Operation[]
  menuRemoveFromOperationCandidates: RemoveFromOperationCandidate[]
  addToOperationSubmenu: OperationTargetSubmenuPosition | null
  removeFromOperationSubmenu: OperationTargetSubmenuPosition | null
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
  onOpenAddToOperationSubmenu: (trigger: HTMLElement) => void
  onCloseAddToOperationSubmenu: () => void
  onOpenRemoveFromOperationSubmenu: (trigger: HTMLElement) => void
  onCloseRemoveFromOperationSubmenu: () => void
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
  menuAddToOperationCandidates,
  menuRemoveFromOperationCandidates,
  addToOperationSubmenu,
  removeFromOperationSubmenu,
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
  onOpenAddToOperationSubmenu,
  onCloseAddToOperationSubmenu,
  onOpenRemoveFromOperationSubmenu,
  onCloseRemoveFromOperationSubmenu,
}: FeatureContextMenuProps) {
  const { t } = useI18n()

  // 2D/3D headings only when the submenu actually spans both halves; for a
  // plain sketch feature (2D only) the list stays flat, as before.
  const showQuickOpGroups = menuQuickOperations.some((quickOp) => quickOp.group === '2d')
    && menuQuickOperations.some((quickOp) => quickOp.group === '3d')

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
                    {menuQuickOperations.map((quickOp, index) => {
                      // Group headings only earn their space when the list
                      // actually spans both halves — a lone heading over a
                      // uniform list says nothing (issue #398).
                      const startsGroup = showQuickOpGroups
                        && (index === 0 || menuQuickOperations[index - 1].group !== quickOp.group)
                      return (
                        <Fragment key={quickOp.kind}>
                          {startsGroup ? (
                            <>
                              {index > 0 ? <div className="feature-context-menu__separator" /> : null}
                              <div className="feature-context-menu__group-label">
                                {quickOp.group === '3d'
                                  ? camT('cam.quickOp.group.threeD')
                                  : camT('cam.quickOp.group.twoD')}
                              </div>
                            </>
                          ) : null}
                          <button
                            className="feature-context-menu__item"
                            type="button"
                            onClick={() => actions.createQuickOperation(menuFeature.id, quickOp)}
                          >
                            {quickOp.label}
                          </button>
                        </Fragment>
                      )
                    })}
                  </div>
                ) : null}
              </div>
              <div className="feature-context-menu__separator" />
            </>
          ) : null}
          <div
            className="feature-context-menu__submenu-host"
            onMouseEnter={tabletShell || menuAddToOperationCandidates.length === 0 ? undefined : (event) => onOpenAddToOperationSubmenu(event.currentTarget)}
            onMouseLeave={tabletShell ? undefined : onCloseAddToOperationSubmenu}
          >
            <button
              className="feature-context-menu__item feature-context-menu__item--submenu"
              type="button"
              aria-haspopup="menu"
              aria-expanded={addToOperationSubmenu !== null}
              disabled={menuAddToOperationCandidates.length === 0}
              title={menuAddToOperationCandidates.length === 0 ? t('featureTree.contextMenu.addToOperationEmptyTooltip') : undefined}
              onClick={(event) => {
                if (menuAddToOperationCandidates.length === 0) {
                  return
                }
                if (tabletShell && addToOperationSubmenu) {
                  onCloseAddToOperationSubmenu()
                } else {
                  onOpenAddToOperationSubmenu(event.currentTarget)
                }
              }}
            >
              <span>{t('featureTree.contextMenu.addToOperation')}</span>
              <span className="feature-context-menu__submenu-caret" aria-hidden="true">›</span>
            </button>
            {addToOperationSubmenu && menuAddToOperationCandidates.length > 0 ? (
              <div
                className={`feature-context-menu feature-context-menu__submenu feature-context-menu__submenu--${addToOperationSubmenu.side}`}
                style={{ top: addToOperationSubmenu.top, left: addToOperationSubmenu.left }}
                onContextMenu={(event) => event.preventDefault()}
              >
                {menuAddToOperationCandidates.map((operation) => (
                  <button
                    key={operation.id}
                    className="feature-context-menu__item"
                    type="button"
                    onClick={() => actions.addToOperation([...ids], operation.id)}
                  >
                    {operation.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div
            className="feature-context-menu__submenu-host"
            onMouseEnter={tabletShell || menuRemoveFromOperationCandidates.length === 0 ? undefined : (event) => onOpenRemoveFromOperationSubmenu(event.currentTarget)}
            onMouseLeave={tabletShell ? undefined : onCloseRemoveFromOperationSubmenu}
          >
            <button
              className="feature-context-menu__item feature-context-menu__item--submenu"
              type="button"
              aria-haspopup="menu"
              aria-expanded={removeFromOperationSubmenu !== null}
              disabled={menuRemoveFromOperationCandidates.length === 0}
              title={menuRemoveFromOperationCandidates.length === 0 ? t('featureTree.contextMenu.removeFromOperationEmptyTooltip') : undefined}
              onClick={(event) => {
                if (menuRemoveFromOperationCandidates.length === 0) {
                  return
                }
                if (tabletShell && removeFromOperationSubmenu) {
                  onCloseRemoveFromOperationSubmenu()
                } else {
                  onOpenRemoveFromOperationSubmenu(event.currentTarget)
                }
              }}
            >
              <span>{t('featureTree.contextMenu.removeFromOperation')}</span>
              <span className="feature-context-menu__submenu-caret" aria-hidden="true">›</span>
            </button>
            {removeFromOperationSubmenu && menuRemoveFromOperationCandidates.length > 0 ? (
              <div
                className={`feature-context-menu feature-context-menu__submenu feature-context-menu__submenu--${removeFromOperationSubmenu.side}`}
                style={{ top: removeFromOperationSubmenu.top, left: removeFromOperationSubmenu.left }}
                onContextMenu={(event) => event.preventDefault()}
              >
                {menuRemoveFromOperationCandidates.map(({ operation, canRemove }) => (
                  <button
                    key={operation.id}
                    className="feature-context-menu__item"
                    type="button"
                    disabled={!canRemove}
                    title={!canRemove ? t('featureTree.contextMenu.removeWouldInvalidateTooltip') : undefined}
                    onClick={() => actions.removeFromOperation([...ids], operation.id)}
                  >
                    {operation.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="feature-context-menu__separator" />
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
          {!menuHasMultipleSelection ? (
            <button className="feature-context-menu__item" type="button" onClick={() => actions.editTab(menuTab.id)}>
              {t('featureTree.contextMenu.editSketch')}
            </button>
          ) : null}
          {!menuHasMultipleSelection ? (
            <button className="feature-context-menu__item" type="button" onClick={() => actions.copyTab(menuTab.id)}>
              {t('featureTree.contextMenu.copy')}
            </button>
          ) : null}
          {!menuHasMultipleSelection ? (
            <button className="feature-context-menu__item" type="button" onClick={() => actions.moveTab(menuTab.id)}>
              {t('featureTree.contextMenu.move')}
            </button>
          ) : null}
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => menuHasMultipleSelection ? actions.deleteTabs([...ids]) : actions.deleteTab(menuTab.id)}
          >
            {menuHasMultipleSelection ? t('featureTree.contextMenu.deleteSelected') : t('featureTree.contextMenu.delete')}
          </button>
        </>
      ) : menuClamp ? (
        <>
          {!menuHasMultipleSelection ? (
            <button className="feature-context-menu__item" type="button" onClick={() => actions.editClamp(menuClamp.id)}>
              {t('featureTree.contextMenu.editSketch')}
            </button>
          ) : null}
          {!menuHasMultipleSelection ? (
            <button className="feature-context-menu__item" type="button" onClick={() => actions.copyClamp(menuClamp.id)}>
              {t('featureTree.contextMenu.copy')}
            </button>
          ) : null}
          {!menuHasMultipleSelection ? (
            <button className="feature-context-menu__item" type="button" onClick={() => actions.moveClamp(menuClamp.id)}>
              {t('featureTree.contextMenu.move')}
            </button>
          ) : null}
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => menuHasMultipleSelection ? actions.deleteClamps([...ids]) : actions.deleteClamp(menuClamp.id)}
          >
            {menuHasMultipleSelection ? t('featureTree.contextMenu.deleteSelected') : t('featureTree.contextMenu.delete')}
          </button>
        </>
      ) : null}
    </div>
  )
}
