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
import { getStockBounds, newProject } from '../../types/project'
import type { Project } from '../../types/project'
import { formatLength } from '../../utils/units'

type TemplateKind = 'blank_metric' | 'blank_imperial' | 'current' | 'file'

interface NewProjectDialogProps {
  onClose: () => void
}

function suggestedProjectName(kind: TemplateKind, currentProject: Project, fileTemplate: Project | null): string {
  void currentProject
  void fileTemplate
  switch (kind) {
    case 'blank_metric':
      return 'Untitled'
    case 'blank_imperial':
      return 'Untitled'
    case 'current':
      return 'Untitled'
    case 'file':
      return 'Untitled'
  }
}

function templateLabel(kind: TemplateKind, currentProject: Project, fileTemplate: Project | null): string {
  switch (kind) {
    case 'blank_metric':
      return 'Blank Metric'
    case 'blank_imperial':
      return 'Blank Imperial'
    case 'current':
      return `Current Project Setup: ${currentProject.meta.name}`
    case 'file':
      return fileTemplate ? `Template File Setup: ${fileTemplate.meta.name}` : 'Template File Setup'
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

export function NewProjectDialog({ onClose }: NewProjectDialogProps) {
  const { project, createNewProject } = useProjectStore()
  const [templateKind, setTemplateKind] = useState<TemplateKind>('blank_metric')
  const [fileTemplate, setFileTemplate] = useState<Project | null>(null)
  const [fileLabel, setFileLabel] = useState<string>('No template file loaded.')
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
        units: activeTemplate.meta.units === 'inch' ? 'Inch' : 'Millimeter',
        stock: `${formatLength(width, activeTemplate.meta.units)} × ${formatLength(height, activeTemplate.meta.units)} × ${formatLength(activeTemplate.stock.thickness, activeTemplate.meta.units)}`,
        features: activeTemplate.features.length,
        tools: activeTemplate.tools.length,
        operations: activeTemplate.operations.length,
        machine: activeTemplate.meta.selectedMachineId
          ? (activeTemplate.meta.machineDefinitions.find((definition) => definition.id === activeTemplate.meta.selectedMachineId)?.name ?? 'None')
          : 'None',
      }
    } catch {
      return null
    }
  }, [activeTemplate])

  function handleCreate() {
    if (!activeTemplate) {
      return
    }

    createNewProject(activeTemplate, projectName.trim() || suggestedProjectName(templateKind, project, fileTemplate))
    onClose()
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
        setFileError('Failed to parse template project file.')
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">New Project</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close" type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="new-project-name">Project Name</label>
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
              <label className="dialog-section-title">Template</label>
              <div className="project-template-list">
                <button
                  className={`project-template-card ${templateKind === 'blank_metric' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => setTemplateKind('blank_metric')}
                >
                  <span className="project-template-card__title">Blank Metric</span>
                  <span className="project-template-card__meta">Empty project in millimeters.</span>
                </button>
                <button
                  className={`project-template-card ${templateKind === 'blank_imperial' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => setTemplateKind('blank_imperial')}
                >
                  <span className="project-template-card__title">Blank Imperial</span>
                  <span className="project-template-card__meta">Empty project in inches.</span>
                </button>
                <button
                  className={`project-template-card ${templateKind === 'current' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => setTemplateKind('current')}
                >
                  <span className="project-template-card__title">Current Project</span>
                  <span className="project-template-card__meta">Use the open project settings as a starting template.</span>
                </button>
                <button
                  className={`project-template-card ${templateKind === 'file' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="project-template-card__title">Template File</span>
                  <span className="project-template-card__meta">{fileTemplate ? `${fileLabel} (settings only)` : fileLabel}</span>
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".camj,.json"
                onChange={handleTemplateFileChange}
                style={{ display: 'none' }}
              />
              {fileError ? <div className="cam-field-message">{fileError}</div> : null}
            </div>
          </div>

          <div className="dialog-preview-container">
            <label className="dialog-section-title">Template Preview</label>
            <div className="dialog-preview project-template-preview">
              {activeTemplate && templateSummary ? (
                <div className="project-template-preview__content">
                  <div className="project-template-preview__title">{templateLabel(templateKind, project, fileTemplate)}</div>
                  <div className="project-template-preview__row">
                    <span>Units</span>
                    <strong>{templateSummary.units}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>Stock</span>
                    <strong>{templateSummary.stock}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>Features</span>
                    <strong>{templateSummary.features}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>Tools</span>
                    <strong>{templateSummary.tools}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>Operations</span>
                    <strong>{templateSummary.operations}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>Machine</span>
                    <strong>{templateSummary.machine}</strong>
                  </div>
                </div>
              ) : (
                <div className="project-template-preview__empty">
                  Load a project file to use it as a template.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} type="button">Cancel</button>
          <button className="btn-primary" onClick={handleCreate} type="button" disabled={!activeTemplate}>
            Create Project
          </button>
        </div>
      </div>
    </div>
  )
}
