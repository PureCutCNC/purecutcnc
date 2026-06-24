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

import type { DimensionType, Project, SketchFeature } from '../types/project'
import { useProjectStore } from '../store/projectStore'
import type {
  FeatureAlignment,
  FeatureDistribution,
  PendingConstraint,
  PendingDimensionTool,
  PendingMoveTool,
  PendingOffsetTool,
  PendingShapeActionTool,
  PendingTransformTool,
  SelectionState,
  SketchEditTool,
  TapeMeasureState,
} from '../store/types'
import { featureHasClosedGeometry } from '../text'

export interface CommandDescriptor {
  id: string
  icon: string
  label: string
  enabled: boolean
  active: boolean
  onActivate: () => void
}

export interface ValueCommandDescriptor<T extends string> extends Omit<CommandDescriptor, 'onActivate'> {
  value: T
  onActivate: (value: T) => void
}

export interface SketchCommandPredicates {
  selectedFeatureIds: string[]
  primarySelectedFeatureId: string | null
  selectedFeatures: SketchFeature[]
  hasSelectedFeatures: boolean
  hasSelectedBackdrop: boolean
  hasLockedSelectedFeatures: boolean
  hasClosedSelectedFeatures: boolean
  hasOffsetEligibleSelectedFeatures: boolean
  alignableFeatureIds: string[]
  canAlignSelectedFeatures: boolean
  canDistributeSelectedFeatures: boolean
  featureSketchEditActive: boolean
  selectedConstraintFeatureId: string | null
}

type CommandStatus = Pick<CommandDescriptor, 'enabled' | 'active'>

export interface SketchCommandStatus {
  transform: Record<'copy' | 'move' | 'delete' | 'resize' | 'rotate' | 'mirror', CommandStatus>
  boolean: Record<'join' | 'cut' | 'offset', CommandStatus>
  arrange: Record<'align' | 'distribute', CommandStatus>
  sketchEdit: Record<SketchEditTool, CommandStatus>
  constraint: CommandStatus
  dimension: {
    tapeMeasure: CommandStatus
    deleteDimension: CommandStatus
    showDimensions: CommandStatus
    dimensionTypes: Record<DimensionType, CommandStatus>
  }
}

export interface SketchCommandStateInput {
  project: Project
  selection: SelectionState
  pendingMove: PendingMoveTool | null
  pendingTransform: PendingTransformTool | null
  pendingOffset: PendingOffsetTool | null
  pendingShapeAction: PendingShapeActionTool | null
  pendingConstraint: PendingConstraint | null
  tapeMeasure: TapeMeasureState | null
  pendingDimension: PendingDimensionTool | null
  dimensionDeleteArmed: boolean
}

export interface SketchCommandState extends SketchCommandStatus {
  predicates: SketchCommandPredicates
}

export const DIMENSION_TYPE_VALUES: DimensionType[] = [
  'aligned',
  'horizontal',
  'vertical',
  'radius',
  'diameter',
  'angle',
]

export function deriveSketchCommandPredicates({
  project,
  selection,
}: Pick<SketchCommandStateInput, 'project' | 'selection'>): SketchCommandPredicates {
  const selectedFeatureIds = selection.mode === 'feature' ? selection.selectedFeatureIds : []
  const primarySelectedFeatureId = selection.selectedFeatureId ?? selectedFeatureIds[0] ?? null
  const selectedFeatures = selectedFeatureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
  const hasSelectedFeatures = selectedFeatureIds.length > 0
  const hasSelectedBackdrop = selection.selectedNode?.type === 'backdrop' && !!project.backdrop
  const hasLockedSelectedFeatures = selectedFeatures.some((feature) => feature.locked)
  const hasClosedSelectedFeatures =
    selectedFeatures.length > 0 && selectedFeatures.every((feature) => featureHasClosedGeometry(feature))
  const hasOffsetEligibleSelectedFeatures =
    hasClosedSelectedFeatures && selectedFeatures.every((feature) => feature.kind !== 'text')
  const alignableFeatureIds = selectedFeatures
    .filter((feature) => !feature.locked)
    .map((feature) => feature.id)
  const featureSketchEditActive =
    selection.mode === 'sketch_edit'
    && selection.selectedNode?.type === 'feature'
    && !!selection.selectedFeatureId
  const selectedConstraintFeatureId =
    (selection.selectedNode?.type === 'feature' ? selection.selectedNode.featureId : null) ??
    selection.selectedFeatureId

  return {
    selectedFeatureIds,
    primarySelectedFeatureId,
    selectedFeatures,
    hasSelectedFeatures,
    hasSelectedBackdrop,
    hasLockedSelectedFeatures,
    hasClosedSelectedFeatures,
    hasOffsetEligibleSelectedFeatures,
    alignableFeatureIds,
    canAlignSelectedFeatures: alignableFeatureIds.length >= 2,
    canDistributeSelectedFeatures: alignableFeatureIds.length >= 3,
    featureSketchEditActive,
    selectedConstraintFeatureId,
  }
}

