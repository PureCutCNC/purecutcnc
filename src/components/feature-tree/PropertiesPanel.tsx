import { defaultStock, getStockBounds } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'

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
            <input type="text" value="Grid" disabled />
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
            <input
              type="number"
              min={20}
              value={project.grid.extent}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isFinite(next) || next < 20) return
                setGrid({ ...project.grid, extent: next })
              }}
            />
          </label>
          <label className="properties-field">
            <span>Major Lines</span>
            <input
              type="number"
              min={1}
              value={project.grid.majorSpacing}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isFinite(next) || next < 1 || next < project.grid.minorSpacing) return
                setGrid({ ...project.grid, majorSpacing: next })
              }}
            />
          </label>
          <label className="properties-field">
            <span>Minor Lines</span>
            <input
              type="number"
              min={1}
              value={project.grid.minorSpacing}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isFinite(next) || next < 1 || next > project.grid.majorSpacing) return
                setGrid({ ...project.grid, minorSpacing: next })
              }}
            />
          </label>
          <label className="properties-field">
            <span>Snap Increment</span>
            <input
              type="number"
              min={0.1}
              step={project.meta.units === 'inch' ? 0.001 : 0.1}
              value={project.grid.snapIncrement}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isFinite(next) || next <= 0) return
                setGrid({ ...project.grid, snapIncrement: next })
              }}
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
            <input type="text" value="Stock" disabled />
          </label>
          <label className="properties-field">
            <span>Width</span>
            <input
              type="number"
              min={20}
              value={width}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isFinite(next) || next < 20) return
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
            <input
              type="number"
              min={20}
              value={height}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isFinite(next) || next < 20) return
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
            <input
              type="number"
              min={1}
              value={project.stock.thickness}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isFinite(next) || next < 1) return
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
          <input
            type="text"
            value={selectedFeature.name}
            onChange={(event) => updateFeature(selectedFeature.id, { name: event.target.value })}
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
          <input
            type="number"
            value={zTop}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (!Number.isFinite(next) || next < 0 || next > zBottom) return
              updateFeature(selectedFeature.id, { z_top: next })
            }}
          />
        </label>
        <label className="properties-field">
          <span>Z Bottom</span>
          <input
            type="number"
            value={zBottom}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (!Number.isFinite(next) || next < zTop) return
              updateFeature(selectedFeature.id, { z_bottom: next })
            }}
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
