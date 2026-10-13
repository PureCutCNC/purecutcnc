# Face audit for issue #395 part A (Codex, read-only, against integration/0.6.0 @ 5f401e0b)

Classes: B = binary top/bottom assumption, E = the compiler flags it, G = guard, N = neutral.
Line numbers are from 5f401e0b and may have moved; find the function by name.

## Face-dependent sites

Source checked at `5f401e0b`. The local branch name is `purecutcnc-0-6-0-release-078630`.

A “site” below is a decision, representation, or forwarding boundary; repeated expressions within the same function are grouped. For orientation-only sites, “Top/Bottom branch” means what happens if Around is represented using the existing 0°/180° encoding. Unsupported orientations currently fail the guards first. Fixed two-item arrays are **B**, not **E**: extending `SetupFace` does not make TypeScript require another array entry.

### `src/types/` and store contracts

- `src/types/project.ts:454` — draft feature — carries optional `authoringFace` — **N** — treat as its own face (new branch); retain the missing-value Top default.
- `src/types/project.ts:531` — `FeatureInstance` — stores required `authoringFace` — **N** — treat as its own face (new branch); document the unrolled coordinate/depth contract.
- `src/types/project.ts:1012` — `SetupFace` — defines face names — **N** — treat as its own face (new branch).
- `src/types/project.ts:1016` — `SetupOrientation` — represents a fixed rotation using `axis` and `angleDeg` — **N** — unroll frame here; add a discriminator rather than another rotation angle.
- `src/types/project.ts:1028` — `SetupIndexing` — permits only `'manual'` — **N** — unclear — needs a decision: is continuous rotary machining a new indexing mode or a separate frame kind?
- `src/types/project.ts:1053` — `MachiningSetup` — carries orientation/indexing, without an independent face/frame kind — **N** — treat as its own face (new branch).
- `src/types/project.ts:1071` — `defaultTopSetup` — explicitly constructs the legacy Top setup — **N** — same as Top is actually correct because this is the Top default; create a separate Around default.
- `src/store/types.ts:505` — `ProjectStore.createSetup` — accepts only an orientation — **N** — treat as its own face (new branch); accept the new setup discriminator.
- `src/store/types.ts:508` — `ProjectStore.updateSetup` — exposes a `flipAxis` patch — **N** — treat as its own face (new branch); expose rotary properties separately.
- `src/store/types.ts:529` — `ProjectStore.setFeatureAuthoringFace` — accepts a face without a geometry conversion policy — **N** — unclear — needs a decision: may this action move geometry between planar and unrolled surfaces?

### `src/engine/setupOrientation.ts`

- `src/engine/setupOrientation.ts:58` — `SetupPoint` — carries XYZ only — **N** — unroll frame here; wrapped points need an angular coordinate.
- `src/engine/setupOrientation.ts:65` — `isSupportedSetupOrientation` — admits only X/Y and 0°/180° — **G** — Around must be handled before this rotation-only guard.
- `src/engine/setupOrientation.ts:70` — `assertSupported` — throws for other orientations — **G** — Around must be handled before this rotation-only guard.
- `src/engine/setupOrientation.ts:79` — `setupFace` — maps zero to Top, otherwise Bottom after validation — **B** — treat as its own face (new branch); an angle-based Around encoding currently becomes Top or Bottom.
- `src/engine/setupOrientation.ts:85` — `orientationForFace` — Top gets 0°, every other face gets 180° — **B** — treat as its own face (new branch); `'around'` currently becomes Bottom.
- `src/engine/setupOrientation.ts:93` — `SetupFrame` — contains only a rotation and pivot — **N** — unroll frame here; use distinct rotation/unroll frame variants.
- `src/engine/setupOrientation.ts:100` — `setupPivot` — derives the physical stock centre and mid-thickness — **N** — same as Top is actually correct because a round bar’s physical centre is still needed; it does not describe the unrolled origin.
- `src/engine/setupOrientation.ts:109` — `setupFrame` — validates and constructs a rotation frame — **G** — Around should get its own frame constructor before this guard.
- `src/engine/setupOrientation.ts:120` — `halfTurn` — X branch, otherwise Y reflection — **B** — unroll frame here; an unroll frame must never reach either half-turn branch.
- `src/engine/setupOrientation.ts:132` — `canonicalToSetupPoint` — validates, then identity or half-turn — **G** — Around must be handled separately before the rotation guard.
- `src/engine/setupOrientation.ts:138` — `setupToCanonicalPoint` — validates, then identity or the same half-turn — **G** — Around needs a separate inverse/wrap mapping before this guard.
- `src/engine/setupOrientation.ts:149` — `setupFlipsArcDirection` — accepts only supported rotations and tests 180° — **G** — Around must be handled before this guard; rotary paths are not ordinary mirrored XY arcs.
- `src/engine/setupOrientation.ts:162` — `setupOriginInCanonical` — forwards origin through the inverse transform — **N** — unroll frame here; define rotary zero, centreline and radial Z.
- `src/engine/setupOrientation.ts:171` — `setupForOperation` — resolves setup ownership; missing `setupId` means legacy Top — **N** — treat as its own face (new branch); preserve explicit Around ownership.
- `src/engine/setupOrientation.ts:186` — `setupFrameForOperation` — zero means no frame, nonzero means rotation frame — **B** — unroll frame here; a zero-angle Around encoding currently bypasses all transformation.
- `src/engine/setupOrientation.ts:223` — `depthFromFace` — Top uses thickness-minus-Z, otherwise Bottom Z — **B** — treat as its own face (new branch); `'around'` currently receives Bottom depth semantics.
- `src/engine/setupOrientation.ts:234` — `spanFromFaceDepth` — Top conversion, otherwise Bottom conversion — **B** — treat as its own face (new branch); `'around'` currently writes a Bottom stock span.

### `src/engine/setupFrameProject.ts`

- `src/engine/setupFrameProject.ts:66` — `setupPlanMirror` — produces an X- or Y-flip matrix — **B** — unroll frame here; Around would receive a half-turn mirror.
- `src/engine/setupFrameProject.ts:72` — `turnZ` — reflects Z about the pivot — **B** — unroll frame here; Around needs radial depth rather than Bottom reflection.
- `src/engine/setupFrameProject.ts:76` — `turnFeature` — mirrors XY and swaps/reflections the Z span — **B** — unroll frame here; Around must retain unrolled artwork and use its radial span.
- `src/engine/setupFrameProject.ts:89` — `turnRect` — reflects tab/clamp rectangles by flip axis — **B** — unclear — needs a decision: which tabs/clamps exist on the unrolled job?
- `src/engine/setupFrameProject.ts:95` — `turnTab` — forwards through rectangle/Z transforms — **N** — unclear — needs a decision: support surface tabs or refuse them on Around?
- `src/engine/setupFrameProject.ts:99` — `turnClamp` — forwards through the rectangle transform — **N** — unclear — needs a decision: how should chuck/tailstock restrictions appear in the flat job?
- `src/engine/setupFrameProject.ts:107` — `turnModelDefinitions` — marks every imported model turned over — **B** — not offered on Around (hide/refuse with a message) unless cylindrical model projection is explicitly added.
- `src/engine/setupFrameProject.ts:127` — `projectInSetupFrame` — zero returns the original project; otherwise mirrors the entire project and resets angles to zero — **B** — unroll frame here; zero-encoded Around stays round, while nonzero-encoded Around becomes Bottom.
- `src/engine/setupFrameProject.ts:183` — `toolpathInStockFrame` — identity or half-turn of moves, bounds, drill cycles and step levels — **B** — unroll frame here; wrap moves to A and preserve/recompute all metadata.
- `src/engine/setupFrameProject.ts:222` — `toolpathInSetupFrame` — calls `toolpathInStockFrame` because a half-turn is self-inverse — **B** — unroll frame here; wrapping and unwrapping must be different functions.

