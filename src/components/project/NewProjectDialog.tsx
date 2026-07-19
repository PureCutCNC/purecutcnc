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
import type { ChangeEvent } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { ExampleProjectList } from './ExampleProjectList'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { getStockBounds, newProject } from '../../types/project'
import type { Project } from '../../types/project'
import { formatLength } from '../../utils/units'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

type TemplateKind = 'blank_metric' | 'blank_imperial' | 'current' | 'file'

interface NewProjectDialogProps {
  onClose: () => void
  onCreated?: () => void
}

function suggestedProjectName(_kind: TemplateKind, currentProject: Project, fileTemplate: Project | null): string {
  void currentProject
  void fileTemplate
  // 'Untitled' is a store-bound default — never translated per i18n invariants.
  return 'Untitled'
}

function templateLabel(
  kind: TemplateKind,
  currentProject: Project,
  fileTemplate: Project | null,
  td: (key: keyof typeof dialogsEn, params?: MessageParams) => string,
): string {
  switch (kind) {
    case 'blank_metric':
      return td('dialogs.newProject.templateLabel.blankMetric')
    case 'blank_imperial':
      return td('dialogs.newProject.templateLabel.blankImperial')
    case 'current':
      return td('dialogs.newProject.templateLabel.currentProject', { name: currentProject.meta.name })
    case 'file':
      return fileTemplate
        ? td('dialogs.newProject.templateLabel.fileSetup', { name: fileTemplate.meta.name })
        : td('dialogs.newProject.templateLabel.fileSetupFallback')
  }
}

