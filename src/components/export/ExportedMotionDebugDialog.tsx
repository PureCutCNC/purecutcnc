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
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { exportGeometryTolerance } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import {
  parseExportedMotion,
  buildExportedMotionDebugModel,
  getExportedMotionEligibility,
} from '../../engine/gcode'
import type { PostProcessorResult } from '../../engine/gcode'
import type { ToolpathGenerationTrace, ToolpathResult } from '../../engine/toolpaths/types'
import type { MachineDefinition } from '../../engine/gcode'
import { pinRotaryAxis } from '../../engine/gcode/types'
import { isRotaryOperationKind, type Operation, type Project } from '../../types/project'
import { isBarStock } from '../../types/barStock'
import { buildMotionLayerPathD } from './motionDebugSvg'
import { exportDialectLabels } from './exportDialectLabels'
import { planInspectMotion } from './inspectMotionPlan'
import { summaryMotionModel } from './motionDebugSummary'
import { buildWrappedMotion, type WrappedMotionModel } from './motionDebugWrapped'
import { MotionDebugWrappedView, type WrappedViewLayer } from './MotionDebugWrappedView'

interface ExportedMotionDebugDialogProps {
  operation: Operation
  /**
   * Asynchronous trace acquisition (issue #675). Requested against the same
   * snapshot that produced the displayed G-code, so the "Generated",
   * "Optimized" and "Exported" layers all describe one revision.
   */
  requestGenerationTrace: (operationId: string, signal?: AbortSignal) => Promise<ToolpathGenerationTrace | null>
  project: Project
  definition: MachineDefinition
  /** The already-computed postprocessor result from the Export dialog. */
  previewResult: PostProcessorResult
  /**
   * The prepared toolpath for this operation, when the Export dialog has it.
   * A rotary generator emits one final path and reports no separate raw path
   * (the engine's envelope is `{ result, raw: null }`), so the trace request
   * answers nothing for exactly the operations the wrapped view exists for.
   * This path is that same motion, and stands in for both debug layers.
   */
  toolpath?: ToolpathResult
  onClose: () => void
}

type LayerId = 'generated' | 'optimized' | 'exported'

/**
 * The drawing area's state while the trace is acquired (issue #1183). A
 * failure keeps the message it caught, which the old placeholder threw away.
 */