### Other `src/engine/` sites

- `src/engine/setupTargets.ts:84` — `spanReachesBothFaces` — defines “through” using the two planar stock faces — **B** — treat as its own face (new branch); Around currently inherits the planar through-cut definition.
- `src/engine/setupTargets.ts:97` — `isThroughFeature` — forwards to the planar span rule — **N** — unclear — needs a decision: does a radial cut ever qualify as a cross-face through-feature?
- `src/engine/setupTargets.ts:112` — `crossFaceReach` — offers through-cuts and all imported models from another face — **N** — treat as its own face (new branch); restrict the exception to compatible face pairs.
- `src/engine/setupTargets.ts:124` — `featureReachableFromFace` — face equality, otherwise through/model exception — **N** — treat as its own face (new branch); equality works, but the exception must not admit planar geometry into Around.
- `src/engine/setupTargets.ts:157` — `operationFace` — forwards the owning setup’s face — **N** — treat as its own face (new branch).
- `src/engine/setupTargets.ts:163` — `judgeTargetFromFace` — equality/cross-face verdict plus face-local depth — **N** — treat as its own face (new branch); use radial depth and compatible surface domains.
- `src/engine/setupTargets.ts:189` — `judgeTargetsFromFace` — forwards a face to each target verdict — **N** — treat as its own face (new branch).
- `src/engine/setupTargets.ts:204` — `operationTargetVerdicts` — derives the operation face and forwards it — **N** — treat as its own face (new branch).
- `src/engine/setupTargets.ts:209` — `rejectedOperationTargets` — forwards/filter verdicts — **N** — treat as its own face (new branch).
- `src/engine/setupTargets.ts:214` — `crossFaceTargetIds` — forwards/filter cross-face verdicts — **N** — treat as its own face (new branch).
- `src/engine/setupTargets.ts:226` — `targetAllowedInSetup` — resolves saved/provisional setup, then judges targets — **N** — treat as its own face (new branch).
- `src/engine/setupTargets.ts:247` — `setupGenerationBlock` — refuses targets rejected from the operation face — **N** — treat as its own face (new branch); retain this generation-time refusal.
- `src/engine/setupOperationMove.ts:67` — `planOperationMove` — rejudges targets/depths from the destination setup — **N** — unclear — needs a decision: refuse planar↔Around moves or convert their targets/settings?
- `src/engine/setupReach.ts:73` — `operationCutRange` — Top takes deepest/minimum Z; otherwise Bottom highest/maximum Z — **B** — treat as its own face (new branch); `'around'` currently measures Bottom reach.
- `src/engine/setupReach.ts:160` — `throughFeatureCoverage` — indexes a `Record<SetupFace, …>` containing Top/Bottom — **E** — not offered on Around (hide/refuse with a message) until radial coverage is defined.
- `src/engine/setupReach.ts:175` — `throughFeatureCoverage.combined` — Top combines downward reach; otherwise Bottom upward reach — **B** — treat as its own face (new branch); `'around'` currently takes Bottom aggregation.
- `src/engine/toolpaths/generateOperation.ts:125` — `computeOperationToolpath` — target guard, setup-frame generation, then stock-frame return — **N** — unroll frame here; this is the central plug-in boundary.
- `src/engine/toolpaths/plasma.ts:48` — `plasmaSetupIsTop` — allows Top/no setup, rejects every other face — **B** — not offered on Around (hide/refuse with a message); `'around'` should remain rejected.
- `src/engine/toolpaths/toolpathDependencies.ts:94` — `featureInstanceComputationEquals` — compares `authoringFace` as a generation input — **N** — treat as its own face (new branch); equality already invalidates a changed face.
- `src/engine/operations/camPlan/createCamPlan.ts:55` — CAM-plan input stamp — includes feature `authoringFace` — **N** — treat as its own face (new branch).
- `src/engine/operations/camPlan/createCamPlan.ts:701` — `activeSetupTurnsStock` — nonzero angle means unsupported turned setup — **B** — not offered on Around (hide/refuse with a message); zero-encoded Around currently evades this refusal.
- `src/engine/operations/camPlan/createCamPlan.ts:706` — `createCamPlan` — filters proposals through the active face’s target verdicts — **N** — not offered on Around (hide/refuse with a message) unless the planner explicitly consumes the unrolled project.
- `src/engine/importedModelTransform.ts:72` — `modelDataTurnedOver` — carries a Bottom-only mesh marker — **N** — not offered on Around (hide/refuse with a message) unless a separate cylindrical model mapping is added.
- `src/engine/importedModelTransform.ts:77` — `isModelTurnedOver` — reads that marker — **N** — same as Top is actually correct because Around is not a half-turn; do not use this marker to represent unrolling.
- `src/engine/csg.ts:288` — `stlTransformedGeometryCacheKey` — distinguishes only turned-over/as-placed model data — **B** — not offered on Around (hide/refuse with a message) unless an unrolled model/cache variant is added; absent marker takes as-placed.
- `src/engine/csg.ts:403` — `loadSTLTransformedGeometry` — reflects model Z when marked turned over — **B** — not offered on Around (hide/refuse with a message); setting the marker gives Bottom geometry, omitting it gives ordinary geometry.

### `src/engine/gcode/` and booklet reporting

- `src/engine/gcode/utils.ts:34` — `projectToMachinePoint` — applies setup transform, origin, Y inversion and XYZ mapping — **N** — unroll frame here; preserve/output A instead of rebuilding an XYZ-only point.
- `src/engine/gcode/utils.ts:76` — `machineToProjectPoint` — reverses XYZ mapping and setup transform — **N** — unroll frame here; reconstruct unrolled Y from A for inspection.
- `src/engine/gcode/utils.ts:132` — `machineToProjectFlipsArcDirection` — combines axis handedness with setup arc flipping — **N** — not offered on Around (hide/refuse with a message) for ordinary XY arc reconstruction unless rotary arc semantics are defined.
- `src/engine/gcode/setupPrograms.ts:42` — `projectExportsPerSetup` — splits/annotates when more than one setup exists — **N** — treat as its own face (new branch); decide whether a sole Around setup also requires its rotary header.
- `src/engine/gcode/setupPrograms.ts:47` — `setupProgramNumber` — numbers by setup order — **N** — same as Top is actually correct because numbering is face-independent.
- `src/engine/gcode/setupPrograms.ts:78` — `setupFileSlug` — uses the face as an empty-name fallback — **N** — treat as its own face (new branch).
- `src/engine/gcode/setupPrograms.ts:95` — `planSetupPrograms` — partitions selected operations by setup identity — **N** — treat as its own face (new branch); Around gets its own program.
- `src/engine/gcode/setupPrograms.ts:159` — `describeTouchOff` — Top name, otherwise Bottom, using rectangular corners and stock thickness — **B** — treat as its own face (new branch); `'around'` currently receives Bottom/corner touch-off instructions.
- `src/engine/gcode/setupPrograms.ts:224` — `describeSetupTurn` — Top-up or Bottom flip instruction — **B** — treat as its own face (new branch); `'around'` currently instructs a Bottom flip.
- `src/engine/gcode/setupPrograms.ts:235` — `setupHeaderLines` — forwards setup/face to operator instructions — **N** — treat as its own face (new branch); include rotary mounting and A-zero instructions.
- `src/engine/gcode/setupPrograms.ts:250` — `setupLacksRegistration` — warns for later setups without registration — **N** — unclear — needs a decision: what registration is meaningful for chuck/rotary mounting?
- `src/engine/gcode/motionPipeline.ts:517` — `planProgramSetup` — validates targets, refuses mixed setup identities, supplies headers — **N** — treat as its own face (new branch); retain mixed-program refusal.
- `src/engine/gcode/motionPipeline.ts:397` — `plasmaSheetZ` — transforms the Top sheet surface through the operation frame — **N** — not offered on Around (hide/refuse with a message).
- `src/engine/gcode/motionPipeline.ts:569` — `planDrillCycles` — transforms XY and cycle Z values through the setup frame — **N** — unclear — needs a decision: rotary-aware expanded drilling or refusal of canned cycles on Around?
- `src/engine/gcode/motionPipeline.ts:620` — `planOperationMotion` — transforms every move, then fits machine-plane arcs — **N** — unroll frame here; retain A and avoid fitting away rotary movement.
- `src/engine/operationBooklet/report.ts:145` — target-summary construction — marks targets reached from another face — **N** — treat as its own face (new branch).
- `src/engine/operationBooklet/report.ts:160` — `setupRows` — Top description, otherwise Bottom/flip-axis description — **B** — treat as its own face (new branch); `'around'` currently prints Bottom instructions.
- `src/engine/operationBooklet/report.ts:537` — `buildOperationBookletReport` — converts the toolpath back to setup-local heights — **N** — unroll frame here; report the flat job and radial depth.

