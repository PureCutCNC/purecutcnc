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

// One declaration of which clearing controls each level-based kind offers, and
// the recorded reason for every cell that does not (issues #614/#616).
//
// Before this table the offered set lived in four places that answered
// independently: the CAM panel's field predicates (operationFields.ts), the
// engine's slot-feed gate (resolveSlotFeedScale in pocket.ts), the operation
// booklet (operationBooklet/report.ts), and -- for the one control that got it
// right -- usesTangentLinks in pocketPatterns.ts. Three of the four already
// disagreed: the panel offered feed reduction on surface_clean, the engine
// honoured it there, and the booklet printed no row at the machine.
//
// The table encodes today's matrix exactly, so rewiring the consumers changes
// no toolpath and no emitted program; the one deliberate exception (the
// booklet starting to print surface_clean's feed-reduction rows) fixes exactly
// that disagreement. The shape mirrors OPERATION_PATTERN_SUPPORT (#609), and
// both exhaustiveness obligations come with it:
//
//   - Record<OperationKind, ...> -- a new operation kind does not compile
//     until it declares whether it clears.
//   - Record<ClearingControl, ...> on each clearing row -- a new clearing
//     control does not compile until every clearing kind classifies it.
//
// Two boundaries are deliberate:
//
//   - Tangential S-links stay with usesTangentLinks in pocketPatterns.ts.
//     Linking is pattern-dependent: this table says whether a kind links at
//     all, the pattern function says on which patterns. Duplicating the kind
//     half here would recreate the two-gates problem this file exists to close.
//   - edge_route_inside/edge_route_outside are not clearing kinds, but they
//     share roundOutsideCorners, cornerRelief and machiningOrder with pocket.
//     Their half stays inline at each consumer (clearingControlApplies(...) or
//     edge route), because declaring those cells here would settle questions
//     #614 explicitly leaves out of scope.

import type { OperationKind } from '../../types/project'

/** A control the level-based clearing kinds can offer. */
export type ClearingControl =
  | 'slotFeed'
  | 'engagementMode'
  | 'roundOutsideCorners'
  | 'cleanWallCorners'
  | 'cornerRelief'
  | 'machiningOrder'

/** One (kind, control) cell: offered, or the recorded reason it is not. */
export type ControlSupport =
  | { readonly applies: true }
  | { readonly applies: false; readonly reason: string }

/** One kind's row: the six cells, or the reason the kind clears nothing. */
export type ClearingKindSupport =
  | { readonly clears: true; readonly controls: Readonly<Record<ClearingControl, ControlSupport>> }
  | { readonly clears: false; readonly reason: string }

const APPLIES: ControlSupport = { applies: true }

function doesNotApply(reason: string): ControlSupport {
  return { applies: false, reason }
}

// Reasons owned by sibling issues, not by this one. These cells record
// today's gaps honestly; the sibling decides them, then edits the cell here
// (which is why #616 blocks every other sub-issue).

// #620 -- surface_clean + rough_surface x machining order.
function machiningOrderPending(kind: string, reachable: string): string {
  return 'not offered today; whether ' + kind + ' gains machining order is issue #620\u2019s decision. '
    + reachable
    + ' The stored feature_first value ships inside saved files, so switching the control on rewrites their output.'
}

// Undecided, not settled: #614's matrix deliberately leaves cleanWallCorners
// out (it is gated on rounding being enabled), so no owner call exists for the
// model-sliced kinds. The observation below stands until one lands.
const WALL_CLEANUP_MODEL_SLICED =
  'undecided: the #614 matrix deliberately excludes this control (it is gated on rounding being enabled), '
  + 'so no owner call exists for these kinds yet. Wall-corner cleanup repairs the coverage a rounded ring loses '
  + 'against a designed pocket wall a mating part seats into; these kinds\u2019 level boundaries are sliced model silhouettes.'