export function deriveSketchCommandState(input: SketchCommandStateInput): SketchCommandState {
  const predicates = deriveSketchCommandPredicates(input)
  const featureTransformAvailable = predicates.hasSelectedFeatures && !predicates.hasLockedSelectedFeatures

  return {
    predicates,
    transform: {
      copy: {
        enabled: predicates.hasSelectedFeatures,
        active: input.pendingMove?.entityType === 'feature' && input.pendingMove.mode === 'copy',
      },
      move: {
        enabled: featureTransformAvailable,
        active: input.pendingMove?.entityType === 'feature' && input.pendingMove.mode === 'move',
      },
      delete: {
        enabled: predicates.hasSelectedFeatures,
        active: false,
      },
      resize: {
        enabled: featureTransformAvailable,
        active: input.pendingTransform?.entityType === 'feature' && input.pendingTransform.mode === 'resize',
      },
      rotate: {
        enabled: featureTransformAvailable,
        active: input.pendingTransform?.entityType === 'feature' && input.pendingTransform.mode === 'rotate',
      },
      mirror: {
        enabled: featureTransformAvailable,
        active: input.pendingTransform?.entityType === 'feature' && input.pendingTransform.mode === 'mirror',
      },
    },
    boolean: {
      join: {
        enabled: true,
        active: input.pendingShapeAction?.kind === 'join',
      },
      cut: {
        enabled: true,
        active: input.pendingShapeAction?.kind === 'cut',
      },
      offset: {
        enabled: featureTransformAvailable && predicates.hasOffsetEligibleSelectedFeatures,
        active: input.pendingOffset !== null,
      },
    },
    arrange: {
      align: {
        enabled: predicates.canAlignSelectedFeatures,
        active: false,
      },
      distribute: {
        enabled: predicates.canDistributeSelectedFeatures,
        active: false,
      },
    },
    sketchEdit: {
      add_point: {
        enabled: predicates.featureSketchEditActive,
        active: input.selection.sketchEditTool === 'add_point',
      },
      delete_point: {
        enabled: predicates.featureSketchEditActive,
        active: input.selection.sketchEditTool === 'delete_point',
      },
      delete_segment: {
        enabled: predicates.featureSketchEditActive,
        active: input.selection.sketchEditTool === 'delete_segment',
      },
      disconnect: {
        enabled: predicates.featureSketchEditActive,
        active: input.selection.sketchEditTool === 'disconnect',
      },
      fillet: {
        enabled: predicates.featureSketchEditActive,
        active: input.selection.sketchEditTool === 'fillet',
      },
      chamfer: {
        enabled: predicates.featureSketchEditActive,
        active: input.selection.sketchEditTool === 'chamfer',
      },
      trim: {
        enabled: predicates.featureSketchEditActive,
        active: input.selection.sketchEditTool === 'trim',
      },
      extend: {
        enabled: predicates.featureSketchEditActive,
        active: input.selection.sketchEditTool === 'extend',
      },
    },
    constraint: {
      enabled: predicates.hasSelectedFeatures && !predicates.hasLockedSelectedFeatures,
      active: input.pendingConstraint !== null,
    },
    dimension: {
      tapeMeasure: {
        enabled: true,
        active: input.tapeMeasure !== null,
      },
      deleteDimension: {
        enabled: input.project.annotations.length > 0,
        active: input.dimensionDeleteArmed,
      },
      showDimensions: {
        enabled: true,
        active: input.project.meta.showDimensions,
      },
      dimensionTypes: DIMENSION_TYPE_VALUES.reduce((accumulator, type) => {
        accumulator[type] = {
          enabled: true,
          active: input.pendingDimension?.type === type,
        }
        return accumulator
      }, {} as Record<DimensionType, CommandStatus>),
    },
  }
}

function command(
  id: string,
  icon: string,
  label: string,
  status: CommandStatus,
  onActivate: () => void,
): CommandDescriptor {
  return { id, icon, label, enabled: status.enabled, active: status.active, onActivate }
}

