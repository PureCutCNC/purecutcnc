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

import type { RestRegionDraft } from '../../toolpaths/restRegions'
import type { Operation, Tab, Tool } from '../../../types/project'

export type CamPlanCoverageStatus = 'existing' | 'planned' | 'not_needed' | 'unsupported'

export interface CamPlanCoverage {
  featureId: string
  featureName: string
  status: CamPlanCoverageStatus
  detail: string
}

export interface CamPlanTool {
  id: string
  source: 'existing' | 'library'
  libraryKey?: string
  tool: Tool
}

export interface CamPlanRestDraft {
  sourceOperationKey: string
  sourceFeatureIds: string[]
  regions: RestRegionDraft[]
}

export type CamPlanOperationField = keyof Operation

export interface CamPlanOperationDraft {
  key: string
  enabled: boolean
  operation: Operation
  targetLabel: string
  rationale: string
  toolReason: string
  toolOptions: string[]
  coveredFeatureIds: string[]
  dependencies: string[]
  hardError: string | null
  staleReason: string | null
  userOverrides: CamPlanOperationField[]
  rest?: CamPlanRestDraft
}

export interface CamPlanSharedTabsDraft {
  key: string
  enabled: boolean
  targetFeatureIds: string[]
  operationKeys: string[]
  targetLabel: string
  reusedExistingTabs: boolean
  tabs: Tab[]
  warning: string | null
}

export interface CamPlanDraft {
  sourceFingerprint: string
  tools: CamPlanTool[]
  operations: CamPlanOperationDraft[]
  sharedTabs: CamPlanSharedTabsDraft[]
  coverage: CamPlanCoverage[]
}

export type ApplyCamPlanResult =
  | { ok: true; operationIds: string[] }
  | { ok: false; reason: 'stale' | 'invalid'; message: string }