### `src/store/helpers/`

- `src/store/helpers/activeFace.ts:60` — `activeSetup` — resolves saved/provisional setup, with legacy Top fallback — **N** — treat as its own face (new branch).
- `src/store/helpers/activeFace.ts:70` — `activeFace` — forwards `setupFace(activeSetup)` — **N** — treat as its own face (new branch).
- `src/store/helpers/activeFace.ts:75` — `findSetupForFace` — finds a setup by face equality — **N** — treat as its own face (new branch).
- `src/store/helpers/activeFace.ts:85` — `projectUsesBothFaces` — only Bottom presence activates multi-face UI — **B** — treat as its own face (new branch); Top+Around currently takes the Top-only branch.
- `src/store/helpers/activeFace.ts:108` — `isFaceEditInProgress` — guards changes while a workflow owns its face — **N** — same as Top is actually correct because an Around edit must also retain its starting face.
- `src/store/helpers/activeFace.ts:137` — `ghostPredicate` — compares feature face with active face — **N** — treat as its own face (new branch); equality already supports three values.
- `src/store/helpers/activeFace.ts:143` — `isGhostFeature` — forwards the ghost rule — **N** — treat as its own face (new branch).
- `src/store/helpers/activeFace.ts:155` — `linkedCopiesOffFace` — counts linked instances on any different face — **N** — treat as its own face (new branch); multiple other faces are already counted.
- `src/store/helpers/activeFace.ts:178` — `editableFeatures` — removes ghosts by the shared predicate — **N** — treat as its own face (new branch).
- `src/store/helpers/activeFace.ts:190` — `editableProjectFeatures` — resolves features then removes ghosts — **N** — treat as its own face (new branch).
- `src/store/helpers/activeFace.ts:195` — `ghostFeatureIds` — collects differing-face IDs — **N** — treat as its own face (new branch).
- `src/store/helpers/activeFace.ts:213` — `featuresAtActiveFace` — cross-face material reaches Top or, otherwise, Bottom — **B** — treat as its own face (new branch); `'around'` currently accepts material reaching planar Bottom.
- `src/store/helpers/activeFace.ts:235` — `newFeatureSpan` — Top span, otherwise Bottom span — **B** — treat as its own face (new branch); `'around'` currently creates Bottom-style Z.
- `src/store/helpers/activeFace.ts:253` — `faceArtworkMirror` — Top identity, otherwise flip-axis mirror — **B** — same as Top is actually correct because unrolled artwork should remain readable without a Bottom mirror; today Around takes the mirror branch.
- `src/store/helpers/activeFace.ts:268` — `crossFaceArtworkMirror` — always chooses a Bottom setup’s mirror for a cross-face transfer — **B** — unclear — needs a decision: refuse planar↔Around transfers or define their artwork mapping?
- `src/store/helpers/activeFace.ts:280` — `flipAxisMirror` — forwards anchored points through the half-turn frame — **N** — not offered on Around (hide/refuse with a message); this helper should remain rotation-only.
- `src/store/helpers/activeFace.ts:297` — `activeOriginInStock` — Top identity, otherwise mirrored origin — **B** — unroll frame here; Around currently takes the Bottom-style mapping.
- `src/store/helpers/activeFace.ts:310` — `originPlacementFromStock` — Top identity, otherwise inverse setup mapping — **B** — unroll frame here; Around needs longitudinal/A-zero placement semantics.
- `src/store/helpers/activeFace.ts:321` — `faceArtworkTransform` — converts the selected artwork map into a matrix — **N** — same as Top is actually correct because Around’s unrolled artwork needs no half-turn mirror.
- `src/store/helpers/activeFace.ts:330` — `crossFaceArtworkTransform` — forwards the cross-face mirror as a matrix — **N** — unclear — needs a decision: how are planar↔Around copies mapped?
- `src/store/helpers/activeFace.ts:356` — `isThroughFeature` — forwards the engine’s planar through rule — **N** — treat as its own face (new branch); do not infer Around accessibility from planar thickness.
- `src/store/helpers/activeFace.ts:393` — `reversedStockAxes` — Top returns none; otherwise samples a rotation frame — **B** — same as Top is actually correct because the unrolled authoring plane is not a Bottom reflection; Around currently enters the rotation branch.
- `src/store/helpers/activeFace.ts:427` — `faceOffsets` — derives signed spacing from reversed axes — **N** — same as Top is actually correct because spacing is measured in the flat unrolled plane.
- `src/store/helpers/activeFace.ts:448` — `faceAngles` — derives direction/turn/axis-angle maps from reversed axes — **N** — same as Top is actually correct for 2D unrolled angles; 3D model angles need a separate policy.
- `src/store/helpers/activeFace.ts:483` — `flippedZRange` — explicitly derives a Bottom display range — **N** — not offered on Around (hide/refuse with a message); use an Around radial range helper.
- `src/store/helpers/activeFace.ts:509` — `dropGhostSelection` — drops differing-face selection/hover/edit IDs — **N** — treat as its own face (new branch).
- `src/store/helpers/provisionalSetup.ts:36` — `PROVISIONAL_SETUPS` — exhaustive `Record<SetupFace, MachiningSetup>` — **E** — treat as its own face (new branch); an Around default must be stock-dependent.
- `src/store/helpers/provisionalSetup.ts:58` — `defaultSetupForFace` — indexes that record — **N** — treat as its own face (new branch); validate round stock.
- `src/store/helpers/provisionalSetup.ts:63` — `provisionalSetupId` — indexes that record for an ID — **N** — treat as its own face (new branch).
- `src/store/helpers/provisionalSetup.ts:73` — `provisionalSetupFor` — finds an active provisional setup among record values — **N** — treat as its own face (new branch).
- `src/store/helpers/provisionalSetup.ts:85` — `realizeProvisionalSetup` — materializes the selected setup and reassigns new content — **N** — treat as its own face (new branch); preserve its frame/indexing discriminator.
- `src/store/helpers/provisionalSetup.ts:114` — `createsContentFor` — detects new features matching the provisional face — **N** — treat as its own face (new branch).
- `src/store/helpers/provisionalSetup.ts:154` — `syncWorkspaceSetups` — resolves/materializes by face equality — **N** — treat as its own face (new branch).
- `src/store/helpers/provisionalSetup.ts:177` — `keepWorkspaceFace` / `onWorkspaceFace` — restores the same face or its provisional ID — **N** — treat as its own face (new branch).
- `src/store/helpers/setups.ts:92` — `isSetupFace` — whitelists Top/Bottom — **G** — Around should pass the extended face guard.
- `src/store/helpers/setups.ts:103` — `decodeSetups` — rejects unsupported rotation/indexing; reconstructs only manual 0°/180° setups — **G** — Around should pass a new strict setup-kind decoder, before rotation-only validation.
- `src/store/helpers/setups.ts:163` — `findSetupWithTurn` — compares angle, ignoring axis at zero — **B** — treat as its own face (new branch); zero-encoded Around can currently match Top.
- `src/store/helpers/setups.ts:194` — `syncProjectSetups` — reconciles setup IDs and operation membership — **N** — treat as its own face (new branch).
- `src/store/helpers/projectFormat.ts:323` — `normalizeInstance` — rejects an unknown `authoringFace` — **G** — Around should pass the extended strict face validation.
- `src/store/helpers/projectFormat.ts:680` — `decodeProjectFormat` — decodes setups, otherwise creates legacy Top — **N** — treat as its own face (new branch); retain the absent-field migration.
- `src/store/helpers/featureDefinitions.ts:214` — `createFeatureInstance` — copies the supplied face, defaulting missing drafts to Top — **N** — treat as its own face (new branch); callers must stamp Around.
- `src/store/helpers/resolveFeatures.ts:474` — `resolveFeatureRow` — copies `authoringFace` into resolved geometry — **N** — treat as its own face (new branch).
- `src/store/helpers/resolveFeatures.ts:527` — `featureInstanceFromResolved` — preserves the resolved face — **N** — treat as its own face (new branch).
- `src/store/helpers/resolveFeatures.ts:602` — `commitResolvedInstances` — writes edited face metadata back — **N** — treat as its own face (new branch).
- `src/store/helpers/derivedFeatures.ts:445` — `createDerivedFeature` — inherits the source face — **N** — treat as its own face (new branch).
- `src/store/helpers/textExpansion.ts:131` — `expandTextFeature` — gives glyph features the text instance’s face — **N** — treat as its own face (new branch).
- `src/store/helpers/buildShapeFeature.ts:73` — `buildShapeFeature` — forwards new-feature Z through `newFeatureSpan` — **N** — treat as its own face (new branch); use radial/unrolled stock height.
- `src/store/helpers/manualFeatureOperation.ts:100` — `inferLineTopZFromEnclosingFeature` — derives the nearest surface using an `onTop` boolean — **B** — treat as its own face (new branch); `'around'` currently chooses Bottom surfaces and thickness-minus-Z.
- `src/store/helpers/referenceFeatures.ts:22` — `referenceProjectFeatures` — filters ghosts, optionally retaining construction references — **N** — unclear — needs a decision: may planar construction references appear in the unrolled plane?
- `src/store/helpers/camPlanApply.ts:166` — CAM-plan application — validates targets against the active setup — **N** — not offered on Around (hide/refuse with a message) until Around planning is supported.

