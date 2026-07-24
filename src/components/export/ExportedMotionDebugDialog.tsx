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

import { useEffect, useRef, useState } from 'react'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import {
  parseGcodeMotion,
  buildExportedMotionDebugModel,
  getExportedMotionEligibility,
} from '../../engine/gcode'
import type { PostProcessorResult } from '../../engine/gcode'
import type { ToolpathGenerationTrace } from '../../engine/toolpaths/types'
import type { MachineDefinition } from '../../engine/gcode'
import type { Operation, Project } from '../../types/project'
import { buildMotionLayerPathD } from './motionDebugSvg'

interface ExportedMotionDebugDialogProps {
  operation: Operation
  getGenerationTrace: (operation: Operation) => ToolpathGenerationTrace | null
  project: Project
  definition: MachineDefinition
  /** The already-computed postprocessor result from the Export dialog. */
  previewResult: PostProcessorResult
  onClose: () => void
}

type LayerId = 'generated' | 'optimized' | 'exported'

const LAYER_STYLE: Record<LayerId, { color: string; opacity: number; labelKey: MessageKey }> = {
  generated: { color: '#e69138', opacity: 0.65, labelKey: 'dialogs.motionDebug.layerGenerated' }, // theme-exempt: developer-only motion-debug overlay
  optimized: { color: '#3d7df4', opacity: 0.6, labelKey: 'dialogs.motionDebug.layerOptimized' }, // theme-exempt: developer-only motion-debug overlay
  exported: { color: '#d6336c', opacity: 0.9, labelKey: 'dialogs.motionDebug.layerExported' }, // theme-exempt: developer-only motion-debug overlay
}

const NONCUT_STYLE = { color: '#8a8a8a', opacity: 0.45 } // theme-exempt: developer-only motion-debug overlay

interface ViewState { x: number; y: number; w: number; h: number }

function fitBounds(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  cssW: number,
  cssH: number,
): ViewState | null {
  if (!cssW || !cssH) return null
  const pad = 0.08
  let cw = bounds.maxX - bounds.minX
  let ch = bounds.maxY - bounds.minY
  if (cw < 1e-6) cw = 1
  if (ch < 1e-6) ch = 1
  const scale = Math.min((cssW * (1 - 2 * pad)) / cw, (cssH * (1 - 2 * pad)) / ch)
  const vw = cssW / scale
  const vh = cssH / scale
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  return { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh }
}

