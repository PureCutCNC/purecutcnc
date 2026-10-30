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

/**
 * An operation's "Cuts" list (issue #1112 slice I): its current targets only,
 * each a compact row — the target's own icon, its name and a small remove × at
 * the end of the row — with hovering a row highlighting the target on the
 * canvas. It replaces the read-only Target line and the two target checklists
 * (`CrossFaceTargetPicker`, `RotaryTargetPicker`): every target those offered
 * is now selectable, so selecting it and using Add / Use current selection
 * reaches the same place, and removing a row is how a model is kept out.
 *
 * A long list groups by the tree's folders and each folder collapses. The
 * rows, their icons and the grouping are `operationCuts.ts`'s — this file only
 * draws them.
 */

import { useMemo } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useI18n } from '../../i18n/i18nContext'
import { Icon } from '../Icon'
import { camT } from './camI18n'
import { operationCutGroups, operationCutRows, cutRemovalTarget, type OperationCutRow } from './operationCuts'
import type { Operation, Project } from '../../types/project'

export function OperationCuts({ project, operation }: { project: Project; operation: Operation }) {
  // Subscribe to locale changes: camT() reads the i18n store without
  // subscribing.
  useI18n()
  const hoverFeature = useProjectStore((state) => state.hoverFeature)
  const updateOperation = useProjectStore((state) => state.updateOperation)
  // Keyed on the project and the operation, not on hover: CAMPanel re-renders
  // on every hover, and a 200-target list must not re-resolve its geometry for
  // that. Hovering a row only reads the store's hovered id.
  const rows = useMemo(() => operationCutRows(project, operation), [project, operation])
  const { grouped, groups } = useMemo(() => operationCutGroups(project, rows), [project, rows])

  function remove(featureId: string) {
    const target = cutRemovalTarget(project, operation, featureId)
    if (target) updateOperation(operation.id, { target })
  }

  function renderRow(row: OperationCutRow) {
    return (
      <div
        key={row.featureId}
        className="cam-cuts__row"
        data-cut-feature-id={row.featureId}
        data-cut-filter={row.filter ? 'true' : undefined}
        onMouseEnter={() => hoverFeature(row.featureId)}
        onMouseLeave={() => hoverFeature(null)}
      >
        <span className="cam-cuts__icon" data-cut-icon={row.icon}>
          <Icon id={row.icon} size={13} />
        </span>
        <span className="cam-cuts__name" title={row.name}>{row.name}</span>
        {row.filter ? <span className="cam-cuts__filter">{camT('cam.operation.cutsFilter')}</span> : null}
        <button
          className="cam-cuts__remove"
          type="button"
          aria-label={camT('cam.operation.cutsRemove', { name: row.name })}
          title={row.removable
            ? camT('cam.operation.cutsRemove', { name: row.name })
            : camT('cam.operation.cutsLastTarget')}
          disabled={!row.removable}
          onClick={() => remove(row.featureId)}
        >
          <Icon id="close" size={12} />
        </button>
      </div>
    )
  }

  return (
    <div className="properties-field cam-cuts" data-operation-cuts>
      <span>{camT('cam.operation.cuts')}</span>
      <div className="cam-cuts__list">
        {operation.target.source === 'stock' ? (
          <div className="cam-cuts__row" data-cut-stock>
            <span className="cam-cuts__icon" data-cut-icon="stock">
              <Icon id="stock" size={13} />
            </span>
            <span className="cam-cuts__name">{camT('cam.target.stock')}</span>
          </div>
        ) : rows.length === 0 ? (
          <span className="properties-hint">{camT('cam.target.noFeatures')}</span>
        ) : grouped ? (
          groups.map((group) => group.folderId === null ? (
            <div key="ungrouped" className="cam-cuts__group">{group.rows.map(renderRow)}</div>
          ) : (
            <details
              key={group.folderId}
              className="cam-cuts__folder"
              data-cut-folder-id={group.folderId}
              open
            >
              <summary className="cam-cuts__folder-summary">
                {camT('cam.operation.cutsFolder', { name: group.folderName ?? '', count: group.rows.length })}
              </summary>
              {group.rows.map(renderRow)}
            </details>
          ))
        ) : rows.map(renderRow)}
      </div>
    </div>
  )
}
