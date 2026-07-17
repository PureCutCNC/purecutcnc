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

import { useI18n } from '../../../i18n/i18nContext'
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
  const { t } = useI18n()
  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton icon="new" label={t('file.newProject')} onClick={onNew} />
        <ToolbarActionButton icon="open" label={t('file.openProject')} onClick={onOpen} />
        <ToolbarActionButton icon="import" label={t('file.importGeometry')} onClick={onImport} />
        <ToolbarActionButton icon="export" label={t('file.exportModel')} onClick={onExportModel} />
        <ToolbarActionButton icon="print" label={t('file.printDesign')} onClick={onPrintDesign} />
        <ToolbarActionButton
          icon="save"
          label={projectDirty ? t('file.saveProjectDirty') : t('file.saveProject')}
          emphasized={projectDirty}
          onClick={onSave}
        />
      </div>
      <div className="toolbar-group">
        <ToolbarActionButton icon="undo" label={t('file.undo')} onClick={onUndo} disabled={historyLengthPast === 0} />
        <ToolbarActionButton icon="redo" label={t('file.redo')} onClick={onRedo} disabled={historyLengthFuture === 0} />
      </div>
      <div className="toolbar-group">
        <ToolbarActionButton icon="fit" label={t('shell.topBar.zoomToModel')} onClick={onZoomToModel} />
        <ToolbarActionButton
          icon="fit-window"
          label={zoomWindowActive ? t('shell.topBar.cancelZoomSelected') : t('shell.topBar.zoomSelected')}
          active={zoomWindowActive}
          onClick={onZoomWindow}
        />
      </div>
    </>
  )
}

export { GlobalActions }
