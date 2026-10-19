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
import { Select } from '../Select'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { getStockBounds, newProject } from '../../types/project'
import type { Project, ProjectType } from '../../types/project'
import { formatLength } from '../../utils/units'
import { getActiveMachineDefinition } from '../../engine/gcode/definitions'
import { normalizeMachineDefinitions } from '../../store/helpers/normalize'
import { projectWithProjectType } from '../../store/helpers/projectTypeApply'
import {
  blankTemplateProject,
  defaultBlankStockDraft,
  type BlankStockDraft,
  type BlockStockDraft,
} from './newProjectStock'
import { machineCandidates } from '../../machine/registry'
import { useMachineLibrary } from '../../machine/useMachineLibrary'
import { PROJECT_TYPES, projectTypeLabelKey } from '../feature-tree/projectTypeChoice'
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
  const cloned = structuredClone(template)
  // A template carries only the machine snapshot it selected — never a
  // library. The picker always reads the current application library, so a
  // template can't decide which bundled machines exist.
  const machines = normalizeMachineDefinitions(cloned)
  return {
    ...cloned,
    meta: {
      ...cloned.meta,
      machineDefinitions: machines.machineDefinitions,
      selectedMachineId: machines.selectedMachineId,
    },
    dimensions: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
}

function stockDimensionsDraft(template: Project): BlockStockDraft {
  const bounds = getStockBounds(template.stock)
  return {
    width: String(bounds.maxX - bounds.minX),
    height: String(bounds.maxY - bounds.minY),
    thickness: String(template.stock.thickness),
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
  const [projectTypeChoice, setProjectTypeChoice] = useState<ProjectType>('milling')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { library: machineLibrary } = useMachineLibrary()

  const metricTemplate = useMemo(() => newProject('Untitled', 'mm'), [])
  const imperialTemplate = useMemo(() => newProject('Untitled', 'inch'), [])
  const [stockDraft, setStockDraft] = useState<BlockStockDraft>(() => stockDimensionsDraft(metricTemplate))
  const [barDraft, setBarDraft] = useState<BlankStockDraft>(() => defaultBlankStockDraft(metricTemplate.meta.units))
  const currentProjectTemplate = useMemo(() => setupOnlyTemplate(project), [project])
  const fileProjectTemplate = useMemo(() => (fileTemplate ? setupOnlyTemplate(fileTemplate) : null), [fileTemplate])

  const isBlankTemplate = templateKind === 'blank_metric' || templateKind === 'blank_imperial'
  // The blank template's stock fields follow the type (issue #1046): rotary
  // asks for the bar it machines, milling and plasma keep width × height ×
  // thickness.
  const usesBarStock = isBlankTemplate && projectTypeChoice === 'rotary'

  /**
   * The project the dialog will create. A blank template's stock is built as
   * the shape its type machines (issue #1046) and the chosen type then sets
   * the stored type and, when the template's machine does not suit it, the
   * first matching machine from the picker's candidate list (issue #1028). A
   * current or file template keeps today's behaviour.
   */
  const chosenTemplate = useMemo<Project | null>(() => {
    switch (templateKind) {
      case 'blank_metric':
      case 'blank_imperial':
        return blankTemplateProject(
          templateKind === 'blank_metric' ? metricTemplate : imperialTemplate,
          projectTypeChoice,
          machineCandidates(machineLibrary, null),
          stockDraft,
          barDraft,
        )
      case 'current':
        return projectWithProjectType(
          currentProjectTemplate,
          projectTypeChoice,
          machineCandidates(machineLibrary, getActiveMachineDefinition(currentProjectTemplate)),
        )
      case 'file':
        if (!fileProjectTemplate) return null
        return projectWithProjectType(
          fileProjectTemplate,
          projectTypeChoice,
          machineCandidates(machineLibrary, getActiveMachineDefinition(fileProjectTemplate)),
        )
    }
  }, [
    barDraft,
    currentProjectTemplate,
    fileProjectTemplate,
    imperialTemplate,
    machineLibrary,
    metricTemplate,
    projectTypeChoice,
    stockDraft,
    templateKind,
  ])

  const previewTemplate = chosenTemplate ?? (templateKind === 'blank_metric' ? metricTemplate : templateKind === 'blank_imperial' ? imperialTemplate : null)

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
    if (!previewTemplate) {
      return null
    }

    try {
      const bounds = getStockBounds(previewTemplate.stock)
      const width = bounds.maxX - bounds.minX
      const height = bounds.maxY - bounds.minY

      return {
        units: previewTemplate.meta.units === 'inch' ? td('dialogs.common.inch') : td('dialogs.common.millimeter'),
        stock: `${formatLength(width, previewTemplate.meta.units)} × ${formatLength(height, previewTemplate.meta.units)} × ${formatLength(previewTemplate.stock.thickness, previewTemplate.meta.units)}`,
        features: previewTemplate.features.length,
        tools: previewTemplate.tools.length,
        operations: previewTemplate.operations.length,
        // The template carries only its own embedded snapshot; the machine
        // picker always reads the current application library instead.
        machine: getActiveMachineDefinition(previewTemplate)?.name ?? td('dialogs.common.none'),
      }
    } catch {
      return null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- td wraps stable context t; languageTag drives locale recomputes
  }, [languageTag, previewTemplate])

  function handleCreate() {
    if (!chosenTemplate) {
      return
    }

    createNewProject(chosenTemplate, projectName.trim() || suggestedProjectName(templateKind, project, fileTemplate))
    onClose()
    onCreated?.()
  }

  function selectTemplate(kind: TemplateKind) {
    setTemplateKind(kind)
    if (kind === 'blank_metric' || kind === 'blank_imperial') {
      const template = kind === 'blank_metric' ? metricTemplate : imperialTemplate
      setStockDraft(stockDimensionsDraft(template))
      // The shape the user picked survives a units change; only the numbers
      // follow the new template's units.
      setBarDraft((draft) => defaultBlankStockDraft(template.meta.units, draft.shape))
    }
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
                  onClick={() => selectTemplate('blank_metric')}
                >
                  <span className="project-template-card__title">{td('dialogs.newProject.templateBlankMetric')}</span>
                  <span className="project-template-card__meta">{td('dialogs.newProject.templateBlankMetricMeta')}</span>
                </button>
                <button
                  className={`project-template-card ${templateKind === 'blank_imperial' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => selectTemplate('blank_imperial')}
                >
                  <span className="project-template-card__title">{td('dialogs.newProject.templateBlankImperial')}</span>
                  <span className="project-template-card__meta">{td('dialogs.newProject.templateBlankImperialMeta')}</span>
                </button>
                <button
                  className={`project-template-card ${templateKind === 'current' ? 'project-template-card--active' : ''}`}
                  type="button"
                  onClick={() => selectTemplate('current')}
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

            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.newProject.projectType')}</label>
              <div className="properties-field properties-field--new-project-type">
                <Select
                  value={projectTypeChoice}
                  options={PROJECT_TYPES.map((type) => ({ value: type, label: t(projectTypeLabelKey(type)) }))}
                  onChange={setProjectTypeChoice}
                />
              </div>
            </div>

          </div>

          <div className="dialog-preview-container">
            <label className="dialog-section-title">{td('dialogs.newProject.templatePreview')}</label>
            <div className="dialog-preview project-template-preview">
              {previewTemplate && templateSummary ? (
                <div className="project-template-preview__content">
                  <div className="project-template-preview__title">{templateLabel(templateKind, project, fileTemplate, td)}</div>
                  <div className="project-template-preview__row">
                    <span>{td('dialogs.newProject.previewUnits')}</span>
                    <strong>{templateSummary.units}</strong>
                  </div>
                  <div className={`project-template-preview__row ${isBlankTemplate ? 'project-template-preview__row--stock' : ''}`}>
                    <span>{td('dialogs.newProject.previewStock')}</span>
                    {isBlankTemplate ? (
                      <div className={`new-project-stock-dimensions${usesBarStock ? ' new-project-stock-dimensions--bar' : ''}`}>
                        {usesBarStock ? (
                          <>
                            <label className="properties-field properties-field--stock-shape">
                              <span>{td('dialogs.newProject.stockShape')}</span>
                              <Select
                                value={barDraft.shape}
                                options={[
                                  { value: 'round', label: td('dialogs.newProject.shapeRound') },
                                  { value: 'square', label: td('dialogs.newProject.shapeSquare') },
                                ]}
                                onChange={(shape) => setBarDraft((draft) => ({ ...draft, shape }))}
                              />
                            </label>
                            <label className="properties-field">
                              <span>
                                {barDraft.shape === 'round'
                                  ? td('dialogs.newProject.stockDiameter')
                                  : td('dialogs.newProject.stockSide')}
                              </span>
                              <input
                                id="new-project-stock-size"
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={barDraft.size}
                                onChange={(event) => setBarDraft((draft) => ({ ...draft, size: event.target.value }))}
                              />
                            </label>
                            <label className="properties-field">
                              <span>{td('dialogs.newProject.stockLength')}</span>
                              <input
                                id="new-project-stock-length"
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={barDraft.length}
                                onChange={(event) => setBarDraft((draft) => ({ ...draft, length: event.target.value }))}
                              />
                            </label>
                            <label className="properties-field properties-field--stock-axis">
                              <span>{td('dialogs.newProject.stockAxis')}</span>
                              <Select
                                value={barDraft.axis}
                                options={[
                                  { value: 'x', label: td('dialogs.newProject.stockAxisX') },
                                  { value: 'y', label: td('dialogs.newProject.stockAxisY') },
                                ]}
                                onChange={(axis) => setBarDraft((draft) => ({ ...draft, axis }))}
                              />
                            </label>
                          </>
                        ) : (
                          <>
                            <label className="properties-field">
                              <span>{td('dialogs.newProject.stockWidth')}</span>
                              <input
                                id="new-project-stock-width"
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={stockDraft.width}
                                onChange={(event) => setStockDraft((draft) => ({ ...draft, width: event.target.value }))}
                              />
                            </label>
                            <label className="properties-field">
                              <span>{td('dialogs.newProject.stockHeight')}</span>
                              <input
                                id="new-project-stock-height"
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={stockDraft.height}
                                onChange={(event) => setStockDraft((draft) => ({ ...draft, height: event.target.value }))}
                              />
                            </label>
                            <label className="properties-field">
                              <span>{td('dialogs.newProject.stockThickness')}</span>
                              <input
                                id="new-project-stock-thickness"
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={stockDraft.thickness}
                                onChange={(event) => setStockDraft((draft) => ({ ...draft, thickness: event.target.value }))}
                              />
                            </label>
                          </>
                        )}
                      </div>
                    ) : (
                      <strong>{templateSummary.stock}</strong>
                    )}
                  </div>
                  {isBlankTemplate && !chosenTemplate ? <div className="cam-field-message" role="alert">{td('dialogs.newProject.stockDimensionsInvalid')}</div> : null}
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
          <button className="btn-primary" onClick={handleCreate} type="button" disabled={!chosenTemplate}>
            {td('dialogs.newProject.createProject')}
          </button>
        </div>
      </div>
    </div>
  )
}
