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

/**
 * What a `.camj` folder import will report, for the import dialog to show
 * (issue #946). `mergeCamjFolders` has always returned warnings — an
 * operation left behind because its setup is missing, a setup added so an
 * imported operation keeps the face it was made for — and the store action
 * dropped them, so a Bottom setup could appear in a project with nothing said.
 *
 * The merge is pure, so this runs it against the same inputs the store action
 * is about to use and keeps only what it has to say. Nothing is changed.
 */

import { mergeCamjFolders } from '../../import'
import type { Project } from '../../types/project'

export function camjImportWarnings(input: {
  currentProject: Project
  sourceProject: Project
  selectedFolderIds: string[]
  importStock?: boolean
}): string[] {
  return mergeCamjFolders(input).warnings
}
