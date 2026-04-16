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

import type { PlatformApi } from './api'
import { browserPlatform } from './browser'
import { desktopPlatform } from './desktop'

export type { PlatformApi, OpenProjectResult, PickGeometryResult } from './api'

/**
 * True when the app is running inside Tauri.
 * Tauri v2 injects __TAURI_INTERNALS__ into the window object.
 */
export const isDesktop =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const platform: PlatformApi = isDesktop ? desktopPlatform : browserPlatform
