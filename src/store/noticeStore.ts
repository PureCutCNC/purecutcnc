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
 * Transient command notice (issue #1112 A2).
 *
 * Some refusals have no control to hover: double-clicking a generated shape to
 * edit its sketch, or clicking one as a trim reference. Those paths need a
 * visible reason, so they publish an i18n key here and the app shell renders
 * it as a live status message. The message lives outside `ProjectStore`
 * because it is view state, never part of the saved document.
 */

import { create } from 'zustand'
import type { MessageKey } from '../i18n/locales/en'

export interface CommandNotice {
  /** i18n key of the reason to show. */
  messageKey: MessageKey
  /** Monotonic token so repeating the same reason re-announces it. */
  nonce: number
}

interface NoticeStore {
  notice: CommandNotice | null
  showNotice: (messageKey: MessageKey) => void
  clearNotice: () => void
}

let nextNonce = 1

export const useNoticeStore = create<NoticeStore>((set) => ({
  notice: null,
  showNotice: (messageKey) => set({ notice: { messageKey, nonce: nextNonce++ } }),
  clearNotice: () => set({ notice: null }),
}))
