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

import { createPortal } from 'react-dom'
import { ImportGeometryDialog } from '../../project/ImportGeometryDialog'
import { NewProjectDialog } from '../../project/NewProjectDialog'
import { TextToolDialog } from '../../project/TextToolDialog'
import type { TextToolConfig } from '../../../text'

function ToolbarDialog({
  showNewProjectDialog,
  showImportDialog,
  showTextDialog,
  onCloseNewProject,
  onCloseImport,
  onCloseText,
  onConfirmText,
  onImportComplete,
}: {
  showNewProjectDialog: boolean
  showImportDialog: boolean
  showTextDialog: boolean
  onCloseNewProject: () => void
  onCloseImport: () => void
  onCloseText: () => void
  onConfirmText: (config: TextToolConfig) => void
  onImportComplete?: () => void
}) {
  const dialogs = (
    <>
      {showNewProjectDialog ? <NewProjectDialog onClose={onCloseNewProject} /> : null}
      {showImportDialog ? <ImportGeometryDialog onClose={onCloseImport} onImportComplete={onImportComplete} /> : null}
      {showTextDialog ? <TextToolDialog onClose={onCloseText} onConfirm={onConfirmText} /> : null}
    </>
  )

  if (typeof document === 'undefined') {
    return dialogs
  }

  return createPortal(dialogs, document.body)
}

export { ToolbarDialog }
