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
