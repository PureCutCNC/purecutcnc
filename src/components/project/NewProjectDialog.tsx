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
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { ExampleProjectList } from './ExampleProjectList'
import { Select } from '../Select'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { getStockBounds, newProject } from '../../types/project'
import type { Project, ProjectType } from '../../types/project'
import { formatLength } from '../../utils/units'
import { getActiveMachineDefinition } from '../../engine/gcode/definitions'
import { decodeProjectFormat } from '../../store/helpers/projectFormat'
import { rescueMachinesToLibrary } from '../../machine/store'
import {
  blankTemplateProject,
  defaultBlankStockDraft,
  type BlankStockDraft,
  type BlockStockDraft,
} from './newProjectStock'
import {
  isBlankTemplateKind,
  newProjectType,
  setupOnlyTemplate,
  templateChosenProject,
  type TemplateKind,
} from './newProjectTemplate'
import { machineCandidates } from '../../machine/registry'
import { useMachineLibrary } from '../../machine/useMachineLibrary'
import { PROJECT_TYPES, projectTypeLabelKey } from '../feature-tree/projectTypeChoice'
import { projectTypeKeyNav, projectTypeMetaKey } from './newProjectProjectType'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

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

function stockDimensionsDraft(template: Project): BlockStockDraft {
  const bounds = getStockBounds(template.stock)
  return {
    width: String(bounds.maxX - bounds.minX),
    height: String(bounds.maxY - bounds.minY),
    thickness: String(template.stock.thickness),
  }
}

interface StockNumberInputProps {
  id: string
  value: string
  onChange: (value: string) => void
}

/**
 * One length in the blank template's stock fields, typed as text: the same
 * field the Properties panel uses for a length, with a decimal keyboard on
 * touch and no native number spinner. Every numeric stock field in the dialog
 * renders through it, so a block's width/height/thickness and a bar's
 * size/length look and behave alike (#1046).
 */
