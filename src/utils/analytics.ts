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

import { isDesktop } from '../platform'

const GOATCOUNTER_SCRIPT_ID = 'goatcounter-count'
const GOATCOUNTER_ENDPOINT = 'https://purecutcnc.goatcounter.com/count'
const GOATCOUNTER_SRC = 'https://gc.zgo.at/count.js'

export function installAnalytics(): void {
  if (typeof document === 'undefined' || isDesktop) {
    return
  }

  if (document.getElementById(GOATCOUNTER_SCRIPT_ID)) {
    return
  }

  const script = document.createElement('script')
  script.id = GOATCOUNTER_SCRIPT_ID
  script.async = true
  script.src = GOATCOUNTER_SRC
  script.dataset.goatcounter = GOATCOUNTER_ENDPOINT
  document.head.append(script)
}
