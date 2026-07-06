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

import { useProjectStore } from '../../../store/projectStore'
import { AlignmentActions, DistributionActions } from './AlignmentActions'
import { BackdropEditActions } from './BackdropEditActions'
import { CreationActions } from './CreationActions'
import { FeatureEditActions } from './FeatureEditActions'
import { GlobalActions } from './GlobalActions'
import { MeasureActions } from './MeasureActions'
import { ProjectNameControl } from './ProjectNameControl'
import { ShapeToolActions } from './ShapeToolActions'
import { SketchEditActions } from './SketchEditActions'
import { SnapActions } from './SnapActions'
import { ToolbarDialog } from './ToolbarDialog'
import { useToolbarState } from './useToolbarState'
import type { SnapToolbarProps, ToolbarProps } from './shared'

export function Toolbar({
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive = false,
  onImportComplete,
  onExportModel,
  onPrintDesign,
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: ToolbarProps & SnapToolbarProps) {
  const toolbar = useToolbarState(onZoomToModel, onImportComplete, onExportModel, onPrintDesign)

  return (
    <>
      <div className="toolbar toolbar--combined">
        <ProjectNameControl
          projectName={toolbar.project.meta.name}
          dirty={toolbar.dirty}
          editingName={toolbar.editingName}
          nameVal={toolbar.nameVal}
          setNameVal={toolbar.setNameVal}
          setEditingName={toolbar.setEditingName}
          setProjectName={toolbar.setProjectName}
        />
        <GlobalActions
          historyLengthPast={toolbar.historyLengthPast}
          historyLengthFuture={toolbar.historyLengthFuture}
          onNew={toolbar.fileCommands.newProject.onActivate}
          onOpen={toolbar.fileCommands.openProject.onActivate}
          onImport={toolbar.fileCommands.importGeometry.onActivate}
          onExportModel={toolbar.fileCommands.exportModel.onActivate}
          onPrintDesign={toolbar.fileCommands.printDesign.onActivate}
          onSave={toolbar.fileCommands.saveProject.onActivate}
          onUndo={toolbar.fileCommands.undo.onActivate}
          onRedo={toolbar.fileCommands.redo.onActivate}
          onZoomToModel={toolbar.handleZoomToModel}
          onZoomWindow={onZoomWindow}
          zoomWindowActive={zoomWindowActive}
          projectDirty={toolbar.dirty}
        />
        <SnapActions
          snapSettings={snapSettings}
          activeSnapMode={activeSnapMode}
          onToggleSnapEnabled={onToggleSnapEnabled}
          onToggleSnapMode={onToggleSnapMode}
        />
        <MeasureActions
          tapeActive={toolbar.sketchCommands.dimension.tapeMeasure.active}
          pendingDimensionType={toolbar.sketchCommands.dimension.pendingDimensionType}
          dimensionDeleteArmed={toolbar.sketchCommands.dimension.deleteDimension.active}
          showDimensions={toolbar.sketchCommands.dimension.showDimensions.active}
          dimensionCount={toolbar.sketchCommands.dimension.dimensionCount}
          onTapeMeasure={toolbar.sketchCommands.dimension.tapeMeasure.onActivate}
          onDimensionType={toolbar.sketchCommands.dimension.dimensionTypes.aligned.onActivate}
          onDeleteDimension={toolbar.sketchCommands.dimension.deleteDimension.onActivate}
          onToggleShowDimensions={toolbar.sketchCommands.dimension.showDimensions.onActivate}
        />
        <CreationActions
          pendingShape={toolbar.pendingShape}
          creationTarget={toolbar.creationCommands.creationTarget}
          onCreationTargetChange={toolbar.creationCommands.setCreationTarget}
          onRect={toolbar.creationCommands.shapeCommands[0].onActivate}
          onCircle={toolbar.creationCommands.shapeCommands[1].onActivate}
          onEllipse={toolbar.creationCommands.shapeCommands[2].onActivate}
          onPolygon={toolbar.creationCommands.shapeCommands[3].onActivate}
          onSpline={toolbar.creationCommands.shapeCommands[4].onActivate}
          onComposite={toolbar.creationCommands.shapeCommands[5].onActivate}
          onText={toolbar.creationCommands.shapeCommands[6].onActivate}
          onSlot={toolbar.creationCommands.shapeCommands[7].onActivate}
          onNgon={toolbar.creationCommands.shapeCommands[8].onActivate}
          onGear={toolbar.creationCommands.shapeCommands[9].onActivate}
          onRoundRect={toolbar.creationCommands.shapeCommands[10].onActivate}
          onChamferRect={toolbar.creationCommands.shapeCommands[11].onActivate}
        />
        <ShapeToolActions
          pendingShapeAction={toolbar.sketchCommands.boolean.join.active ? 'join' : toolbar.sketchCommands.boolean.cut.active ? 'cut' : null}
          onJoin={toolbar.sketchCommands.boolean.join.onActivate}
          onCut={toolbar.sketchCommands.boolean.cut.onActivate}
        />
        <FeatureEditActions
          enabled={toolbar.sketchCommands.predicates.hasSelectedFeatures}
          hasLockedSelection={toolbar.sketchCommands.predicates.hasLockedSelectedFeatures}
          hasClosedSelection={toolbar.sketchCommands.predicates.hasOffsetEligibleSelectedFeatures}
          pendingMoveMode={toolbar.sketchCommands.transform.move.active ? 'move' : toolbar.sketchCommands.transform.copy.active ? 'copy' : null}
          pendingTransformMode={toolbar.sketchCommands.transform.resize.active ? 'resize' : toolbar.sketchCommands.transform.rotate.active ? 'rotate' : toolbar.sketchCommands.transform.mirror.active ? 'mirror' : null}
          pendingOffset={toolbar.sketchCommands.boolean.offset.active}
          onCopy={toolbar.sketchCommands.transform.copy.onActivate}
          onMove={toolbar.sketchCommands.transform.move.onActivate}
          onDelete={toolbar.sketchCommands.transform.delete.onActivate}
          onResize={toolbar.sketchCommands.transform.resize.onActivate}
          onRotate={toolbar.sketchCommands.transform.rotate.onActivate}
          onMirror={toolbar.sketchCommands.transform.mirror.onActivate}
          onOffset={toolbar.sketchCommands.boolean.offset.onActivate}
          onConstraint={toolbar.sketchCommands.constraint.onActivate}
          constraintActive={toolbar.sketchCommands.constraint.active}
        />
        <AlignmentActions
          enabled={toolbar.sketchCommands.predicates.canAlignSelectedFeatures}
          onAlign={toolbar.sketchCommands.arrange.alignFeature}
        />
        <DistributionActions
          enabled={toolbar.sketchCommands.predicates.canDistributeSelectedFeatures}
          onDistribute={toolbar.sketchCommands.arrange.distributeFeatures}
        />
        <SketchEditActions
          enabled={toolbar.sketchCommands.predicates.featureSketchEditActive}
          activeTool={toolbar.sketchCommands.sketchEdit.add_point.active ? 'add_point' : toolbar.sketchCommands.sketchEdit.delete_point.active ? 'delete_point' : toolbar.sketchCommands.sketchEdit.delete_segment.active ? 'delete_segment' : toolbar.sketchCommands.sketchEdit.disconnect.active ? 'disconnect' : toolbar.sketchCommands.sketchEdit.fillet.active ? 'fillet' : toolbar.sketchCommands.sketchEdit.chamfer.active ? 'chamfer' : toolbar.sketchCommands.sketchEdit.trim.active ? 'trim' : toolbar.sketchCommands.sketchEdit.extend.active ? 'extend' : null}
          onAddPoint={toolbar.sketchCommands.sketchEdit.add_point.onActivate}
          onDeletePoint={toolbar.sketchCommands.sketchEdit.delete_point.onActivate}
          onDeleteSegment={toolbar.sketchCommands.sketchEdit.delete_segment.onActivate}
          onDisconnect={toolbar.sketchCommands.sketchEdit.disconnect.onActivate}
          onFillet={toolbar.sketchCommands.sketchEdit.fillet.onActivate}
          onChamfer={toolbar.sketchCommands.sketchEdit.chamfer.onActivate}
          onTrim={toolbar.sketchCommands.sketchEdit.trim.onActivate}
          onExtend={toolbar.sketchCommands.sketchEdit.extend.onActivate}
          trimExtendDisabled={!toolbar.sketchCommands.sketchEdit.trim.enabled}
        />
        <BackdropEditActions
          enabled={toolbar.hasSelectedBackdrop}
          pendingMoveMode={toolbar.pendingMove?.entityType === 'backdrop' && toolbar.pendingMove.mode === 'move' ? 'move' : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'backdrop' && toolbar.pendingTransform.mode !== 'mirror' ? toolbar.pendingTransform.mode : null}
          onMove={toolbar.handleBackdropMove}
          onDelete={toolbar.handleBackdropDelete}
          onResize={toolbar.handleBackdropResize}
          onRotate={toolbar.handleBackdropRotate}
        />
      </div>
      <ToolbarDialog
        showNewProjectDialog={toolbar.showNewProjectDialog}
        showImportDialog={toolbar.showImportDialog}
        showTextDialog={toolbar.showTextDialog}
        onCloseNewProject={() => {
          toolbar.setNameVal(useProjectStore.getState().project.meta.name)
          toolbar.setEditingName(false)
          toolbar.setShowNewProjectDialog(false)
        }}
        onCloseImport={() => toolbar.setShowImportDialog(false)}
        onCloseText={() => toolbar.setShowTextDialog(false)}
        onConfirmText={toolbar.confirmTextTool}
        onImportComplete={onImportComplete}
      />
    </>
  )
}
