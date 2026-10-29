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

import { Fragment, type ReactNode, type RefObject } from 'react'
import type { QuickOperation } from '../cam/operationValidity'
import type { RemoveFromOperationCandidate } from '../cam/operationTargetLists'
import { camT } from '../cam/camI18n'
import type { FeatureTreeActions } from '../../app/useFeatureTreeActions'
import type { MenuPosition, QuickOpsSubmenuPosition, FolderSubmenuPosition, OperationTargetSubmenuPosition, MenuFolderEntry } from '../../app/useTreeContextMenu'
import type { Clamp, Operation, SketchFeature, Tab } from '../../types/project'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import { useProjectStore } from '../../store/projectStore'
import { activeFace, canChangeAuthoringFace, isFaceEditInProgress, projectUsesBothFaces } from '../../store/helpers/activeFace'
import { cannedShapeIsExpandable, cannedShapeLabelKey, getCannedShapeEditor, isCannedFeature } from '../../cannedShapes'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'

/**
 * A disabled menu item's reason is visible text, not only a native `title`:
 * touch has no hover, and a refusal nobody can read is indistinguishable from
 * a broken control. The `title` stays for the desktop pointer.
 */
function menuItemClass(reason?: string, extra?: string): string {
  return [
    'feature-context-menu__item',
    extra ?? '',
    reason ? 'feature-context-menu__item--reason' : '',
  ].filter(Boolean).join(' ')
}

