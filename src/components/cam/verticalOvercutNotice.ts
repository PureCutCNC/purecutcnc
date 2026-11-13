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
 * The CAM panel's notice under an Edge Route's Vertical overcut field (issue
 * #834). Pure, so the panel's wording can be checked without rendering: a
 * valid overcut is a warning naming the amount in project units, a refused one
 * is the error that says why no toolpath is generated.
 */

import type { Operation, Project } from '../../types/project'
import type { MessageParams } from '../../i18n/catalog'
import { resolveVerticalOvercut, verticalOvercutWarning } from '../../engine/toolpaths/verticalOvercut'

export interface VerticalOvercutFieldNotice {
  tone: 'warning' | 'error'
  key: 'cam.operation.verticalOvercutNotice' | 'cam.operation.verticalOvercutInvalid'
  params: MessageParams
}

export function verticalOvercutFieldNotice(project: Pick<Project, 'meta'>, operation: Operation): VerticalOvercutFieldNotice | null {
  const status = resolveVerticalOvercut(project, operation)
  // The engine's own warning carries the formatted amount and limit, so the
  // panel, the export and the booklet print the same numbers.
  const warning = verticalOvercutWarning(project, operation, status)
  if (!warning) return null
  const params: MessageParams = { amount: String(warning.params?.amount ?? '') }
  if (status.kind === 'ok') return { tone: 'warning', key: 'cam.operation.verticalOvercutNotice', params }
  return {
    tone: 'error',
    key: 'cam.operation.verticalOvercutInvalid',
    params: { ...params, limit: String(warning.params?.limit ?? '') },
  }
}