### `src/store/` and `src/store/slices/`

- `src/store/faceViewStore.ts:25` — `FaceViewState` — holds one “other side” toggle and a face-change request — **N** — unclear — needs a decision: does “other side” show both remaining faces or selectable references?
- `src/store/workspaceFace.ts:37` — `switchWorkspaceFace` — selects matching saved/provisional setup under the busy guard — **N** — treat as its own face (new branch); refuse Around on non-round stock.
- `src/store/workspaceFace.ts:49` — `requestAuthoringFaceChange` — opens a face-change request under the busy guard — **N** — unclear — needs a decision: destination picker or planar-only change action?
- `src/store/slices/setupsSlice.ts:61` — `withSetupSync` — forwards setup reconciliation after writes — **N** — treat as its own face (new branch).
- `src/store/slices/setupsSlice.ts:77` — `withGhostSelectionGuard` — forwards shared ghost-selection filtering — **N** — treat as its own face (new branch).
- `src/store/slices/setupsSlice.ts:124` — `createSetup` validation — rejects unsupported orientation — **G** — Around should pass a setup-kind/round-stock guard before rotation validation.
- `src/store/slices/setupsSlice.ts:131` — `createSetup` default name — Top name, otherwise Bottom — **B** — treat as its own face (new branch); `'around'` currently becomes “Bottom”.
- `src/store/slices/setupsSlice.ts:134` — `createSetup` construction — copies only axis/angle and forces manual indexing — **B** — treat as its own face (new branch); additional Around identity would currently be lost.
- `src/store/slices/setupsSlice.ts:158` — `updateSetup` — validates/patches an X/Y flip axis — **B** — treat as its own face (new branch); Around currently receives planar flip-axis editing.
- `src/store/slices/setupsSlice.ts:193` — `setActiveSetup` — recognizes only Top/Bottom provisional IDs — **B** — treat as its own face (new branch); an Around provisional ID is currently refused.
- `src/store/slices/setupsSlice.ts:204` — `assignOperationToSetup` — realizes destination, then applies a validated move — **N** — treat as its own face (new branch); retain the move validator.
- `src/store/slices/setupsSlice.ts:213` — `setFeatureAuthoringFace` — changes only the face tag, leaving geometry/Z untouched — **N** — unclear — needs a decision: planar↔Around changes require conversion or refusal.
- `src/store/slices/featureSlice.ts:504` — `addFeature` — uses supplied face or stamps active face — **N** — treat as its own face (new branch).
- `src/store/slices/pendingAddSlice.ts:454` — text placement — stamps active face and applies artwork transform — **N** — same as Top is actually correct because text reads directly in the unrolled plane; retain the Around tag.
- `src/store/slices/pendingAddSlice.ts:577` — line/composite placement, also `613`, `843` — forwards Z through `newFeatureSpan` — **N** — treat as its own face (new branch).
- `src/store/slices/importMergeSlice.ts:128` — geometry/model import, also `159` — stamps active authoring face — **N** — treat as its own face (new branch); unsupported imported models need explicit refusal.
- `src/store/slices/featureGeometrySlice.ts:125` — `instanceFromResolved` — preserves authoring face during edits — **N** — treat as its own face (new branch).
- `src/store/slices/featureGeometrySlice.ts:240` — `moveFeatureControl` — refuses a ghost reached by feature ID — **N** — treat as its own face (new branch).
- `src/store/slices/featureGeometrySlice.ts:806` — `trimFeatureSegment` — refuses ghost subjects — **N** — treat as its own face (new branch).
- `src/store/slices/featureGeometrySlice.ts:1047` — `extendFeatureEndpoint` — refuses ghost subjects — **N** — treat as its own face (new branch).
- `src/store/slices/selectionSlice.ts:980` — `enterSketchEdit` — refuses ghost features — **N** — treat as its own face (new branch).
- `src/store/slices/selectionSlice.ts:1178` — `setPendingSketchSubject` — refuses ghost subjects — **N** — treat as its own face (new branch).
- `src/store/slices/treeVisibilitySlice.ts:94` — `toggleFolderVisible` — changes only non-ghost folder members — **N** — treat as its own face (new branch).
- `src/store/slices/operationsSlice.ts:94` — `addOperation` — validates targets against active setup — **N** — treat as its own face (new branch).
- `src/store/slices/operationsSlice.ts:184` — `updateOperation` — refuses newly introduced incompatible setup targets — **N** — treat as its own face (new branch).
- `src/store/slices/featureDistributionSlice.ts:58` — `faceLocalDefaults` — forwards radial sweep/grid spacing through face maps — **N** — same as Top is actually correct because Around distribution uses the flat unrolled plane.
- `src/store/slices/workpieceSlice.ts:105` — origin placement — forwards picked XY through `originPlacementFromStock` — **N** — unroll frame here; define surface zero independently of planar origin placement.

