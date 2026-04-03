import { useEffect, useState } from 'react'
import type { FeatureOperation, TextFontStyle } from '../../types/project'
import { defaultFontIdForStyle, defaultTextToolConfig, getTextFontOptions, type TextToolConfig } from '../../text'
import { useProjectStore } from '../../store/projectStore'

interface TextToolDialogProps {
  onClose: () => void
  onConfirm: (config: TextToolConfig) => void
}

export function TextToolDialog({ onClose, onConfirm }: TextToolDialogProps) {
  const units = useProjectStore((state) => state.project.meta.units)
  const defaults = defaultTextToolConfig(units)
  const [text, setText] = useState(defaults.text)
  const [style, setStyle] = useState<TextFontStyle>(defaults.style)
  const [fontId, setFontId] = useState(defaults.fontId)
  const [size, setSize] = useState(String(defaults.size))
  const [operation, setOperation] = useState<FeatureOperation>(defaults.operation)
  const fontOptions = getTextFontOptions(style)

  useEffect(() => {
    if (!fontOptions.some((font) => font.id === fontId)) {
      setFontId(defaultFontIdForStyle(style))
    }
  }, [fontId, fontOptions, style])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handleCreate() {
    const parsedSize = Number(size)
    if (!text.trim() || !Number.isFinite(parsedSize) || parsedSize <= 0) {
      return
    }

    onConfirm({
      text: text.replace(/\s*\n+\s*/g, ' ').trim(),
      style,
      fontId,
      size: parsedSize,
      operation,
    })
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">Add Text</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close" type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="text-tool-value">Text</label>
              <div className="properties-field">
                <textarea
                  id="text-tool-value"
                  rows={2}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  spellCheck={false}
                  autoFocus
                />
              </div>
            </div>
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="text-tool-style">Font Style</label>
              <div className="properties-field">
                <select id="text-tool-style" value={style} onChange={(event) => setStyle(event.target.value as TextFontStyle)}>
                  <option value="skeleton">Skeleton</option>
                  <option value="outline">Outline</option>
                </select>
              </div>
            </div>
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="text-tool-font">Font</label>
              <div className="properties-field">
                <select id="text-tool-font" value={fontId} onChange={(event) => setFontId(event.target.value as typeof fontId)}>
                  {fontOptions.map((font) => (
                    <option key={font.id} value={font.id}>
                      {font.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="text-tool-size">Height</label>
              <div className="properties-field">
                <input
                  id="text-tool-size"
                  type="number"
                  min="0.001"
                  step="any"
                  value={size}
                  onChange={(event) => setSize(event.target.value)}
                />
              </div>
            </div>
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="text-tool-operation">Operation</label>
              <div className="properties-field">
                <select id="text-tool-operation" value={operation} onChange={(event) => setOperation(event.target.value as FeatureOperation)}>
                  <option value="subtract">Subtract</option>
                  <option value="add">Add</option>
                </select>
              </div>
            </div>
            <div className="cam-field-message">
              Single-line text for now. Outline text generates closed features; skeleton text generates open engraving paths.
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="feat-btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="feat-btn" type="button" onClick={handleCreate}>
            Place Text
          </button>
        </div>
      </div>
    </div>
  )
}
