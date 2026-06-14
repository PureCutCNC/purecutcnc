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

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'
import { usePortalPosition } from '../../hooks/usePortalPosition'
import { useProjectStore } from '../../store/projectStore'
import { featureHasClosedGeometry } from '../../text'
import { TextToolDialog } from '../project/TextToolDialog'
import type { FeatureAlignment, FeatureDistribution, SketchEditTool } from '../../store/types'
import type { TextToolConfig } from '../../text'

const CREATION_SHAPE_OPTIONS = [
  { value: 'rect', icon: 'rect', noun: 'rectangle' },
  { value: 'circle', icon: 'circle', noun: 'circle' },
  { value: 'ellipse', icon: 'ellipse', noun: 'ellipse' },
  { value: 'polygon', icon: 'polygon', noun: 'polygon' },
  { value: 'spline', icon: 'spline', noun: 'spline' },
  { value: 'composite', icon: 'composite', noun: 'composite' },
  { value: 'text', icon: 'text', noun: 'text' },
] as const

type CreationShape = typeof CREATION_SHAPE_OPTIONS[number]['value']
type PlacementShape = Exclude<CreationShape, 'text'>

function RailButton({
  icon,
  label,
  active = false,
  emphasized = false,
  disabled = false,
  onClick,
}: {
  icon: string
  label: string
  active?: boolean
  emphasized?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <div className="tool-rail__action">
      <button
        className={`tool-rail__btn ${active ? 'tool-rail__btn--active' : ''} ${emphasized ? 'tool-rail__btn--live' : ''}`}
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={(e) => {
          onClick()
          e.currentTarget.blur()
        }}
      >
        <Icon id={icon} />
      </button>
      <span className="tool-rail__tooltip" role="tooltip">{label}</span>
    </div>
  )
}

/**
 * A rail button with a flyout menu (align / distribute). The menu is portaled
 * to document.body and positioned with fixed coordinates from the trigger, so
 * the scrolling tool rail (overflow-y: auto) cannot clip it.
 */
