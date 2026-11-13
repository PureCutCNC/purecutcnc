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

import { exportDialectLabels } from '../components/export/exportDialectLabels'
import { getActiveMachineDefinition } from '../engine/gcode/definitions'
import { useDesktopIntegration } from '../platform/useDesktopIntegration'
import type { DesktopIntegrationOptions } from '../platform/useDesktopIntegration'
import { useProjectStore } from '../store/projectStore'

/**
 * Desktop integration for the app shell. Adds the one thing the platform
 * layer cannot work out for itself: what the native export menu item should
 * say, which depends on the output format of the project's machine (issue
 * #953).
 */
export function useAppDesktopIntegration(options: Omit<DesktopIntegrationOptions, 'exportMenuLabel'>): void {
  // The selector returns a string, so it is stable until the wording changes.
  const exportMenuLabel = useProjectStore(
    (state) => exportDialectLabels(getActiveMachineDefinition(state.project)).nativeMenuItem,
  )
  useDesktopIntegration({ ...options, exportMenuLabel })
}