export const CLEARING_CONTROL_SUPPORT: Readonly<Record<OperationKind, ClearingKindSupport>> = {
  pocket: {
    clears: true,
    controls: {
      slotFeed: APPLIES,
      engagementMode: APPLIES,
      roundOutsideCorners: APPLIES,
      cleanWallCorners: APPLIES,
      cornerRelief: APPLIES,
      machiningOrder: APPLIES,
    },
  },
  surface_clean: {
    clears: true,
    controls: {
      slotFeed: APPLIES,
      engagementMode: APPLIES,
      roundOutsideCorners: APPLIES,
      cleanWallCorners: APPLIES,
      cornerRelief: doesNotApply(
        // Owner's call, recorded on #614: the control exists so a mating part
        // can seat in an inside corner -- a pocket-shaped intent.
        'corner relief exists so a mating part can seat in an inside corner -- a pocket-shaped intent -- '
        + 'and surface_clean faces a region down to a level rather than cutting a wall something is fitted into.',
      ),
      machiningOrder: doesNotApply(
        machiningOrderPending('surface_clean', 'It clears from sketch geometry, so the split is reachable.'),
      ),
    },
  },
  rough_surface: {
    clears: true,
    controls: {
      slotFeed: APPLIES,
      engagementMode: APPLIES,
      roundOutsideCorners: APPLIES,
      cleanWallCorners: doesNotApply(WALL_CLEANUP_MODEL_SLICED),
      cornerRelief: doesNotApply(
        // Settled by the owner on #616; recorded verbatim.
        'Relief corners are collected from the wall contours of a band built from a sketch '
        + '(pocket.ts:3846); these kinds\u2019 level boundaries are sliced model silhouettes, '
        + 'not designed corners with a mating part to seat.',
      ),
      machiningOrder: doesNotApply(
        machiningOrderPending(
          'rough_surface',
          'Its validity is .some(model) among multiple machining features (operationDefaults.ts:189), so the split is reachable.',
        ),
      ),
    },
  },
  finish_surface_cleanup: {
    clears: true,
    controls: {
      slotFeed: APPLIES,
      engagementMode: APPLIES,
      roundOutsideCorners: APPLIES,
      cleanWallCorners: doesNotApply(WALL_CLEANUP_MODEL_SLICED),
      cornerRelief: doesNotApply(
        // Settled by the owner on #616; recorded verbatim.
        'Relief corners are collected from the wall contours of a band built from a sketch '
        + '(pocket.ts:3846); these kinds\u2019 level boundaries are sliced model silhouettes, '
        + 'not designed corners with a mating part to seat.',
      ),
      machiningOrder: doesNotApply(
        // Settled by the owner on #616; recorded verbatim.
        'Its target validity admits exactly one STL model plus closed regions (operationDefaults.ts:165, '
        + 'modelCount !== 1 rejects), and perFeatureOperations drops region features before splitting '
        + '(multiFeature.ts:34). The per-feature split can never produce more than one part, '
        + 'so the control would be inert.',
      ),
    },
  },
  finish_surface: {
    clears: false,
    // #614 out-of-scope reasoning, kept machine-readable instead of a comment:
    // the record accounts for every kind without implying the controls transfer.
    reason:
      'The only true 3D operation: the cutter descends along the surface within a pass -- measured '
      + '100% sloped cuts across thousands of distinct Z values on the cone fixture -- so the '
      + 'level-based clearing controls do not transfer and must not be applied by analogy.',
  },
  v_carve: {
    clears: false,
    reason: 'Engraves along feature lines; it clears no area, so there is nothing for the clearing controls to govern.',
  },
  v_carve_medial: {
    clears: false,
    reason: 'Carves medial-axis channels; it never clears an area a level at a time, so the clearing controls have no cell to fill.',
  },
  edge_route_inside: {
    clears: false,
    reason: 'Cuts along an edge profile, not area clearing; the controls it shares with pocket (rounding, relief, order) stay decided inline at the consumers, outside the scope of #614.',
  },
  edge_route_outside: {
    clears: false,
    reason: 'Cuts along an edge profile, not area clearing; the controls it shares with pocket (rounding, relief, order) stay decided inline at the consumers, outside the scope of #614.',
  },
  follow_line: {
    clears: false,
    reason: 'Follows feature lines directly; it clears no area.',
  },
  drilling: {
    clears: false,
    reason: 'Plunges holes; it clears no area.',
  },
}

/**
 * Whether kind offers control, per the declaration.
 *
 * The one question the panel predicates, the engine slot-feed gate and the
 * booklet ask; none of them keeps an independent kind list. False covers both
 * a clearing kind declining a control (reason recorded in the table) and a
 * kind that does not clear at all.
 */
export function clearingControlApplies(kind: OperationKind, control: ClearingControl): boolean {
  const support = CLEARING_CONTROL_SUPPORT[kind]
  return support.clears && support.controls[control].applies
}
