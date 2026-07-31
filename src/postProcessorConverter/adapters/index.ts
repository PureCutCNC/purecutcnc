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

import type { SourceAdapter, SourceFormatId } from '../types'
import { visualMillAdapter } from './visualMill'
import { vectricEstlcamAdapter } from './vectricEstlcam'
import { artcamAdapter } from './artcam'
import { ecamAdapter } from './ecam'
import { sheetcamAdapter } from './sheetcam'
import { autodeskCpsAdapter } from './autodeskCps'
import { mastercamPstAdapter } from './mastercamPst'

export const ADAPTERS: SourceAdapter[] = [
  visualMillAdapter,
  vectricEstlcamAdapter,
  artcamAdapter,
  ecamAdapter,
  sheetcamAdapter,
  autodeskCpsAdapter,
  mastercamPstAdapter,
]

export function getAdapter(id: SourceFormatId): SourceAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id)
  if (!adapter) throw new Error(`Unknown source format id: ${id}`)
  return adapter
}

/** File extensions are unique across all seven formats, so extension alone
 *  is an unambiguous auto-detection signal — no content sniffing needed. */
export function detectAdapterByExtension(filePath: string): SourceAdapter | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(filePath)
  if (!match) return null
  const extension = match[1].toLowerCase()
  return ADAPTERS.find((a) => a.fileExtensions.includes(extension)) ?? null
}
