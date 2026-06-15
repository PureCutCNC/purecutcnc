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

import { useState } from 'react'
import { useCreationShapeCommands } from '../../../commands/creationShapes'
import { useFileCommands } from '../../../commands/fileCommands'
import { useSketchCommands } from '../../../commands/sketchCommands'
import { useProjectStore } from '../../../store/projectStore'
import type { TextToolConfig } from '../../../text'

export function useToolbarState(onZoomToModel: () => void, onImportComplete?: () => void, onExportModel: () => void = () => undefined) {
  void onImportComplete
  const {
    project,
    setProjectName,
    startMoveBackdrop,
    startResizeBackdrop,
    startRotateBackdrop,
    deleteBackdrop,
    pendingMove,
    pendingTransform,
    cancelPendingMove,
    cancelPendingTransform,
  } = useProjectStore()
  const sketchCommands = useSketchCommands()

  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(project.meta.name)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showTextDialog, setShowTextDialog] = useState(false)
  const creationCommands = useCreationShapeCommands({
    onRequestText: () => setShowTextDialog(true),
  })
  const fileCommands = useFileCommands({
    onNewProject: () => setShowNewProjectDialog(true),
    onImportGeometry: () => setShowImportDialog(true),
    onExportModel,
  })

  // Keep the edit field in sync with the project name when it changes externally
  // (load / new project) while not editing. Adjusting state during render — the
  // React-recommended alternative to a synchronous setState-in-effect. Entering
  // edit mode seeds `nameVal` in its own click handler, so only out-of-edit
  // changes need syncing here.
  const [syncedName, setSyncedName] = useState(project.meta.name)
  if (!editingName && project.meta.name !== syncedName) {
    setSyncedName(project.meta.name)
    setNameVal(project.meta.name)
  }

  function confirmTextTool(config: TextToolConfig) {
    creationCommands.confirmTextTool(config)
    setShowTextDialog(false)
  }

  function handleBackdropMove() {
    if (!project.backdrop) {
      return
    }

    if (pendingMove?.entityType === 'backdrop' && pendingMove.mode === 'move') {
      cancelPendingMove()
      return
    }

    startMoveBackdrop()
  }

  function handleBackdropResize() {
    if (!project.backdrop) {
      return
    }

    if (pendingTransform?.entityType === 'backdrop' && pendingTransform.mode === 'resize') {
      cancelPendingTransform()
      return
    }

    startResizeBackdrop()
  }

  function handleBackdropRotate() {
    if (!project.backdrop) {
      return
    }

    if (pendingTransform?.entityType === 'backdrop' && pendingTransform.mode === 'rotate') {
      cancelPendingTransform()
      return
    }

    startRotateBackdrop()
  }

  function handleBackdropDelete() {
    deleteBackdrop()
  }

  return {
    project,
    dirty: fileCommands.dirty,
    pendingShape: creationCommands.pendingShape,
    pendingMove: sketchCommands.predicates.hasSelectedBackdrop ? pendingMove : null,
    pendingTransform: sketchCommands.predicates.hasSelectedBackdrop ? pendingTransform : null,
    historyLengthPast: fileCommands.historyPastLength,
    historyLengthFuture: fileCommands.historyFutureLength,
    editingName,
    nameVal,
    showNewProjectDialog,
    showImportDialog,
    showTextDialog,
    hasSelectedBackdrop: sketchCommands.predicates.hasSelectedBackdrop,
    setProjectName,
    setEditingName,
    setNameVal,
    setShowNewProjectDialog,
    setShowImportDialog,
    setShowTextDialog,
    fileCommands: fileCommands.commands,
    handleZoomToModel: onZoomToModel,
    creationCommands,
    sketchCommands,
    confirmTextTool,
    handleBackdropMove,
    handleBackdropResize,
    handleBackdropRotate,
    handleBackdropDelete,
  }
}