function setupOnlyTemplate(template: Project): Project {
  return {
    ...structuredClone(template),
    dimensions: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
}

export function NewProjectDialog({ onClose, onCreated }: NewProjectDialogProps) {
  useRestoreCanvasFocus()
  const { project, createNewProject } = useProjectStore()
  const { t, languageTag } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    return t(key, params)
  }

  const [templateKind, setTemplateKind] = useState<TemplateKind>('blank_metric')
  const [fileTemplate, setFileTemplate] = useState<Project | null>(null)
  const [fileLabel, setFileLabel] = useState<string>(td('dialogs.newProject.templateFileNoFile'))
  const [fileError, setFileError] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('Untitled')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const metricTemplate = useMemo(() => newProject('Untitled', 'mm'), [])
  const imperialTemplate = useMemo(() => newProject('Untitled', 'inch'), [])
  const currentProjectTemplate = useMemo(() => setupOnlyTemplate(project), [project])
  const fileProjectTemplate = useMemo(() => (fileTemplate ? setupOnlyTemplate(fileTemplate) : null), [fileTemplate])

  const activeTemplate = useMemo<Project | null>(() => {
    switch (templateKind) {
      case 'blank_metric':
        return metricTemplate
      case 'blank_imperial':
        return imperialTemplate
      case 'current':
        return currentProjectTemplate
      case 'file':
        return fileProjectTemplate
    }
  }, [currentProjectTemplate, fileProjectTemplate, imperialTemplate, metricTemplate, templateKind])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    setProjectName(suggestedProjectName(templateKind, project, fileTemplate))
  }, [fileTemplate, project, templateKind])

  const templateSummary = useMemo(() => {
    if (!activeTemplate) {
      return null
    }

    try {
      const bounds = getStockBounds(activeTemplate.stock)
      const width = bounds.maxX - bounds.minX
      const height = bounds.maxY - bounds.minY

      return {
        units: activeTemplate.meta.units === 'inch' ? td('dialogs.common.inch') : td('dialogs.common.millimeter'),
        stock: `${formatLength(width, activeTemplate.meta.units)} × ${formatLength(height, activeTemplate.meta.units)} × ${formatLength(activeTemplate.stock.thickness, activeTemplate.meta.units)}`,
        features: activeTemplate.features.length,
        tools: activeTemplate.tools.length,
        operations: activeTemplate.operations.length,
        machine: activeTemplate.meta.selectedMachineId
          ? (activeTemplate.meta.machineDefinitions.find((definition) => definition.id === activeTemplate.meta.selectedMachineId)?.name ?? td('dialogs.common.none'))
          : td('dialogs.common.none'),
      }
    } catch {
      return null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- td wraps stable context t; languageTag drives locale recomputes
  }, [activeTemplate, languageTag])

  function handleCreate() {
    if (!activeTemplate) {
      return
    }

    createNewProject(activeTemplate, projectName.trim() || suggestedProjectName(templateKind, project, fileTemplate))
    onClose()
    onCreated?.()
  }

  function handleTemplateFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.onload = (readerEvent) => {
      try {
        const parsed = JSON.parse(readerEvent.target?.result as string) as Project
        setFileTemplate(parsed)
        setFileLabel(file.name)
        setFileError(null)
        setTemplateKind('file')
      } catch {
        setFileTemplate(null)
        setFileLabel(file.name)
        setFileError(td('dialogs.newProject.templateFileParseError'))
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog--new-project" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{td('dialogs.newProject.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={td('dialogs.common.close')} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="new-project-name">{td('dialogs.newProject.projectName')}</label>
              <div className="properties-field">
                <input
                  id="new-project-name"
                  type="text"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  spellCheck={false}
                  autoFocus
                />
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.newProject.template')}</label>
              <div className="project-template-list">
                <button
                  className={`project-template-card ${templateKind === 'blank_metric' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => setTemplateKind('blank_metric')}
                >
                  <span className="project-template-card__title">{td('dialogs.newProject.templateBlankMetric')}</span>
                  <span className="project-template-card__meta">{td('dialogs.newProject.templateBlankMetricMeta')}</span>
                </button>
                <button
                  className={`project-template-card ${templateKind === 'blank_imperial' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => setTemplateKind('blank_imperial')}
                >
                  <span className="project-template-card__title">{td('dialogs.newProject.templateBlankImperial')}</span>
                  <span className="project-template-card__meta">{td('dialogs.newProject.templateBlankImperialMeta')}</span>
                </button>
                <button
                  className={`project-template-card ${templateKind === 'current' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => setTemplateKind('current')}
                >
                  <span className="project-template-card__title">{td('dialogs.newProject.templateCurrentProject')}</span>
                  <span className="project-template-card__meta">{td('dialogs.newProject.templateCurrentProjectMeta')}</span>
                </button>
                <button
                  className={`project-template-card ${templateKind === 'file' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="project-template-card__title">{td('dialogs.newProject.templateFile')}</span>
                  <span className="project-template-card__meta">{fileTemplate ? td('dialogs.newProject.templateFileMetaSettings', { name: fileLabel }) : fileLabel}</span>
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".camj,.json,application/json"
                onChange={handleTemplateFileChange}
                style={{ display: 'none' }}
              />
              {fileError ? <div className="cam-field-message">{fileError}</div> : null}
            </div>
          </div>

          <div className="dialog-preview-container">
            <label className="dialog-section-title">{td('dialogs.newProject.templatePreview')}</label>
            <div className="dialog-preview project-template-preview">
              {activeTemplate && templateSummary ? (
                <div className="project-template-preview__content">
                  <div className="project-template-preview__title">{templateLabel(templateKind, project, fileTemplate, td)}</div>
                  <div className="project-template-preview__row">
                    <span>{td('dialogs.newProject.previewUnits')}</span>
                    <strong>{templateSummary.units}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>{td('dialogs.newProject.previewStock')}</span>
                    <strong>{templateSummary.stock}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>{td('dialogs.newProject.previewFeatures')}</span>
                    <strong>{templateSummary.features}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>{td('dialogs.newProject.previewTools')}</span>
                    <strong>{templateSummary.tools}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>{td('dialogs.newProject.previewOperations')}</span>
                    <strong>{templateSummary.operations}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>{td('dialogs.newProject.previewMachine')}</span>
                    <strong>{templateSummary.machine}</strong>
                  </div>
                </div>
              ) : (
                <div className="project-template-preview__empty">
                  {td('dialogs.newProject.previewEmpty')}
                </div>
              )}
            </div>
          </div>

          <div className="dialog-section-group new-project-examples">
            <label className="dialog-section-title">{td('dialogs.newProject.orOpenExample')}</label>
            <ExampleProjectList
              onOpened={() => {
                onClose()
                onCreated?.()
              }}
            />
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} type="button">{td('dialogs.common.cancel')}</button>
          <button className="btn-primary" onClick={handleCreate} type="button" disabled={!activeTemplate}>
            {td('dialogs.newProject.createProject')}
          </button>
        </div>
      </div>
    </div>
  )
}
