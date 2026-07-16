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
import { GlobalActions } from './GlobalActions'
import { MeasureActions } from './MeasureActions'
import { ProjectNameControl } from './ProjectNameControl'
import { SnapActions } from './SnapActions'
import { ToolbarDialog } from './ToolbarDialog'
import { useToolbarState } from './useToolbarState'
import type { SnapToolbarProps, ToolbarProps } from './shared'
import { AppearanceControl } from '../AppearanceControl'

export function GlobalToolbar({
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
      <div className="toolbar toolbar--global">
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
        <div className="toolbar-group toolbar-group--appearance">
          <AppearanceControl />
        </div>
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
