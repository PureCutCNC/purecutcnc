import { useState, useMemo, useEffect } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { 
  BUNDLED_DEFINITIONS, 
  type MachineDefinition, 
  runPostProcessor, 
  type PostProcessorResult,
  validateMachineDefinition
} from '../../engine/gcode'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { Operation } from '../../types/project'

interface ExportDialogProps {
  onClose: () => void
  generateToolpath: (operation: Operation) => ToolpathResult | null
}

export function ExportDialog({ onClose, generateToolpath }: ExportDialogProps) {
  const { project, setMachineId, setCustomMachineDefinition } = useProjectStore()
  
  const [selectedMachineId, setSelectedMachineId] = useState<string>(project.meta.machineId || BUNDLED_DEFINITIONS[0].id)
  const [customDefinition, setCustomDefinition] = useState<MachineDefinition | null>(project.meta.customMachineDefinition)
  const [emitToolChanges, setEmitToolChanges] = useState(true)
  const [emitCoolant, setEmitCoolant] = useState(false)
  const [previewResult, setPreviewResult] = useState<PostProcessorResult | null>(null)

  const activeDefinition = useMemo(() => {
    if (selectedMachineId === 'custom' && customDefinition) {
      return customDefinition
    }
    return BUNDLED_DEFINITIONS.find(d => d.id === selectedMachineId) || BUNDLED_DEFINITIONS[0]
  }, [selectedMachineId, customDefinition])

  // Prepare post-processor input
  const postProcessorInput = useMemo(() => {
    const activeOperations = project.operations
      .filter(op => op.enabled && op.showToolpath && op.toolRef)
      .map(op => {
        const toolpath = generateToolpath(op)
        const toolRecord = project.tools.find(t => t.id === op.toolRef)
        if (!toolpath || !toolRecord) return null
        
        return {
          operation: op,
          tool: normalizeToolForProject(toolRecord, project),
          toolpath
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    return {
      project,
      operations: activeOperations,
      definition: activeDefinition,
      options: {
        emitToolChanges,
        emitCoolant,
        programName: project.meta.name
      }
    }
  }, [project, activeDefinition, emitToolChanges, emitCoolant, generateToolpath])

  // Run post-processor for preview (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      const result = runPostProcessor(postProcessorInput)
      setPreviewResult(result)
    }, 300)
    return () => clearTimeout(timer)
  }, [postProcessorInput])

  function handleDownload() {
    if (!previewResult) return

    // Save machine settings to project store
    setMachineId(selectedMachineId === 'custom' ? null : selectedMachineId)
    if (selectedMachineId === 'custom') {
      setCustomMachineDefinition(customDefinition)
    }

    const blob = new Blob([previewResult.gcode], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    const ext = activeDefinition.fileExtension
    anchor.download = `${project.meta.name.replace(/\s+/g, '_')}.${ext}`
    anchor.click()
    URL.revokeObjectURL(url)
    onClose()
  }

  function handleLoadCustom(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string)
        const validated = validateMachineDefinition(json)
        setCustomDefinition(validated)
        setSelectedMachineId('custom')
      } catch (err) {
        alert('Invalid machine definition JSON: ' + (err instanceof Error ? err.message : String(err)))
      }
    }
    reader.readAsText(file)
  }

  const previewLines = previewResult?.gcode.split('\n').slice(0, 30).join('\n') || 'Generating preview...'

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">Export G-code</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title">Machine Controller</label>
              <div className="properties-field">
                <select 
                  value={selectedMachineId} 
                  onChange={e => setSelectedMachineId(e.target.value)}
                  style={{ width: '100%' }}
                >
                  {BUNDLED_DEFINITIONS.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                  <option value="custom">{customDefinition ? `Custom: ${customDefinition.name}` : 'Load Custom...'}</option>
                </select>
              </div>
              {selectedMachineId === 'custom' && (
                <div style={{ marginTop: '8px' }}>
                  <input type="file" accept=".json" onChange={handleLoadCustom} style={{ fontSize: '12px' }} />
                </div>
              )}
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Origin</label>
              <div style={{ fontSize: '13px', color: 'var(--text)', display: 'grid', gap: '6px' }}>
                <div>Export uses the current project origin as machine X0 Y0 Z0.</div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                  Edit Origin in the Project Tree to change the work zero used for export.
                </div>
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Project Units</label>
              <div style={{ fontSize: '13px', color: 'var(--text)' }}>
                {project.meta.units === 'inch' ? 'Inch' : 'Millimeter'}
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Options</label>
              <div className="export-option-group">
                <label className="export-option">
                  <input 
                    type="checkbox" 
                    checked={emitToolChanges} 
                    onChange={e => setEmitToolChanges(e.target.checked)} 
                  />
                  Emit tool changes (M6)
                </label>
                <label className="export-option">
                  <input 
                    type="checkbox" 
                    checked={emitCoolant} 
                    onChange={e => setEmitCoolant(e.target.checked)} 
                  />
                  Emit coolant commands
                </label>
              </div>
            </div>

            {previewResult && previewResult.warnings.length > 0 && (
              <div className="dialog-section-group">
                <label className="dialog-section-title">Warnings</label>
                <div className="export-warning-list">
                  {previewResult.warnings.map((w, i) => (
                    <div key={i} className="export-warning">{w}</div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="dialog-preview-container">
            <label className="dialog-section-title">Preview (First 30 lines)</label>
            <div className="dialog-preview">
              {previewLines}
              {previewResult && previewResult.gcode.split('\n').length > 30 && '\n...'}
            </div>
            {previewResult && (
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', textAlign: 'right' }}>
                {previewResult.stats.moveCount} moves, {previewResult.stats.lineCount} lines total
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button 
            className="btn-primary" 
            onClick={handleDownload}
            disabled={!previewResult || (selectedMachineId === 'custom' && !customDefinition)}
          >
            Download .{activeDefinition.fileExtension}
          </button>
        </div>
      </div>
    </div>
  )
}
