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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MachineDefinition } from '../../engine/gcode/types'
import { getActiveMachineDefinition } from '../../engine/gcode/definitions'
import {
  duplicateMachineAsCustom,
  machineFieldDifferences,
  machinesFunctionallyEqual,
  parseMachineImport,
  serializeMachineExport,
} from '../../machine/registry'
import { deleteCustomMachine, saveCustomMachine } from '../../machine/store'
import { useMachineLibrary } from '../../machine/useMachineLibrary'
import { useProjectStore } from '../../store/projectStore'
import { platform } from '../../platform'
import { MachineDefinitionEditorDialog } from './MachineDefinitionEditorDialog'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

/**
 * Human labels for the top-level definition fields, so the comparison state
 * says "canned cycles, motion commands" instead of leaking schema keys.
 */
const MACHINE_FIELD_LABEL_KEYS: Record<string, keyof typeof dialogsEn> = {
  id: 'dialogs.machineManager.field.id',
  name: 'dialogs.machineManager.field.name',
  description: 'dialogs.machineManager.field.description',
  vendor: 'dialogs.machineManager.field.vendor',
  builtin: 'dialogs.machineManager.field.builtin',
  fileExtension: 'dialogs.machineManager.field.fileExtension',
  coordinateSystem: 'dialogs.machineManager.field.coordinateSystem',
  numberFormat: 'dialogs.machineManager.field.numberFormat',
  units: 'dialogs.machineManager.field.units',
  program: 'dialogs.machineManager.field.program',
  workCoordinates: 'dialogs.machineManager.field.workCoordinates',
  motion: 'dialogs.machineManager.field.motion',
  feedSpeed: 'dialogs.machineManager.field.feedSpeed',
  toolChange: 'dialogs.machineManager.field.toolChange',
  cannedCycles: 'dialogs.machineManager.field.cannedCycles',
  coolant: 'dialogs.machineManager.field.coolant',
  stop: 'dialogs.machineManager.field.stop',
}

export interface MachineDefinitionManagerDialogProps {
  onClose: () => void
  /** Open focused on a specific machine — used by the update warning's "Review update". */
  focusMachineId?: string | null
}

/**
 * Machine lifecycle manager. The list is the **application** library
 * (built-in machines from the current build plus My Machines); the project
 * holds only the snapshot it selected, shown as its own row when it is not in
 * the library. Library CRUD here never edits a project — replacing a
 * project's copy is always the explicit "Use this machine" / "Update project
 * copy" action.
 */