function StockNumberInput({ id, value, onChange }: StockNumberInputProps) {
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      spellCheck={false}
      data-numeric-entry="true"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
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
  /** One ref per project type tile, so an arrow key can take focus with it. */
  const projectTypeTilesRef = useRef<Array<HTMLButtonElement | null>>([])
  const { library: machineLibrary } = useMachineLibrary()

  const metricTemplate = useMemo(() => newProject('Untitled', 'mm'), [])
  const imperialTemplate = useMemo(() => newProject('Untitled', 'inch'), [])
  const [stockDraft, setStockDraft] = useState<BlockStockDraft>(() => stockDimensionsDraft(metricTemplate))
  const [barDraft, setBarDraft] = useState<BlankStockDraft>(() => defaultBlankStockDraft(metricTemplate.meta.units))
  const currentProjectTemplate = useMemo(() => setupOnlyTemplate(project).project, [project])
  const fileProjectTemplate = useMemo(() => (fileTemplate ? setupOnlyTemplate(fileTemplate).project : null), [fileTemplate])

  const blankTemplate = isBlankTemplateKind(templateKind)

  /**
   * The type the dialog will create (issue #1112, item 24): the template's own
   * for the current project and a template file, the tiles' choice for a
   * blank template. A template brings its type, so the tiles are shown locked
   * on it rather than offering a choice that would be discarded.
   */
  const chosenType = newProjectType(
    templateKind,
    projectTypeChoice,
    templateKind === 'current' ? currentProjectTemplate : fileProjectTemplate,
  )
  // The blank template's stock fields follow the type (issue #1046): rotary
  // asks for the bar it machines, milling and plasma keep width × height ×
  // thickness.
  const usesBarStock = blankTemplate && chosenType === 'rotary'

  /**
   * The project the dialog will create. A blank template's stock is built as
   * the shape its type machines (issue #1046) and the chosen type then sets
   * the stored type and, when the template's machine does not suit it, the
   * first matching machine from the picker's candidate list (issue #1028). A
   * current or file template keeps its own type, stock, chuck and machine
   * (issue #1112, item 24).
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
        return templateChosenProject('current', currentProjectTemplate, projectTypeChoice, machineLibrary)
      case 'file':
        if (!fileProjectTemplate) return null
        return templateChosenProject('file', fileProjectTemplate, projectTypeChoice, machineLibrary)
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

  /**
   * Arrow keys move the project type choice across the three tiles and take
   * focus with them, wrapping at both ends (issue #1102, proposal 16). Tab
   * enters the group once, on the checked tile. A template brings its own type
   * (issue #1112, item 24), so the group is locked and the keys do nothing.
   */
  function handleProjectTypeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!blankTemplate) {
      return
    }
    const next = projectTypeKeyNav(projectTypeChoice, event.key)
    if (next === projectTypeChoice) {
      return
    }
    event.preventDefault()
    setProjectTypeChoice(next)
    projectTypeTilesRef.current[PROJECT_TYPES.indexOf(next)]?.focus()
  }

  function handleTemplateFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.onload = (readerEvent) => {
      try {
        const parsed = JSON.parse(readerEvent.target?.result as string) as unknown
        // Decode now so a structurally unreadable machine refuses the template
        // visibly instead of throwing while the dialog renders, and so the
        // file's other machines reach My Machines rather than disappearing
        // (#1119). The selected snapshot is kept, including a template-invalid
        // one; export refuses it later.
        const decoded = decodeProjectFormat(parsed, rescueMachinesToLibrary)
        setFileTemplate(decoded.project)
        setFileLabel(file.name)
        setFileError(null)
        setTemplateKind('file')
      } catch (error) {
        setFileTemplate(null)
        setFileLabel(file.name)
        setFileError(
          error instanceof SyntaxError
            ? td('dialogs.newProject.templateFileParseError')
            : (error instanceof Error ? error.message : td('dialogs.newProject.templateFileParseError')),
        )
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
              <div className="dialog-section-title">{td('dialogs.newProject.projectType')}</div>
              <div
                className="project-template-list project-template-list--project-type"
                role="radiogroup"
                aria-label={td('dialogs.newProject.projectType')}
                onKeyDown={handleProjectTypeKeyDown}
              >
                {PROJECT_TYPES.map((type, index) => {
                  const selected = chosenType === type
                  const label = t(projectTypeLabelKey(type))
                  return (
                    <button
                      key={type}
                      ref={(element) => { projectTypeTilesRef.current[index] = element }}
                      className={`project-template-card ${selected ? 'project-template-card--active' : ''}`}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={label}
                      aria-describedby={`new-project-type-${type}-meta`}
                      tabIndex={selected ? 0 : -1}
                      disabled={!blankTemplate}
                      onClick={() => setProjectTypeChoice(type)}
                    >
                      <span className="project-template-card__title">{label}</span>
                      <span className="project-template-card__meta" id={`new-project-type-${type}-meta`}>{td(projectTypeMetaKey(type))}</span>
                    </button>
                  )
                })}
              </div>
              {blankTemplate ? null : (
                <div className="new-project-type-note">{td('dialogs.newProject.projectTypeLocked')}</div>
              )}
            </div>

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
              <div className="project-template-list project-template-list--template">
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
                  <div className={`project-template-preview__row ${blankTemplate ? 'project-template-preview__row--stock' : ''}`}>
                    <span>{td('dialogs.newProject.previewStock')}</span>
                    {blankTemplate ? (
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
                              <StockNumberInput
                                id="new-project-stock-size"
                                value={barDraft.size}
                                onChange={(size) => setBarDraft((draft) => ({ ...draft, size }))}
                              />
                            </label>
                            <label className="properties-field">
                              <span>{td('dialogs.newProject.stockLength')}</span>
                              <StockNumberInput
                                id="new-project-stock-length"
                                value={barDraft.length}
                                onChange={(length) => setBarDraft((draft) => ({ ...draft, length }))}
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
                              <StockNumberInput
                                id="new-project-stock-width"
                                value={stockDraft.width}
                                onChange={(width) => setStockDraft((draft) => ({ ...draft, width }))}
                              />
                            </label>
                            <label className="properties-field">
                              <span>{td('dialogs.newProject.stockHeight')}</span>
                              <StockNumberInput
                                id="new-project-stock-height"
                                value={stockDraft.height}
                                onChange={(height) => setStockDraft((draft) => ({ ...draft, height }))}
                              />
                            </label>
                            <label className="properties-field">
                              <span>{td('dialogs.newProject.stockThickness')}</span>
                              <StockNumberInput
                                id="new-project-stock-thickness"
                                value={stockDraft.thickness}
                                onChange={(thickness) => setStockDraft((draft) => ({ ...draft, thickness }))}
                              />
                            </label>
                          </>
                        )}
                      </div>
                    ) : (
                      <strong>{templateSummary.stock}</strong>
                    )}
                  </div>
                  {blankTemplate && !chosenTemplate ? <div className="cam-field-message" role="alert">{td('dialogs.newProject.stockDimensionsInvalid')}</div> : null}
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
