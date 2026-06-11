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

import type { Operation, Project } from '../../types/project'
import type { NormalizedTool, ToolpathResult } from '../toolpaths/types'

export interface OperationBookletInput {
  project: Project
  operation: Operation
  tool: NormalizedTool | null
  toolpath: ToolpathResult | null
  snapshotPng?: Uint8Array
  generatedAt?: Date
}

export interface OperationBookletRow {
  label: string
  value: string
}

export interface OperationBookletReport {
  projectName: string
  operationName: string
  operationDescription: string
  generatedDate: string
  units: string
  originZSummary: string
  stockSizeSummary: string
  targetSummary: string
  targetFeatureNames: string[]
  toolRows: OperationBookletRow[]
  settingRows: OperationBookletRow[]
  warnings: string[]
  toolpathStats: OperationBookletRow[]
}
