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
 * Verify namespace (issue #1269): the simulation viewport's Verify mode —
 * comparison selector, run state, results list and the reason codes of the
 * model check (#1268) and the exported-motion parity (#1261).
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const verifyEn = {
  'verify.mode': 'Verify',
  'verify.modeTitle': 'Verify the path: compare the model, the internal toolpath and the exported program',
  'verify.panelLabel': 'Verify exported path',
  'verify.comparisonLabel': 'Compare',
  'verify.comparison.modelInternal': 'Model ↔ internal',
  'verify.comparison.modelExported': 'Model ↔ exported',
  'verify.comparison.internalExported': 'Internal ↔ exported',
  'verify.comparisonHint.modelInternal': 'Stock cut by the generated toolpaths, against the model.',
  'verify.comparisonHint.modelExported': 'Stock cut by the exported program, read back, against the model.',
  'verify.comparisonHint.internalExported': 'The exported program against the generated toolpaths.',
  'verify.scopeUpto': 'All visible operations up to {operation}',
  'verify.scopeAll': 'All visible operations of {setup}',
  'verify.run': 'Run verification',
  'verify.cancel': 'Cancel',
  'verify.running': 'Verifying… {done} of {total}',
  'verify.idle': 'Verification runs only when you ask. Choose a comparison and run it.',
  'verify.failed': 'Verification could not finish. Try again; the console has the details.',
  'verify.stale.projectEdited': 'Out of date: the project changed since this result. Run verification again to update it.',
  'verify.stale.requestChanged': 'Out of date: this result is for another comparison, operation, setup or detail. Run verification again to update it.',
  'verify.summary': '{verified} verified · {deviation} with deviations · {unverified} unverified',
  'verify.runUnverified': 'Not verified: {reason}',
  'verify.resultsLabel': 'Verification results',
  'verify.legendLabel': 'Colour key',
  'verify.verdict.verified': 'Verified',
  'verify.verdict.deviation': 'Deviation',
  'verify.verdict.unverified': 'Unverified',
  'verify.kind.gouge': 'Gouge',
  'verify.kind.intendedLeftover': 'Intended leftover',
  'verify.kind.unintendedLeftover': 'Unintended leftover',
  'verify.kind.missingCut': 'Missing cut',
  'verify.kind.extraCut': 'Extra cut',
  'verify.kind.feed': 'Feed',
  'verify.kind.unverified': 'Unverified operation',
  'verify.findingRegion': '{area} · max {size}',
  'verify.findingDistance': '{size} from the other path',
  'verify.findingNoCounterpart': 'No matching cut on the other path',
  'verify.findingFeed': 'Feed {actual} instead of {expected}',
  'verify.findingFeedMissing': 'No feed stated; {expected} expected',
  'verify.moreDeviations': '{count} more deviations not listed',
  'verify.noFindings': 'No deviations',
  'verify.unattributed': 'Material no operation cut',
  'verify.findingFocus': 'Show in the viewport',
  'verify.reasonAtLine': '{reason} (line {line})',
  'verify.reason.aroundSetup': 'a setup on the around face is not compared against the model yet',
  'verify.reason.rotaryOperation': 'a rotary operation is not compared against the model yet',
  'verify.reason.rotaryMotion': 'a move turns the rotary axis while cutting',
  'verify.reason.unsupportedSetup': 'this setup orientation cannot be machined',
  'verify.reason.uptoOperationNotFound': 'the selected operation has nothing to replay',
  'verify.reason.noModel': 'the project has no model to compare against',
  'verify.reason.exportUnsupported': 'the exported program has a construct that cannot be read back',
  'verify.reason.exportFailed': 'the program could not be produced or read back',
  'verify.reason.noCutMoves': 'neither path has a cutting move',
  'verify.reason.unparsedText': 'the program has text that is not G-code',
  'verify.reason.unsupportedCommand': 'the reader cannot reconstruct the motion of {command}',
  'verify.reason.machineCoordinateRetract': 'a machine-coordinate retract',
  'verify.reason.machineCoordinateMove': 'a machine-coordinate move that is not a retract',
  'verify.reason.rapidAfterMachineRetract': 'a rapid after a machine-coordinate retract does not state Z',
  'verify.reason.workZUnknown': 'a feed move after a machine-coordinate retract does not state Z',
  'verify.reason.motionWithoutMode': 'coordinates before any motion mode',
  'verify.reason.inverseTimeFeedMissing': 'an inverse-time feed move without its own feed word',
  'verify.reason.arcCentreMissing': 'an arc without a centre or radius',
  'verify.reason.arcRadiusTooSmall': 'an arc whose radius cannot span its endpoints',
  'verify.reason.cannedCycleIncomplete': 'a canned cycle without the depth, retract plane or peck it needs',
  'verify.reason.cannedCycleWithRotary': 'a canned cycle that also turns the rotary axis',
  'verify.reason.cannedRetractModeAssumed': 'no retract mode before a canned cycle; return to the start level assumed',
  'verify.reason.chipBreakRetractApproximate': 'a chip-break retract is read approximately',
  'verify.reason.probeMove': 'a probing move',
  'verify.reason.touchOffZ': 'a Z touch-off',
  'verify.reason.rotaryZeroed': 'the rotary axis is zeroed in the program',
  'verify.reason.workOffsetChange': 'the work offset changes in the program',
  'verify.reason.parseFailure': 'the program could not be read',
  'verify.reason.unsupportedStatement': 'a statement the reader cannot reconstruct',
  'verify.reason.emptyProgram': 'the postprocessor wrote no program',
  'verify.reason.operationRefused': 'the postprocessor refused the operation',
  'verify.reason.postFailed': 'the postprocessor failed',
  'verify.reason.noTool': 'the operation has no usable tool',
  'verify.reason.axisNotStated': 'the program never states the {axis} axis',
  'verify.reason.manualIndexTurnRemoved': 'the manual-index opening turn was taken out of the angles',
  'verify.reason.noToolpath': 'its toolpath could not be generated',
  'verify.reason.noMachine': 'no machine is selected for the export',
  'verify.reason.noOperations': 'no visible operation with a toolpath up to the selection',
} as const satisfies Record<string, string>
