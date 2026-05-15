import { useState } from 'react'
import { Icon } from '../Icon'
import { useProjectStore } from '../../store/projectStore'
import { featureHasClosedGeometry } from '../../text'
import { TextToolDialog } from '../project/TextToolDialog'
import type { FeatureAlignment, FeatureDistribution, SketchEditTool } from '../../store/types'
import type { TextToolConfig } from '../../text'

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
  const [showAlignPopover, setShowAlignPopover] = useState(false)
  const [showDistributePopover, setShowDistributePopover] = useState(false)

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

  function togglePlacement(shape: 'rect' | 'circle' | 'ellipse' | 'polygon' | 'spline' | 'composite', start: () => void) {
    if (pendingAdd?.shape === shape) {
      cancelPendingAdd()
      return
    }
    start()
  }

  function handleTextTool() {
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
          <RailButton icon="rect" label="Rectangle" active={pendingAdd?.shape === 'rect'} onClick={() => togglePlacement('rect', startAddRectPlacement)} />
          <RailButton icon="circle" label="Circle" active={pendingAdd?.shape === 'circle'} onClick={() => togglePlacement('circle', startAddCirclePlacement)} />
          <RailButton icon="ellipse" label="Ellipse" active={pendingAdd?.shape === 'ellipse'} onClick={() => togglePlacement('ellipse', startAddEllipsePlacement)} />
          <RailButton icon="polygon" label="Polygon" active={pendingAdd?.shape === 'polygon'} onClick={() => togglePlacement('polygon', startAddPolygonPlacement)} />
          <RailButton icon="spline" label="Spline" active={pendingAdd?.shape === 'spline'} onClick={() => togglePlacement('spline', startAddSplinePlacement)} />
          <RailButton icon="composite" label="Composite" active={pendingAdd?.shape === 'composite'} onClick={() => togglePlacement('composite', startAddCompositePlacement)} />
          <RailButton icon="text" label="Text" active={pendingAdd?.shape === 'text'} onClick={handleTextTool} />
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
            <div className="tool-rail__action">
              <button
                className={`tool-rail__btn ${showAlignPopover ? 'tool-rail__btn--active' : ''}`}
                type="button"
                aria-label="Align features"
                onClick={() => { setShowAlignPopover((v) => !v); setShowDistributePopover(false) }}
              >
                <Icon id="align" />
              </button>
              <span className="tool-rail__tooltip" role="tooltip">Align</span>
              {showAlignPopover && (
                <div className="tool-rail__popover">
                  <button type="button" aria-label="Align left" onClick={() => handleAlign('left')}><Icon id="align-left" /></button>
                  <button type="button" aria-label="Align center horizontal" onClick={() => handleAlign('center_horizontal')}><Icon id="align-center-horizontal" /></button>
                  <button type="button" aria-label="Align right" onClick={() => handleAlign('right')}><Icon id="align-right" /></button>
                  <button type="button" aria-label="Align top" onClick={() => handleAlign('top')}><Icon id="align-top" /></button>
                  <button type="button" aria-label="Align center vertical" onClick={() => handleAlign('center_vertical')}><Icon id="align-center-vertical" /></button>
                  <button type="button" aria-label="Align bottom" onClick={() => handleAlign('bottom')}><Icon id="align-bottom" /></button>
                </div>
              )}
            </div>
            {canDistribute && (
              <div className="tool-rail__action">
                <button
                  className={`tool-rail__btn ${showDistributePopover ? 'tool-rail__btn--active' : ''}`}
                  type="button"
                  aria-label="Distribute features"
                  onClick={() => { setShowDistributePopover((v) => !v); setShowAlignPopover(false) }}
                >
                  <Icon id="distribute" />
                </button>
                <span className="tool-rail__tooltip" role="tooltip">Distribute</span>
                {showDistributePopover && (
                  <div className="tool-rail__popover">
                    <button type="button" aria-label="Distribute horizontal gaps" onClick={() => handleDistribute('horizontal_gaps')}><Icon id="distribute-horizontal-gaps" /></button>
                    <button type="button" aria-label="Distribute horizontal centers" onClick={() => handleDistribute('horizontal_centers')}><Icon id="distribute-horizontal-centers" /></button>
                    <button type="button" aria-label="Distribute vertical gaps" onClick={() => handleDistribute('vertical_gaps')}><Icon id="distribute-vertical-gaps" /></button>
                    <button type="button" aria-label="Distribute vertical centers" onClick={() => handleDistribute('vertical_centers')}><Icon id="distribute-vertical-centers" /></button>
                  </div>
                )}
              </div>
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

      {showTextDialog && <TextToolDialog onClose={() => setShowTextDialog(false)} onConfirm={confirmTextTool} />}
    </>
  )
}