type PreparationState =
  | { state: 'preparing' }
  | { state: 'ready' }
  | { state: 'failed'; message: string }

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
  requestGenerationTrace,
  project,
  definition,
  previewResult,
  toolpath,
  onClose,
}: ExportedMotionDebugDialogProps) {
  useRestoreCanvasFocus()
  const { t } = useI18n()

  // Built once on open, in an effect rather than a memo: acquiring the trace is
  // a request, not a derivation, and since #675 its answer arrives in a later
  // tick. A completion that lands after the dialog closes — or after the
  // preparation it belongs to has changed — is dropped rather than rendered.
  // The exported-motion debug view is gated on one operation's generated
  // motion. The plan view's eligibility refuses variable-Z cutting, which every
  // rotary operation has by design, so a motion carrying rotary angles is
  // admitted through its wrapped view instead (issue #1179 correction round 3).
  const [model, setModel] = useState<ReturnType<typeof buildExportedMotionDebugModel> | null>(null)
  // What the drawing area is showing (issue #1183): preparing the trace takes
  // seconds on a big rotary path, and it used to be indistinguishable from a
  // failure because both rendered the same "Warning" placeholder.
  const [preparation, setPreparation] = useState<PreparationState>({ state: 'preparing' })
  // The 3D wrapped view's geometry (issue #1179): null for a program with no
  // rotary angle, which is what keeps the toggle off a flat operation.
  const [wrapped, setWrapped] = useState<WrappedMotionModel | null>(null)
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d')
  // Whether the path has discrete cutting levels, so the level selector and the
  // level-by-level comparison apply. A rotary rough/finish changes Z on every
  // move; the selector and the comparison are meaningless for it, and its plan
  // model costs seconds to build, so it has neither (#1179 correction round 3).
  const [levelsApply, setLevelsApply] = useState(true)
  // Whether the flat plan view exists for this path. The wrapped-only path has
  // no plan model to draw, so 2D is not offered at all.
  const [planView, setPlanView] = useState(true)
  // Whether the generator reported a separate raw path. A rotary operation has
  // none, so its "Generated (raw)" layer and the raw/removed counts are not
  // shown rather than reporting the prepared path twice under two names.
  const [hasRawTrace, setHasRawTrace] = useState(true)

  // The exported layer is named after what the machine exports: G-code, or a
  // ShopBot part file (issue #953).
  const exportedLayerLabel = exportDialectLabels(definition).exportedLayer

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [cssSize, setCssSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [view, setView] = useState<ViewState | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; vb: ViewState } | null>(null)

  // Inputs are stable for the dialog's lifetime (opened for one operation);
  // recompute only if they actually change.
  const inputs = `${operation.id}|${project.meta.units}|${definition.id}`
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      try {
        const requested = await requestGenerationTrace(operation.id, controller.signal)
        if (cancelled) return
        // A rotary operation has no separate raw path — the generator emits its
        // final motion — so the trace request correctly answers nothing for the
        // rotary kinds, which are exactly the operations the wrapped view is
        // for. The toolpath the Export dialog prepared is that same final path,
        // so it stands in for both source layers (#1179 correction round 3).
        const trace: ToolpathGenerationTrace | null = requested ?? (
          toolpath !== undefined && isRotaryOperationKind(operation.kind)
            ? { operationId: operation.id, raw: toolpath, optimized: toolpath }
            : null
        )
        if (!trace) {
          throw new Error('no-trace')
        }
        const plan = planInspectMotion(trace.optimized.moves)
        if (!plan.offer) {
          throw new Error(`ineligible:${plan.reason ?? ''}`)
        }
        // The plan view's own eligibility, true only for a trace with discrete
        // constant-Z cutting levels.
        const planar = getExportedMotionEligibility(trace.optimized.moves)
        const tolerance = exportGeometryTolerance(project.meta.units)
        const postprocessorTrace = previewResult.motionTraces?.[0]
        if (!postprocessorTrace) {
          throw new Error('no-motion-trace')
        }
        // The bar axis decides a borrowed motor's letter (#1153).
        const pinned = pinRotaryAxis(definition, project.stock)
        const parsed = parseExportedMotion(previewResult.gcode, pinned)
        const buildPlan = (): ReturnType<typeof buildExportedMotionDebugModel> => buildExportedMotionDebugModel({
          trace,
          parsed,
          postprocessorTrace,
          origin: project.origin,
          definition: pinned,
          tolerance,
        })
        // The plan model is a per-cutting-level comparison, quadratic in the
        // move count: it is built only where its levels mean something. A
        // rotary path changes Z on every move, so its wrapped view is the view
        // and the sidebar gets the counts alone (#1179 correction round 3).
        let built = planar.eligible ? buildPlan() : null
        const wrappedModel = isBarStock(project.stock)
          ? buildWrappedMotion({
            parsed,
            origin: project.origin,
            definition: pinned,
            stock: project.stock,
            trace,
            // The 2D model already snapped its exported segments to these
            // levels; the 3D view must agree, or the selector hides the
            // exported cuts it should show (review of #1179). A variable-Z
            // rotary program has no level to snap to — its selector is gone.
            zSnap: planar.eligible && built !== null ? { levels: built.zLevels, tolerance } : undefined,
          })
          : null
        // A rotary motion the machine's program carries no angle for has no
        // wrapped view either; the plan is all that is left, so it is built
        // even without discrete levels.
        if (wrappedModel === null && built === null) built = buildPlan()
        if (!cancelled) {
          setModel(built ?? summaryMotionModel(trace, parsed))
          // A wrapped rotary program is the reason this dialog was opened: it
          // lands on the wrapped view, and the plan stays a click away where
          // its levels are meaningful (#1179 correction round 3).
          setWrapped(wrappedModel)
          setLevelsApply(planar.eligible)
          setPlanView(built !== null)
          setHasRawTrace(requested !== null)
          setViewMode(wrappedModel !== null ? '3d' : '2d')
          setPreparation({ state: 'ready' })
        }
      } catch (e) {
        if (!cancelled) {
          setPreparation({ state: 'failed', message: e instanceof Error ? e.message : String(e) })
          setModel(null)
          setWrapped(null)
        }
      }
    })()
    // Releases the raw path with the request: the debug layer is the only
    // consumer that asks for one, and nothing should keep a second full copy of
    // the moves alive after the dialog is gone.
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs])

  // Measure the SVG viewport (CSS pixels) for pan/zoom + fit math. Re-runs when
  // the 3D view takes the area, so switching back re-attaches to the new box.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setCssSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [viewMode])

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
  // The wrapped view is the only view a variable-Z rotary path has, so it is
  // shown even though the toggle that normally selects it is not offered.
  // It is built from the prepared model, so 3D cannot be on screen while the
  // trace is still preparing: the drawing area's preparing/failure placeholder
  // is the whole 3D empty state too, not just the 2D one (#1183).
  const show3d = wrapped !== null && (viewMode === '3d' || !planView)
  // The 3D scene's layers, rebuilt only with the model: the same colours and
  // opacities the sidebar swatches show.
  // The layers this dialog has a source for. Without a raw path there is no
  // Generated layer to draw, so it is not offered.
  const sourceLayers = useMemo<LayerId[]>(
    () => (hasRawTrace ? (Object.keys(LAYER_STYLE) as LayerId[]) : ['optimized', 'exported']),
    [hasRawTrace],
  )
  const wrappedLayers = useMemo<WrappedViewLayer[]>(() => {
    if (!wrapped) return []
    return sourceLayers.map((id) => ({
      id,
      color: LAYER_STYLE[id].color,
      opacity: LAYER_STYLE[id].opacity,
      pieces: wrapped.layers[id],
    }))
  }, [wrapped, sourceLayers])
  const [selectedZ, setSelectedZ] = useState<number | 'all'>('all')
  const [zoomSelectMode, setZoomSelectMode] = useState(false)
  const selectionRef = useRef<{ startX: number; startY: number } | null>(null)
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const didInitZRef = useRef(false)
  // Default to the first cutting Z once the model loads (issue: defaults to the
  // first cutting Z in machine order; "All cutting levels" is opt-in). A path
  // whose Z varies on every move has no levels to choose: it draws all of them.
  useEffect(() => {
    if (!levelsApply) {
      didInitZRef.current = true
      setSelectedZ('all')
      return
    }
    if (model && model.zLevels.length > 0 && !didInitZRef.current) {
      didInitZRef.current = true
      setSelectedZ(model.zLevels[0])
    }
  }, [model, levelsApply])

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
            {levelsApply ? (
              <div data-testid="motion-debug-level">
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
            ) : (
              <div data-testid="motion-debug-variable-z-note">
                <div className="motion-debug__section-title">{t('dialogs.motionDebug.cuttingLevel')}</div>
                <div className="motion-debug__note">{t('dialogs.motionDebug.variableZAllLevels')}</div>
              </div>
            )}

            <div>
              <div className="motion-debug__section-title">{t('dialogs.export.options')}</div>
              <div className="motion-debug__layers">
                {sourceLayers.map((id) => (
                  <label key={id} className="motion-debug__layer-row">
                    <input
                      type="checkbox"
                      checked={visibleLayers[id]}
                      onChange={(e) => setVisibleLayers((s) => ({ ...s, [id]: e.target.checked }))}
                    />
                    <span className="motion-debug__swatch" style={{ background: LAYER_STYLE[id].color }} />
                    {t(id === 'exported' ? exportedLayerLabel : LAYER_STYLE[id].labelKey)}
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
                {hasRawTrace && (
                  <div>{t('dialogs.motionDebug.rawMoves')}: <strong>{model?.metrics.rawMoveCount ?? '—'}</strong></div>
                )}
                <div>{t('dialogs.motionDebug.optimizedMoves')}: <strong>{model?.metrics.optimizedMoveCount ?? '—'}</strong></div>
                {hasRawTrace && (
                  <div>{t('dialogs.motionDebug.removed')}: <strong>{model?.metrics.removedMoveCount ?? '—'}</strong></div>
                )}
              </div>
            </div>

            <div>
              <div className="motion-debug__section-title">{t(exportedLayerLabel)}</div>
              <div className="motion-debug__metrics">
                <div>{t('dialogs.motionDebug.linear')}: <strong>{model?.metrics.emitted.linear ?? '—'}</strong></div>
                <div>{t('dialogs.motionDebug.rapid')}: <strong>{model?.metrics.emitted.rapid ?? '—'}</strong></div>
                <div>{t('dialogs.motionDebug.arcCw')}: <strong>{model?.metrics.emitted.arcCw ?? '—'}</strong></div>
                <div>{t('dialogs.motionDebug.arcCcw')}: <strong>{model?.metrics.emitted.arcCcw ?? '—'}</strong></div>
              </div>
            </div>

            {levelsApply && model && model.zLevelStats.length > 0 && (
              <div data-testid="motion-debug-per-level">
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
              {wrapped && planView && (
                <div className="motion-debug__view-toggle" role="group" aria-label={t('dialogs.motionDebug.viewMode')}>
                  <button
                    className={`btn-secondary${show3d ? '' : ' btn-primary'}`}
                    type="button"
                    aria-pressed={!show3d}
                    onClick={() => setViewMode('2d')}
                  >
                    {t('dialogs.motionDebug.view2d')}
                  </button>
                  <button
                    className={`btn-secondary${show3d ? ' btn-primary' : ''}`}
                    type="button"
                    aria-pressed={show3d}
                    data-testid="motion-debug-view-3d"
                    onClick={() => setViewMode('3d')}
                  >
                    {t('dialogs.motionDebug.view3d')}
                  </button>
                </div>
              )}
              {!show3d && (
                <>
                  <button className="btn-secondary" type="button" onClick={handleFit} disabled={!model?.bounds}>{t('dialogs.motionDebug.fit')}</button>
                  <button
                    className={`btn-secondary${zoomSelectMode ? ' btn-primary' : ''}`}
                    type="button"
                    onClick={() => { setZoomSelectMode(!zoomSelectMode); setSelectionRect(null) }}
                  >
                    {t('dialogs.motionDebug.zoomSelection')}
                  </button>
                </>
              )}
            </div>
            {show3d && isBarStock(project.stock) ? (
              <MotionDebugWrappedView
                stock={project.stock}
                layers={wrappedLayers}
                visibleLayers={visibleLayers}
                // The sidebar's level and non-cutting filters apply to the
                // wrapped view too (review of #1179): without them every level
                // and rapid stayed on screen in 3D.
                selectedZ={selectedZ}
                showNonCutting={showNonCutting}
                aRange={wrapped.aRange}
                // A wrapped-only path has no plan to fall back to, so a failed
                // WebGL context must not claim one is still shown.
                fallbackPlan={planView}
              />
            ) : (
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
              {preparation.state === 'failed' ? (
                <div className="motion-debug__empty" data-testid="motion-debug-status">
                  {preparation.message.startsWith('ineligible:')
                    ? t(ineligibleKey[preparation.message.slice('ineligible:'.length)] ?? 'dialogs.motionDebug.ineligibleNoCut')
                    : t('dialogs.motionDebug.prepareFailed', { message: preparation.message })}
                </div>
              ) : preparation.state === 'preparing' || !model || !viewBoxStr ? (
                <div className="motion-debug__empty" data-testid="motion-debug-status">{t('dialogs.motionDebug.preparing')}</div>
              ) : (
                <svg className="motion-debug__svg" viewBox={viewBoxStr} preserveAspectRatio="xMidYMid meet">
                  <rect x={view!.x} y={view!.y} width={view!.w} height={view!.h} fill="transparent" pointerEvents="all" />
                  {sourceLayers.map((id) => {
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
            )}
            {/* No comparison is run for a wrapped-only path, so it is not
                reported as a verdict; the sidebar says why. */}
            {planView && (
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
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" onClick={onClose} type="button">{t('dialogs.common.close')}</button>
        </div>
      </div>
    </div>
  )
}
