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
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import { dialogsZhCN } from '../../i18n/locales/zh-CN/dialogs'
import { interpolate } from '../../i18n/catalog'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

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
  const { localeId } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    const catalog = localeId === 'zh-CN' ? dialogsZhCN : dialogsEn
    const template = (catalog as Record<string, string>)[key] ?? dialogsEn[key]
    return interpolate(template, params)
  }

  const [form, setForm] = useState<MachineFormData>(() => toFormData(definition))
  const [advancedJson, setAdvancedJson] = useState<string>(() =>
    JSON.stringify(definition, null, 2),
  )
  const textAreaRef = useRef<HTMLTextAreaElement>(null)

  // Escape key closes the dialog.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Pure derivation — no setState calls inside useMemo.
  const { mergedDef, jsonError, validationError } = useMemo(() => {
    // Try parsing + validating the Advanced JSON editor first.
    try {
      const parsed = JSON.parse(advancedJson)
      const result = validateDef(parsed)
      if (result.ok) {
        return { mergedDef: result.ok, jsonError: null, validationError: null }
      }
      return { mergedDef: null, jsonError: null, validationError: result.error }
    } catch {
      // JSON syntax error — fall back to merging the focused form.
      const jsonErr = td('dialogs.machineEditor.invalidJson')
      try {
        const merged = mergeFormData(definition, form)
        const result = validateDef(merged)
        if (result.ok) {
          return { mergedDef: result.ok, jsonError: jsonErr, validationError: null }
        }
        return { mergedDef: null, jsonError: jsonErr, validationError: result.error }
      } catch {
        return { mergedDef: null, jsonError: jsonErr, validationError: 'Invalid definition' }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      }
    } catch {
      // JSON syntax error — jsonError is derived from advancedJson in useMemo.
    }
  }

  function handleSave() {
    if (!mergedDef) return
    onSave(mergedDef)
  }

  function handleJsonBlur() {
    // Re-validate and sync the focused form on blur so it stays in
    // sync with any hand-edited JSON.
    try {
      const parsed = JSON.parse(advancedJson)
      const result = validateDef(parsed)
      if (result.ok) {
        setForm(toFormData(result.ok))
      }
    } catch {
      // JSON still invalid — nothing to sync.
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
        aria-label={td('dialogs.machineEditor.title', { name: definition.name })}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">
            {td('dialogs.machineEditor.title', { name: definition.name })}
          </h2>
          <button className="dialog-close" onClick={onClose} aria-label={td('dialogs.common.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <span className="dialog-section-title">{td('dialogs.machineEditor.general')}</span>
              <label className="machine-editor-field">
                <span className="machine-editor-label">{td('dialogs.machineEditor.name')}</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.name}
                  onChange={(e) => handleFormChange({ name: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">{td('dialogs.machineEditor.fileExtension')}</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.fileExtension}
                  onChange={(e) => handleFormChange({ fileExtension: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">{td('dialogs.machineEditor.mmCommand')}</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.mmCommand}
                  placeholder="e.g. G21"
                  onChange={(e) => handleFormChange({ mmCommand: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">{td('dialogs.machineEditor.inchCommand')}</span>
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
              <span className="dialog-section-title">{td('dialogs.machineEditor.program')}</span>
              {renderTextAreaField(td('dialogs.machineEditor.header'), form.header, (v) => handleFormChange({ header: v }))}
              {renderTextAreaField(td('dialogs.machineEditor.operationHeader'), form.operationHeader, (v) =>
                handleFormChange({ operationHeader: v }),
              )}
              {renderTextAreaField(td('dialogs.machineEditor.footer'), form.footer, (v) => handleFormChange({ footer: v }))}
            </div>

            <div className="dialog-section-group">
              <span className="dialog-section-title">{td('dialogs.machineEditor.toolChange')}</span>
              {renderTextAreaField(td('dialogs.machineEditor.toolChangeCommands'), form.toolChangeCommands, (v) =>
                handleFormChange({ toolChangeCommands: v }),
              )}
            </div>

            <div className="dialog-section-group">
              <span className="dialog-section-title">{td('dialogs.machineEditor.coolant')}</span>
              <label className="machine-editor-field">
                <span className="machine-editor-label">{td('dialogs.machineEditor.floodOn')}</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.floodOnCommand}
                  placeholder="e.g. M8"
                  onChange={(e) => handleFormChange({ floodOnCommand: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">{td('dialogs.machineEditor.mistOn')}</span>
                <input
                  className="machine-editor-input"
                  type="text"
                  value={form.mistOnCommand}
                  placeholder="e.g. M7"
                  onChange={(e) => handleFormChange({ mistOnCommand: e.target.value })}
                />
              </label>
              <label className="machine-editor-field">
                <span className="machine-editor-label">{td('dialogs.machineEditor.coolantOff')}</span>
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
              title={td('dialogs.machineEditor.advanced')}
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
              title={td('dialogs.machineEditor.variablesReference')}
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
            {td('dialogs.common.cancel')}
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={handleSave}
            disabled={!canSave}
          >
            {td('dialogs.machineEditor.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