export function ExportedMotionDebugDialog({
  operation,
  getGenerationTrace,
  project,
  definition,
  previewResult,
  onClose,
}: ExportedMotionDebugDialogProps) {
  useRestoreCanvasFocus()
  const { t } = useI18n()

  // Build the debug model once on open. Done in an effect (not useMemo) because
  // getGenerationTrace forces a fresh toolpath compute (cache delete + recapture)
  // — a side effect that belongs outside render. The compute is fast (one op).
  const [model, setModel] = useState<ReturnType<typeof buildExportedMotionDebugModel> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [cssSize, setCssSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [view, setView] = useState<ViewState | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; vb: ViewState } | null>(null)

  // Inputs are stable for the dialog's lifetime (opened for one operation);
  // recompute only if they actually change.
  const inputs = `${operation.id}|${project.meta.units}|${definition.id}`
  useEffect(() => {
    let cancelled = false
    try {
      const trace = getGenerationTrace(operation)
      if (!trace) {
        throw new Error('no-trace')
      }
      const eligibility = getExportedMotionEligibility(trace.optimized.moves)
      if (!eligibility.eligible) {
        throw new Error(`ineligible:${eligibility.reason ?? ''}`)
      }
      const tolerance = project.meta.units === 'mm' ? 0.01 : 0.01 / 25.4
      const postprocessorTrace = previewResult.motionTraces?.[0]
      if (!postprocessorTrace) {
        throw new Error('no-motion-trace')
      }
      const parsed = parseGcodeMotion(
        previewResult.gcode,
        definition.motion.arcFormat,
        definition.program.commentPrefix,
        definition.program.commentSuffix,
      )
      const built = buildExportedMotionDebugModel({
        trace,
        parsed,
        postprocessorTrace,
        origin: project.origin,
        definition,
        tolerance,
      })
      if (!cancelled) {
        setModel(built)
        setError(null)
      }
    } catch (e) {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : String(e))
        setModel(null)
      }
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs])

  // Measure the SVG viewport (CSS pixels) for pan/zoom + fit math.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setCssSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit to the model bounds whenever they (or the viewport size) first arrive.
  useEffect(() => {
    if (model?.bounds && cssSize.w && cssSize.h) {
      setView((prev) => prev ?? fitBounds(model.bounds!, cssSize.w, cssSize.h))
    }
  }, [model, cssSize.w, cssSize.h])

  const [visibleLayers, setVisibleLayers] = useState<Record<LayerId, boolean>>({
    generated: true,
    optimized: true,
    exported: true,
  })
  const [showNonCutting, setShowNonCutting] = useState(false)
  const [selectedZ, setSelectedZ] = useState<number | 'all'>('all')
  const [zoomSelectMode, setZoomSelectMode] = useState(false)
  const selectionRef = useRef<{ startX: number; startY: number } | null>(null)
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const didInitZRef = useRef(false)
  // Default to the first cutting Z once the model loads (issue: defaults to the
  // first cutting Z in machine order; "All cutting levels" is opt-in).
  useEffect(() => {
    if (model && model.zLevels.length > 0 && !didInitZRef.current) {
      didInitZRef.current = true
      setSelectedZ(model.zLevels[0])
    }
  }, [model])

  function handleFit() {
    if (model?.bounds && cssSize.w && cssSize.h) {
      setView(fitBounds(model.bounds, cssSize.w, cssSize.h))
    }
  }

  function handleWheel(e: React.WheelEvent) {
    if (!view) return
    e.preventDefault()
    const el = wrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 0.85 : 1.18
    const newW = Math.max(view.w * factor, 1e-3)
    const newH = Math.max(view.h * factor, 1e-3 * (view.h / view.w))
    const ux = view.x + (mx / cssSize.w) * view.w
    const uy = view.y + (my / cssSize.h) * view.h
    setView({ x: ux - (mx / cssSize.w) * newW, y: uy - (my / cssSize.h) * newH, w: newW, h: newH })
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (!view) return
    if (zoomSelectMode) {
      selectionRef.current = { startX: e.clientX, startY: e.clientY }
      setSelectionRect(null)
    } else {
      dragRef.current = { startX: e.clientX, startY: e.clientY, vb: view }
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (zoomSelectMode) {
      const sel = selectionRef.current
      if (!sel || !view) return
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect) return
      // Convert CSS pixel deltas to viewBox units
      const fx = view.w / cssSize.w
      const fy = view.h / cssSize.h
      const x0 = view.x + (sel.startX - rect.left) * fx
      const y0 = view.y + (sel.startY - rect.top) * fy
      const x1 = view.x + (e.clientX - rect.left) * fx
      const y1 = view.y + (e.clientY - rect.top) * fy
      setSelectionRect({
        x: Math.min(x0, x1), y: Math.min(y0, y1),
        w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
      })
    } else {
      const drag = dragRef.current
      if (!drag || !view) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      const fx = drag.vb.w / cssSize.w
      const fy = drag.vb.h / cssSize.h
      setView({ ...drag.vb, x: drag.vb.x - dx * fx, y: drag.vb.y - dy * fy })
    }
  }
  function handlePointerUp() {
    if (zoomSelectMode && selectionRect && selectionRect.w > 1e-6 && selectionRect.h > 1e-6) {
      // Fit the viewBox to the selection rectangle with 8% padding
      const pad = 0.08
      const sw = selectionRect.w * (1 + 2 * pad)
      const sh = selectionRect.h * (1 + 2 * pad)
      const scale = Math.min(cssSize.w / sw, cssSize.h / sh)
      const vw = cssSize.w / scale
      const vh = cssSize.h / scale
      const cx = selectionRect.x + selectionRect.w / 2
      const cy = selectionRect.y + selectionRect.h / 2
      setView({ x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh })
      setSelectionRect(null)
      setZoomSelectMode(false)
    } else {
      setSelectionRect(null)
    }
    dragRef.current = null
    selectionRef.current = null
  }

  const viewBoxStr = view ? `${view.x} ${view.y} ${view.w} ${view.h}` : undefined

  function filterSegments(layerId: LayerId) {
    if (!model) return { cutting: '', nonCutting: '' }
    const cutting: typeof model.layers.generated.segments = []
    const nonCutting: typeof model.layers.generated.segments = []
    for (const seg of model.layers[layerId].segments) {
      if (seg.cutting) {
        if (selectedZ === 'all' || Math.abs(seg.z - selectedZ) < 1e-6) cutting.push(seg)
      } else if (showNonCutting) {
        nonCutting.push(seg)
      }
    }
    return { cutting: buildMotionLayerPathD(cutting), nonCutting: buildMotionLayerPathD(nonCutting) }
  }

  const ineligibleKey: Record<string, MessageKey> = {
    drilling: 'dialogs.motionDebug.ineligibleDrilling',
    noCutMoves: 'dialogs.motionDebug.ineligibleNoCut',
    variableZ: 'dialogs.motionDebug.ineligibleVariableZ',
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog--motion-debug" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('dialogs.motionDebug.title', { operation: operation.name })}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t('dialogs.motionDebug.title', { operation: operation.name })}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={t('dialogs.common.close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--motion-debug">
          <div className="motion-debug__sidebar">
            <div>
              <div className="motion-debug__section-title">{t('dialogs.motionDebug.cuttingLevel')}</div>
              <select
                value={selectedZ === 'all' ? 'all' : String(selectedZ)}
                onChange={(e) => setSelectedZ(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                disabled={!model || model.zLevels.length === 0}
              >
                <option value="all">{t('dialogs.motionDebug.allLevels')}</option>
                {model?.zLevels.map((z) => (
                  <option key={z} value={z}>{Number(z.toFixed(4))}</option>
                ))}
              </select>
            </div>

            <div>
              <div className="motion-debug__section-title">{t('dialogs.export.options')}</div>
              <div className="motion-debug__layers">
                {(Object.keys(LAYER_STYLE) as LayerId[]).map((id) => (
                  <label key={id} className="motion-debug__layer-row">
                    <input
                      type="checkbox"
                      checked={visibleLayers[id]}
                      onChange={(e) => setVisibleLayers((s) => ({ ...s, [id]: e.target.checked }))}
                    />
                    <span className="motion-debug__swatch" style={{ background: LAYER_STYLE[id].color }} />
                    {t(LAYER_STYLE[id].labelKey)}
                  </label>
                ))}
                <label className="motion-debug__layer-row">
                  <input type="checkbox" checked={showNonCutting} onChange={(e) => setShowNonCutting(e.target.checked)} />
                  <span className="motion-debug__swatch" style={{ background: NONCUT_STYLE.color, opacity: NONCUT_STYLE.opacity }} />
                  {t('dialogs.motionDebug.nonCuttingMoves')}
                </label>
              </div>
            </div>

            <div>
              <div className="motion-debug__section-title">{t('dialogs.motionDebug.rawMoves')}</div>
              <div className="motion-debug__metrics">
                <div>{t('dialogs.motionDebug.rawMoves')}: <strong>{model?.metrics.rawMoveCount ?? '—'}</strong></div>
                <div>{t('dialogs.motionDebug.optimizedMoves')}: <strong>{model?.metrics.optimizedMoveCount ?? '—'}</strong></div>
                <div>{t('dialogs.motionDebug.removed')}: <strong>{model?.metrics.removedMoveCount ?? '—'}</strong></div>
              </div>
            </div>

            <div>
              <div className="motion-debug__section-title">{t('dialogs.motionDebug.layerExported')}</div>
              <div className="motion-debug__metrics">
                <div>{t('dialogs.motionDebug.linear')}: <strong>{model?.metrics.emitted.linear ?? '—'}</strong></div>
                <div>{t('dialogs.motionDebug.rapid')}: <strong>{model?.metrics.emitted.rapid ?? '—'}</strong></div>
                <div>{t('dialogs.motionDebug.arcCw')}: <strong>{model?.metrics.emitted.arcCw ?? '—'}</strong></div>
                <div>{t('dialogs.motionDebug.arcCcw')}: <strong>{model?.metrics.emitted.arcCcw ?? '—'}</strong></div>
              </div>
            </div>

            {model && model.zLevelStats.length > 0 && (
              <div>
                <div className="motion-debug__section-title">{t('dialogs.motionDebug.perLevel')}</div>
                <div className="motion-debug__metrics">
                  {model.zLevelStats.map((zs) => (
                    <div key={zs.z}>
                      Z={zs.z.toFixed(2)}: <strong>{zs.exportedSegs}</strong> segs
                      {zs.warnings.length > 0 && <span style={{ color: 'var(--warning-text)' }}> ⚠ {zs.warnings.length}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="motion-debug__view">
            <div className="motion-debug__toolbar">
              <button className="btn-secondary" type="button" onClick={handleFit} disabled={!model?.bounds}>{t('dialogs.motionDebug.fit')}</button>
              <button className="btn-secondary" type="button" onClick={handleFit} disabled={!model?.bounds}>{t('dialogs.motionDebug.reset')}</button>
              <button
                className={`btn-secondary${zoomSelectMode ? ' btn-primary' : ''}`}
                type="button"
                onClick={() => { setZoomSelectMode(!zoomSelectMode); setSelectionRect(null) }}
              >
                {t('dialogs.motionDebug.zoomSelection')}
              </button>
            </div>
            <div
              ref={wrapRef}
              className="motion-debug__svg-wrap"
              style={zoomSelectMode ? { cursor: 'crosshair' } : undefined}
              onWheel={handleWheel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            >
              {error ? (
                <div className="motion-debug__empty">
                  {error.startsWith('ineligible:') ? t(ineligibleKey[error.slice('ineligible:'.length)] ?? 'dialogs.motionDebug.ineligibleNoCut') : t('dialogs.motionDebug.warning')}
                </div>
              ) : !model || !viewBoxStr ? (
                <div className="motion-debug__empty">{t('dialogs.motionDebug.warning')}</div>
              ) : (
                <svg className="motion-debug__svg" viewBox={viewBoxStr} preserveAspectRatio="xMidYMid meet">
                  <rect x={view!.x} y={view!.y} width={view!.w} height={view!.h} fill="transparent" pointerEvents="all" />
                  {(Object.keys(LAYER_STYLE) as LayerId[]).map((id) => {
                    if (!visibleLayers[id]) return null
                    const { cutting, nonCutting } = filterSegments(id)
                    return (
                      <g key={id}>
                        {cutting && <path d={cutting} fill="none" stroke={LAYER_STYLE[id].color} strokeWidth={1.5} strokeOpacity={LAYER_STYLE[id].opacity} vectorEffect="non-scaling-stroke" />}
                        {nonCutting && <path d={nonCutting} fill="none" stroke={NONCUT_STYLE.color} strokeWidth={1} strokeOpacity={NONCUT_STYLE.opacity} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
                      </g>
                    )
                  })}
                  {selectionRect && (
                    <rect
                      x={selectionRect.x} y={selectionRect.y}
                      width={selectionRect.w} height={selectionRect.h}
                      className="motion-debug__selection"
                      pointerEvents="none"
                    />
                  )}
                </svg>
              )}
            </div>
            <div className={`motion-debug__diagnostic ${model?.diagnostic.state === 'verified' ? 'motion-debug__diagnostic--verified' : 'motion-debug__diagnostic--warning'}`}>
              {model ? (
                <>
                  <div>{model.diagnostic.state === 'verified' ? t('dialogs.motionDebug.verified') : `${t('dialogs.motionDebug.warning')}`}</div>
                  {model.diagnostic.warnings.length > 0 && (() => {
                    const filtered = selectedZ === 'all'
                      ? model.diagnostic.warnings
                      : model.diagnostic.warnings.filter((w) => w.message.startsWith(`Z=${(selectedZ as number).toFixed(4)}`))
                    return filtered.length > 0 ? (
                      <div className="motion-debug__warnings">
                        {filtered.map((w, i) => (
                          <div key={i}>{w.kind}: {w.message}</div>
                        ))}
                      </div>
                    ) : null
                  })()}
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" onClick={onClose} type="button">{t('dialogs.common.close')}</button>
        </div>
      </div>
    </div>
  )
}
