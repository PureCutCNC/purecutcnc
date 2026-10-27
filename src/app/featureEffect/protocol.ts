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
 * The feature-effect worker's wire format (issue #1112 N). Types only: both
 * ends import this module, and the worker graph must not gain a runtime edge
 * back to the main thread.
 */

import type { FeatureEffectFeature } from '../../engine/featureEffect'

export interface FeatureEffectRequest {
  type: 'analyze'
  requestId: number
  features: readonly FeatureEffectFeature[]
}

export type FeatureEffectResponse =
  | { type: 'result'; requestId: number; warnings: string[] }
  | { type: 'error'; requestId: number; message: string }