### `src/app/`

- `src/app/simulationSetup.ts:66` — `frameForSetup` — zero means no frame, otherwise rotation frame — **B** — unroll frame here; zero-encoded Around currently simulates the physical round project.
- `src/app/simulationSetup.ts:86` — `buildSimulationSetupInput` — scopes operations and maps project/toolpaths into setup space — **N** — unroll frame here; provide flat stock and unwrapped paths.
- `src/app/simulationSetup.ts:112` — `simulationSetups` — enumerates saved plus active provisional setup — **N** — treat as its own face (new branch).
- `src/app/simulationSetup.ts:124` — `setupOperations` — resolves membership by setup identity — **N** — treat as its own face (new branch).
- `src/app/simulationSetup.ts:146` — `resolveSimulationSetup` — explicit choice, selected operation’s owner, then workspace setup — **N** — treat as its own face (new branch).
- `src/app/useSimulationModel.ts:407` — simulation picker construction — forwards setup ID/name/face — **N** — treat as its own face (new branch).
- `src/app/useFeatureTreeActions.ts:160` — `switchFaceToEdit` — reads feature face and invokes the workspace switch — **N** — treat as its own face (new branch).
- `src/app/toolpathGeneration/cacheInputs.ts:165` — `operationSetupOrientation` / capture — stores only the owning orientation — **N** — treat as its own face (new branch); capture frame kind and rotary inputs.
- `src/app/toolpathGeneration/cacheInputs.ts:171` — `sameOrientation` — compares only axis/angle — **B** — treat as its own face (new branch); equal-angle Top/Around currently compare equal.
- `src/app/toolpathGeneration/exportPreparation.ts:257` — export preparation — builds one prepared program per setup and forwards its face — **N** — treat as its own face (new branch).
- `src/App.tsx:247` — app composition, also `450` — forwards setup-aware simulation inputs/picker — **N** — treat as its own face (new branch).

### `src/components/layout/`

- `src/components/layout/FaceSwitch.tsx:26` — `FACES` — enumerates only Top/Bottom — **B** — treat as its own face (new branch); Around is currently omitted.
- `src/components/layout/FaceSwitch.tsx:62` — `FaceSwitch` labels/icons, also `65`, `66` — Top or Bottom presentation — **B** — treat as its own face (new branch); an added Around entry currently looks like Bottom.
- `src/components/layout/FaceSwitch.tsx:74` — `FaceSwitch` ghost toggle — Top’s other face is Bottom, otherwise Top — **B** — unclear — needs a decision: which other faces should Around reference? Today it selects Top styling.
- `src/components/layout/FaceBanner.tsx:52` — `FaceBanner` mounting note — only Bottom gets a flip note — **B** — treat as its own face (new branch); Around currently gets no mounting/unroll note.
- `src/components/layout/FaceBanner.tsx:64` — `FaceBanner` drawing hint — Top or Bottom icon/text — **B** — treat as its own face (new branch); `'around'` currently says Bottom.
- `src/components/layout/AppShell.tsx:129` — `AppShell` banner visibility, also `133` — consumes `projectUsesBothFaces` — **N** — treat as its own face (new branch); inherit generalized multi-face visibility.

### `src/components/feature-tree/`

- `src/components/feature-tree/FeatureTree.tsx:368` — feature row rendering — face inequality creates a ghost row — **N** — treat as its own face (new branch).
- `src/components/feature-tree/FeatureTree.tsx:381` — ghost-row tooltip — Bottom tooltip, otherwise Top — **B** — treat as its own face (new branch); `'around'` currently says Top.
- `src/components/feature-tree/FeatureTree.tsx:471` — `renderMachiningEntries` — filters features/folders by requested face and active-face equality — **N** — treat as its own face (new branch).
- `src/components/feature-tree/FeatureTree.tsx:669` — face layers, labels/icons through `681` — enumerates Top/Bottom — **B** — treat as its own face (new branch); Around features disappear from layered rendering.
- `src/components/feature-tree/FaceChip.tsx:24` — `FaceChip` — Top text, otherwise Bottom — **B** — treat as its own face (new branch); `'around'` currently says Bottom.
- `src/components/feature-tree/FaceChip.tsx:38` — `AuthoringFaceRow` — forwards face to chip/change request — **N** — treat as its own face (new branch).
- `src/components/feature-tree/ChangeFaceDialog.tsx:30` — `oppositeFace` — Top→Bottom, otherwise Top — **B** — unclear — needs a decision: use a destination picker or forbid planar↔Around moves? Today Around moves to Top.
- `src/components/feature-tree/ChangeFaceDialog.tsx:38` — `formatZRange` — Bottom flipped range, otherwise stored Top range — **B** — treat as its own face (new branch); `'around'` currently receives Top display semantics.
- `src/components/feature-tree/ChangeFaceDialog.tsx:69` — `ChangeFaceDialogBody` selection — selects movable features by face equality — **N** — treat as its own face (new branch).
- `src/components/feature-tree/ChangeFaceDialog.tsx:76` — face names/title/action, also `92`, `93`, `192` — Top or Bottom wording — **B** — treat as its own face (new branch); direct Around values receive Bottom wording.
- `src/components/feature-tree/ChangeFaceDialog.tsx:170` — linked-copy translation key — interpolates face into typed message keys — **E** — treat as its own face (new branch); adding Around creates an unsupported typed key until catalog entries exist.
- `src/components/feature-tree/FeatureContextMenu.tsx:116` — ghost menu — face inequality restricts editing — **N** — treat as its own face (new branch).
- `src/components/feature-tree/FeatureContextMenu.tsx:131` — switch-to-edit label — Bottom label, otherwise Top — **B** — treat as its own face (new branch); `'around'` currently says Top.
- `src/components/feature-tree/FeatureContextMenu.tsx:496` — change-face menu visibility — consumes the both-faces helper — **N** — treat as its own face (new branch).
- `src/components/feature-tree/PropertiesPanel.tsx:100` — face angle maps, backdrop use at `862`/`867` — forwards face-local direction conversion — **N** — same as Top is actually correct because unrolled 2D directions are planar directions.
- `src/components/feature-tree/PropertiesPanel.tsx:1282` — bulk Z properties — Bottom gets `FaceZRange`, otherwise ordinary Z controls — **B** — treat as its own face (new branch); `'around'` currently gets Top controls.
- `src/components/feature-tree/PropertiesPanel.tsx:1535` — linked-copy warning — Top’s other face is Bottom, otherwise Top — **B** — treat as its own face (new branch); Around currently describes all linked copies as Top.
- `src/components/feature-tree/PropertiesPanel.tsx:1572` — authoring-face properties — forwards the instance face — **N** — treat as its own face (new branch).
- `src/components/feature-tree/PropertiesPanel.tsx:1593` — single-feature Z properties — Bottom-specific range or ordinary Top controls — **B** — treat as its own face (new branch); `'around'` currently gets Top controls.
- `src/components/feature-tree/FaceZRange.tsx:60` — `FaceZRange` — always computes a flipped Bottom range; tags `data-face="bottom"` at `91` — **B** — not offered on Around (hide/refuse with a message); add radial/unrolled range controls.
- `src/components/feature-tree/faceZRangeEdit.ts:66` — `planFaceZEdit` — always writes using Bottom depth conversion — **B** — not offered on Around (hide/refuse with a message); use an Around-specific writer.
- `src/components/feature-tree/ModelOrientationSection.tsx:174` — model angle editing, also `187`, `189` — forwards axis rotations through face maps — **N** — not offered on Around (hide/refuse with a message) until imported-model support is defined.

### CAM, export and simulation components