function RailFlyout({
  icon,
  label,
  tooltip,
  open,
  onToggle,
  onClose,
  children,
}: {
  icon: string
  label: string
  tooltip: string
  open: boolean
  onToggle: () => void
  onClose: () => void
  children: ReactNode
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const coords = usePortalPosition(btnRef, popRef, open, (b, p) => {
    const margin = 8
    let left = b.right + 6
    let top = b.top + b.height / 2 - p.height / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin))
    top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin))
    return { top, left }
  })

  useEffect(() => {
    if (!open) {
      return
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) {
        return
      }
      onClose()
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  return (
    <div className="tool-rail__action">
      <button
        ref={btnRef}
        className={`tool-rail__btn ${open ? 'tool-rail__btn--active' : ''}`}
        type="button"
        aria-label={label}
        onClick={onToggle}
      >
        <Icon id={icon} />
      </button>
      <span className="tool-rail__tooltip" role="tooltip">{tooltip}</span>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="tool-rail__popover tool-rail__popover--floating"
              style={{
                position: 'fixed',
                top: coords?.top ?? -9999,
                left: coords?.left ?? -9999,
                visibility: coords ? 'visible' : 'hidden',
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

interface ToolRailProps {
  onZoomToModel: () => void
  onImportComplete?: () => void
}

export function ToolRail({ onZoomToModel: _onZoomToModel, onImportComplete: _onImportComplete }: ToolRailProps) {
  void _onZoomToModel
  void _onImportComplete

  const {
    project,
    pendingAdd,
    selection,
    pendingMove,
    pendingTransform,
    pendingOffset,
    pendingShapeAction,
    pendingConstraint,
    creationTarget,
    setCreationTarget,
    startAddRectPlacement,
    startAddCirclePlacement,
    startAddEllipsePlacement,
    startAddPolygonPlacement,
    startAddSplinePlacement,
    startAddCompositePlacement,
    startAddTextPlacement,
    startMoveFeature,
    startCopyFeature,
    startResizeFeature,
    startRotateFeature,
    startMirrorFeature,
    startJoinSelectedFeatures,
    startCutSelectedFeatures,
    startOffsetSelectedFeatures,
    alignFeatures,
    distributeFeatures,
    deleteFeatures,
    setSketchEditTool,
    beginConstraint,
    cancelPendingAdd,
    cancelPendingMove,
    cancelPendingTransform,
    cancelPendingOffset,
    cancelPendingShapeAction,
    cancelPendingConstraint,
  } = useProjectStore()

  const [showTextDialog, setShowTextDialog] = useState(false)
  const [showCreationPopover, setShowCreationPopover] = useState(false)
  const [showAlignPopover, setShowAlignPopover] = useState(false)
  const [showDistributePopover, setShowDistributePopover] = useState(false)
  const [lastCreationShape, setLastCreationShape] = useState<CreationShape>('rect')

  const selectedFeatureIds = selection.mode === 'feature' ? selection.selectedFeatureIds : []
  const primarySelectedFeatureId = selection.selectedFeatureId ?? selectedFeatureIds[0] ?? null
  const selectedFeatures = selectedFeatureIds
    .map((id) => project.features.find((f) => f.id === id) ?? null)
    .filter((f): f is NonNullable<typeof f> => f !== null)
  const hasSelectedFeatures = selectedFeatureIds.length > 0
  const hasLockedSelectedFeatures = selectedFeatures.some((f) => f.locked)
  const hasClosedSelectedFeatures = selectedFeatures.length > 0 && selectedFeatures.every((f) => featureHasClosedGeometry(f))
  const hasOffsetEligibleSelectedFeatures = hasClosedSelectedFeatures && selectedFeatures.every((f) => f.kind !== 'text')
  const alignableCount = selectedFeatures.filter((f) => !f.locked).length
  const canAlign = alignableCount >= 2
  const canDistribute = alignableCount >= 3
  const featureSketchEditActive = selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'feature' && !!selection.selectedFeatureId

  const availableCreationOptions = creationTarget === 'region'
    ? CREATION_SHAPE_OPTIONS.filter((option) => option.value !== 'text')
    : CREATION_SHAPE_OPTIONS
  const lastCreationOption = availableCreationOptions.find((option) => option.value === lastCreationShape) ?? availableCreationOptions[0]

  function togglePlacement(shape: PlacementShape, start: () => void) {
    if (pendingAdd?.shape === shape) {
      cancelPendingAdd()
      return
    }
    start()
  }

  function startCreationShape(shape: CreationShape) {
    if (shape === 'text') {
      handleTextTool()
      return
    }
    if (shape === 'rect') {
      togglePlacement(shape, startAddRectPlacement)
    } else if (shape === 'circle') {
      togglePlacement(shape, startAddCirclePlacement)
    } else if (shape === 'ellipse') {
      togglePlacement(shape, startAddEllipsePlacement)
    } else if (shape === 'polygon') {
      togglePlacement(shape, startAddPolygonPlacement)
    } else if (shape === 'spline') {
      togglePlacement(shape, startAddSplinePlacement)
    } else {
      togglePlacement(shape, startAddCompositePlacement)
    }
  }

  function selectCreationShape(shape: CreationShape) {
    setLastCreationShape(shape)
    setShowCreationPopover(false)
    startCreationShape(shape)
  }

  function handleTextTool() {
    if (creationTarget === 'region') return
    if (pendingAdd) cancelPendingAdd()
    setShowTextDialog(true)
  }

  function confirmTextTool(config: TextToolConfig) {
    startAddTextPlacement(config)
    setShowTextDialog(false)
  }

  function handleMove() {
    if (!primarySelectedFeatureId) return
    if (pendingMove?.entityType === 'feature' && pendingMove.mode === 'move') { cancelPendingMove(); return }
    startMoveFeature(primarySelectedFeatureId)
  }

  function handleCopy() {
    if (!primarySelectedFeatureId) return
    if (pendingMove?.entityType === 'feature' && pendingMove.mode === 'copy') { cancelPendingMove(); return }
    startCopyFeature(primarySelectedFeatureId)
  }

  function handleResize() {
    if (!primarySelectedFeatureId) return
    if (pendingTransform?.mode === 'resize') { cancelPendingTransform(); return }
    startResizeFeature(primarySelectedFeatureId)
  }

  function handleRotate() {
    if (!primarySelectedFeatureId) return
    if (pendingTransform?.mode === 'rotate') { cancelPendingTransform(); return }
    startRotateFeature(primarySelectedFeatureId)
  }

  function handleMirror() {
    if (!primarySelectedFeatureId) return
    if (pendingTransform?.mode === 'mirror') { cancelPendingTransform(); return }
    startMirrorFeature(primarySelectedFeatureId)
  }

  function handleJoin() {
    if (pendingShapeAction?.kind === 'join') { cancelPendingShapeAction(); return }
    startJoinSelectedFeatures()
  }

  function handleCut() {
    if (pendingShapeAction?.kind === 'cut') { cancelPendingShapeAction(); return }
    startCutSelectedFeatures()
  }

  function handleOffset() {
    if (pendingOffset) { cancelPendingOffset(); return }
    startOffsetSelectedFeatures()
  }

  function handleConstraint() {
    if (pendingConstraint) { cancelPendingConstraint(); return }
    const featureId = (selection.selectedNode?.type === 'feature' ? selection.selectedNode.featureId : null) ?? selection.selectedFeatureId
    if (!featureId) return
    if (featureSketchEditActive) setSketchEditTool(null)
    beginConstraint(featureId)
  }

  function handleAlign(alignment: FeatureAlignment) {
    const ids = selectedFeatures.filter((f) => !f.locked).map((f) => f.id)
    if (ids.length < 2) return
    alignFeatures(ids, alignment)
    setShowAlignPopover(false)
  }

  function handleDistribute(distribution: FeatureDistribution) {
    const ids = selectedFeatures.filter((f) => !f.locked).map((f) => f.id)
    if (ids.length < 3) return
    distributeFeatures(ids, distribution)
    setShowDistributePopover(false)
  }

  function toggleSketchEditTool(tool: SketchEditTool) {
    if (!featureSketchEditActive) return
    setSketchEditTool(selection.sketchEditTool === tool ? null : tool)
  }

  return (
    <>
      <nav className="tool-rail" aria-label="Tools">
        {/* Creation target toggle */}
        <div className="tool-rail__section">
          <div className="tool-rail__target-toggle">
            <button
              className={`tool-rail__target-btn ${creationTarget === 'feature' ? 'tool-rail__target-btn--active' : ''}`}
              type="button"
              aria-label="Create features"
              aria-pressed={creationTarget === 'feature'}
              onClick={() => setCreationTarget('feature')}
            >
              <Icon id="plus" />
            </button>
            <button
              className={`tool-rail__target-btn tool-rail__target-btn--region ${creationTarget === 'region' ? 'tool-rail__target-btn--active' : ''}`}
              type="button"
              aria-label="Create regions"
              aria-pressed={creationTarget === 'region'}
              onClick={() => setCreationTarget('region')}
            >
              <Icon id="pocket" />
            </button>
          </div>
        </div>

        {/* Creation tools */}
        <div className="tool-rail__section">
          <RailFlyout
            icon="feature-drawer"
            label={`Choose ${creationTarget} shape`}
            tooltip="Shapes"
            open={showCreationPopover}
            onToggle={() => {
              setShowCreationPopover((v) => !v)
              setShowAlignPopover(false)
              setShowDistributePopover(false)
            }}
            onClose={() => setShowCreationPopover(false)}
          >
            {availableCreationOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={`Add ${creationTarget} ${option.noun}`}
                className={lastCreationOption.value === option.value ? 'tool-rail__popover-btn--active' : ''}
                onClick={() => selectCreationShape(option.value)}
              >
                <Icon id={option.icon} />
              </button>
            ))}
          </RailFlyout>
          <RailButton
            icon={lastCreationOption.icon}
            label={pendingAdd?.shape === lastCreationOption.value ? `Cancel ${lastCreationOption.noun}` : `Add ${creationTarget} ${lastCreationOption.noun}`}
            active={pendingAdd?.shape === lastCreationOption.value}
            onClick={() => startCreationShape(lastCreationOption.value)}
          />
        </div>

        {/* Edit tools (visible when features selected) */}
        {hasSelectedFeatures && (
          <div className="tool-rail__section">
            <RailButton icon="copy" label="Copy" active={pendingMove?.entityType === 'feature' && pendingMove.mode === 'copy'} onClick={handleCopy} />
            <RailButton icon="move" label="Move" active={pendingMove?.entityType === 'feature' && pendingMove.mode === 'move'} disabled={hasLockedSelectedFeatures} onClick={handleMove} />
            <RailButton icon="trash" label="Delete" onClick={() => deleteFeatures(selectedFeatureIds)} />
            <RailButton icon="resize" label="Resize" active={pendingTransform?.mode === 'resize'} disabled={hasLockedSelectedFeatures} onClick={handleResize} />
            <RailButton icon="rotate" label="Rotate" active={pendingTransform?.mode === 'rotate'} disabled={hasLockedSelectedFeatures} onClick={handleRotate} />
            <RailButton icon="mirror" label="Mirror" active={pendingTransform?.mode === 'mirror'} disabled={hasLockedSelectedFeatures} onClick={handleMirror} />
            <RailButton icon="offset" label="Offset" active={!!pendingOffset} disabled={hasLockedSelectedFeatures || !hasOffsetEligibleSelectedFeatures} onClick={handleOffset} />
            <RailButton icon="constraint" label="Constraint" active={!!pendingConstraint} disabled={hasLockedSelectedFeatures} onClick={handleConstraint} />
            <RailButton icon="merge" label="Join" active={pendingShapeAction?.kind === 'join'} onClick={handleJoin} />
            <RailButton icon="cut" label="Cut" active={pendingShapeAction?.kind === 'cut'} onClick={handleCut} />
          </div>
        )}

        {/* Alignment/distribution (multi-select) */}
        {canAlign && (
          <div className="tool-rail__section">
            <RailFlyout
              icon="align"
              label="Align features"
              tooltip="Align"
              open={showAlignPopover}
              onToggle={() => { setShowAlignPopover((v) => !v); setShowDistributePopover(false) }}
              onClose={() => setShowAlignPopover(false)}
            >
              <button type="button" aria-label="Align left" onClick={() => handleAlign('left')}><Icon id="align-left" /></button>
              <button type="button" aria-label="Align center horizontal" onClick={() => handleAlign('center_horizontal')}><Icon id="align-center-horizontal" /></button>
              <button type="button" aria-label="Align right" onClick={() => handleAlign('right')}><Icon id="align-right" /></button>
              <button type="button" aria-label="Align top" onClick={() => handleAlign('top')}><Icon id="align-top" /></button>
              <button type="button" aria-label="Align center vertical" onClick={() => handleAlign('center_vertical')}><Icon id="align-center-vertical" /></button>
              <button type="button" aria-label="Align bottom" onClick={() => handleAlign('bottom')}><Icon id="align-bottom" /></button>
            </RailFlyout>
            {canDistribute && (
              <RailFlyout
                icon="distribute"
                label="Distribute features"
                tooltip="Distribute"
                open={showDistributePopover}
                onToggle={() => { setShowDistributePopover((v) => !v); setShowAlignPopover(false) }}
                onClose={() => setShowDistributePopover(false)}
              >
                <button type="button" aria-label="Distribute horizontal gaps" onClick={() => handleDistribute('horizontal_gaps')}><Icon id="distribute-horizontal-gaps" /></button>
                <button type="button" aria-label="Distribute horizontal centers" onClick={() => handleDistribute('horizontal_centers')}><Icon id="distribute-horizontal-centers" /></button>
                <button type="button" aria-label="Distribute vertical gaps" onClick={() => handleDistribute('vertical_gaps')}><Icon id="distribute-vertical-gaps" /></button>
                <button type="button" aria-label="Distribute vertical centers" onClick={() => handleDistribute('vertical_centers')}><Icon id="distribute-vertical-centers" /></button>
              </RailFlyout>
            )}
          </div>
        )}

        {/* Sketch edit tools */}
        {featureSketchEditActive && (
          <div className="tool-rail__section">
            <RailButton icon="point-add" label="Add point" active={selection.sketchEditTool === 'add_point'} onClick={() => toggleSketchEditTool('add_point')} />
            <RailButton icon="point-delete" label="Delete point" active={selection.sketchEditTool === 'delete_point'} onClick={() => toggleSketchEditTool('delete_point')} />
            <RailButton icon="segment-delete" label="Delete segment" active={selection.sketchEditTool === 'delete_segment'} onClick={() => toggleSketchEditTool('delete_segment')} />
            <RailButton icon="disconnect" label="Disconnect" active={selection.sketchEditTool === 'disconnect'} onClick={() => toggleSketchEditTool('disconnect')} />
            <RailButton icon="fillet" label="Fillet" active={selection.sketchEditTool === 'fillet'} onClick={() => toggleSketchEditTool('fillet')} />
          </div>
        )}
      </nav>

      {showTextDialog && typeof document !== 'undefined'
        ? createPortal(
            <TextToolDialog onClose={() => setShowTextDialog(false)} onConfirm={confirmTextTool} />,
            document.body,
          )
        : null}
    </>
  )
}