export function MachineDefinitionManagerDialog({
  onClose,
  focusMachineId = null,
}: MachineDefinitionManagerDialogProps) {
  const project = useProjectStore((s) => s.project)
  const setProjectMachine = useProjectStore((s) => s.setProjectMachine)
  const { library, customMachines } = useMachineLibrary()
  const { t, languageTag } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    return t(key, params)
  }

  const projectMachine = getActiveMachineDefinition(project)
  const projectOnlyMachine = projectMachine
    && !library.some((definition) => definition.id === projectMachine.id)
    ? projectMachine
    : null

  /** Every row the list can show: the library, plus a project-only snapshot. */
  const rows = useMemo(
    () => (projectOnlyMachine ? [...library, projectOnlyMachine] : [...library]),
    [library, projectOnlyMachine],
  )

  const [previewId, setPreviewId] = useState<string | null>(
    () => focusMachineId ?? projectMachine?.id ?? (library.length > 0 ? library[0].id : null),
  )

  // A removed machine falls back to the first row so list and detail stay in sync.
  const safePreviewId = previewId && rows.some((definition) => definition.id === previewId)
    ? previewId
    : (rows.length > 0 ? rows[0].id : null)
  const previewDef = safePreviewId
    ? rows.find((definition) => definition.id === safePreviewId) ?? null
    : null

  const [editingDef, setEditingDef] = useState<MachineDefinition | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const isProjectCopy = previewDef !== null && previewDef === projectOnlyMachine
  const isActive = previewDef !== null
    && projectMachine !== null
    && previewDef.id === projectMachine.id
    && machinesFunctionallyEqual(previewDef, projectMachine)
  /** The previewed library machine is a newer/different copy of the project's. */
  const isUpdateForProject = previewDef !== null
    && projectMachine !== null
    && !isProjectCopy
    && previewDef.id === projectMachine.id
    && !machinesFunctionallyEqual(previewDef, projectMachine)
  const differingFields = (isUpdateForProject && projectMachine && previewDef
    ? machineFieldDifferences(projectMachine, previewDef)
    : []
  ).map((field) => {
    const labelKey = MACHINE_FIELD_LABEL_KEYS[field]
    return labelKey ? td(labelKey) : field
  })

  const handleUseThisMachine = useCallback(() => {
    if (previewDef) setProjectMachine(previewDef)
  }, [previewDef, setProjectMachine])

  const handleSaveToMyMachines = useCallback(() => {
    if (!previewDef) return
    const result = saveCustomMachine(previewDef)
    setError(result.error ?? null)
    if (result.ok) setPreviewId(result.ok.id)
  }, [previewDef])

  const handleImportJson = useCallback(async () => {
    const content = await platform.pickJsonFile()
    if (!content) return
    const parsed = parseMachineImport(content, customMachines)
    if (parsed.error !== undefined) {
      setError(td('dialogs.machineManager.invalidImport', { message: parsed.error }))
      return
    }
    const saved = saveCustomMachine(parsed.ok)
    setError(saved.error ?? null)
    if (saved.ok) setPreviewId(saved.ok.id)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- td wraps stable context t; languageTag drives locale recomputes
  }, [customMachines, languageTag])

  const handleEdit = useCallback(() => {
    if (previewDef && !previewDef.builtin && !isProjectCopy) setEditingDef(previewDef)
  }, [previewDef, isProjectCopy])

  const handleDuplicateToEdit = useCallback(() => {
    if (!previewDef) return
    const duplicate = duplicateMachineAsCustom(previewDef, customMachines)
    const saved = saveCustomMachine(duplicate)
    setError(saved.error ?? null)
    if (saved.ok) {
      setPreviewId(saved.ok.id)
      setEditingDef(saved.ok)
    }
  }, [previewDef, customMachines])

  const handleExportJson = useCallback(() => {
    if (!previewDef) return
    platform.saveTextFile(`${previewDef.name}.json`, serializeMachineExport(previewDef), 'json')
  }, [previewDef])

  const handleRemove = useCallback(() => {
    if (!previewDef || previewDef.builtin || isProjectCopy) return
    deleteCustomMachine(previewDef.id)
    setPreviewId(null)
  }, [previewDef, isProjectCopy])

  const handleEditorSave = useCallback(
    (definition: MachineDefinition) => {
      // Look the entry up by the ID it had when editing started, so renaming
      // the "id" field in the raw JSON editor moves the entry instead of
      // silently creating a second one.
      const originalId = editingDef?.id
      const saved = saveCustomMachine(originalId ? { ...definition, id: originalId } : definition)
      setError(saved.error ?? null)
      if (saved.ok) setPreviewId(saved.ok.id)
      setEditingDef(null)
    },
    [editingDef],
  )

  function renderRow(definition: MachineDefinition, projectOnly: boolean) {
    const rowIsActive = projectMachine !== null && definition.id === projectMachine.id
    return (
      <button
        key={`${projectOnly ? 'project' : 'library'}-${definition.id}`}
        type="button"
        className={[
          'machine-manager-item',
          definition.id === safePreviewId ? 'machine-manager-item--selected' : '',
          rowIsActive ? 'machine-manager-item--active' : '',
        ].join(' ').trim()}
        onClick={() => { setPreviewId(definition.id); setError(null) }}
      >
        <div className="machine-manager-item-name">{definition.name}</div>
        {projectOnly ? (
          <span className="machine-manager-badge machine-manager-badge--missing">
            {td('dialogs.machineManager.notInLibrary')}
          </span>
        ) : (
          <span className={definition.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
            {definition.builtin ? td('dialogs.machineManager.builtin') : td('dialogs.machineManager.custom')}
          </span>
        )}
      </button>
    )
  }

  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--machine-manager"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={td('dialogs.machineManager.title')}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{td('dialogs.machineManager.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={td('dialogs.common.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body dialog-body--machine-manager">
          {/* Left: the application library, then the project-only snapshot */}
          <div className="machine-manager-list">
            <div className="machine-manager-group-label">{td('dialogs.machineManager.builtinGroup')}</div>
            {library.filter((definition) => definition.builtin).map((definition) => renderRow(definition, false))}

            <div className="machine-manager-group-label">{td('dialogs.machineManager.myMachines')}</div>
            {customMachines.length > 0
              ? customMachines.map((definition) => renderRow(definition, false))
              : <div className="machine-manager-empty">{td('dialogs.machineManager.emptyCustom')}</div>}

            {projectOnlyMachine ? (
              <>
                <div className="machine-manager-group-label">{td('dialogs.machineManager.projectGroup')}</div>
                {renderRow(projectOnlyMachine, true)}
              </>
            ) : null}
          </div>

          {/* Right: preview + actions */}
          <div className="machine-manager-detail">
            {previewDef ? (
              <>
                <div className="machine-manager-detail-header">
                  <h3 className="machine-manager-detail-name">{previewDef.name}</h3>
                  {isActive ? (
                    <span className="machine-manager-badge machine-manager-badge--active">{td('dialogs.machineManager.active')}</span>
                  ) : null}
                  {isProjectCopy ? (
                    <span className="machine-manager-badge machine-manager-badge--missing">{td('dialogs.machineManager.notInLibrary')}</span>
                  ) : (
                    <span className={previewDef.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                      {previewDef.builtin ? td('dialogs.machineManager.builtin') : td('dialogs.machineManager.custom')}
                    </span>
                  )}
                  {isUpdateForProject ? (
                    <span className="machine-manager-badge machine-manager-badge--update">{td('dialogs.machineManager.updateAvailable')}</span>
                  ) : null}
                </div>

                <dl className="machine-manager-meta">
                  <dt>{td('dialogs.machineManager.fileExtension')}</dt>
                  <dd>.{previewDef.fileExtension}</dd>
                  {previewDef.description ? (
                    <>
                      <dt>{td('dialogs.machineManager.description')}</dt>
                      <dd>{previewDef.description}</dd>
                    </>
                  ) : null}
                  {previewDef.vendor ? (
                    <>
                      <dt>{td('dialogs.machineManager.vendor')}</dt>
                      <dd>{previewDef.vendor}</dd>
                    </>
                  ) : null}
                  {previewDef.builtin ? (
                    <dd className="machine-manager-hint">{td('dialogs.machineManager.builtinHint')}</dd>
                  ) : null}
                  {isProjectCopy ? (
                    <dd className="machine-manager-hint">{td('dialogs.machineManager.projectCopyHint')}</dd>
                  ) : null}
                </dl>

                {isUpdateForProject ? (
                  <div className="machine-manager-comparison">
                    <strong>{td('dialogs.machineManager.comparisonTitle')}</strong>
                    <p>
                      {td(
                        previewDef.builtin
                          ? 'dialogs.machineManager.comparisonBodyBuiltin'
                          : 'dialogs.machineManager.comparisonBodyCustom',
                        { name: previewDef.name },
                      )}
                    </p>
                    {differingFields.length > 0 ? (
                      <p className="machine-manager-hint">
                        {td('dialogs.machineManager.comparisonFields', { fields: differingFields.join(', ') })}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {error ? <div className="machine-editor-error">{error}</div> : null}

                <div className="machine-manager-actions">
                  {isUpdateForProject ? (
                    <button className="btn-primary" type="button" onClick={handleUseThisMachine}>
                      {td('dialogs.machineManager.updateProjectCopy')}
                    </button>
                  ) : !isActive ? (
                    <button className="btn-primary" type="button" onClick={handleUseThisMachine}>
                      {td('dialogs.machineManager.useThisMachine')}
                    </button>
                  ) : null}

                  <div className="machine-manager-actions-row">
                    {isProjectCopy ? (
                      <button className="btn-secondary" type="button" onClick={handleSaveToMyMachines}>
                        {td('dialogs.machineManager.saveToMyMachines')}
                      </button>
                    ) : null}

                    {!previewDef.builtin && !isProjectCopy ? (
                      <button className="btn-secondary" type="button" onClick={handleEdit}>
                        {td('dialogs.machineManager.edit')}
                      </button>
                    ) : null}

                    <button className="btn-secondary" type="button" onClick={handleDuplicateToEdit}>
                      {previewDef.builtin ? td('dialogs.machineManager.duplicateToEdit') : td('dialogs.machineManager.duplicate')}
                    </button>

                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={handleImportJson}
                      title={td('dialogs.machineManager.importMachine')}
                    >
                      {td('dialogs.machineManager.importMachine')}
                    </button>

                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={handleExportJson}
                      title={td('dialogs.machineManager.exportMachine')}
                    >
                      {td('dialogs.machineManager.exportMachine')}
                    </button>
                  </div>

                  {!previewDef.builtin && !isProjectCopy ? (
                    <button className="machine-manager-action--remove" type="button" onClick={handleRemove}>
                      {td('dialogs.machineManager.removeMachine')}
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="machine-manager-empty">
                {td('dialogs.machineManager.emptyDetail')}
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" type="button" onClick={onClose}>
            {td('dialogs.machineManager.done')}
          </button>
        </div>
      </div>

      {/* Nested editor dialog */}
      {editingDef ? (
        <MachineDefinitionEditorDialog
          definition={editingDef}
          onSave={handleEditorSave}
          onClose={() => setEditingDef(null)}
        />
      ) : null}
    </div>,
    document.body,
  )
}