- `src/components/cam/machineMode.ts:114` — `showsFaceSwitch` — consumes multi-face presence to preserve access in plasma mode — **N** — treat as its own face (new branch); use generalized face-presence information.
- `src/components/cam/setupSections.ts:63` — `camSetupSections` — enumerates saved/provisional setups and groups by ownership — **N** — treat as its own face (new branch).
- `src/components/cam/setupSections.ts:73` — `camSetupSections.flipAxis` — zero means no flip, otherwise X/Y flip — **B** — treat as its own face (new branch); Around currently looks unturned or flipped.
- `src/components/cam/setupSections.ts:81` — `crossFaceTargets` — forwards cross-face verdicts — **N** — treat as its own face (new branch).
- `src/components/cam/setupSections.ts:86` — `unreachableTargets` — forwards rejected verdicts — **N** — treat as its own face (new branch).
- `src/components/cam/setupSections.ts:123` — target-reach construction — invokes planar through-feature coverage — **N** — not offered on Around (hide/refuse with a message) until radial reach is defined.
- `src/components/cam/CamSetupSectionView.tsx:32` — section heading — Top operations, otherwise Bottom operations — **B** — treat as its own face (new branch); `'around'` currently says Bottom.
- `src/components/cam/CamSetupSectionView.tsx:39` — section mounting status — flip-axis text or setup name — **B** — treat as its own face (new branch); Around currently inherits the flipped/unturned presentation.
- `src/components/cam/SetupPropertiesDialog.tsx:39` — setup properties through `58` — rotation-origin calculation, fixed face buttons, flip axis and flip sketch — **B** — treat as its own face (new branch); Around currently receives planar flip controls and is absent from the face buttons.
- `src/components/cam/SetupOperationControls.tsx:73` — target-depth description — Top wording, otherwise Bottom wording — **B** — treat as its own face (new branch); `'around'` currently says Bottom.
- `src/components/cam/CrossFaceTargetPicker.tsx:24` — `CrossFaceTargetPicker` — forwards the requested face to target verdicts — **N** — not offered on Around (hide/refuse with a message) for planar through/model exceptions unless explicitly supported.
- `src/components/cam/operationValidity.ts:96` — `activeSetupFace` — forwards active face — **N** — treat as its own face (new branch).
- `src/components/cam/operationValidity.ts:107` — `activeSetupTargetHint` — Top rejection wording, otherwise Bottom — **B** — treat as its own face (new branch); `'around'` currently says Bottom.
- `src/components/cam/operationValidity.ts:500` — `compatibleFeatureIdsForOperationWithMap` — filters using face reachability — **N** — treat as its own face (new branch).
- `src/components/cam/CAMPanel.tsx:2263` — add-operation target picker — 180° means Bottom, otherwise Top — **B** — treat as its own face (new branch); zero/other-angle Around currently becomes Top.
- `src/components/cam/CAMPlanOperationEditor.tsx:145` — CAM-plan editor — obtains the active setup for scoped controls — **N** — not offered on Around (hide/refuse with a message) until its plan supports the unrolled frame.
- `src/components/cam/bookletExport.ts:98` — `bookletFileName` — includes program number/setup name — **N** — treat as its own face (new branch).
- `src/components/cam/CAMPanel.tsx:997` — booklet snapshot preparation — passes the captured canonical project/path directly to snapshot rendering — **N** — unroll frame here; supply the operation’s flat setup input.
- `src/components/export/exportOperationSelection.ts:86` — grouped export options — forwards setup face and membership — **N** — treat as its own face (new branch).
- `src/components/export/exportOperationSelection.ts:83` — single-setup export group — always labels the group Top — **B** — treat as its own face (new branch); a sole Around setup currently has Top group metadata.
- `src/components/export/ExportDialog.tsx:348` — export headings/program cards, also `428` — forwards face into DOM attributes and setup naming — **N** — treat as its own face (new branch).
- `src/components/simulation/SimulationViewport.tsx:1176` — simulation setup picker — enumerates supplied setup IDs/names — **N** — treat as its own face (new branch); the picker itself needs no binary face branch.

### `src/components/canvas/`

