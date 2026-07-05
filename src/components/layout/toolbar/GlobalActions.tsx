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

import { ToolbarActionButton } from './primitives'

function GlobalActions({
  historyLengthPast,
  historyLengthFuture,
  onNew,
  onOpen,
  onImport,
  onExportModel,
  onPrintDesign,
  onSave,
  onUndo,
  onRedo,
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive,
  projectDirty,
}: {
  historyLengthPast: number
  historyLengthFuture: number
  onNew: () => void
  onOpen: () => void
  onImport: () => void
  onExportModel: () => void
  onPrintDesign: () => void
  onSave: () => void
  onUndo: () => void
  onRedo: () => void
  onZoomToModel: () => void
  onZoomWindow: () => void
  zoomWindowActive: boolean
  projectDirty: boolean
}) {
  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton icon="new" label="New project" onClick={onNew} />
        <ToolbarActionButton icon="open" label="Open project" onClick={onOpen} />
        <ToolbarActionButton icon="import" label="Import geometry" onClick={onImport} />
        <ToolbarActionButton icon="export" label="Export model" onClick={onExportModel} />
        <ToolbarActionButton icon="print" label="Print design" onClick={onPrintDesign} />
        <ToolbarActionButton
          icon="save"
          label={projectDirty ? 'Save project with unsaved changes' : 'Save project'}
          emphasized={projectDirty}
          onClick={onSave}
        />
      </div>
      <div className="toolbar-group">
        <ToolbarActionButton icon="undo" label="Undo" onClick={onUndo} disabled={historyLengthPast === 0} />
        <ToolbarActionButton icon="redo" label="Redo" onClick={onRedo} disabled={historyLengthFuture === 0} />
      </div>
      <div className="toolbar-group">
        <ToolbarActionButton icon="fit" label="Zoom to model" onClick={onZoomToModel} />
        <ToolbarActionButton
          icon="fit-window"
          label={zoomWindowActive ? 'Cancel zoom selected' : 'Zoom selected'}
          active={zoomWindowActive}
          onClick={onZoomWindow}
        />
      </div>
    </>
  )
}

export { GlobalActions }