export function useSketchCommands(): SketchCommandState & {
  transform: Record<'copy' | 'move' | 'delete' | 'resize' | 'rotate' | 'mirror', CommandDescriptor>
  boolean: Record<'join' | 'cut' | 'offset', CommandDescriptor>
  arrange: {
    align: CommandDescriptor
    distribute: CommandDescriptor
    alignFeature: (alignment: FeatureAlignment) => void
    distributeFeatures: (distribution: FeatureDistribution) => void
  }
  sketchEdit: Record<SketchEditTool, CommandDescriptor>
  constraint: CommandDescriptor
  dimension: {
    tapeMeasure: CommandDescriptor
    deleteDimension: CommandDescriptor
    showDimensions: CommandDescriptor
    dimensionTypes: Record<DimensionType, ValueCommandDescriptor<DimensionType>>
    pendingDimensionType: DimensionType | null
    dimensionCount: number
  }
} {
  const store = useProjectStore()
  const state = deriveSketchCommandState(store)

  function startFeatureMove(mode: 'move' | 'copy') {
    if (!state.predicates.primarySelectedFeatureId) {
      return
    }

    if (store.pendingMove?.entityType === 'feature' && store.pendingMove.mode === mode) {
      store.cancelPendingMove()
      return
    }

    if (mode === 'move') {
      store.startMoveFeature(state.predicates.primarySelectedFeatureId)
    } else {
      store.startCopyFeature(state.predicates.primarySelectedFeatureId)
    }
  }

  function startFeatureTransform(mode: 'resize' | 'rotate' | 'mirror') {
    if (!state.predicates.primarySelectedFeatureId) {
      return
    }

    if (store.pendingTransform?.mode === mode) {
      store.cancelPendingTransform()
      return
    }

    if (mode === 'resize') {
      store.startResizeFeature(state.predicates.primarySelectedFeatureId)
    } else if (mode === 'rotate') {
      store.startRotateFeature(state.predicates.primarySelectedFeatureId)
    } else {
      store.startMirrorFeature(state.predicates.primarySelectedFeatureId)
    }
  }

  function toggleSketchEditTool(tool: SketchEditTool) {
    if (!state.predicates.featureSketchEditActive) {
      return
    }
    store.setSketchEditTool(store.selection.sketchEditTool === tool ? null : tool)
  }

  function toggleConstraint() {
    if (store.pendingConstraint) {
      store.cancelPendingConstraint()
      return
    }
    if (!state.predicates.selectedConstraintFeatureId) {
      return
    }
    if (state.predicates.featureSketchEditActive) {
      store.setSketchEditTool(null)
    }
    store.beginConstraint(state.predicates.selectedConstraintFeatureId)
  }

  function toggleShapeAction(kind: 'join' | 'cut') {
    if (store.pendingShapeAction?.kind === kind) {
      store.cancelPendingShapeAction()
      return
    }
    if (kind === 'join') {
      store.startJoinSelectedFeatures()
    } else {
      store.startCutSelectedFeatures()
    }
  }

  function toggleOffset() {
    if (store.pendingOffset) {
      store.cancelPendingOffset()
      return
    }
    store.startOffsetSelectedFeatures()
  }

  function alignFeature(alignment: FeatureAlignment) {
    if (state.predicates.alignableFeatureIds.length < 2) {
      return
    }
    store.alignFeatures(state.predicates.alignableFeatureIds, alignment)
  }

  function distributeFeatures(distribution: FeatureDistribution) {
    if (state.predicates.alignableFeatureIds.length < 3) {
      return
    }
    store.distributeFeatures(state.predicates.alignableFeatureIds, distribution)
  }

  function toggleTapeMeasure() {
    if (store.tapeMeasure) {
      store.clearTapeMeasure()
      return
    }
    if (store.pendingAdd) {
      store.cancelPendingAdd()
    }
    store.startTapeMeasure()
  }

  function startDimensionType(type: DimensionType) {
    if (store.pendingDimension?.type === type) {
      store.cancelPendingDimension()
      return
    }
    if (store.pendingAdd) {
      store.cancelPendingAdd()
    }
    store.startDimensionTool(type)
  }

  function toggleDimensionDelete() {
    if (store.pendingAdd) {
      store.cancelPendingAdd()
    }
    if (store.selectedAnnotationId) {
      store.deleteDimensionAnnotation(store.selectedAnnotationId)
      if (store.dimensionDeleteArmed) {
        store.setDimensionDeleteArmed(false)
      }
      return
    }
    store.setDimensionDeleteArmed(!store.dimensionDeleteArmed)
  }

  return {
    ...state,
    transform: {
      copy: command('copy', 'copy', state.transform.copy.active ? 'Cancel copy' : 'Copy selected features', state.transform.copy, () => startFeatureMove('copy')),
      move: command('move', 'move', state.transform.move.active ? 'Cancel move' : 'Move selected features', state.transform.move, () => startFeatureMove('move')),
      delete: command('delete', 'trash', 'Delete selected features', state.transform.delete, () => {
        if (state.predicates.hasSelectedFeatures) {
          store.deleteFeatures(state.predicates.selectedFeatureIds)
        }
      }),
      resize: command('resize', 'resize', state.transform.resize.active ? 'Cancel resize' : 'Resize selected features', state.transform.resize, () => startFeatureTransform('resize')),
      rotate: command('rotate', 'rotate', state.transform.rotate.active ? 'Cancel rotate' : 'Rotate selected features', state.transform.rotate, () => startFeatureTransform('rotate')),
      mirror: command('mirror', 'mirror', state.transform.mirror.active ? 'Cancel mirror' : 'Mirror selected features', state.transform.mirror, () => startFeatureTransform('mirror')),
    },
    boolean: {
      join: command('join', 'merge', state.boolean.join.active ? 'Cancel join' : 'Join closed features', state.boolean.join, () => toggleShapeAction('join')),
      cut: command('cut', 'cut', state.boolean.cut.active ? 'Cancel cut' : 'Cut features', state.boolean.cut, () => toggleShapeAction('cut')),
      offset: command('offset', 'offset', state.boolean.offset.active ? 'Cancel offset' : 'Create offset feature', state.boolean.offset, toggleOffset),
    },
    arrange: {
      align: command('align', 'align', 'Align selected features', state.arrange.align, () => undefined),
      distribute: command('distribute', 'distribute', 'Distribute selected features', state.arrange.distribute, () => undefined),
      alignFeature,
      distributeFeatures,
    },
    sketchEdit: {
      add_point: command('add_point', 'point-add', state.sketchEdit.add_point.active ? 'Cancel add point' : 'Add point', state.sketchEdit.add_point, () => toggleSketchEditTool('add_point')),
      delete_point: command('delete_point', 'point-delete', state.sketchEdit.delete_point.active ? 'Cancel delete point' : 'Delete point', state.sketchEdit.delete_point, () => toggleSketchEditTool('delete_point')),
      delete_segment: command('delete_segment', 'segment-delete', state.sketchEdit.delete_segment.active ? 'Cancel delete segment' : 'Delete segment', state.sketchEdit.delete_segment, () => toggleSketchEditTool('delete_segment')),
      disconnect: command('disconnect', 'disconnect', state.sketchEdit.disconnect.active ? 'Cancel disconnect' : 'Disconnect point', state.sketchEdit.disconnect, () => toggleSketchEditTool('disconnect')),
      fillet: command('fillet', 'fillet', state.sketchEdit.fillet.active ? 'Cancel fillet' : 'Round corner / fillet', state.sketchEdit.fillet, () => toggleSketchEditTool('fillet')),
      chamfer: command('chamfer', 'chamfer', state.sketchEdit.chamfer.active ? 'Cancel chamfer' : 'Chamfer corner', state.sketchEdit.chamfer, () => toggleSketchEditTool('chamfer')),
      trim: command('trim', 'trim', state.sketchEdit.trim.active ? 'Cancel trim' : 'Trim segment', state.sketchEdit.trim, () => toggleSketchEditTool('trim')),
      extend: command('extend', 'extend', state.sketchEdit.extend.active ? 'Cancel extend' : 'Extend segment', state.sketchEdit.extend, () => toggleSketchEditTool('extend')),
    },
    constraint: command('constraint', 'constraint', state.constraint.active ? 'Cancel constraint' : 'Add constraint', state.constraint, toggleConstraint),
    dimension: {
      tapeMeasure: command('tapeMeasure', 'tape-measure', state.dimension.tapeMeasure.active ? 'Tape measure (on)' : 'Tape measure', state.dimension.tapeMeasure, toggleTapeMeasure),
      deleteDimension: command('deleteDimension', 'trash', state.dimension.deleteDimension.active ? 'Delete dimension (click one)' : 'Delete dimension', state.dimension.deleteDimension, toggleDimensionDelete),
      showDimensions: command(
        'showDimensions',
        store.project.meta.showDimensions ? 'eye' : 'eye-off',
        store.project.annotations.length === 0
          ? 'Show/hide dimensions'
          : store.project.meta.showDimensions ? `Hide dimensions (${store.project.annotations.length})` : `Show dimensions (${store.project.annotations.length})`,
        state.dimension.showDimensions,
        () => store.setShowDimensions(!store.project.meta.showDimensions),
      ),
      dimensionTypes: DIMENSION_TYPE_VALUES.reduce((accumulator, type) => {
        const status = state.dimension.dimensionTypes[type]
        accumulator[type] = {
          id: `dimension-${type}`,
          value: type,
          icon: '',
          label: type,
          enabled: status.enabled,
          active: status.active,
          onActivate: startDimensionType,
        }
        return accumulator
      }, {} as Record<DimensionType, ValueCommandDescriptor<DimensionType>>),
      pendingDimensionType: store.pendingDimension?.type ?? null,
      dimensionCount: store.project.annotations.length,
    },
  }
}
