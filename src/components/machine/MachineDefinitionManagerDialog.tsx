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

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MachineDefinition } from '../../engine/gcode/types'
import { validateMachineDefinition } from '../../engine/gcode/types'
import { useProjectStore } from '../../store/projectStore'
import { platform } from '../../platform'
import { MachineDefinitionEditorDialog } from './MachineDefinitionEditorDialog'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

export interface MachineDefinitionManagerDialogProps {
  onClose: () => void
}

export function MachineDefinitionManagerDialog({
  onClose,
}: MachineDefinitionManagerDialogProps) {
  const project = useProjectStore((s) => s.project)
  const setSelectedMachineId = useProjectStore((s) => s.setSelectedMachineId)
  const addMachineDefinition = useProjectStore((s) => s.addMachineDefinition)
  const removeMachineDefinition = useProjectStore((s) => s.removeMachineDefinition)
  const updateMachineDefinition = useProjectStore((s) => s.updateMachineDefinition)
  const duplicateMachineDefinition = useProjectStore((s) => s.duplicateMachineDefinition)
  const { t, languageTag } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    return t(key, params)
  }

  const definitions = project.meta.machineDefinitions
  const activeId = project.meta.selectedMachineId

  // Track which machine is previewed in the right column (not necessarily active).
  const [previewId, setPreviewId] = useState<string | null>(() =>
    activeId ?? (definitions.length > 0 ? definitions[0].id : null),
  )

  // If the previewed machine was removed, fall back to the first available.
  const safePreviewId =
    previewId && definitions.some((d) => d.id === previewId)
      ? previewId
      : definitions.length > 0
        ? definitions[0].id
        : null

  const previewDef = safePreviewId
    ? definitions.find((d) => d.id === safePreviewId) ?? null
    : null

  const [editingDef, setEditingDef] = useState<MachineDefinition | null>(null)

  // Escape key closes.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleUseThisMachine = useCallback(() => {
    if (previewDef) {
      setSelectedMachineId(previewDef.id)
    }
  }, [previewDef, setSelectedMachineId])

  const handleImportJson = useCallback(async () => {
    const content = await platform.pickJsonFile()
    if (!content) return
    try {
      const parsed = JSON.parse(content)
      const validated = validateMachineDefinition({ ...parsed, builtin: false })
      addMachineDefinition(validated)
      setPreviewId(validated.id)
    } catch (error) {
      alert(td('dialogs.machineManager.invalidImport', { message: error instanceof Error ? error.message : String(error) }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- td wraps stable context t; languageTag drives locale recomputes
  }, [addMachineDefinition, languageTag])

  const handleEdit = useCallback(() => {
    if (previewDef) {
      setEditingDef(previewDef)
    }
  }, [previewDef])

  const handleDuplicateToEdit = useCallback(() => {
    if (!previewDef) return
    // Store the current list length so we can find the new entry.
    const prevIds = new Set(definitions.map((d) => d.id))
    duplicateMachineDefinition(previewDef.id)
    // The store updates synchronously; find the new id.
    const updated = useProjectStore.getState().project.meta.machineDefinitions
    const newDef = updated.find((d) => !prevIds.has(d.id))
    if (newDef) {
      setPreviewId(newDef.id)
      setEditingDef(newDef)
    }
  }, [previewDef, definitions, duplicateMachineDefinition])

  const handleExportJson = useCallback(() => {
    if (!previewDef) return
    const { builtin: _, ...exportDef } = previewDef as MachineDefinition & { builtin?: boolean }
    platform.saveTextFile(
      `${previewDef.name}.json`,
      JSON.stringify(exportDef, null, 2),
      'json',
    )
  }, [previewDef])

  const handleRemove = useCallback(() => {
    if (!previewDef || previewDef.builtin) return
    removeMachineDefinition(previewDef.id)
    // The store updates synchronously; reset previewId so the list
    // selection row stays in sync with the detail pane.
    const updated = useProjectStore.getState().project.meta.machineDefinitions
    setPreviewId(updated.length > 0 ? updated[0].id : null)
  }, [previewDef, removeMachineDefinition])

  const handleEditorSave = useCallback(
    (definition: MachineDefinition) => {
      // Use the original editingDef.id for the lookup so that editing the
      // "id" field in the raw JSON editor does not cause the update to
      // target a non-existent key and silently no-op.
      updateMachineDefinition(editingDef!.id, definition)
      setEditingDef(null)
    },
    [updateMachineDefinition, editingDef],
  )

  const isActive = previewDef?.id === activeId

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
          {/* Left: machine list */}
          <div className="machine-manager-list">
            {definitions.map((def) => (
              <button
                key={def.id}
                type="button"
                className={[
                  'machine-manager-item',
                  def.id === previewId ? 'machine-manager-item--selected' : '',
                  def.id === activeId ? 'machine-manager-item--active' : '',
                ].join(' ').trim()}
                onClick={() => setPreviewId(def.id)}
              >
                <div className="machine-manager-item-name">{def.name}</div>
                <span className={def.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                  {def.builtin ? td('dialogs.machineManager.builtin') : td('dialogs.machineManager.custom')}
                </span>
              </button>
            ))}
            {definitions.length === 0 ? (
              <div className="machine-manager-empty">
                {td('dialogs.machineManager.empty')}
              </div>
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
                  <span className={previewDef.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                    {previewDef.builtin ? td('dialogs.machineManager.builtin') : td('dialogs.machineManager.custom')}
                  </span>
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
                </dl>

                <div className="machine-manager-actions">
                  {!isActive ? (
                    <button className="btn-primary" type="button" onClick={handleUseThisMachine}>
                      {td('dialogs.machineManager.useThisMachine')}
                    </button>
                  ) : null}

                  <div className="machine-manager-actions-row">
                    {!previewDef.builtin ? (
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

                  {!previewDef.builtin ? (
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
