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
      alert(`Invalid machine definition JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [addMachineDefinition])

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
    // preview will be synced by the useEffect above.
  }, [previewDef, removeMachineDefinition])

  const handleEditorSave = useCallback(
    (definition: MachineDefinition) => {
      updateMachineDefinition(definition.id, definition)
      setEditingDef(null)
    },
    [updateMachineDefinition],
  )

  const isActive = previewDef?.id === activeId

  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--machine-manager"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage machines"
      >
        <div className="dialog-header">
          <h2 className="dialog-title">Manage Machines</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close" type="button">
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
                  {def.builtin ? 'Built-in' : 'Custom'}
                </span>
              </button>
            ))}
            {definitions.length === 0 ? (
              <div className="machine-manager-empty">
                No machine definitions. Import one to get started.
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
                    <span className="machine-manager-badge machine-manager-badge--active">Active</span>
                  ) : null}
                  <span className={previewDef.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                    {previewDef.builtin ? 'Built-in' : 'Custom'}
                  </span>
                </div>

                <dl className="machine-manager-meta">
                  <dt>File extension</dt>
                  <dd>.{previewDef.fileExtension}</dd>
                  {previewDef.description ? (
                    <>
                      <dt>Description</dt>
                      <dd>{previewDef.description}</dd>
                    </>
                  ) : null}
                  {previewDef.vendor ? (
                    <>
                      <dt>Vendor</dt>
                      <dd>{previewDef.vendor}</dd>
                    </>
                  ) : null}
                  {previewDef.builtin ? (
                    <dd className="machine-manager-hint">Built-in definitions are read-only. Duplicate to create an editable copy.</dd>
                  ) : null}
                </dl>

                <div className="machine-manager-actions">
                  {!isActive ? (
                    <button className="machine-manager-action btn-primary" type="button" onClick={handleUseThisMachine}>
                      Use this machine
                    </button>
                  ) : null}

                  {!previewDef.builtin ? (
                    <button className="machine-manager-action btn-secondary" type="button" onClick={handleEdit}>
                      Edit
                    </button>
                  ) : null}

                  <button className="machine-manager-action btn-secondary" type="button" onClick={handleDuplicateToEdit}>
                    {previewDef.builtin ? 'Duplicate to edit' : 'Duplicate'}
                  </button>

                  <button className="machine-manager-action btn-secondary" type="button" onClick={handleImportJson}>
                    Import JSON
                  </button>

                  <button className="machine-manager-action btn-secondary" type="button" onClick={handleExportJson}>
                    Export JSON
                  </button>

                  {!previewDef.builtin ? (
                    <button className="machine-manager-action machine-manager-action--remove" type="button" onClick={handleRemove}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="machine-manager-empty">
                Select a machine from the list or import one.
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" type="button" onClick={onClose}>
            Done
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
