import { useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import type { Tool, ToolType } from '../../types/project'
import { convertToolUnits, formatLength, parseLengthInput } from '../../utils/units'

interface DraftTextInputProps {
  value: string
  onCommit: (value: string) => void
}

function DraftTextInput({ value, onCommit }: DraftTextInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = value
  }

  function commit(element: HTMLInputElement) {
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

interface DraftLengthInputProps {
  value: number
  units: 'mm' | 'inch'
  min?: number
  max?: number
  onCommit: (value: number) => void
}

function DraftLengthInput({ value, units, min, max, onCommit }: DraftLengthInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = formatLength(value, units)
  }

  function commit(element: HTMLInputElement) {
    const next = parseLengthInput(element.value, units)
    if (next === null || !Number.isFinite(next)) {
      reset(element)
      return
    }
    if (min !== undefined && next < min) {
      reset(element)
      return
    }
    if (max !== undefined && next > max) {
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
}

function DraftNumberInput({ value, min, max, onCommit }: DraftNumberInputProps) {
  function reset(element: HTMLInputElement) {
    element.value = String(value)
  }

  function commit(element: HTMLInputElement) {
    const next = Number(element.value)
    if (!Number.isFinite(next)) {
      reset(element)
      return
    }
    if (min !== undefined && next < min) {
      reset(element)
      return
    }
    if (max !== undefined && next > max) {
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

function toolTypeLabel(type: ToolType): string {
  switch (type) {
    case 'flat_endmill':
      return 'Flat Endmill'
    case 'ball_endmill':
      return 'Ball Endmill'
    case 'v_bit':
      return 'V-Bit'
    case 'drill':
      return 'Drill'
  }
}

function toolUnitsLabel(units: Tool['units']): string {
  return units === 'inch' ? 'in' : 'mm'
}

export function CAMPanel() {
  const [tab, setTab] = useState<'operations' | 'tools'>('tools')
  const [selectedToolIdState, setSelectedToolId] = useState<string | null>(null)
  const { project, addTool, updateTool, deleteTool, duplicateTool } = useProjectStore()

  const selectedToolId =
    selectedToolIdState && project.tools.some((tool) => tool.id === selectedToolIdState)
      ? selectedToolIdState
      : project.tools[0]?.id ?? null

  const selectedTool = selectedToolId
    ? project.tools.find((tool) => tool.id === selectedToolId) ?? null
    : null

  function handleAddTool() {
    const toolId = addTool()
    setSelectedToolId(toolId)
    setTab('tools')
  }

  function handleDuplicateTool() {
    if (!selectedTool) {
      return
    }

    const toolId = duplicateTool(selectedTool.id)
    if (toolId) {
      setSelectedToolId(toolId)
      setTab('tools')
    }
  }

  function handleDeleteTool() {
    if (!selectedTool) {
      return
    }

    const currentIndex = project.tools.findIndex((tool) => tool.id === selectedTool.id)
    const fallback = project.tools[currentIndex - 1]?.id ?? project.tools[currentIndex + 1]?.id ?? null
    deleteTool(selectedTool.id)
    setSelectedToolId(fallback)
  }

  return (
    <div className="cam-panel">
      <div className="cam-subtabs">
        <button
          className={`cam-subtab ${tab === 'operations' ? 'cam-subtab--active' : ''}`}
          type="button"
          onClick={() => setTab('operations')}
        >
          Operations
        </button>
        <button
          className={`cam-subtab ${tab === 'tools' ? 'cam-subtab--active' : ''}`}
          type="button"
          onClick={() => setTab('tools')}
        >
          Tools
        </button>
      </div>

      {tab === 'operations' ? (
        <div className="panel-empty">
          Operations schema and target selection are planned next. The tool library is ready in the `Tools` tab.
        </div>
      ) : (
        <div className="cam-tools">
          <div className="cam-toolbar">
            <button className="feat-btn" type="button" onClick={handleAddTool}>
              Add Tool
            </button>
            <button className="feat-btn" type="button" onClick={handleDuplicateTool} disabled={!selectedTool}>
              Duplicate
            </button>
            <button className="feat-btn feat-btn--delete" type="button" onClick={handleDeleteTool} disabled={!selectedTool}>
              Delete
            </button>
          </div>

          <div className="cam-tools-layout">
            <div className="cam-tool-list">
              {project.tools.length === 0 ? (
                <div className="panel-empty">No tools yet. Add the first tool to start building the library.</div>
              ) : (
                project.tools.map((tool) => (
                  <button
                    key={tool.id}
                    className={`cam-tool-row ${tool.id === selectedToolId ? 'cam-tool-row--active' : ''}`}
                    type="button"
                    onClick={() => setSelectedToolId(tool.id)}
                  >
                    <span className="cam-tool-row__name">{tool.name}</span>
                    <span className="cam-tool-row__meta">
                      {toolTypeLabel(tool.type)} · {formatLength(tool.diameter, tool.units)} {toolUnitsLabel(tool.units)}
                    </span>
                  </button>
                ))
              )}
            </div>

            {selectedTool ? (
              <div className="properties-panel cam-tool-properties">
                <div className="properties-group">
                  <label className="properties-field">
                    <span>Name</span>
                    <DraftTextInput value={selectedTool.name} onCommit={(value) => updateTool(selectedTool.id, { name: value })} />
                  </label>
                  <label className="properties-field">
                    <span>Type</span>
                    <select
                      value={selectedTool.type}
                      onChange={(event) => updateTool(selectedTool.id, { type: event.target.value as ToolType })}
                    >
                      <option value="flat_endmill">Flat Endmill</option>
                      <option value="ball_endmill">Ball Endmill</option>
                      <option value="v_bit">V-Bit</option>
                      <option value="drill">Drill</option>
                    </select>
                  </label>
                  <label className="properties-field">
                    <span>Units</span>
                    <select
                      value={selectedTool.units}
                      onChange={(event) => updateTool(selectedTool.id, convertToolUnits(selectedTool, event.target.value as Tool['units']))}
                    >
                      <option value="mm">Millimeters</option>
                      <option value="inch">Inches</option>
                    </select>
                  </label>
                  <label className="properties-field">
                    <span>Diameter</span>
                    <DraftLengthInput
                      value={selectedTool.diameter}
                      units={selectedTool.units}
                      min={0.0001}
                      onCommit={(value) => updateTool(selectedTool.id, { diameter: value })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>Flutes</span>
                    <DraftNumberInput
                      value={selectedTool.flutes}
                      min={1}
                      max={12}
                      onCommit={(value) => updateTool(selectedTool.id, { flutes: Math.round(value) })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>Material</span>
                    <select
                      value={selectedTool.material}
                      onChange={(event) => updateTool(selectedTool.id, { material: event.target.value as Tool['material'] })}
                    >
                      <option value="carbide">Carbide</option>
                      <option value="hss">HSS</option>
                    </select>
                  </label>
                  <label className="properties-field">
                    <span>Default RPM</span>
                    <DraftNumberInput
                      value={selectedTool.defaultRpm}
                      min={1}
                      onCommit={(value) => updateTool(selectedTool.id, { defaultRpm: Math.round(value) })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>Default Feed</span>
                    <DraftLengthInput
                      value={selectedTool.defaultFeed}
                      units={selectedTool.units}
                      min={0.0001}
                      onCommit={(value) => updateTool(selectedTool.id, { defaultFeed: value })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>Plunge Feed</span>
                    <DraftLengthInput
                      value={selectedTool.defaultPlungeFeed}
                      units={selectedTool.units}
                      min={0.0001}
                      onCommit={(value) => updateTool(selectedTool.id, { defaultPlungeFeed: value })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>Stepdown</span>
                    <DraftLengthInput
                      value={selectedTool.defaultStepdown}
                      units={selectedTool.units}
                      min={0.0001}
                      onCommit={(value) => updateTool(selectedTool.id, { defaultStepdown: value })}
                    />
                  </label>
                  <label className="properties-field">
                    <span>Stepover Ratio</span>
                    <DraftNumberInput
                      value={selectedTool.defaultStepover}
                      min={0.01}
                      max={1}
                      onCommit={(value) => updateTool(selectedTool.id, { defaultStepover: value })}
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
