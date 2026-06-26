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

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MachineDefinition } from '../../engine/gcode/types'
import { DisclosureSection } from '../common/DisclosureSection'
import {
  toFormData,
  mergeFormData,
  validateDef,
} from './machineDefinitionForm'
import type { MachineFormData } from './machineDefinitionForm'

export interface MachineDefinitionEditorDialogProps {
  definition: MachineDefinition
  onSave: (definition: MachineDefinition) => void
  onClose: () => void
}

export function MachineDefinitionEditorDialog({
  definition,
  onSave,
  onClose,
}: MachineDefinitionEditorDialogProps) {
  const [form, setForm] = useState<MachineFormData>(() => toFormData(definition))
  const [advancedJson, setAdvancedJson] = useState<string>(() =>
    JSON.stringify(definition, null, 2),
  )
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const textAreaRef = useRef<HTMLTextAreaElement>(null)

  // Escape key closes the dialog.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Validate on every change to compute whether Save should be enabled.
  const mergedDef = useMemo<MachineDefinition | null>(() => {
    // If the user has touched the Advanced JSON editor, use that as the
    // source of truth; otherwise merge the focused form onto the original.
    try {
      const parsed = JSON.parse(advancedJson)
      const result = validateDef(parsed)
      if (result.ok) {
        setJsonError(null)
        setValidationError(null)
        return result.ok
      }
      setJsonError(null)
      setValidationError(result.error)
      return null
    } catch {
      // JSON parse error — fall back to form merge for now.
      try {
        const merged = mergeFormData(definition, form)
        const result = validateDef(merged)
        if (result.ok) {
          setValidationError(null)
          return result.ok
        }
        setValidationError(result.error)
        return null
      } catch {
        setValidationError('Invalid definition')
        return null
      }
    }
  }, [advancedJson, definition, form])

  function handleFormChange(patch: Partial<MachineFormData>) {
    setForm((prev) => {
      const next = { ...prev, ...patch }
      // When the focused form changes, also update the Advanced JSON view
      // so both stay in sync. Only sync if the JSON view doesn't have a
      // syntax error (if it does, keep the user's broken JSON).
      try {
        JSON.parse(advancedJson)
        const merged = mergeFormData(definition, next)
        setAdvancedJson(JSON.stringify(merged, null, 2))
      } catch {
        // Syntax error in JSON editor — don't overwrite; user is editing raw.
      }
      return next
    })
  }

  function handleJsonChange(value: string) {
    setAdvancedJson(value)
    try {
      const parsed = JSON.parse(value)
      // Also sync the focused form from the JSON.
      const result = validateDef(parsed)
      if (result.ok) {
        setForm(toFormData(result.ok))
        setJsonError(null)
      } else {
        setJsonError(null) // valid JSON but invalid definition
      }
    } catch {
      setJsonError('Invalid JSON syntax')
    }
  }

  function handleSave() {
    if (!mergedDef) return
    onSave(mergedDef)
  }

  function handleJsonBlur() {
    // Re-validate and sync on blur.
    try {
      const parsed = JSON.parse(advancedJson)
      const result = validateDef(parsed)
      if (result.ok) {
        setForm(toFormData(result.ok))
        setJsonError(null)
        return
      }
    } catch {
      // Keep jsonError from typing
    }
  }

function renderVar(name: string, desc: string, context?: string) {
  return (
    <div className="machine-editor-var" key={name}>
      <code className="machine-editor-var-name">{'{'}{name}{'}'}</code>
      <span className="machine-editor-var-desc">{desc}{context ? <span className="machine-editor-var-context"> — {context}</span> : null}</span>
    </div>
  )
}

  const canSave = mergedDef !== null && !jsonError

  function renderTextAreaField(label: string, value: string, onChange: (v: string) => void) {
    return (
      <label className="machine-editor-field">
        <span className="machine-editor-label">{label}</span>
        <textarea
          className="machine-editor-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={Math.max(2, value.split('\n').length)}
          spellCheck={false}
        />
      </label>
    )
  }

  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--machine-editor"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit machine: ${definition.name}`}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">
            Edit Machine: {definition.name}
          </h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close" type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <span className="dialog-section-title">General</span>
              <label className="machine-editor-field">
                <span className="machine-editor-label">Name</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.name}
                  onChange={(e) => handleFormChange({ name: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">File Extension</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.fileExtension}
                  onChange={(e) => handleFormChange({ fileExtension: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">Units — mm command</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.mmCommand}
                  placeholder="e.g. G21"
                  onChange={(e) => handleFormChange({ mmCommand: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">Units — inch command</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.inchCommand}
                  placeholder="e.g. G20"
                  onChange={(e) => handleFormChange({ inchCommand: e.target.value })}
                />
              </label>
            </div>

            <div className="dialog-section-group">
              <span className="dialog-section-title">Program</span>
              {renderTextAreaField('Header', form.header, (v) => handleFormChange({ header: v }))}
              {renderTextAreaField('Operation Header', form.operationHeader, (v) =>
                handleFormChange({ operationHeader: v }),
              )}
              {renderTextAreaField('Footer', form.footer, (v) => handleFormChange({ footer: v }))}
            </div>

            <div className="dialog-section-group">
              <span className="dialog-section-title">Tool Change</span>
              {renderTextAreaField('Commands', form.toolChangeCommands, (v) =>
                handleFormChange({ toolChangeCommands: v }),
              )}
            </div>

            <div className="dialog-section-group">
              <span className="dialog-section-title">Coolant</span>
              <label className="machine-editor-field">
                <span className="machine-editor-label">Flood On</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.floodOnCommand}
                  placeholder="e.g. M8"
                  onChange={(e) => handleFormChange({ floodOnCommand: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">Mist On</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.mistOnCommand}
                  placeholder="e.g. M7"
                  onChange={(e) => handleFormChange({ mistOnCommand: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">Coolant Off</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.coolantOffCommand}
                  placeholder="e.g. M9"
                  onChange={(e) => handleFormChange({ coolantOffCommand: e.target.value })}
                />
              </label>
            </div>
          </div>

          <div className="dialog-section">
            <DisclosureSection
              title="Advanced (raw JSON)"
              storageKey="machine-editor-advanced"
            >
              <textarea
                ref={textAreaRef}
                className="machine-editor-json"
                value={advancedJson}
                onChange={(e) => handleJsonChange(e.target.value)}
                onBlur={handleJsonBlur}
                rows={24}
                spellCheck={false}
              />
              {jsonError ? (
                <div className="machine-editor-error" role="alert">
                  {jsonError}
                </div>
              ) : null}
            </DisclosureSection>
            {validationError ? (
              <div className="machine-editor-error" role="alert">
                {validationError}
              </div>
            ) : null}

            <DisclosureSection
              title="Variables reference"
              storageKey="machine-editor-vars"
            >
              <div className="machine-editor-vars">
                {renderVar('programName', 'Project name (comment-safe)', 'header, footer')}
                {renderVar('date', 'Current date (YYYY-MM-DD)', 'header, footer')}
                {renderVar('units', 'Project units: mm or inch', 'header, footer')}
                {renderVar('unitsCommand', 'Units G-code command (e.g. G21)', 'header, footer')}
                {renderVar('wcsCommand', 'Work coordinate select (e.g. G54)', 'header, footer')}
                {renderVar('operationIndex', '1-based operation number', 'operation header')}
                {renderVar('operationName', 'Operation name (comment-safe)', 'operation header')}
                {renderVar('operationDescription', 'Operation description text', 'operation header')}
                {renderVar('operationKind', 'Operation kind: contour, pocket, drill…', 'operation header')}
                {renderVar('operationPass', 'rough or finish', 'operation header')}
                {renderVar('operationTarget', 'Target shape summary', 'operation header')}
                {renderVar('toolNumber', 'Tool index (1-based)', 'tool change, op header')}
                {renderVar('toolName', 'Tool name (comment-safe)', 'tool change, op header')}
                {renderVar('feed', 'Cutting feed rate (formatted)', 'operation header')}
                {renderVar('plungeFeed', 'Plunge feed rate (formatted)', 'operation header')}
                {renderVar('rpm', 'Spindle RPM (formatted)', 'tool change, op header')}
              </div>
            </DisclosureSection>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={handleSave}
            disabled={!canSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