- `src/components/canvas/viewTransform.ts:144` — `viewMirrorForOrientation` — identity at zero, otherwise derives two mirror flags — **B** — unroll frame here; Around currently gets identity-on-physical-stock or a Bottom mirror.
- `src/components/canvas/viewTransform.ts:195` — `computeSketchViewTransform` — combines stock viewport with setup mirror — **N** — unroll frame here; use length×circumference bounds.
- `src/components/canvas/viewTransform.ts:206` — `computeFitViewState` — fits canonical bounds after planar mirror arithmetic — **B** — unroll frame here; Around currently fits the physical rectangle.
- `src/components/canvas/viewTransform.ts:57` — `worldToCanvas` — applies optional reflected coordinates — **N** — same as Top is actually correct because unrolled feature coordinates need an ordinary flat viewport.
- `src/components/canvas/viewTransform.ts:65` — `canvasToWorld` — reverses the optional reflection — **N** — same as Top is actually correct because picks should return unrolled XY.
- `src/components/canvas/viewTransform.ts:76` — `viewIsMirrored` — derives handedness from mirror flags — **N** — same as Top is actually correct because the unrolled plane is not a half-turn mirror.
- `src/components/canvas/viewTransform.ts:81` — `worldAngleToCanvas` — derives displayed angle from mirror flags — **N** — same as Top is actually correct because unrolled angles are ordinary planar angles.
- `src/components/canvas/viewTransform.ts:90` — `worldArcToCanvas` — derives arc sweep/direction from mirror flags — **N** — same as Top is actually correct because sketch arcs live in the flat unrolled plane.
- `src/components/canvas/viewTransform.ts:106` — `applyViewMirror` — reflects the drawing context — **N** — same as Top is actually correct because Around’s flat view needs no Bottom reflection.
- `src/components/canvas/viewTransform.ts:117` — `reflectContextForView` — reflects cached drawing coordinates — **N** — same as Top is actually correct after supplying unwrapped display paths.
- `src/components/canvas/viewTransform.ts:131` — `viewLinearMap` — supplies signed GPU scales/offsets — **N** — same as Top is actually correct after supplying unrolled coordinates.
- `src/components/canvas/faceOverlay.ts:37` — `ghostColorKey` — Top ghost colour, otherwise Bottom — **B** — treat as its own face (new branch); `'around'` currently gets Bottom colour.
- `src/components/canvas/faceOverlay.ts:46` — `drawGhostFeature` — forwards the feature face to ghost styling — **N** — unclear — needs a decision: how can planar ghosts be meaningfully displayed in an unrolled surface?
- `src/components/canvas/faceOverlay.ts:132` — `drawOtherFace` — draws every differing-face feature as canonical geometry — **N** — unclear — needs a decision: hide incompatible face domains or project them explicitly?
- `src/components/canvas/faceOverlay.ts:148` — `drawOtherFace` origin marker — only Bottom draws Top’s origin landing — **B** — treat as its own face (new branch); Around currently has no appropriate rotary-origin marker.
- `src/components/canvas/previewPrimitives.ts:93` — `drawFeatureInfo` — Bottom flips its label range, otherwise stored Top range — **B** — treat as its own face (new branch); `'around'` currently receives Top Z labels.
- `src/components/canvas/SketchCanvas.tsx:983` — `SketchCanvas`, also `1288`, `1406`, `2007`, `2135`, `2225`, `2322` — forwards view, angle, artwork and editable-feature helpers — **N** — unroll frame here; keep drawing, preview, fitting and picking in one unrolled coordinate domain.
- `src/components/canvas/useCanvasKeyboard.ts:344` — keyboard dimension entry, also `426`, `457`, `495`, `512`, `566`, `588` — forwards face angle/view helpers — **N** — same as Top is actually correct because Around’s typed 2D input is flat-plane input.
- `src/components/canvas/useClickPlacement.ts:386` — click placement, also `401`, `416`, `586`, `992` — forwards setup view and editable/reference filtering — **N** — unroll frame here; pick unrolled XY and restrict incompatible references.
- `src/components/canvas/usePointerGestures.ts:408` — pointer workflows, also `460`, `535`, `909`, `936`, `1018`, `1025`, `1177`, `1189` — forwards setup view and face filtering — **N** — unroll frame here; keep drag/box-selection coordinates unrolled.
- `src/components/canvas/useCanvasContextMenu.ts:104` — context-menu hit testing, also `128` — forwards setup view/editable geometry — **N** — unroll frame here.
- `src/components/canvas/hitTest.ts:230` — `segmentHitTest` — defaults to editable, non-ghost features — **N** — treat as its own face (new branch).
- `src/components/canvas/snappingHelpers.ts:447` — `resolveSketchSnap` — defaults to editable features and setup-aware origin — **N** — unroll frame here; snap to unrolled geometry and rotary zero.
- `src/components/canvas/triggerDimensionEdit.ts:87` — dimension-entry setup, also `227` — forwards angle and setup-view helpers — **N** — same as Top is actually correct because Around dimensions are entered in the flat plane.
- `src/components/canvas/useDimensionEditWorkflow.ts:141` — dimension-edit preview, also `230` — forwards face angle maps — **N** — same as Top is actually correct because unrolled 2D angles have Top handedness.
- `src/components/canvas/useCreationWorkflow.ts:156` — creation preview, also `208` — forwards face-local direction/preview maps — **N** — same as Top is actually correct because creation happens in the unrolled plane.
- `src/components/canvas/useTransformExactWorkflow.ts:159` — exact rotation, also `238` — forwards face-angle conversion — **N** — same as Top is actually correct because rotations are flat sketch rotations.
- `src/components/canvas/manualEntry.ts:56` — `formatDirectionAngle` — forwards direction through supplied `FaceAngles` — **N** — same as Top is actually correct because unrolled direction angles are planar.
- `src/components/canvas/manualEntry.ts:112` — `computeDimensionEditPreviewPoint`, face conversion at `177`, `187`, `207` — forwards supplied direction mapping — **N** — same as Top is actually correct because previews are unrolled XY.
- `src/components/canvas/manualEntry.ts:259` — rotation preview/readback, also `270` — forwards supplied turn mapping — **N** — same as Top is actually correct because the unrolled plane has ordinary handedness.
- `src/components/canvas/measurements.ts:201` — `drawAngleMeasurement` — reverses labels only for mirrored views — **N** — same as Top is actually correct because Around’s unrolled view is not mirrored.
- `src/components/canvas/FeatureDistributionPanel.tsx:63` — distribution controls — derive face angles/offsets from active setup — **N** — same as Top is actually correct because spacing/sweeps are flat-plane values.
- `src/components/canvas/EditSketchPanel.tsx:275` — linked-copy warning — Top’s other face is Bottom, otherwise Top — **B** — treat as its own face (new branch); Around currently describes linked copies as Top.
- `src/components/canvas/renderSketchToolpaths.ts:37` — `renderSketchToolpaths`, reflection at `57`/`81` — scopes emphasis by setup and renders stock-space buffers through mirror maps — **N** — unroll frame here; render unwrapped Around paths rather than centreline-only wrapped XYZ.
- `src/components/canvas/toolpathDisplay.ts:341` — `canvasDisplayViewport` — derives reflected culling bounds — **N** — same as Top is actually correct after supplying flat unrolled display paths.
- `src/components/canvas/gpuToolpathRenderer.ts:232` — `GpuToolpathRenderer.render` — forwards signed view map into GPU rendering — **N** — same as Top is actually correct after supplying unrolled buffers.
- `src/components/canvas/gpuToolpathAnnotations.ts:63` — `GpuToolpathAnnotations.render`, reflection at `81` — keys/draws annotations using mirror flags — **N** — same as Top is actually correct after supplying unrolled paths.
- `src/components/canvas/stlTopViewRenderer.ts:55` — `resolveStlTopViewPlacement` — derives image reflection from view flags — **N** — not offered on Around (hide/refuse with a message) until model-surface mapping is supported.
- `src/components/canvas/scenePrimitives.ts:599` — `drawBackdropImage`, also `608` — mirrors backdrop image/selection with the view — **N** — same as Top is actually correct for a backdrop authored in the unrolled plane.
- `src/components/canvas/operationSnapshot.ts:238` — `drawOperationSnapshot` — uses canonical stock bounds and ordinary view transform, without a setup frame — **B** — unroll frame here; Around currently prints the physical-stock/canonical picture.

### 3D viewport and setup muting

- `src/components/viewport3d/viewPresets.ts:100` — `viewPresetSpherical` — Bottom reverses isometric elevation; every other face uses normal preset — **B** — unclear — needs a decision: physical-bar view or flat Around workspace view? Today Around uses Top elevation.
- `src/components/viewport3d/orbitControls.ts:114` — preset application — forwards workspace face to preset helper — **N** — treat as its own face (new branch).
- `src/components/viewport3d/Viewport3D.tsx:466` — workspace-face preset effect — replaces a Top/Bottom preset with the face name — **B** — treat as its own face (new branch); Around would be passed as an unsupported `ViewPreset`.
- `src/components/toolpathSetupMuting.ts:39` — `mutedToolpathOperationIds` — uses setup membership to mute other setups — **N** — treat as its own face (new branch); separately define how wrapped/unwrapped paths are displayed.

### Clipboard, import, units, fixtures and print

- `src/platform/featureClipboard.ts:144` — `readableOnActiveFace` — differing-face text always receives the Bottom cross-face mirror — **B** — unclear — needs a decision: planar↔Around text transfer policy; today it receives the Bottom mirror.
- `src/platform/featureClipboard.ts:186` — paste — stamps the active authoring face — **N** — treat as its own face (new branch); apply the agreed cross-domain transfer policy.
- `src/import/camj.ts:100` — `inspectCamjString` — forwards all loading through the shared strict decoder — **N** — treat as its own face (new branch).
- `src/import/camj.ts:406` — merge operation intake — skips an operation whose source setup is missing — **N** — same as Top is actually correct because unknown setup ownership must not be guessed.
- `src/import/camj.ts:443` — merge `setupIdFor` — matches by rotation only and constructs a manual setup — **B** — treat as its own face (new branch); Around can currently match Top or lose its new discriminator.
- `src/utils/units.ts:397` — `convertSetup` — preserves setup fields and converts registration lengths — **N** — treat as its own face (new branch); angles remain degrees, any stored rotary lengths must convert.
- `src/test/projectFixtures.ts:108` — `withBottomSetup` — explicitly builds a Bottom/manual fixture — **N** — same as Bottom is actually correct because this helper specifically constructs Bottom; add a separate Around helper.
- `src/test/projectFixtures.ts:139` — legacy fixture construction — removes authoring-face metadata — **N** — same as Top is actually correct because this fixture represents pre-face files.
- `src/components/export/PrintDesignDialog.tsx:103` — print preparation, also `128` — sends the canonical project to print SVG generation — **B** — unclear — needs a decision: active-face print or physical-stock print? Today Around uses canonical planar output.
- `src/engine/designPrint/svg.ts:770` — `buildWorldContent`, called by print/SVG export — draws stock/features without face-domain selection or setup transform — **B** — unroll frame here if Around print/export is supported; otherwise not offered on Around with a message.

### `e2e/`

