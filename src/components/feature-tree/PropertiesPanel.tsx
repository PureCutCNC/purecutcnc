import { defaultStock, getStockBounds } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'

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
  min?: number
  max?: number
  onCommit: (value: number) => void
  validate?: (value: number) => boolean
}

function DraftNumberInput({
  value,
  min,
  max,
  onCommit,
  validate,
}: DraftNumberInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = String(value)
  }

  function isValid(next: number) {
    if (!Number.isFinite(next)) return false
    if (min !== undefined && next < min) return false
    if (max !== undefined && next > max) return false
    if (validate && !validate(next)) return false
    return true
  }

  function commit(element: HTMLInputElement) {
    const next = Number(element.value)
    if (!isValid(next)) {
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
      defaultValue={String(value)}
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
    setGrid,
    setStock,
    setUnits,
    updateFeature,
    deleteFeature,
    enterSketchEdit,
  } = useProjectStore()

  const selectedFeatureId = selection.selectedNode?.type === 'feature'
    ? selection.selectedNode.featureId
    : null

  const selectedFeature = selectedFeatureId
    ? project.features.find((feature) => feature.id === selectedFeatureId) ?? null
    : null

  if (selection.selectedNode?.type === 'grid') {
    return (
      <div className="properties-panel">
        <div className="properties-group">
          <label className="properties-field">
            <span>Name</span>
            <DraftTextInput value="Grid" disabled />
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
          <label className="properties-field">
            <span>Grid Extent</span>
            <DraftNumberInput
              key={`grid-extent-${project.grid.extent}`}
              value={project.grid.extent}
              min={20}
              onCommit={(next) => setGrid({ ...project.grid, extent: next })}
            />
          </label>
          <label className="properties-field">
            <span>Major Lines</span>
            <DraftNumberInput
              key={`grid-major-${project.grid.majorSpacing}-${project.grid.minorSpacing}`}
              value={project.grid.majorSpacing}
              min={1}
              validate={(next) => next >= project.grid.minorSpacing}
              onCommit={(next) => setGrid({ ...project.grid, majorSpacing: next })}
            />
          </label>
          <label className="properties-field">
            <span>Minor Lines</span>
            <DraftNumberInput
              key={`grid-minor-${project.grid.minorSpacing}-${project.grid.majorSpacing}`}
              value={project.grid.minorSpacing}
              min={1}
              validate={(next) => next <= project.grid.majorSpacing}
              onCommit={(next) => setGrid({ ...project.grid, minorSpacing: next })}
            />
          </label>
          <label className="properties-field">
            <span>Snap Increment</span>
            <DraftNumberInput
              key={`grid-snap-${project.grid.snapIncrement}-${project.meta.units}`}
              value={project.grid.snapIncrement}
              min={0.0001}
              onCommit={(next) => setGrid({ ...project.grid, snapIncrement: next })}
            />
          </label>
          <label className="properties-check">
            <input
              type="checkbox"
              checked={project.grid.snapEnabled}
              onChange={(event) => setGrid({ ...project.grid, snapEnabled: event.target.checked })}
            />
            <span>Snap Enabled</span>
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
    const width = Math.round(bounds.maxX - bounds.minX)
    const height = Math.round(bounds.maxY - bounds.minY)

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
              min={20}
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
              min={20}
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
              min={1}
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

  if (!selectedFeature) {
    return (
      <div className="panel-empty">
        Select Grid, Stock, or a feature in the tree to edit its properties.
      </div>
    )
  }

  const zTop = typeof selectedFeature.z_top === 'number' ? selectedFeature.z_top : 0
  const zBottom = typeof selectedFeature.z_bottom === 'number' ? selectedFeature.z_bottom : 0

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
              <span className="properties-locked-hint">🔒 Base solid</span>
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
          <span>Z Top</span>
          <DraftNumberInput
            key={`feature-ztop-${selectedFeature.id}-${zTop}-${zBottom}`}
            value={zTop}
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
      </div>
      <div className="properties-actions">
        <button className="feat-btn" type="button" onClick={() => enterSketchEdit(selectedFeature.id)}>
          Edit Sketch
        </button>
        <button className="feat-btn feat-btn--delete" type="button" onClick={() => deleteFeature(selectedFeature.id)}>
          Delete Feature
        </button>
      </div>
    </div>
  )
}
