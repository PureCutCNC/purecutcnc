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

import { useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Icon } from '../Icon'
import { ExpandedPanelContext } from '../layout/expandedPanelContext'
import { Select } from '../Select'
import { DisclosureSection } from '../common/DisclosureSection'
import { ZRangeSlider } from './ZRangeSlider'
import { defaultStock, getStockBounds, profileExceedsStock, profileHasSelfIntersection } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { getDefinitionId, getInstanceIdsForDefinition } from '../../store/helpers/featureDefinitions'
import { isMachinable, isSolid, sectionForOperation } from '../../store/helpers/featureRoles'
import type { FeatureTreeSection } from '../../store/helpers/featureRoles'
import { defaultFontIdForStyle, getTextFontOptions } from '../../text'
import { convertLength, formatLength, parseLengthInput } from '../../utils/units'
import { MachineDefinitionManagerDialog } from '../machine/MachineDefinitionManagerDialog'
import { UnitConversionDialog } from '../project/UnitConversionDialog'
import type { FeatureOperation, Project, RegionMaskMode } from '../../types/project'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { useI18n } from '../../i18n/i18nContext'

interface DraftTextInputProps {
  value: string
  disabled?: boolean
  onCommit?: (value: string) => void
}

function DraftTextInput({ value, disabled = false, onCommit }: DraftTextInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = value
  }

  function commit(element: HTMLInputElement) {
    if (!onCommit) {
      reset(element)
      return
    }

    if (element.value !== value) {
      onCommit(element.value)
    } else {
      reset(element)
    }
  }

  return (
    <input
      type="text"
      defaultValue={value}
      disabled={disabled}
      spellCheck={false}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
          return
        }

        if (event.key === 'Escape') {
          reset(event.currentTarget)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

interface DraftNumberInputProps {
  value: number | null
  units: 'mm' | 'inch'
  min?: number
  max?: number
  disabled?: boolean
  placeholder?: string
  onCommit: (value: number) => void
  validate?: (value: number) => boolean
}

function DraftNumberInput({
  value,
  units,
  min,
  max,
  disabled = false,
  placeholder,
  onCommit,
  validate,
}: DraftNumberInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = value === null ? '' : formatLength(value, units)
  }

  function isValid(next: number) {
    if (!Number.isFinite(next)) return false
    if (min !== undefined && next < min) return false
    if (max !== undefined && next > max) return false
    if (validate && !validate(next)) return false
    return true
  }

  function commit(element: HTMLInputElement) {
    if (element.value.trim() === '') {
      reset(element)
      return
    }

    const next = parseLengthInput(element.value, units)
    if (next === null || !isValid(next)) {
      reset(element)
      return
    }

    if (value === null || next !== value) {
      onCommit(next)
    } else {
      reset(element)
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      defaultValue={value === null ? '' : formatLength(value, units)}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      data-numeric-entry="true"
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
          return
        }

        if (event.key === 'Escape') {
          reset(event.currentTarget)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function PropertiesPanel() {
  const {
    project,
    selection,
    addFeatureFolder,
    startAddTabPlacement,
    startAddClampPlacement,
    assignFeaturesToFolder,
    deleteTab,
    deleteClamp,
    deleteFeatureFolder,
    toggleFolderGrouped,
    setProjectName,
    setShowFeatureInfo,
    setProjectClearances,
    setSelectedMachineId,
    refreshMachineDefinitions,
    setOrigin,
    startPlaceOrigin,
    loadBackdropImage,
    backdropImageLoading,
    setBackdropImageLoading,
    updateBackdrop,
    deleteBackdrop,
    startMoveBackdrop,
    startResizeBackdrop,
    startRotateBackdrop,
    setGrid,
    setStock,
    setStockSourceFeature,
    setUnits,
    updateTab,
    updateClamp,
    updateFeatureFolder,
    updateFeature,
    updateFeatures,
    deleteFeature,
    deleteFeatures,
    enterSketchEdit,
    enterStockSketchEdit,
    enterTabEdit,
    enterClampEdit,
    deleteConstraint,
    makeUnique,
    expandTextFeature,
  } = useProjectStore()
  const features = useMemo(() => resolvedProjectFeatures(project), [project])
  const { t } = useI18n()
  const backdropFileInputRef = useRef<HTMLInputElement>(null)
  const expandedPanelCtx = useContext(ExpandedPanelContext)
  const closeExpanded = useCallback(
    () => expandedPanelCtx?.closeExpandedPanel(),
    [expandedPanelCtx],
  )

  const selectedFeatureIds = selection.selectedFeatureIds
  const selectedFeatureId = selectedFeatureIds.length === 1 ? selectedFeatureIds[0] : null
  const units = project.meta.units
  const minimumLength = convertLength(1, 'mm', units)
  const minimumPanelSpan = convertLength(20, 'mm', units)
  const minimumSnap = convertLength(0.0001, 'mm', units)

  const selectedFeature = selectedFeatureId
    ? features.find((feature) => feature.id === selectedFeatureId) ?? null
    : null
  const selectedNode = selection.selectedNode
  const selectedFolder =
    selectedNode?.type === 'folder'
      ? project.featureFolders.find((folder) => folder.id === selectedNode.folderId) ?? null
      : null
  const selectedClamp =
    selectedNode?.type === 'clamp'
      ? project.clamps.find((clamp) => clamp.id === selectedNode.clampId) ?? null
      : null
  const selectedTab =
    selectedNode?.type === 'tab'
      ? project.tabs.find((tab) => tab.id === selectedNode.tabId) ?? null
      : null
  const allSelectedFeatures = features.filter((feature) => selectedFeatureIds.includes(feature.id))
  const commonSelectedFolderId =
    allSelectedFeatures.length > 0 &&
    allSelectedFeatures.every((feature) => feature.folderId === allSelectedFeatures[0]?.folderId)
      ? allSelectedFeatures[0]?.folderId ?? null
      : '__mixed__'
  // P2-1: all selected features are in a grouped folder — disable the folder dropdown.
  const allSelectedInGroupedFolder =
    allSelectedFeatures.length > 0 &&
    allSelectedFeatures.every((f) => {
      if (!f.folderId) return false
      const folder = project.featureFolders.find((ff) => ff.id === f.folderId)
      return folder?.grouped === true
    })
  const commonSelectedOperation =
    allSelectedFeatures.length > 0 &&
    allSelectedFeatures.every((feature) => feature.operation === allSelectedFeatures[0]?.operation)
      ? allSelectedFeatures[0]?.operation ?? null
      : '__mixed__'
  const selectedRegionFeatures = allSelectedFeatures.filter((feature) => feature.operation === 'region')
  const commonSelectedRegionMaskMode =
    selectedRegionFeatures.length > 0 &&
    selectedRegionFeatures.every(
      (feature) => (feature.regionMaskMode ?? 'include') === (selectedRegionFeatures[0]?.regionMaskMode ?? 'include'),
    )
      ? selectedRegionFeatures[0]?.regionMaskMode ?? 'include'
      : '__mixed__'
  const selectedZEditableFeatures = allSelectedFeatures.filter(isMachinable)
  const selectedZEditableFeatureIds = selectedZEditableFeatures.map((feature) => feature.id)
  const selectedClosedEditableFeatures = selectedZEditableFeatures.filter((feature) => feature.sketch.profile.closed)
  const selectedOpenEditableFeatures = selectedZEditableFeatures.filter((feature) => !feature.sketch.profile.closed)
  const hasOpenEditableFeatures = selectedOpenEditableFeatures.length > 0
  const commonSelectedZTop =
    selectedZEditableFeatures.length > 0 &&
    typeof selectedZEditableFeatures[0]?.z_top === 'number' &&
    selectedZEditableFeatures.every((feature) => feature.z_top === selectedZEditableFeatures[0]?.z_top)
      ? selectedZEditableFeatures[0]?.z_top ?? null
      : null
  const commonSelectedZBottom =
    selectedClosedEditableFeatures.length > 0 &&
    typeof selectedClosedEditableFeatures[0]?.z_bottom === 'number' &&
    selectedClosedEditableFeatures.every((feature) => feature.z_bottom === selectedClosedEditableFeatures[0]?.z_bottom)
      ? selectedClosedEditableFeatures[0]?.z_bottom ?? null
      : null
  const selectedNumericZBottoms = selectedClosedEditableFeatures
    .map((feature) => feature.z_bottom)
    .filter((value): value is number => typeof value === 'number')
  const selectedNumericZTops = selectedZEditableFeatures
    .map((feature) => feature.z_top)
    .filter((value): value is number => typeof value === 'number')
  const multiEditMinZTop =
    selectedNumericZBottoms.length === selectedClosedEditableFeatures.length
      ? Math.max(...selectedNumericZBottoms)
      : null
  const multiEditMaxZBottom =
    selectedNumericZTops.length === selectedZEditableFeatures.length
      ? Math.min(...selectedNumericZTops)
      : null
  const selectedMachine = project.meta.selectedMachineId
      ? project.meta.machineDefinitions.find((definition) => definition.id === project.meta.selectedMachineId) ?? null
      : null

  function handleBackdropFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    if (!file.type.startsWith('image/')) {
      alert(t('featureTree.properties.backdrop.mustBeImage'))
      event.target.value = ''
      return
    }

    setBackdropImageLoading(true)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null
      if (!dataUrl) {
        alert(t('featureTree.properties.backdrop.readFailed'))
        setBackdropImageLoading(false)
        event.target.value = ''
        return
      }

      const image = new Image()
      image.onload = () => {
        loadBackdropImage({
          name: file.name.replace(/\.[^.]+$/, '') || 'Backdrop',
          mimeType: file.type || 'image/png',
          imageDataUrl: dataUrl,
          intrinsicWidth: image.naturalWidth || image.width || 1,
          intrinsicHeight: image.naturalHeight || image.height || 1,
        })
        event.target.value = ''
      }
      image.onerror = () => {
        alert(t('featureTree.properties.backdrop.decodeFailed'))
        setBackdropImageLoading(false)
        event.target.value = ''
      }
      image.src = dataUrl
    }
    reader.onerror = () => {
      alert(t('featureTree.properties.backdrop.readFailed'))
      setBackdropImageLoading(false)
      event.target.value = ''
    }
    reader.readAsDataURL(file)
  }

  const [showManager, setShowManager] = useState(false)
  const [pendingUnits, setPendingUnits] = useState<Project['meta']['units'] | null>(null)

  function commitPendingUnits(mode: 'convert' | 'reinterpret') {
    if (!pendingUnits || pendingUnits === project.meta.units) return
    const nextUnits = pendingUnits
    setPendingUnits(null)
    setUnits(nextUnits, mode)
  }

  function renderContent() {

  function renderFolderSelect(value: string | '__mixed__' | null, onChange: (folderId: string | null) => void, disabled?: boolean, section?: FeatureTreeSection) {
    const folders = section
      ? project.featureFolders.filter((folder) => (folder.section ?? 'features') === section)
      : project.featureFolders
    return (
      <Select
        value={value ?? ''}
        options={[
          ...(value === '__mixed__' ? [{ value: '__mixed__', label: t('featureTree.properties.select.mixedFolders') }] : []),
          { value: '', label: t('featureTree.properties.select.root') },
          ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
        ]}
        onChange={(next) => onChange(next === '' || next === '__mixed__' ? null : next)}
        disabled={disabled}
      />
    )
  }

  if (selection.selectedNode?.type === 'project') {
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput
              key={`project-name-${project.meta.name}`}
              value={project.meta.name}
              onCommit={setProjectName}
            />
          </label>
          <label className="properties-field">
            <span>{t('featureTree.properties.units')}</span>
            <Select
              value={project.meta.units}
              options={[
                { value: 'mm', label: t('featureTree.properties.units.mm') },
                { value: 'inch', label: t('featureTree.properties.units.inch') },
              ]}
              onChange={(value) => {
                if (value !== project.meta.units) setPendingUnits(value)
              }}
            />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={project.meta.showFeatureInfo}
              onChange={(event) => setShowFeatureInfo(event.target.checked)}
            />
            {t('featureTree.properties.showFeatureInfo')}
          </label>
          <label className="properties-field">
            <span>{t('featureTree.properties.safeZ')}</span>
            <DraftNumberInput
              key={`project-max-travel-z-${project.meta.maxTravelZ}`}
              value={project.meta.maxTravelZ}
              units={units}
              min={0}
              onCommit={(next) => setProjectClearances({ maxTravelZ: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t('featureTree.properties.opClearZ')}</span>
            <DraftNumberInput
              key={`project-operation-clearance-z-${project.meta.operationClearanceZ}`}
              value={project.meta.operationClearanceZ}
              units={units}
              min={0}
              onCommit={(next) => setProjectClearances({ operationClearanceZ: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.clampClearXY")}</span>
            <DraftNumberInput
              key={`project-clamp-clearance-xy-${project.meta.clampClearanceXY}`}
              value={project.meta.clampClearanceXY}
              units={units}
              min={0}
              onCommit={(next) => setProjectClearances({ clampClearanceXY: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.clampClearZ")}</span>
            <DraftNumberInput
              key={`project-clamp-clearance-z-${project.meta.clampClearanceZ}`}
              value={project.meta.clampClearanceZ}
              units={units}
              min={0}
              onCommit={(next) => setProjectClearances({ clampClearanceZ: next })}
            />
          </label>
          <label className="properties-field properties-field--machine">
            <div className="properties-field-label-row">
              <span>{t("featureTree.properties.machine")}</span>
              <button
                type="button"
                className="tree-action-btn properties-refresh-btn"
                onClick={refreshMachineDefinitions}
                aria-label={t('featureTree.properties.machine.refresh')}
                title={t('featureTree.properties.machine.refresh')}
              >
                <Icon id="refresh" size={15} />
              </button>
            </div>
            <Select
              value={project.meta.selectedMachineId ?? ''}
              options={[
                { value: '', label: t('featureTree.properties.machine.none') },
                ...project.meta.machineDefinitions.map((definition) => ({ value: definition.id, label: definition.name })),
              ]}
              onChange={(value) => setSelectedMachineId(value || null)}
            />
          </label>
          {selectedMachine ? (
            <div className="properties-machine-status">
              <span className={selectedMachine.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                {selectedMachine.builtin ? t('featureTree.properties.machine.builtin') : t('featureTree.properties.machine.custom')}
              </span>
              <span className="properties-machine-ext">.{selectedMachine.fileExtension}</span>
              {selectedMachine.builtin ? (
                <span className="properties-machine-hint">{t('featureTree.properties.machine.duplicateHint')}</span>
              ) : null}
            </div>
          ) : null}
          <div className="properties-actions">
            <button type="button" onClick={() => setShowManager(true)}>
              {t('featureTree.properties.machine.manage')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (selection.selectedNode?.type === 'grid') {
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput value={t('featureTree.properties.name.grid')} disabled />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.gridExtent")}</span>
            <DraftNumberInput
              key={`grid-extent-${project.grid.extent}`}
              value={project.grid.extent}
              units={units}
              min={minimumPanelSpan}
              onCommit={(next) => setGrid({ ...project.grid, extent: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.majorLines")}</span>
            <DraftNumberInput
              key={`grid-major-${project.grid.majorSpacing}-${project.grid.minorSpacing}`}
              value={project.grid.majorSpacing}
              units={units}
              min={minimumLength}
              validate={(next) => next >= project.grid.minorSpacing}
              onCommit={(next) => setGrid({ ...project.grid, majorSpacing: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.minorLines")}</span>
            <DraftNumberInput
              key={`grid-minor-${project.grid.minorSpacing}-${project.grid.majorSpacing}`}
              value={project.grid.minorSpacing}
              units={units}
              min={minimumLength}
              validate={(next) => next <= project.grid.majorSpacing}
              onCommit={(next) => setGrid({ ...project.grid, minorSpacing: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.snapIncrement")}</span>
            <DraftNumberInput
              key={`grid-snap-${project.grid.snapIncrement}-${project.meta.units}`}
              value={project.grid.snapIncrement}
              units={units}
              min={minimumSnap}
              onCommit={(next) => setGrid({ ...project.grid, snapIncrement: next })}
            />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={project.grid.visible}
              onChange={(event) => setGrid({ ...project.grid, visible: event.target.checked })}
            />
            <span>{t("featureTree.properties.visible")}</span>
          </label>
        </div>
      </div>
    )
  }

  if (selection.selectedNode?.type === 'stock') {
    const isFeatureStock = !!project.stock.sourceFeatureId && !!project.stock.sourceFeature
    const bounds = getStockBounds(project.stock)
    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY

    if (isFeatureStock) {
      const sourceFeature = project.stock.sourceFeature!
      return (
        <div className="properties-panel">
          <div className="properties-group">
            <label className="properties-field">
              <span>{t('featureTree.properties.name')}</span>
              <DraftTextInput value={t('featureTree.properties.stock.nameDisabled')} disabled />
            </label>
            <label className="properties-field">
              <span>{t("featureTree.properties.sourceFeature")}</span>
              <DraftTextInput value={sourceFeature.name} disabled />
            </label>
            <label className="properties-field">
              <span>{t("featureTree.properties.thickness")}</span>
              <DraftNumberInput
                key={`stock-thickness-${project.stock.thickness}`}
                value={project.stock.thickness}
                units={units}
                min={minimumLength}
                onCommit={(next) => {
                  setStock({ ...project.stock, thickness: next })
                }}
              />
            </label>
            <label className="properties-field">
              <span>{t("featureTree.properties.color")}</span>
              <input
                type="color"
                value={project.stock.color}
                onChange={(event) => {
                  setStock({ ...project.stock, color: event.target.value })
                }}
              />
            </label>
            <label className="properties-check">
              <input
                type="checkbox"
                checked={project.stock.visible}
                onChange={(event) => {
                  setStock({ ...project.stock, visible: event.target.checked })
                }}
              />
              <span>{t("featureTree.properties.visible")}</span>
            </label>
            <div className="properties-actions" style={{ display: 'flex', gap: '8px', marginTop: '12px', flexDirection: 'column' }}>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => { enterStockSketchEdit(sourceFeature.id); closeExpanded() }}
              >
                {t('featureTree.properties.stock.editSketch')}
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => { setStockSourceFeature(null); closeExpanded() }}
              >
                {t('featureTree.properties.stock.resetToRect')}
              </button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput value={t('featureTree.properties.stock.nameDisabled')} disabled />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.width")}</span>
            <DraftNumberInput
              key={`stock-width-${width}-${height}-${project.stock.thickness}`}
              value={width}
              units={units}
              min={minimumPanelSpan}
              onCommit={(next) => {
                const stock = defaultStock(next, height, project.stock.thickness)
                stock.material = project.stock.material
                stock.color = project.stock.color
                stock.visible = project.stock.visible
                setStock(stock)
              }}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.height")}</span>
            <DraftNumberInput
              key={`stock-height-${width}-${height}-${project.stock.thickness}`}
              value={height}
              units={units}
              min={minimumPanelSpan}
              onCommit={(next) => {
                const stock = defaultStock(width, next, project.stock.thickness)
                stock.material = project.stock.material
                stock.color = project.stock.color
                stock.visible = project.stock.visible
                setStock(stock)
              }}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.thickness")}</span>
            <DraftNumberInput
              key={`stock-thickness-${width}-${height}-${project.stock.thickness}`}
              value={project.stock.thickness}
              units={units}
              min={minimumLength}
              onCommit={(next) => {
                const stock = defaultStock(width, height, next)
                stock.material = project.stock.material
                stock.color = project.stock.color
                stock.visible = project.stock.visible
                setStock(stock)
              }}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.color")}</span>
            <input
              type="color"
              value={project.stock.color}
              onChange={(event) => {
                const stock = defaultStock(width, height, project.stock.thickness)
                stock.material = project.stock.material
                stock.color = event.target.value
                stock.visible = project.stock.visible
                setStock(stock)
              }}
            />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={project.stock.visible}
              onChange={(event) => {
                const stock = defaultStock(width, height, project.stock.thickness)
                stock.material = project.stock.material
                stock.color = project.stock.color
                stock.visible = event.target.checked
                setStock(stock)
              }}
            />
            <span>{t("featureTree.properties.visible")}</span>
          </label>
        </div>
      </div>
    )
  }

  if (selection.selectedNode?.type === 'origin') {
    const bounds = getStockBounds(project.stock)

    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput
              key={`origin-name-${project.origin.name}`}
              value={project.origin.name}
              onCommit={(next) => setOrigin({ ...project.origin, name: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.z")}</span>
            <DraftNumberInput
              key={`origin-z-${project.origin.z}`}
              value={project.origin.z}
              units={units}
              onCommit={(next) => setOrigin({ ...project.origin, z: next })}
            />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={project.origin.visible}
              onChange={(event) => setOrigin({ ...project.origin, visible: event.target.checked })}
            />
            <span>{t("featureTree.properties.visible")}</span>
          </label>
        </div>

        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => { startPlaceOrigin(); closeExpanded() }}>
            {t('featureTree.properties.origin.placeOrigin')}
          </button>
        </div>

        <div className="properties-group">
          <span className="dialog-section-title" style={{ fontSize: '11px', marginBottom: '4px', display: 'block' }}>{t('featureTree.properties.origin.presets')}</span>
          <div className="properties-actions">
            <button 
              className="feat-btn" 
              type="button"
              onClick={() => setOrigin({ ...project.origin, x: bounds.minX, y: bounds.minY, z: project.stock.thickness })}
            >
              {t('featureTree.properties.origin.topLeft')}
            </button>
            <button 
              className="feat-btn" 
              type="button"
              onClick={() => setOrigin({ ...project.origin, x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, z: project.stock.thickness })}
            >
              {t('featureTree.properties.origin.centerTop')}
            </button>
            <button 
              className="feat-btn" 
              type="button"
              onClick={() => setOrigin({ ...project.origin, x: bounds.minX, y: bounds.maxY, z: 0 })}
            >
              {t('featureTree.properties.origin.bottomLeft')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (selection.selectedNode?.type === 'backdrop') {
    const backdrop = project.backdrop

    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput
              key={`backdrop-name-${backdrop?.name ?? 'Backdrop'}`}
              value={backdrop?.name ?? 'Backdrop'}
              disabled={!backdrop}
              onCommit={(next) => backdrop && updateBackdrop({ name: next || 'Backdrop' })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.image")}</span>
            <DraftTextInput
              key={`backdrop-image-${backdrop?.imageDataUrl ?? 'none'}-${backdrop?.intrinsicWidth ?? 0}-${backdrop?.intrinsicHeight ?? 0}`}
              value={backdrop ? `${backdrop.name} (${backdrop.intrinsicWidth} × ${backdrop.intrinsicHeight})` : t('featureTree.properties.backdrop.noImage')}
              disabled
            />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={backdrop?.visible ?? false}
              disabled={!backdrop}
              onChange={(event) => updateBackdrop({ visible: event.target.checked })}
            />
            <span>{t("featureTree.properties.visible")}</span>
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.opacity")}</span>
            <input
              type="range"
              min="5"
              max="100"
              step="1"
              value={Math.round((backdrop?.opacity ?? 0.6) * 100)}
              disabled={!backdrop}
              onChange={(event) => updateBackdrop({ opacity: Number(event.target.value) / 100 })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.width")}</span>
            <DraftNumberInput
              key={`backdrop-width-${backdrop?.width ?? 0}`}
              value={backdrop?.width ?? 0}
              units={units}
              min={minimumLength}
              disabled={!backdrop}
              onCommit={(next) => updateBackdrop({ width: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.height")}</span>
            <DraftNumberInput
              key={`backdrop-height-${backdrop?.height ?? 0}`}
              value={backdrop?.height ?? 0}
              units={units}
              min={minimumLength}
              disabled={!backdrop}
              onCommit={(next) => updateBackdrop({ height: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.angle")}</span>
            <DraftTextInput
              key={`backdrop-angle-${backdrop?.orientationAngle ?? 90}`}
              value={String(Math.round((backdrop?.orientationAngle ?? 90) * 1000) / 1000)}
              disabled={!backdrop}
              onCommit={(next) => {
                const parsed = Number(next)
                if (Number.isFinite(parsed)) {
                  updateBackdrop({ orientationAngle: parsed })
                }
              }}
            />
          </label>
        </div>

        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => backdropFileInputRef.current?.click()} disabled={backdropImageLoading}>
            {backdropImageLoading ? t('featureTree.properties.backdrop.loading') : backdrop ? t('featureTree.properties.backdrop.replaceImage') : t('featureTree.properties.backdrop.loadImage')}
          </button>
          <button className="feat-btn" type="button" onClick={() => { startMoveBackdrop(); closeExpanded() }} disabled={!backdrop || backdropImageLoading}>
            {t('featureTree.properties.backdrop.move')}
          </button>
          <button className="feat-btn" type="button" onClick={() => { startResizeBackdrop(); closeExpanded() }} disabled={!backdrop || backdropImageLoading}>
            {t('featureTree.properties.backdrop.resize')}
          </button>
          <button className="feat-btn" type="button" onClick={() => { startRotateBackdrop(); closeExpanded() }} disabled={!backdrop || backdropImageLoading}>
            {t('featureTree.properties.backdrop.rotate')}
          </button>
          <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteBackdrop(); closeExpanded() }} disabled={!backdrop || backdropImageLoading}>
            {t('featureTree.properties.backdrop.delete')}
          </button>
        </div>
        {backdropImageLoading ? (
          <div className="properties-inline-status" role="status" aria-live="polite">
            <span className="inline-spinner" aria-hidden="true" />
            {t('featureTree.properties.backdrop.decoding')}
          </div>
        ) : null}

        <input
          ref={backdropFileInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          style={{ display: 'none' }}
          onChange={handleBackdropFileChange}
        />
      </div>
    )
  }

  if (selection.selectedNode?.type === 'features_root') {
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput value={t('featureTree.properties.name.features')} disabled />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.folders")}</span>
            <DraftTextInput value={`${project.featureFolders.length}`} disabled />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.features")}</span>
            <DraftTextInput value={`${features.length}`} disabled />
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => { addFeatureFolder(); closeExpanded() }}>
            {t('featureTree.properties.actions.addFolder')}
          </button>
        </div>
      </div>
    )
  }

  if (selection.selectedNode?.type === 'clamps_root') {
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput value={t('featureTree.properties.name.clamps')} disabled />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.clamps")}</span>
            <DraftTextInput value={`${project.clamps.length}`} disabled />
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => { startAddClampPlacement(); closeExpanded() }}>
            {t('featureTree.properties.actions.addClamp')}
          </button>
        </div>
      </div>
    )
  }

  if (selection.selectedNode?.type === 'tabs_root') {
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput value={t('featureTree.properties.name.tabs')} disabled />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.tabs")}</span>
            <DraftTextInput value={`${project.tabs.length}`} disabled />
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => { startAddTabPlacement(); closeExpanded() }}>
            {t('featureTree.properties.actions.addTab')}
          </button>
        </div>
      </div>
    )
  }

  if (selectedFolder) {
    const featureCount = features.filter((feature) => feature.folderId === selectedFolder.id).length

    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput
              key={`folder-name-${selectedFolder.id}-${selectedFolder.name}`}
              value={selectedFolder.name}
              onCommit={(next) => updateFeatureFolder(selectedFolder.id, { name: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.features")}</span>
            <DraftTextInput value={`${featureCount}`} disabled />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={!selectedFolder.collapsed}
              onChange={(event) =>
                updateFeatureFolder(selectedFolder.id, { collapsed: !event.target.checked })
              }
            />
            <span>{t("featureTree.properties.expanded")}</span>
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteFeatureFolder(selectedFolder.id); closeExpanded() }}>
            {t('featureTree.properties.actions.deleteFolder')}
          </button>
        </div>
      </div>
    )
  }

  if (selectedClamp) {
    const minimumClampSize = convertLength(0.1, 'mm', units)
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput
              key={`clamp-name-${selectedClamp.id}-${selectedClamp.name}`}
              value={selectedClamp.name}
              onCommit={(next) => updateClamp(selectedClamp.id, { name: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.zTop")}</span>
            <DraftNumberInput
              key={`clamp-height-${selectedClamp.id}-${selectedClamp.height}`}
              value={selectedClamp.height}
              units={units}
              min={minimumClampSize}
              onCommit={(next) => updateClamp(selectedClamp.id, { height: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.zBottom")}</span>
            <DraftNumberInput
              key={`clamp-zbottom-${selectedClamp.id}`}
              value={0}
              units={units}
              min={0}
              max={0}
              onCommit={() => {}}
            />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={selectedClamp.visible}
              onChange={(event) => updateClamp(selectedClamp.id, { visible: event.target.checked })}
            />
            <span>{t("featureTree.properties.visible")}</span>
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => { enterClampEdit(selectedClamp.id); closeExpanded() }}>
            {t('featureTree.properties.stock.editSketch')}
          </button>
          <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteClamp(selectedClamp.id); closeExpanded() }}>
            {t('featureTree.properties.actions.deleteClamp')}
          </button>
        </div>
      </div>
    )
  }

  if (selectedTab) {
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput
              key={`tab-name-${selectedTab.id}-${selectedTab.name}`}
              value={selectedTab.name}
              onCommit={(next) => updateTab(selectedTab.id, { name: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.zTop")}</span>
            <DraftNumberInput
              key={`tab-ztop-${selectedTab.id}-${selectedTab.z_top}`}
              value={selectedTab.z_top}
              units={units}
              min={0}
              validate={(next) => next >= selectedTab.z_bottom}
              onCommit={(next) => updateTab(selectedTab.id, { z_top: next })}
            />
          </label>
          <label className="properties-field">
            <span>{t("featureTree.properties.zBottom")}</span>
            <DraftNumberInput
              key={`tab-zbottom-${selectedTab.id}-${selectedTab.z_bottom}`}
              value={selectedTab.z_bottom}
              units={units}
              min={0}
              validate={(next) => next <= selectedTab.z_top}
              onCommit={(next) => updateTab(selectedTab.id, { z_bottom: next })}
            />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={selectedTab.visible}
              onChange={(event) => updateTab(selectedTab.id, { visible: event.target.checked })}
            />
            <span>{t("featureTree.properties.visible")}</span>
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => { enterTabEdit(selectedTab.id); closeExpanded() }}>
            {t('featureTree.properties.stock.editSketch')}
          </button>
          <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteTab(selectedTab.id); closeExpanded() }}>
            {t('featureTree.properties.actions.deleteTab')}
          </button>
        </div>
      </div>
    )
  }

  if (!selectedFeature) {
    if (selectedFeatureIds.length > 1) {
      return (
        <div className="properties-panel">
          {selection.groupFolderId ? (() => {
            const groupFolder = project.featureFolders.find(f => f.id === selection.groupFolderId)
            if (!groupFolder) return null
            return (
              <div className="properties-group">
                <span className="properties-section-title">{t('featureTree.properties.multi.group')}</span>
                <label className="properties-field">
                  <span>{t('featureTree.properties.name')}</span>
                  <DraftTextInput
                    key={`group-name-${groupFolder.id}-${groupFolder.name}`}
                    value={groupFolder.name}
                    onCommit={(next) => updateFeatureFolder(groupFolder.id, { name: next })}
                  />
                </label>
                <div className="properties-actions">
                  <button className="feat-btn" type="button" onClick={() => toggleFolderGrouped(groupFolder.id)}>
                    {t('featureTree.properties.multi.ungroup')}
                  </button>
                  <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteFeatureFolder(groupFolder.id); closeExpanded() }}>
                    {t('featureTree.properties.multi.deleteGroup')}
                  </button>
                </div>
              </div>
            )
          })() : null}
          <div className="properties-group">
            <label className="properties-field">
              <span>{t("featureTree.properties.selection")}</span>
              <DraftTextInput value={t('featureTree.properties.multi.featuresCount', { count: selectedFeatureIds.length })} disabled />
            </label>
            <label className="properties-field">
              <span>{t("featureTree.properties.editSketch")}</span>
              <DraftTextInput value={t('featureTree.properties.editSketchDisabledMulti')} disabled />
            </label>
            <label className="properties-field">
              <span>{t("featureTree.properties.folder")}</span>
              {renderFolderSelect(commonSelectedFolderId, (folderId) => {
                assignFeaturesToFolder(selectedFeatureIds, folderId)
              }, allSelectedInGroupedFolder)}
            </label>
            <label className="properties-field">
              <span>{t("featureTree.properties.operation")}</span>
              {allSelectedFeatures.length > 0 && allSelectedFeatures.every((f) => !f.sketch.profile.closed) ? (
                <div className="properties-locked-field" title={t('featureTree.properties.multi.editSketchDisabled')}>
                  <span>{t('featureTree.properties.multi.openProfiles')}</span>
                  <span className="properties-locked-hint" aria-hidden="true">🔒</span>
                </div>
              ) : allSelectedFeatures.some((f) => f.operation === 'model') ? (
                <div className="properties-locked-field" title={t('featureTree.properties.multi.modelLockedTooltip')}>
                  <span>{t('featureTree.properties.multi.containsModel')}</span>
                  <span className="properties-locked-hint" aria-hidden="true">🔒</span>
                </div>
              ) : (
                <Select
                  value={commonSelectedOperation ?? ''}
                  options={[
                    ...(commonSelectedOperation === '__mixed__' ? [{ value: '__mixed__', label: t('featureTree.properties.select.mixedOperations') }] : []),
                    { value: 'subtract', label: t('featureTree.properties.operation.subtract') },
                    { value: 'add', label: t('featureTree.properties.operation.add') },
                    { value: 'line', label: t('featureTree.properties.operation.line') },
                    { value: 'region', label: t('featureTree.properties.operation.region') },
                    { value: 'construction', label: t('featureTree.properties.operation.construction') },
                  ]}
                  onChange={(value) => updateFeatures(selectedFeatureIds, {
                    operation: value as FeatureOperation,
                  })}
                />
              )}
            </label>
            {selectedRegionFeatures.length > 0 && selectedRegionFeatures.length === allSelectedFeatures.length ? (
              <label className="properties-field">
                <span>{t("featureTree.properties.maskMode")}</span>
                <Select
                  value={commonSelectedRegionMaskMode}
                  options={[
                    ...(commonSelectedRegionMaskMode === '__mixed__' ? [{ value: '__mixed__', label: t('featureTree.properties.select.mixedModes') }] : []),
                    { value: 'include', label: t('featureTree.properties.maskMode.include') },
                    { value: 'exclude', label: t('featureTree.properties.maskMode.exclude') },
                  ]}
                  onChange={(value) => {
                    if (value === '__mixed__') return
                    updateFeatures(
                      selectedRegionFeatures.map((feature) => feature.id),
                      { regionMaskMode: value as RegionMaskMode },
                    )
                  }}
                />
              </label>
            ) : null}
            {selectedZEditableFeatures.length > 0 ? (
              <>
                <label className="properties-field">
                  <span>{t("featureTree.properties.zTop")}</span>
                  <DraftNumberInput
                    key={`multi-feature-ztop-${selectedZEditableFeatureIds.join(',')}-${commonSelectedZTop ?? 'mixed'}-${commonSelectedZBottom ?? 'mixed'}`}
                    value={commonSelectedZTop}
                    units={units}
                    min={0}
                    placeholder={t('featureTree.properties.select.mixedValues')}
                    validate={(next) => multiEditMinZTop === null || next >= multiEditMinZTop}
                    onCommit={(next) => updateFeatures(selectedZEditableFeatureIds, { z_top: next })}
                  />
                </label>
                {hasOpenEditableFeatures && selectedClosedEditableFeatures.length === 0 ? (
                  <label className="properties-field">
                    <span>{t("featureTree.properties.zBottom")}</span>
                    <DraftNumberInput
                      key={`multi-feature-zbottom-open-${selectedZEditableFeatureIds.join(',')}`}
                      value={0}
                      units={units}
                      min={0}
                      max={0}
                      onCommit={() => {}}
                    />
                  </label>
                ) : hasOpenEditableFeatures ? (
                  <label className="properties-field">
                    <span>{t("featureTree.properties.zBottom")}</span>
                    <DraftNumberInput
                      key={`multi-feature-zbottom-mixed-${selectedZEditableFeatureIds.join(',')}-${commonSelectedZBottom ?? 'mixed'}`}
                      value={commonSelectedZBottom}
                      units={units}
                      min={0}
                      placeholder={t('featureTree.properties.select.mixedValues')}
                      validate={(next) => multiEditMaxZBottom === null || next <= multiEditMaxZBottom}
                      onCommit={(next) => updateFeatures(selectedClosedEditableFeatures.map((f) => f.id), { z_bottom: next })}
                    />
                  </label>
                ) : (
                  <label className="properties-field">
                    <span>{t("featureTree.properties.zBottom")}</span>
                    <DraftNumberInput
                      key={`multi-feature-zbottom-${selectedZEditableFeatureIds.join(',')}-${commonSelectedZTop ?? 'mixed'}-${commonSelectedZBottom ?? 'mixed'}`}
                      value={commonSelectedZBottom}
                      units={units}
                      min={0}
                      placeholder={t('featureTree.properties.select.mixedValues')}
                      validate={(next) => multiEditMaxZBottom === null || next <= multiEditMaxZBottom}
                      onCommit={(next) => updateFeatures(selectedZEditableFeatureIds, { z_bottom: next })}
                    />
                  </label>
                )}
              </>
            ) : (
              <label className="properties-field">
                <span>{t("featureTree.properties.zRange")}</span>
                <div className="properties-locked-field" title={t('featureTree.properties.z.followsStockTooltip')}>
                  <span>{t('featureTree.properties.z.followsStock', { thickness: formatLength(project.stock.thickness, units) })}</span>
                  <span className="properties-locked-hint" aria-hidden="true">🔒</span>
                </div>
              </label>
            )}
          </div>
          <div className="properties-actions">
            <button className="feat-btn" type="button" disabled title={t('featureTree.properties.multi.editSketchDisabled')}>
              {t('featureTree.properties.stock.editSketch')}
            </button>
            <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteFeatures(selectedFeatureIds); closeExpanded() }}>
              {t('featureTree.properties.deleteSelected')}
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="panel-empty">
        {t('featureTree.properties.empty')}
      </div>
    )
  }

  const zTop = typeof selectedFeature.z_top === 'number' ? selectedFeature.z_top : 0
  const zBottom = typeof selectedFeature.z_bottom === 'number' ? selectedFeature.z_bottom : 0
  const isTextFeature = selectedFeature.kind === 'text' && !!selectedFeature.text
  const textFeature = isTextFeature ? selectedFeature.text : null
  const hasSelfIntersection = isTextFeature ? false : profileHasSelfIntersection(selectedFeature.sketch.profile)
  const exceedsStock = isTextFeature ? false : profileExceedsStock(selectedFeature.sketch.profile, project.stock)
  const textFontOptions = textFeature ? getTextFontOptions(textFeature.style) : []

  // First SOLID feature in the tree must be 'add' (lines/regions/construction
  // don't count as base solids); imported STL models are locked as Model.
  // The first Add can be converted to a non-solid role (Line, Region,
  // Construction); only Subtract is disabled on that row.
  const firstSolidFeature = features.find(isSolid) ?? null
  const isFirstFeature =
    firstSolidFeature?.id === selectedFeature.id
  const subtractDisabled = isFirstFeature && selectedFeature.operation === 'add'

  const selectedDefId = getDefinitionId(selectedFeature)
  const linkedInstanceCount = getInstanceIdsForDefinition(project, selectedDefId).length
  const hasLinkedInstances = linkedInstanceCount > 1

  return (
    <div className="properties-panel">
      <div className="properties-group">
        <DisclosureSection
          title={hasLinkedInstances ? t(linkedInstanceCount === 1 ? 'featureTree.properties.shapeShared.one' : 'featureTree.properties.shapeShared.other', { count: linkedInstanceCount }) : t('featureTree.properties.shape')}
          storageKey="feature-shape"
        >
          <label className="properties-field">
            <span>{t("featureTree.properties.operation")}</span>
            {!selectedFeature.sketch.profile.closed ? (
              // Open profiles convert between Line (engraved path) and
              // Construction (sketch reference) only — mirrors the tree menu.
              <Select
                value={selectedFeature.operation === 'construction' ? 'construction' : 'line'}
                options={[
                  { value: 'line', label: t('featureTree.properties.operation.line') },
                  { value: 'construction', label: t('featureTree.properties.operation.construction') },
                ]}
                onChange={(value) => updateFeature(selectedFeature.id, {
                  operation: value as import('../../types/project').FeatureOperation,
                })}
              />
            ) : selectedFeature.operation === 'model' ? (
              <div className="properties-locked-field" title={t('featureTree.properties.operation.modelLockedTooltip')}>
                <span>{t('featureTree.properties.operation.model')}</span>
                <span className="properties-locked-hint" aria-hidden="true">🔒</span>
              </div>
            ) : subtractDisabled ? (
              <Select
                value={selectedFeature.operation}
                options={[
                  { value: 'add', label: t('featureTree.properties.operation.add') },
                  { value: 'line', label: t('featureTree.properties.operation.line') },
                  { value: 'region', label: t('featureTree.properties.operation.region') },
                  { value: 'construction', label: t('featureTree.properties.operation.construction') },
                ]}
                onChange={(value) => updateFeature(selectedFeature.id, {
                  operation: value as FeatureOperation,
                })}
              />
            ) : (
              <Select
                value={selectedFeature.operation}
                options={[
                  { value: 'subtract', label: t('featureTree.properties.operation.subtract') },
                  { value: 'add', label: t('featureTree.properties.operation.add') },
                  { value: 'line', label: t('featureTree.properties.operation.line') },
                  { value: 'region', label: t('featureTree.properties.operation.region') },
                  { value: 'construction', label: t('featureTree.properties.operation.construction') },
                ]}
                onChange={(value) => updateFeature(selectedFeature.id, {
                  operation: value as FeatureOperation,
                })}
              />
            )}
          </label>
          {selectedFeature.operation === 'region' ? (
            <label className="properties-field">
              <span>{t("featureTree.properties.maskMode")}</span>
              <Select
                value={selectedFeature.regionMaskMode ?? 'include'}
                options={[
                  { value: 'include', label: t('featureTree.properties.maskMode.include') },
                  { value: 'exclude', label: t('featureTree.properties.maskMode.exclude') },
                ]}
                onChange={(value) => updateFeature(selectedFeature.id, {
                  regionMaskMode: value as RegionMaskMode,
                })}
              />
            </label>
          ) : null}
          {textFeature ? (
            <>
              <label className="properties-field">
                <span>{t("featureTree.properties.text")}</span>
                <DraftTextInput
                  key={`text-feature-text-${selectedFeature.id}-${textFeature.text}`}
                  value={textFeature.text}
                  onCommit={(next) =>
                    updateFeature(selectedFeature.id, {
                      text: {
                        ...textFeature,
                        text: next.replace(/\s*\n+\s*/g, ' ').trim() || 'TEXT',
                      },
                    })}
                />
              </label>
              <label className="properties-field">
                <span>{t("featureTree.properties.style")}</span>
                <Select
                  value={textFeature.style}
                  options={[
                    { value: 'skeleton', label: t('featureTree.properties.text.skeleton') },
                    { value: 'outline', label: t('featureTree.properties.text.outline') },
                  ]}
                  onChange={(style) => updateFeature(selectedFeature.id, {
                    text: {
                      ...textFeature,
                      style,
                      fontId: defaultFontIdForStyle(style),
                    },
                  })}
                />
              </label>
              <label className="properties-field">
                <span>{t("featureTree.properties.font")}</span>
                <Select
                  value={textFeature.fontId}
                  options={textFontOptions.map((font) => ({ value: font.id, label: font.label }))}
                  onChange={(fontId) => updateFeature(selectedFeature.id, {
                    text: { ...textFeature, fontId },
                  })}
                />
              </label>
            </>
          ) : null}
          {isTextFeature ? (
            <div className="properties-actions" style={{ marginTop: '12px' }}>
              <button
                className="feat-btn"
                type="button"
                onClick={() => {
                  expandTextFeature(selectedFeature.id)
                  closeExpanded()
                }}
              >
                {t('featureTree.properties.expandText')}
              </button>
            </div>
          ) : null}
          {selectedFeature.operation === 'region' ? (
            <div className="properties-region-note">
              <span className="properties-region-note__badge">{t('featureTree.properties.regionNote.badge')}</span>
              <span>{t('featureTree.properties.regionNote.text')}</span>
            </div>
          ) : null}
          {selectedFeature.operation === 'construction' ? (
            <div className="properties-construction-note">
              <span className="properties-construction-note__badge">{t('featureTree.properties.constructionNote.badge')}</span>
              <span>{t('featureTree.properties.constructionNote.text')}</span>
            </div>
          ) : null}
          {hasLinkedInstances ? (
            <div className="properties-actions" style={{ marginTop: '8px' }}>
              <button
                className="feat-btn"
                type="button"
                onClick={() => { makeUnique(selectedFeature.id); closeExpanded() }}
              >
                {t('featureTree.properties.makeUnique')}
              </button>
            </div>
          ) : null}
        </DisclosureSection>
        <DisclosureSection title={t('featureTree.properties.instance')} storageKey="feature-instance">
          <label className="properties-field">
            <span>{t('featureTree.properties.name')}</span>
            <DraftTextInput
              key={`feature-name-${selectedFeature.id}-${selectedFeature.name}`}
              value={selectedFeature.name}
              onCommit={(next) => updateFeature(selectedFeature.id, { name: next })}
            />
          </label>
          {selectedFeature.operation === 'region' ? (
            <>
              <label className="properties-field">
                <span>{t("featureTree.properties.zRange")}</span>
                <div className="properties-locked-field" title={t('featureTree.properties.z.followsStockTooltip')}>
                  <span>{t('featureTree.properties.z.followsStock', { thickness: formatLength(project.stock.thickness, units) })}</span>
                  <span className="properties-locked-hint" aria-hidden="true">🔒</span>
                </div>
              </label>
            </>
          ) : selectedFeature.operation === 'construction' ? (
            <>
              <label className="properties-field">
                <span>{t("featureTree.properties.zRange")}</span>
                <div className="properties-locked-field" title={t('featureTree.properties.z.notMachinedTooltip')}>
                  <span>{t('featureTree.properties.z.notMachined')}</span>
                  <span className="properties-locked-hint" aria-hidden="true">🔒</span>
                </div>
              </label>
            </>
          ) : !selectedFeature.sketch.profile.closed || selectedFeature.operation === 'line' ? (
            <>
              <label className="properties-field">
                <span>{t("featureTree.properties.zTop")}</span>
                <DraftNumberInput
                  key={`feature-ztop-${selectedFeature.id}-${zTop}`}
                    value={zTop}
                    units={units}
                    min={0}
                    onCommit={(next) => updateFeature(selectedFeature.id, { z_top: next })}
                />
              </label>
              <label className="properties-field">
                <span>{t("featureTree.properties.zBottom")}</span>
                <DraftNumberInput
                  key={`feature-zbottom-open-${selectedFeature.id}`}
                    value={0}
                    units={units}
                    min={0}
                    max={0}
                    onCommit={() => {}}
                />
              </label>
            </>
          ) : project.stock.thickness > 0 ? (
            <ZRangeSlider
              featureId={selectedFeature.id}
              zTop={zTop}
              zBottom={zBottom}
              stockThickness={project.stock.thickness}
              units={units}
              onCommitZTop={(next) => updateFeature(selectedFeature.id, { z_top: next })}
              onCommitZBottom={(next) => updateFeature(selectedFeature.id, { z_bottom: next })}
            />
          ) : (
            <>
              <label className="properties-field">
                <span>{t("featureTree.properties.zTop")}</span>
                <DraftNumberInput
                  key={`feature-ztop-${selectedFeature.id}-${zTop}-${zBottom}`}
                    value={zTop}
                    units={units}
                    min={0}
                    validate={(next) => next >= zBottom}
                    onCommit={(next) => updateFeature(selectedFeature.id, { z_top: next })}
                />
              </label>
              <label className="properties-field">
                <span>{t("featureTree.properties.zBottom")}</span>
                <DraftNumberInput
                  key={`feature-zbottom-${selectedFeature.id}-${zTop}-${zBottom}`}
                    value={zBottom}
                    units={units}
                    min={0}
                    validate={(next) => next <= zTop}
                    onCommit={(next) => updateFeature(selectedFeature.id, { z_bottom: next })}
                />
              </label>
            </>
          )}
          <label className="properties-field">
            <span>{t("featureTree.properties.folder")}</span>
            {renderFolderSelect(selectedFeature.folderId, (folderId) => {
              assignFeaturesToFolder([selectedFeature.id], folderId)
            }, project.featureFolders.find((f) => f.id === selectedFeature.folderId)?.grouped === true, sectionForOperation(selectedFeature.operation))}
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={selectedFeature.visible}
              onChange={(event) => updateFeature(selectedFeature.id, { visible: event.target.checked })}
            />
            <span>{t("featureTree.properties.visible")}</span>
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={selectedFeature.locked}
              onChange={(event) => updateFeature(selectedFeature.id, { locked: event.target.checked })}
            />
            <span>{t("featureTree.properties.locked")}</span>
          </label>
        </DisclosureSection>
        {hasSelfIntersection ? (
          <div className="properties-warning">
            {t('featureTree.properties.warning.selfIntersect')}
          </div>
        ) : null}
        {exceedsStock ? (
          <div className="properties-warning">
            {t('featureTree.properties.warning.exceedsStock')}
          </div>
        ) : null}
      </div>
      <div className="properties-actions">
        <button className="feat-btn" type="button" onClick={() => { enterSketchEdit(selectedFeature.id); closeExpanded() }} disabled={isTextFeature}>
          {t('featureTree.properties.stock.editSketch')}
        </button>
        <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteFeature(selectedFeature.id); closeExpanded() }}>
          {t('featureTree.properties.deleteFeature')}
        </button>
      </div>
      {selectedFeature.sketch.constraints.filter((c) => c.type === 'fixed_distance').length > 0 ? (
        <div className="properties-group">
          <span className="properties-section-title">{t('featureTree.properties.constraints.title')}</span>
          {selectedFeature.sketch.constraints
            .filter((c) => c.type === 'fixed_distance')
            .map((c) => {
              const refId = c.reference_feature_id ?? c.segment_ids[0]
              const refFeature = refId ? features.find((f) => f.id === refId) : null
              const label = typeof c.value === 'number' ? formatLength(c.value, units) : '—'
              const refName = refFeature?.name ?? (refId ? `#${refId}` : t('featureTree.properties.constraints.world'))
              const isIntersectionConstraint = c.reference_type === 'intersection' || c.reference_snap_mode === 'intersection'
              const typeLabel = isIntersectionConstraint
                ? t('featureTree.properties.constraints.type.intersect')
                : c.reference_type === 'segment'
                  ? t('featureTree.properties.constraints.type.perp')
                  : c.reference_type === 'point_on_segment'
                    ? t('featureTree.properties.constraints.type.line')
                    : c.reference_type === 'midpoint'
                      ? t('featureTree.properties.constraints.type.midpt')
                      : c.reference_index === -1
                        ? t('featureTree.properties.constraints.type.center')
                        : t('featureTree.properties.constraints.type.point')
              const tooltipText = c.is_invalid
                ? (c.error_message ?? t('featureTree.properties.constraints.tooltip.invalid'))
                : isIntersectionConstraint
                  ? t('featureTree.properties.constraints.tooltip.distanceIntersection')
                  : c.reference_type === 'segment'
                    ? t('featureTree.properties.constraints.tooltip.perpendicularSegment')
                    : c.reference_type === 'point_on_segment'
                      ? t('featureTree.properties.constraints.tooltip.pointOnSegment', { percent: Math.round((c.reference_t ?? 0) * 100) })
                      : c.reference_type === 'midpoint'
                        ? t('featureTree.properties.constraints.tooltip.segmentMidpoint')
                        : c.reference_index === -1
                          ? t('featureTree.properties.constraints.tooltip.featureCenter')
                          : t('featureTree.properties.constraints.tooltip.distanceVertex')
              return (
                <div key={c.id} className={`properties-constraint-row${c.is_invalid ? ' properties-constraint-row--invalid' : ''}`}>
                  <span className="properties-constraint-type" title={tooltipText}>{typeLabel}</span>
                  <span className="properties-constraint-label" title={tooltipText}>
                    {c.is_invalid ? '⚠ ' : ''}{label} → {refName}
                  </span>
                  <button
                    type="button"
                    className="tree-action-btn properties-constraint-delete"
                    onClick={() => { deleteConstraint(selectedFeature.id, c.id); closeExpanded() }}
                    title={t('featureTree.properties.constraints.delete')}
                    aria-label={t('featureTree.properties.constraints.delete')}
                  >
                    ×
                  </button>
                </div>
              )
            })}
        </div>
      ) : null}
    </div>
  )
  } // closes renderContent

  return (
    <>
      {renderContent()}
      {showManager && (
        <MachineDefinitionManagerDialog
          onClose={() => setShowManager(false)}
        />
      )}
      {pendingUnits && pendingUnits !== project.meta.units ? (
        <UnitConversionDialog
          fromUnits={project.meta.units}
          toUnits={pendingUnits}
          onConvert={() => commitPendingUnits('convert')}
          onReinterpret={() => commitPendingUnits('reinterpret')}
          onCancel={() => setPendingUnits(null)}
        />
      ) : null}
    </>
  )
}