- `e2e/selectors.ts:780` — `face.segment` — accepts only `'Top' | 'Bottom'` — **B** — treat as its own face (new branch); Around is currently unaddressable.
- `e2e/selectors.ts:784` — `face.layer` — forwards the face into a DOM selector, with a two-value parameter type — **N** — treat as its own face (new branch); widen the parameter.
- `e2e/selectors.ts:787` — `face.zRange` — addresses the Bottom-specific range component — **N** — treat as its own face (new branch); add an Around radial-range selector.
- `e2e/selectors.ts:805` — `setupCam.section` — forwards a face into a DOM selector, with a two-value parameter type — **N** — treat as its own face (new branch); widen the parameter.
- `e2e/selectors.ts:807` — `setupCam.add` — matches only “Add to Top/Bottom” — **B** — treat as its own face (new branch); Around is currently omitted.

**Class counts: B 80; E 3; G 10; N 185 — 278 listed sites.** The third E site is typed translation-key expansion; the two direct `Record<SetupFace, …>` exhaustiveness sites are provisional setups and reach coverage.

## 1. Unroll/wrap placement and setup representation

The generation seam is exactly `computeOperationToolpath` at `src/engine/toolpaths/generateOperation.ts:133–141`:

1. Resolve the operation’s setup frame.
2. Pass `projectInSetupFrame(project, frame)` to ordinary generators.
3. Apply `toolpathInStockFrame` to both final and raw results.

Add the **unroll branch** in `projectInSetupFrame` at `src/engine/setupFrameProject.ts:127`. Construct a genuine block: length×circumference footprint, radius thickness, and Around-compatible feature/depth inputs. Do not retain `shape: 'round'` or apply `turnFeature` to unrolled artwork.

Add the **wrap branch** in `toolpathInStockFrame` at `:183`: unrolled Y becomes A degrees, with tool XY over the physical bar’s centreline. Moves, bounds, drilling metadata and step levels need explicit treatment. `ToolpathPoint` currently has only XYZ (`src/engine/toolpaths/types.ts:24`).

`{axis, angleDeg}` is insufficient: continuous wrapping is a nonlinear coordinate mapping, not a fixed rigid rotation. Use a discriminated setup/frame kind, either a new setup field or a discriminated orientation/frame union. `SetupIndexing` currently only means manual mounting (`src/types/project.ts:1028`); if it becomes the discriminator, its meaning and every copy/decoder/cache boundary must change.

Crucially, `toolpathInSetupFrame` at `setupFrameProject.ts:222` cannot remain an alias of the forward wrap. Simulation must **unwrap**, while export must preserve A without wrapping twice. `projectToMachinePoint` currently rebuilds an XYZ-only object (`src/engine/gcode/utils.ts:34`), so adding `a` to generated points alone would lose it.

Also decide how stock axis `'y'` maps into the required “unrolled X along the bar” convention; round stock supports both axes (`src/types/project.ts:580`).

## 2. Feature-face storage, creation, display and targeting

The persisted field is `FeatureInstance.authoringFace` (`src/types/project.ts:531`), not a field on the shared shape definition. Drafts may omit it; missing values become Top.

Creation stamps it in `featureSlice.ts:504`, text placement in `pendingAddSlice.ts:454`, geometry import in `importMergeSlice.ts:128/159`, and paste in `featureClipboard.ts:186`. Derived features and expanded text preserve it.

Display/edit filtering centres on `ghostPredicate` and `editableProjectFeatures` (`activeFace.ts:137/190`). Equality supports Around already. Binary failures remain in `projectUsesBothFaces`, tree-layer enumeration, labels, artwork mirrors, origin conversion and Z controls.

Operation eligibility centres on `judgeTargetFromFace`, `targetAllowedInSetup` and `setupGenerationBlock` (`setupTargets.ts:163/226/247`). The present cross-face exception accepts any through subtract or imported model; it must become face-pair/domain aware.

An actual saved `'around'` feature currently fails loading at `projectFormat.ts:324`. Bypassing validation exposes Bottom-style creation/depth conversion, Top-style properties/labels, omitted tree layers and incorrect cross-face targeting. Merely changing the tag does not convert canonical XY/Z into unrolled coordinates (`setupsSlice.ts:213`).

## 3. UI enumeration and output surfaces

- **Face switch/banner:** `layout/FaceSwitch.tsx:26`, `FaceBanner.tsx:52/64`, `AppShell.tsx:129`.
- **Feature layers/tags/change dialog:** `FeatureTree.tsx:669`, `FaceChip.tsx:24`, `ChangeFaceDialog.tsx:30`.
- **Setup properties:** `cam/SetupPropertiesDialog.tsx:54` enumerates six disabled planar face buttons and always offers flip-axis controls.
- **CAM grouping:** `cam/setupSections.ts:63` already enumerates setups generically; `CamSetupSectionView.tsx:32/39` supplies binary labels/mounting text.
- **Simulation:** `app/simulationSetup.ts:112`, `useSimulationModel.ts:407`, `SimulationViewport.tsx:1176` enumerate setups generically. The frame preparation, not the picker, needs unrolling.
- **Export:** `exportOperationSelection.ts:79`, `ExportDialog.tsx:348/428`, and `setupPrograms.ts:95` provide setup groups/programs. Touch-off and mounting instructions remain binary.
- **Booklet:** `report.ts:160/537`, `CAMPanel.tsx:997`, `operationSnapshot.ts:238`; report statistics have a setup transform, while snapshot preparation currently uses canonical geometry.
- **Print/SVG:** `PrintDesignDialog.tsx:103/128`, `designPrint/svg.ts:770`; no current face-domain selection/unroll transform.

The referenced face labels also need Around catalog entries and visual tokens/icons. Static catalog strings do not constitute exhaustive `SetupFace` maps.

## 4. Persistence and unknown values

`decodeSetups` (`src/store/helpers/setups.ts:103`) rejects orientations outside X/Y 0°/180° and rejects any indexing value other than `'manual'`. After validation it reconstructs the setup with only axis/angle and manual indexing. A newly added field would be discarded unless explicitly decoded.

`normalizeInstance` (`projectFormat.ts:291`, face check at `324`) rejects unknown feature faces. Missing/nullish face metadata defaults to Top. `decodeProjectFormat` at `:680` creates a default Top setup when setup data is absent/null/empty; dangling operation setup references are separately rejected.

`.camj` inspection uses that same decoder (`src/import/camj.ts:100`). Merge preserves operation ownership by finding a setup with the same turn, or creating one (`:443`). Matching currently compares only angle/axis; creation forces manual indexing. Both must preserve and compare Around’s discriminator. Missing source setups cause the operation to be skipped with a warning (`:406`), not assigned to the active face.

Unknown **orientation/indexing values** therefore fail closed today. An unknown **additional setup field**, accompanied by otherwise valid Top/Bottom orientation/manual indexing, is not preserved by the decoder.

## 5. Three highest-risk wrong-output boundaries

1. **Generation-frame selection and project conversion** — `generateOperation.ts:133`, `setupOrientation.ts:186`, `setupFrameProject.ts:127`. Zero-encoded Around bypasses unrolling; 180°-encoded Around mirrors the round job as Bottom. Either produces motion for the wrong geometry/depth frame.

2. **Feature depth and cross-face eligibility** — `activeFace.ts:235`, `setupOrientation.ts:223/234`, `setupTargets.ts:124/163`. Around currently receives Bottom-style new spans/depths, while planar through-features/models can be accepted as rotary targets. A plausible-looking target can therefore generate the wrong cut.

3. **Machine-coordinate/export conversion** — `gcode/utils.ts:34`, `motionPipeline.ts:632`, `setupPrograms.ts:159/224`. Export transforms the returned path again and constructs XYZ-only points. Without an explicit rotary branch it can discard A, apply the wrong half-turn, fit inappropriate arcs, and print Bottom mounting instructions.
