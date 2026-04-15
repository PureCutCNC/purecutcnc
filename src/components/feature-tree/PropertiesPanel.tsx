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

import { useRef } from 'react'
import type { ChangeEvent } from 'react'
import { Icon } from '../Icon'
import { validateMachineDefinition } from '../../engine/gcode'
import { defaultStock, getStockBounds, profileExceedsStock, profileHasSelfIntersection } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { defaultFontIdForStyle, getTextFontOptions } from '../../text'
import { convertLength, formatLength, parseLengthInput } from '../../utils/units'
import { platform } from '../../platform'

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
  value: number
  units: 'mm' | 'inch'
  min?: number
  max?: number
  disabled?: boolean
  onCommit: (value: number) => void
  validate?: (value: number) => boolean
}

function DraftNumberInput({
  value,
  units,
  min,
  max,
  disabled = false,
  onCommit,
  validate,
}: DraftNumberInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = formatLength(value, units)
  }

  function isValid(next: number) {
    if (!Number.isFinite(next)) return false
    if (min !== undefined && next < min) return false
    if (max !== undefined && next > max) return false
    if (validate && !validate(next)) return false
    return true
  }

  function commit(element: HTMLInputElement) {
    const next = parseLengthInput(element.value, units)
    if (next === null || !isValid(next)) {
      reset(element)
      return
    }

    if (next !== value) {
      onCommit(next)
    } else {
      reset(element)
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      defaultValue={formatLength(value, units)}
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
    setProjectName,
    setShowFeatureInfo,
    setProjectClearances,
    setSelectedMachineId,
    addMachineDefinition,
    removeMachineDefinition,
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
    setUnits,
    updateTab,
    updateClamp,
    updateFeatureFolder,
    updateFeature,
    deleteFeature,
    deleteFeatures,
    enterSketchEdit,
    enterTabEdit,
    enterClampEdit,
  } = useProjectStore()
  const backdropFileInputRef = useRef<HTMLInputElement>(null)

  const selectedFeatureIds = selection.selectedFeatureIds
  const selectedFeatureId = selectedFeatureIds.length === 1 ? selectedFeatureIds[0] : null
  const units = project.meta.units
  const minimumLength = convertLength(1, 'mm', units)
  const minimumPanelSpan = convertLength(20, 'mm', units)
  const minimumSnap = convertLength(0.0001, 'mm', units)

  const selectedFeature = selectedFeatureId
    ? project.features.find((feature) => feature.id === selectedFeatureId) ?? null
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
  const allSelectedFeatures = project.features.filter((feature) => selectedFeatureIds.includes(feature.id))
  const commonSelectedFolderId =
    allSelectedFeatures.length > 0 &&
    allSelectedFeatures.every((feature) => feature.folderId === allSelectedFeatures[0]?.folderId)
      ? allSelectedFeatures[0]?.folderId ?? null
      : '__mixed__'
  const selectedMachine = project.meta.selectedMachineId
      ? project.meta.machineDefinitions.find((definition) => definition.id === project.meta.selectedMachineId) ?? null
      : null

  function handleBackdropFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    if (!file.type.startsWith('image/')) {
      alert('Backdrop must be a PNG or JPEG image.')
      event.target.value = ''
      return
    }

    setBackdropImageLoading(true)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null
      if (!dataUrl) {
        alert('Failed to read backdrop image.')
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
        alert('Failed to decode backdrop image.')
        setBackdropImageLoading(false)
        event.target.value = ''
      }
      image.src = dataUrl
    }
    reader.onerror = () => {
      alert('Failed to read backdrop image.')
      setBackdropImageLoading(false)
      event.target.value = ''
    }
    reader.readAsDataURL(file)
  }

  async function handleAddMachine() {
    const content = await platform.pickJsonFile()
    if (!content) return
    try {
      const parsed = JSON.parse(content)
      const validated = validateMachineDefinition({ ...parsed, builtin: false })
      addMachineDefinition(validated)
    } catch (error) {
      alert(`Invalid machine definition JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function renderFolderSelect(value: string | null, onChange: (folderId: string | null) => void) {
    return (
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">Root</option>
        {project.featureFolders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name}
          </option>
        ))}
      </select>
    )
  }

  if (selection.selectedNode?.type === 'project') {
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>Name</span>
            <DraftTextInput
              key={`project-name-${project.meta.name}`}
              value={project.meta.name}
              onCommit={setProjectName}
            />
          </label>
          <label className="properties-field">
            <span>Units</span>
            <select
              value={project.meta.units}
              onChange={(event) => setUnits(event.target.value as 'mm' | 'inch')}
            >
              <option value="mm">Millimeters</option>
              <option value="inch">Inches</option>
            </select>
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={project.meta.showFeatureInfo}
              onChange={(event) => setShowFeatureInfo(event.target.checked)}
            />
            Show feature info in sketch
          </label>
          <label className="properties-field">
            <span>Safe Z</span>
            <DraftNumberInput
              key={`project-max-travel-z-${project.meta.maxTravelZ}`}
              value={project.meta.maxTravelZ}
              units={units}
              min={0}
              onCommit={(next) => setProjectClearances({ maxTravelZ: next })}
            />
          </label>
          <label className="properties-field">
            <span>Op Clear Z</span>
            <DraftNumberInput
              key={`project-operation-clearance-z-${project.meta.operationClearanceZ}`}
              value={project.meta.operationClearanceZ}
              units={units}
              min={0}
              onCommit={(next) => setProjectClearances({ operationClearanceZ: next })}
            />
          </label>
          <label className="properties-field">
            <span>Clamp Clear XY</span>
            <DraftNumberInput
              key={`project-clamp-clearance-xy-${project.meta.clampClearanceXY}`}
              value={project.meta.clampClearanceXY}
              units={units}
              min={0}
              onCommit={(next) => setProjectClearances({ clampClearanceXY: next })}
            />
          </label>
          <label className="properties-field">
            <span>Clamp Clear Z</span>
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
              <span>Machine</span>
              <button
                type="button"
                className="tree-action-btn properties-refresh-btn"
                onClick={refreshMachineDefinitions}
                aria-label="Refresh machine definitions"
                title="Refresh machine definitions"
              >
                <Icon id="refresh" size={15} />
              </button>
            </div>
            <select
              value={project.meta.selectedMachineId ?? ''}
              onChange={(event) => setSelectedMachineId(event.target.value || null)}
            >
              <option value="">None</option>
              {project.meta.machineDefinitions.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.name}
                </option>
              ))}
            </select>
          </label>
          <div className="properties-actions">
            <button type="button" onClick={handleAddMachine}>
              Add machine
            </button>
            <button
              type="button"
              onClick={() => selectedMachine && removeMachineDefinition(selectedMachine.id)}
              disabled={!selectedMachine || selectedMachine.builtin}
            >
              Remove machine
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
            <span>Name</span>
            <DraftTextInput value="Grid" disabled />
          </label>
          <label className="properties-field">
            <span>Grid Extent</span>
            <DraftNumberInput
              key={`grid-extent-${project.grid.extent}`}
              value={project.grid.extent}
              units={units}
              min={minimumPanelSpan}
              onCommit={(next) => setGrid({ ...project.grid, extent: next })}
            />
          </label>
          <label className="properties-field">
            <span>Major Lines</span>
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
            <span>Minor Lines</span>
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
            <span>Snap Increment</span>
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
            <span>Visible</span>
          </label>
        </div>
      </div>
    )
  }

  if (selection.selectedNode?.type === 'stock') {
    const bounds = getStockBounds(project.stock)
    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY

    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>Name</span>
            <DraftTextInput value="Stock" disabled />
          </label>
          <label className="properties-field">
            <span>Width</span>
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
            <span>Height</span>
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
            <span>Thickness</span>
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
            <span>Color</span>
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
            <span>Visible</span>
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
            <span>Name</span>
            <DraftTextInput
              key={`origin-name-${project.origin.name}`}
              value={project.origin.name}
              onCommit={(next) => setOrigin({ ...project.origin, name: next })}
            />
          </label>
          <label className="properties-field">
            <span>Z</span>
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
            <span>Visible</span>
          </label>
        </div>

        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => startPlaceOrigin()}>
            Place Origin
          </button>
        </div>

        <div className="properties-group">
          <span className="dialog-section-title" style={{ fontSize: '11px', marginBottom: '4px', display: 'block' }}>Presets</span>
          <div className="properties-actions">
            <button 
              className="feat-btn" 
              type="button"
              onClick={() => setOrigin({ ...project.origin, x: bounds.minX, y: bounds.minY, z: project.stock.thickness })}
            >
              Top Left
            </button>
            <button 
              className="feat-btn" 
              type="button"
              onClick={() => setOrigin({ ...project.origin, x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, z: project.stock.thickness })}
            >
              Center Top
            </button>
            <button 
              className="feat-btn" 
              type="button"
              onClick={() => setOrigin({ ...project.origin, x: bounds.minX, y: bounds.maxY, z: 0 })}
            >
              Bottom Left
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
            <span>Name</span>
            <DraftTextInput
              key={`backdrop-name-${backdrop?.name ?? 'Backdrop'}`}
              value={backdrop?.name ?? 'Backdrop'}
              disabled={!backdrop}
              onCommit={(next) => backdrop && updateBackdrop({ name: next || 'Backdrop' })}
            />
          </label>
          <label className="properties-field">
            <span>Image</span>
            <DraftTextInput
              key={`backdrop-image-${backdrop?.imageDataUrl ?? 'none'}-${backdrop?.intrinsicWidth ?? 0}-${backdrop?.intrinsicHeight ?? 0}`}
              value={backdrop ? `${backdrop.name} (${backdrop.intrinsicWidth} × ${backdrop.intrinsicHeight})` : 'No image loaded'}
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
            <span>Visible</span>
          </label>
          <label className="properties-field">
            <span>Opacity</span>
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
            <span>Width</span>
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
            <span>Height</span>
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
            <span>Angle</span>
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
            {backdropImageLoading ? 'Loading Image...' : backdrop ? 'Replace Image' : 'Load Image'}
          </button>
          <button className="feat-btn" type="button" onClick={() => startMoveBackdrop()} disabled={!backdrop || backdropImageLoading}>
            Move
          </button>
          <button className="feat-btn" type="button" onClick={() => startResizeBackdrop()} disabled={!backdrop || backdropImageLoading}>
            Resize
          </button>
          <button className="feat-btn" type="button" onClick={() => startRotateBackdrop()} disabled={!backdrop || backdropImageLoading}>
            Rotate
          </button>
          <button className="feat-btn feat-btn--delete" type="button" onClick={() => deleteBackdrop()} disabled={!backdrop || backdropImageLoading}>
            Delete
          </button>
        </div>
        {backdropImageLoading ? (
          <div className="properties-inline-status" role="status" aria-live="polite">
            <span className="inline-spinner" aria-hidden="true" />
            Decoding backdrop image...
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
            <span>Name</span>
            <DraftTextInput value="Features" disabled />
          </label>
          <label className="properties-field">
            <span>Folders</span>
            <DraftTextInput value={`${project.featureFolders.length}`} disabled />
          </label>
          <label className="properties-field">
            <span>Features</span>
            <DraftTextInput value={`${project.features.length}`} disabled />
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => addFeatureFolder()}>
            Add Folder
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
            <span>Name</span>
            <DraftTextInput value="Clamps" disabled />
          </label>
          <label className="properties-field">
            <span>Clamps</span>
            <DraftTextInput value={`${project.clamps.length}`} disabled />
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => startAddClampPlacement()}>
            Add Clamp
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
            <span>Name</span>
            <DraftTextInput value="Tabs" disabled />
          </label>
          <label className="properties-field">
            <span>Tabs</span>
            <DraftTextInput value={`${project.tabs.length}`} disabled />
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => startAddTabPlacement()}>
            Add Tab
          </button>
        </div>
      </div>
    )
  }

  if (selectedFolder) {
    const featureCount = project.features.filter((feature) => feature.folderId === selectedFolder.id).length

    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>Name</span>
            <DraftTextInput
              key={`folder-name-${selectedFolder.id}-${selectedFolder.name}`}
              value={selectedFolder.name}
              onCommit={(next) => updateFeatureFolder(selectedFolder.id, { name: next })}
            />
          </label>
          <label className="properties-field">
            <span>Features</span>
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
            <span>Expanded</span>
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn feat-btn--delete" type="button" onClick={() => deleteFeatureFolder(selectedFolder.id)}>
            Delete Folder
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
            <span>Name</span>
            <DraftTextInput
              key={`clamp-name-${selectedClamp.id}-${selectedClamp.name}`}
              value={selectedClamp.name}
              onCommit={(next) => updateClamp(selectedClamp.id, { name: next })}
            />
          </label>
          <label className="properties-field">
            <span>Z Top</span>
            <DraftNumberInput
              key={`clamp-height-${selectedClamp.id}-${selectedClamp.height}`}
              value={selectedClamp.height}
              units={units}
              min={minimumClampSize}
              onCommit={(next) => updateClamp(selectedClamp.id, { height: next })}
            />
          </label>
          <label className="properties-field">
            <span>Z Bottom</span>
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
            <span>Visible</span>
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => enterClampEdit(selectedClamp.id)}>
            Edit Sketch
          </button>
          <button className="feat-btn feat-btn--delete" type="button" onClick={() => deleteClamp(selectedClamp.id)}>
            Delete Clamp
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
            <span>Name</span>
            <DraftTextInput
              key={`tab-name-${selectedTab.id}-${selectedTab.name}`}
              value={selectedTab.name}
              onCommit={(next) => updateTab(selectedTab.id, { name: next })}
            />
          </label>
          <label className="properties-field">
            <span>Z Top</span>
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
            <span>Z Bottom</span>
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
            <span>Visible</span>
          </label>
        </div>
        <div className="properties-actions">
          <button className="feat-btn" type="button" onClick={() => enterTabEdit(selectedTab.id)}>
            Edit Sketch
          </button>
          <button className="feat-btn feat-btn--delete" type="button" onClick={() => deleteTab(selectedTab.id)}>
            Delete Tab
          </button>
        </div>
      </div>
    )
  }

  if (!selectedFeature) {
    if (selectedFeatureIds.length > 1) {
      return (
        <div className="properties-panel">
          <div className="properties-group">
            <label className="properties-field">
              <span>Selection</span>
              <DraftTextInput value={`${selectedFeatureIds.length} Features`} disabled />
            </label>
            <label className="properties-field">
              <span>Edit Sketch</span>
              <DraftTextInput value="Disabled for multi-select" disabled />
            </label>
            <label className="properties-field">
              <span>Folder</span>
              <select
                value={commonSelectedFolderId ?? ''}
                onChange={(event) =>
                  assignFeaturesToFolder(
                    selectedFeatureIds,
                    event.target.value === '' || event.target.value === '__mixed__' ? null : event.target.value,
                  )
                }
              >
                {commonSelectedFolderId === '__mixed__' ? (
                  <option value="__mixed__">Mixed folders</option>
                ) : null}
                <option value="">Root</option>
                {project.featureFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="properties-actions">
            <button className="feat-btn" type="button" disabled title="Edit Sketch is only available for a single feature">
              Edit Sketch
            </button>
            <button className="feat-btn feat-btn--delete" type="button" onClick={() => deleteFeatures(selectedFeatureIds)}>
              Delete Selected
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="panel-empty">
        Select Project, Grid, Stock, or a feature in the tree to edit its properties.
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

  // First feature in the tree must always be 'add' — lock the operation field
  const isFirstFeature =
    project.features.length > 0 && project.features[0].id === selectedFeature.id

  return (
    <div className="properties-panel">
      <div className="properties-group">
        <label className="properties-field">
          <span>Name</span>
          <DraftTextInput
            key={`feature-name-${selectedFeature.id}-${selectedFeature.name}`}
            value={selectedFeature.name}
            onCommit={(next) => updateFeature(selectedFeature.id, { name: next })}
          />
        </label>
        <label className="properties-field">
          <span>Operation</span>
          {isFirstFeature ? (
            <div className="properties-locked-field" title="The first feature must always be Add — it defines the base solid of the part model">
              <span>Add</span>
              <span className="properties-locked-hint" aria-hidden="true">🔒</span>
            </div>
          ) : (
            <select
              value={selectedFeature.operation}
              onChange={(event) =>
                updateFeature(selectedFeature.id, {
                  operation: event.target.value as 'add' | 'subtract',
                })}
            >
              <option value="subtract">Subtract</option>
              <option value="add">Add</option>
            </select>
          )}
        </label>
        <label className="properties-field">
          <span>Folder</span>
          {renderFolderSelect(selectedFeature.folderId, (folderId) =>
            assignFeaturesToFolder([selectedFeature.id], folderId),
          )}
        </label>
        {textFeature ? (
          <>
            <label className="properties-field">
              <span>Text</span>
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
              <span>Style</span>
              <select
                value={textFeature.style}
                onChange={(event) => {
                  const style = event.target.value as typeof textFeature.style
                  updateFeature(selectedFeature.id, {
                    text: {
                      ...textFeature,
                      style,
                      fontId: defaultFontIdForStyle(style),
                    },
                  })
                }}
              >
                <option value="skeleton">Skeleton</option>
                <option value="outline">Outline</option>
              </select>
            </label>
            <label className="properties-field">
              <span>Font</span>
              <select
                value={textFeature.fontId}
                onChange={(event) =>
                  updateFeature(selectedFeature.id, {
                    text: {
                      ...textFeature,
                      fontId: event.target.value as typeof textFeature.fontId,
                    },
                  })}
              >
                {textFontOptions.map((font) => (
                  <option key={font.id} value={font.id}>
                    {font.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label className="properties-field">
          <span>Z Top</span>
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
          <span>Z Bottom</span>
          <DraftNumberInput
            key={`feature-zbottom-${selectedFeature.id}-${zTop}-${zBottom}`}
              value={zBottom}
              units={units}
              min={0}
              validate={(next) => next <= zTop}
              onCommit={(next) => updateFeature(selectedFeature.id, { z_bottom: next })}
          />
        </label>
        <label className="properties-check">
          <input
            type="checkbox"
            checked={selectedFeature.visible}
            onChange={(event) => updateFeature(selectedFeature.id, { visible: event.target.checked })}
          />
          <span>Visible</span>
        </label>
        <label className="properties-check">
          <input
            type="checkbox"
            checked={selectedFeature.locked}
            onChange={(event) => updateFeature(selectedFeature.id, { locked: event.target.checked })}
          />
          <span>Locked</span>
        </label>
        {hasSelfIntersection ? (
          <div className="properties-warning">
            This profile self-intersects. 3D/CAM results may be invalid.
          </div>
        ) : null}
        {exceedsStock ? (
          <div className="properties-warning">
            This profile extends outside the stock boundary.
          </div>
        ) : null}
      </div>
      <div className="properties-actions">
        <button className="feat-btn" type="button" onClick={() => enterSketchEdit(selectedFeature.id)} disabled={isTextFeature}>
          Edit Sketch
        </button>
        <button className="feat-btn feat-btn--delete" type="button" onClick={() => deleteFeature(selectedFeature.id)}>
          Delete Feature
        </button>
      </div>
    </div>
  )
}