function MenuItemText({ reason, children }: { reason?: string; children: ReactNode }) {
  if (!reason) return <>{children}</>
  return (
    <>
      <span className="feature-context-menu__item-label">{children}</span>
      <span className="feature-context-menu__item-reason">{reason}</span>
    </>
  )
}

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
  /**
   * True when the menu's feature is authored on another face yet an operation
   * on the current face can target it (`useTreeContextMenu` asks the Add menu's
   * own list). The menu is then the normal one with its editable items refused;
   * otherwise it stays the hint-only ghost menu.
   */
  menuFeatureTargetableFromFace: boolean
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
  menuFeatureTargetableFromFace,
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
  const project = useProjectStore((state) => state.project)
  const workspaceFace = useProjectStore((state) => activeFace(state.project))
  const bothFaces = useProjectStore((state) => projectUsesBothFaces(state.project))
  // The face of the workspace, and of a feature, stays put while an edit is
  // in progress — the same rule the header switch follows.
  const faceBusy = useProjectStore(isFaceEditInProgress)
  // Geometry cannot move between a flat face and the unrolled bar, so the
  // change-face entry is left out for an Around selection (issue #395).
  const selectionOnAround = workspaceFace === 'around'
    || project.features.some((feature) => ids.includes(feature.id) && (feature.authoringFace ?? 'top') === 'around')
  // Only a feature that goes through the whole stock can change face (issue
  // #1102 slice L). The entry stays, disabled with the reason, because a
  // control that silently does nothing is worse than none.
  const selectionCanChangeFace = project.features.some(
    (feature) => ids.includes(feature.id) && canChangeAuthoringFace(project, feature),
  )
  // A generated shape owns its geometry through parameters, so join/cut/
  // offset/constraints refuse a selection that contains one, and the menu
  // entries stay (disabled) so the reason can be read (#1112 A2).
  const menuHasCannedSelection = resolveFeatureInstances(project, [...ids]).some(isCannedFeature)
  const menuFeatureIsCanned = isCannedFeature(menuFeature)
  // The generated shape's own two actions: its parameter editor (the same
  // opener Properties uses) and expansion into plain features. Both read the
  // same registry Properties reads, so a kind can never be offered there and
  // missing here (issue #1112 F2).
  const cannedLabelKey = menuFeatureIsCanned ? cannedShapeLabelKey(menuFeature?.canned) : null
  const cannedEditor = menuFeatureIsCanned && menuFeature?.canned
    ? getCannedShapeEditor(menuFeature.canned.kind)
    : null
  const cannedExpandable = menuFeatureIsCanned && cannedShapeIsExpandable(menuFeature?.canned)
  const cannedRefusal = t('sketch.canned.actionRefused')
  const addToOperationReason = menuAddToOperationCandidates.length === 0
    ? t('featureTree.contextMenu.addToOperationEmptyTooltip') : undefined
  const removeFromOperationReason = menuRemoveFromOperationCandidates.length === 0
    ? t('featureTree.contextMenu.removeFromOperationEmptyTooltip') : undefined
  const addToFolderReason = menuSelectionSectionsMixed
    ? t('featureTree.contextMenu.addToFolderMixedTooltip') : undefined
  const groupReason = !menuHasMultipleSelection
    ? t('featureTree.contextMenu.groupDisabledTooltip')
    : menuSelectionSectionsMixed
      ? t('featureTree.contextMenu.sectionsMixedTooltip')
      : undefined
  const useAsStockReason = !menuCanUseAsStock
    ? t('featureTree.contextMenu.useAsStockDisabledTooltip') : undefined

  // 2D/3D headings only when the submenu actually spans both halves; for a
  // plain sketch feature (2D only) the list stays flat, as before.
  const showQuickOpGroups = menuQuickOperations.some((quickOp) => quickOp.group === '2d')
    && menuQuickOperations.some((quickOp) => quickOp.group === '3d')

  if (!position || !primaryId || (!menuFeature && !menuTab && !menuClamp)) {
    return null
  }

  // A feature from the other face is a ghost here: the menu offers the way
  // to its own face and the explicit face change, and no edit (issue #945).
  const menuFeatureFace = menuFeature?.authoringFace ?? 'top'
  const onOtherFace = menuFeature !== null && menuFeatureFace !== workspaceFace
  const switchFaceLabel = t(
    menuFeatureFace === 'bottom'
      ? 'featureTree.face.switchToBottomToEdit'
      : menuFeatureFace === 'around'
        ? 'featureTree.face.switchToAroundToEdit'
        : 'featureTree.face.switchToTopToEdit',
  )
  // When an operation on this face can still cut the feature (a through cut, a
  // model), the menu is the normal one and only its editable items are
  // refused: the face, not the feature, is what has to change (issue #1112
  // F2). The hint stays the reason, so touch can read it without a hover.
  if (menuFeature && onOtherFace && !menuFeatureTargetableFromFace) {
    const ghostCanChangeFace = canChangeAuthoringFace(project, menuFeature)
    const switchFaceReason = faceBusy ? t('appShell.face.busy') : undefined
    const changeGhostFaceReason = menuFeature.locked
      ? t('featureTree.contextMenu.lockedTooltip')
      : faceBusy
        ? t('featureTree.face.changeBusy')
        : ghostCanChangeFace ? undefined : t('featureTree.face.changeNotThrough')
    return (
      <div
        ref={menuRef}
        className="feature-context-menu feature-context-menu--ghost"
        style={position}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button
          className={menuItemClass(switchFaceReason)}
          type="button"
          onClick={() => actions.switchFaceToEdit(menuFeature.id)}
          disabled={faceBusy}
          title={switchFaceReason}
        >
          <MenuItemText reason={switchFaceReason}>
            {switchFaceLabel}
          </MenuItemText>
        </button>
        {/* From Around the change is refused (`requestAuthoringFaceChange`), so
            the entry is left out rather than dead (issue #1015 slice K). */}
        {menuFeatureFace === 'around' || workspaceFace === 'around' ? null : (
          <>
            <div className="feature-context-menu__separator" />
            <button
              className={menuItemClass(changeGhostFaceReason)}
              type="button"
              onClick={() => actions.changeAuthoringFace([menuFeature.id])}
              disabled={menuFeature.locked || faceBusy || !ghostCanChangeFace}
              title={changeGhostFaceReason}
            >
              <MenuItemText reason={changeGhostFaceReason}>
                {t('featureTree.face.changeAuthoringFace')}
              </MenuItemText>
            </button>
          </>
        )}
      </div>
    )
  }

  // Past the ghost menu: every item that edits the feature is refused from
  // here, because its geometry belongs to the face it was drawn on.
  const otherFaceEditingReason = onOtherFace ? switchFaceLabel : undefined
  const otherFaceSwitchReason = faceBusy ? t('appShell.face.busy') : undefined
  const otherFaceOr = (reason: string | undefined) => otherFaceEditingReason ?? reason
  const editSketchReason = otherFaceOr(menuFeatureIsCanned ? cannedRefusal : undefined)
  const editCannedReason = otherFaceEditingReason
    ?? (cannedEditor ? undefined : t('featureTree.properties.canned.editUnavailable'))
  const constraintReason = otherFaceOr(
    menuFeatureIsCanned
      ? cannedRefusal
      : menuHasLockedSelection ? t('featureTree.contextMenu.lockedTooltip') : undefined,
  )
  const moveReason = otherFaceOr(
    menuHasLockedSelection ? t('featureTree.contextMenu.lockedTooltip') : undefined,
  )
  const offsetReason = otherFaceOr(
    menuHasCannedSelection
      ? cannedRefusal
      : menuHasLockedSelection ? t('featureTree.contextMenu.lockedTooltip') : undefined,
  )
  const joinReason = otherFaceOr(
    menuHasCannedSelection
      ? cannedRefusal
      : !menuHasMultipleSelection ? t('featureTree.contextMenu.joinDisabledTooltip') : undefined,
  )
  const cutReason = otherFaceOr(menuHasCannedSelection ? cannedRefusal : undefined)
  const changeFaceReason = otherFaceOr(
    menuHasLockedSelection
      ? t('featureTree.contextMenu.lockedTooltip')
      : faceBusy
        ? t('featureTree.face.changeBusy')
        : selectionCanChangeFace ? undefined : t('featureTree.face.changeNotThrough'),
  )

  return (
    <div
      ref={menuRef}
      className="feature-context-menu"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menuFeature ? (
        <>
          {/* A feature authored on another face can be cut from here, but it
              cannot be edited here: the way to its own face stays the first
              entry, exactly as it is in the ghost menu (#1112 F2). */}
          {onOtherFace ? (
            <>
              <button
                className={menuItemClass(otherFaceSwitchReason)}
                type="button"
                onClick={() => actions.switchFaceToEdit(menuFeature.id)}
                disabled={faceBusy}
                title={otherFaceSwitchReason}
              >
                <MenuItemText reason={otherFaceSwitchReason}>{switchFaceLabel}</MenuItemText>
              </button>
              <div className="feature-context-menu__separator" />
            </>
          ) : null}
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
              className={menuItemClass(addToOperationReason, 'feature-context-menu__item--submenu')}
              type="button"
              aria-haspopup="menu"
              aria-expanded={addToOperationSubmenu !== null}
              disabled={menuAddToOperationCandidates.length === 0}
              title={addToOperationReason}
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
              <span className="feature-context-menu__item-text">
                <span>{t('featureTree.contextMenu.addToOperation')}</span>
                {addToOperationReason
                  ? <span className="feature-context-menu__item-reason">{addToOperationReason}</span>
                  : null}
              </span>
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
              className={menuItemClass(removeFromOperationReason, 'feature-context-menu__item--submenu')}
              type="button"
              aria-haspopup="menu"
              aria-expanded={removeFromOperationSubmenu !== null}
              disabled={menuRemoveFromOperationCandidates.length === 0}
              title={removeFromOperationReason}
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
              <span className="feature-context-menu__item-text">
                <span>{t('featureTree.contextMenu.removeFromOperation')}</span>
                {removeFromOperationReason
                  ? <span className="feature-context-menu__item-reason">{removeFromOperationReason}</span>
                  : null}
              </span>
              <span className="feature-context-menu__submenu-caret" aria-hidden="true">›</span>
            </button>
            {removeFromOperationSubmenu && menuRemoveFromOperationCandidates.length > 0 ? (
              <div
                className={`feature-context-menu feature-context-menu__submenu feature-context-menu__submenu--${removeFromOperationSubmenu.side}`}
                style={{ top: removeFromOperationSubmenu.top, left: removeFromOperationSubmenu.left }}
                onContextMenu={(event) => event.preventDefault()}
              >
                {menuRemoveFromOperationCandidates.map(({ operation, canRemove }) => {
                  const reason = canRemove
                    ? undefined : t('featureTree.contextMenu.removeWouldInvalidateTooltip')
                  return (
                    <button
                      key={operation.id}
                      className={menuItemClass(reason)}
                      type="button"
                      disabled={!canRemove}
                      title={reason}
                      onClick={() => actions.removeFromOperation([...ids], operation.id)}
                    >
                      <MenuItemText reason={reason}>{operation.name}</MenuItemText>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
          <div className="feature-context-menu__separator" />
          {/* A generated shape is edited by its parameters, so its own editor
              leads the edit group; Expand follows Edit sketch, which it is the
              way out of (#1112 F2). A model kind has no plain features to
              expand into, exactly as Properties shows it. */}
          {cannedLabelKey ? (
            <button
              className={menuItemClass(editCannedReason)}
              type="button"
              onClick={() => actions.editCannedShape(menuFeature.id)}
              disabled={!cannedEditor || onOtherFace}
              title={editCannedReason}
            >
              <MenuItemText reason={editCannedReason}>
                {t('featureTree.properties.canned.edit', { shape: t(cannedLabelKey as MessageKey) })}
              </MenuItemText>
            </button>
          ) : null}
          <button
            className={menuItemClass(editSketchReason)}
            type="button"
            onClick={() => actions.editSketch(menuFeature.id)}
            disabled={menuFeatureIsCanned || onOtherFace}
            title={editSketchReason}
          >
            <MenuItemText reason={editSketchReason}>{t('featureTree.contextMenu.editSketch')}</MenuItemText>
          </button>
          {cannedExpandable ? (
            <button
              className={menuItemClass(otherFaceEditingReason)}
              type="button"
              onClick={() => actions.expandCannedFeature(menuFeature.id)}
              disabled={onOtherFace}
              title={otherFaceEditingReason}
            >
              <MenuItemText reason={otherFaceEditingReason}>
                {t('featureTree.properties.canned.expand')}
              </MenuItemText>
            </button>
          ) : null}
          <button
            className={menuItemClass(constraintReason)}
            type="button"
            onClick={() => actions.constraint(menuFeature.id)}
            disabled={menuHasMultipleSelection || menuHasLockedSelection || menuFeatureIsCanned || onOtherFace}
            title={constraintReason}
          >
            <MenuItemText reason={constraintReason}>{t('featureTree.contextMenu.addConstraint')}</MenuItemText>
          </button>
          <div className="feature-context-menu__separator" />
          <button className="feature-context-menu__item" type="button" onClick={() => actions.copyFeature(menuFeature.id)}>
            {menuSelectionIsGroup ? t('featureTree.contextMenu.copyGroup') : menuHasMultipleSelection ? t('featureTree.contextMenu.copySelected') : t('featureTree.contextMenu.copy')}
          </button>
          <button
            className={menuItemClass(moveReason)}
            type="button"
            onClick={() => actions.moveFeature(menuFeature.id)}
            disabled={menuHasLockedSelection || onOtherFace}
            title={moveReason}
          >
            <MenuItemText reason={moveReason}>
              {menuSelectionIsGroup ? t('featureTree.contextMenu.moveGroup') : menuHasMultipleSelection ? t('featureTree.contextMenu.moveSelected') : t('featureTree.contextMenu.move')}
            </MenuItemText>
          </button>
          <button
            className={menuItemClass(otherFaceEditingReason)}
            type="button"
            onClick={() => actions.resizeFeature(menuFeature.id)}
            disabled={menuHasLockedSelection || onOtherFace}
            title={otherFaceEditingReason}
          >
            <MenuItemText reason={otherFaceEditingReason}>{t('featureTree.contextMenu.resize')}</MenuItemText>
          </button>
          <button
            className={menuItemClass(otherFaceEditingReason)}
            type="button"
            onClick={() => actions.rotateFeature(menuFeature.id)}
            disabled={menuHasLockedSelection || onOtherFace}
            title={otherFaceEditingReason}
          >
            <MenuItemText reason={otherFaceEditingReason}>{t('featureTree.contextMenu.rotate')}</MenuItemText>
          </button>
          <button
            className={menuItemClass(otherFaceEditingReason)}
            type="button"
            onClick={() => actions.mirrorFeature(menuFeature.id)}
            disabled={menuHasLockedSelection || onOtherFace}
            title={otherFaceEditingReason}
          >
            <MenuItemText reason={otherFaceEditingReason}>{t('featureTree.contextMenu.mirror')}</MenuItemText>
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className={menuItemClass(offsetReason)}
            type="button"
            onClick={() => actions.offsetFeatures()}
            disabled={menuHasLockedSelection || menuHasCannedSelection || onOtherFace}
            title={offsetReason}
          >
            <MenuItemText reason={offsetReason}>{t('featureTree.contextMenu.offset')}</MenuItemText>
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
                  className={menuItemClass(addToFolderReason, 'feature-context-menu__item--submenu')}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={addToFolderSubmenu !== null}
                  disabled={menuSelectionSectionsMixed}
                  title={addToFolderReason}
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
                  <span className="feature-context-menu__item-text">
                    <span>{t('featureTree.contextMenu.addToFolder')}</span>
                    {addToFolderReason
                      ? <span className="feature-context-menu__item-reason">{addToFolderReason}</span>
                      : null}
                  </span>
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
            className={menuItemClass(groupReason)}
            type="button"
            onClick={() => actions.groupFeatures()}
            disabled={!menuHasMultipleSelection || menuSelectionSectionsMixed}
            title={groupReason}
          >
            <MenuItemText reason={groupReason}>{t('featureTree.contextMenu.group')}</MenuItemText>
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className={menuItemClass(joinReason)}
            type="button"
            onClick={() => actions.joinFeatures()}
            disabled={!menuHasMultipleSelection || menuHasLockedSelection || menuHasCannedSelection || onOtherFace}
            title={joinReason}
          >
            <MenuItemText reason={joinReason}>{t('featureTree.contextMenu.join')}</MenuItemText>
          </button>
          <button
            className={menuItemClass(cutReason)}
            type="button"
            onClick={() => actions.cutFeatures()}
            disabled={menuHasLockedSelection || menuHasCannedSelection || onOtherFace}
            title={cutReason}
          >
            <MenuItemText reason={cutReason}>{t('featureTree.contextMenu.cut')}</MenuItemText>
          </button>
          <div className="feature-context-menu__separator" />
          <button
            className={menuItemClass(useAsStockReason)}
            type="button"
            onClick={() => actions.useAsStock(primaryId)}
            disabled={!menuCanUseAsStock}
            title={useAsStockReason}
          >
            <MenuItemText reason={useAsStockReason}>{t('featureTree.contextMenu.useAsStock')}</MenuItemText>
          </button>
          {bothFaces && !selectionOnAround ? (
            <>
              <div className="feature-context-menu__separator" />
              <button
                className={menuItemClass(changeFaceReason)}
                type="button"
                onClick={() => actions.changeAuthoringFace([...ids])}
                disabled={menuHasLockedSelection || faceBusy || !selectionCanChangeFace || onOtherFace}
                title={changeFaceReason}
              >
                <MenuItemText reason={changeFaceReason}>{t('featureTree.face.changeAuthoringFace')}</MenuItemText>
              </button>
            </>
          ) : null}
          <div className="feature-context-menu__separator" />
          <button
            className={menuItemClass(otherFaceEditingReason, 'feature-context-menu__item--danger')}
            type="button"
            onClick={() => actions.deleteFeatures([...ids])}
            disabled={onOtherFace}
            title={otherFaceEditingReason}
          >
            <MenuItemText reason={otherFaceEditingReason}>
              {menuSelectionIsGroup ? t('featureTree.contextMenu.deleteGroup') : menuHasMultipleSelection ? t('featureTree.contextMenu.deleteSelected') : t('featureTree.contextMenu.delete')}
            </MenuItemText>
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
