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
 * The feature context menu of a generated shape and of a feature authored on
 * another face (issue #1112 F2, items 4–6 and 10).
 *
 * What it pins, as rendered:
 *  - every canned kind carries "Edit {shape}…", and only a kind that has plain
 *    features to expand into carries "Expand to features" — the same rule
 *    Properties follows, so the two entry points cannot disagree;
 *  - the refusals a generated shape shows are as short as the menu needs
 *    (item 4's cap is CSS; the text is the reason the menu grew);
 *  - a feature on another face that an operation here can still cut gets the
 *    *normal* menu, with Create operation offering exactly what the Add menu
 *    offers on that face and stock, Add/Remove to operation offered, and every
 *    editable item disabled with the switch-face reason — the reason the tree
 *    row's tooltip carries (item 10);
 *  - the same feature with nothing it can be cut with keeps the hint-only ghost
 *    menu (`menuFeatureTargetableFromFace` is the switch);
 *  - "Change authoring face…" is present on the Around face when a feature from
 *    another face is selected, disabled with the switch-face reason, instead
 *    of being hidden;
 *  - a mixed-face selection refuses the bulk actions (move, resize, rotate,
 *    mirror, offset, join, cut, delete) with the *offending* feature's
 *    switch-face reason, even when the right-clicked feature is on this face;
 *  - "Edit {shape}…" follows Properties' rule and nothing else, on every face:
 *    a Turn or a Polygon authored on Top is offered enabled on Around (where
 *    Frank found it greyed out), the ghost menu offers the same entry above the
 *    way to its own face, and a kind with no registered opener is refused with
 *    Properties' own reason rather than a face's (issue #1112 rt7-c).
 *
 * Mutations checked one at a time:
 *  - showing "Expand to features" for Turn/Polygon → the absence assertion
 *    fails;
 *  - dropping the disabled state on the editable items of an other-face
 *    feature → their disabled/reason assertions fail;
 *  - handing the menu `validQuickOperationsForFeature` instead of the
 *    face-filtered list → Create operation is empty (or lists a kind this face
 *    does not offer) and the exact-list assertion fails;
 *  - rendering the ghost menu regardless of the flag → the Copy/Edit assertions
 *    fail;
 *  - judging the selection's face by the primary feature alone → the mixed-face
 *    test finds Move selected/Delete selected enabled;
 *  - hiding "Change authoring face…" whenever the workspace is Around → the
 *    other-face menu test cannot find it;
 *  - a round-stock fixture → the square-blank assertion on the Add menu rows
 *    fails (no wrapped row says "Needs a round bar");
 *  - putting `onOtherFace` back into the "Edit {shape}…" entry's `disabled` → the
 *    Around tests lose their enabled entry;
 *  - dropping the "Edit {shape}…" entry from the ghost menu → the ghost test
 *    loses it and its ordering assertion (rt7-c).
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/feature-tree/featureContextMenu.test.ts
 */

import * as React from 'react'
import { createElement } from 'react'
import { parseHTML } from 'linkedom'
import type { Operation, Project, SketchFeature } from '../../types/project'
import type { RemoveFromOperationCandidate } from '../cam/operationTargetLists'
import type { QuickOperation } from '../cam/operationValidity'
import type { FeatureTreeActions } from '../../app/useFeatureTreeActions'

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
;(globalThis as unknown as { React?: typeof React }).React = React

const { FeatureContextMenu } = await import('./FeatureContextMenu')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { enMessages } = await import('../../i18n/locales/en')
const { useProjectStore } = await import('../../store/projectStore')
const { projectWithFeatures } = await import('../../test/projectFixtures')
const { newProject, rectProfile } = await import('../../types/project')
const { resolveFeatureInstance } = await import('../../store/helpers/resolveFeatures')
const { rotaryOperationFixture } = await import('../../test/rotaryOperationFixture')
const { validQuickOperationsForFeatureOnActiveFace, operationAddEntries } = await import('../cam/operationAddEntries')
const { singleFeatureSelection } = await import('../cam/operationValidity')
const { machineMode } = await import('../cam/machineMode')
const { camT } = await import('../cam/camI18n')
const { squareStock, isSquareStock } = await import('../../types/barStock')
const { registerCannedShapeEditor, getCannedShapeEditor } = await import('../../cannedShapes')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const noop = (): void => {}

// ── The menu, as the app renders it ──────────────────────────────

interface RenderOptions {
  quickOperations?: QuickOperation[]
  targetableFromFace?: boolean
  addToOperationCandidates?: Operation[]
  removeFromOperationCandidates?: RemoveFromOperationCandidate[]
  /** The whole selection; the primary feature is the one that was clicked. */
  ids?: readonly string[]
  multipleSelection?: boolean
  actions?: FeatureTreeActions
}

function callRecordingActions(calls: string[]): FeatureTreeActions {
  const record = (name: string) => () => calls.push(name)
  return {
    switchFaceToEdit: noop,
    editCannedShape: (featureId) => calls.push(`editCannedShape:${featureId}`),
    expandCannedFeature: (featureId) => calls.push(`expandCannedFeature:${featureId}`),
    editSketch: record('editSketch'),
    constraint: record('constraint'),
    copyFeature: record('copyFeature'),
    makeUnique: record('makeUnique'),
    selectLinkedInstances: record('selectLinkedInstances'),
    moveFeature: record('moveFeature'),
    resizeFeature: record('resizeFeature'),
    rotateFeature: record('rotateFeature'),
    mirrorFeature: record('mirrorFeature'),
    offsetFeatures: record('offsetFeatures'),
    joinFeatures: record('joinFeatures'),
    cutFeatures: record('cutFeatures'),
    useAsStock: record('useAsStock'),
    deleteFeatures: record('deleteFeatures'),
    createQuickOperation: async () => {},
    addToOperation: record('addToOperation'),
    removeFromOperation: record('removeFromOperation'),
    groupFeatures: record('groupFeatures'),
    assignToFolder: record('assignToFolder'),
    createNewFolderAndAssign: record('createNewFolderAndAssign'),
    editTab: record('editTab'),
    copyTab: record('copyTab'),
    moveTab: record('moveTab'),
    deleteTab: record('deleteTab'),
    deleteTabs: record('deleteTabs'),
    editClamp: record('editClamp'),
    copyClamp: record('copyClamp'),
    moveClamp: record('moveClamp'),
    deleteClamp: record('deleteClamp'),
    deleteClamps: record('deleteClamps'),
    changeAuthoringFace: record('changeAuthoringFace'),
  }
}

/** Render the menu for one feature and return its host element. */
async function renderMenu(
  project: Project,
  featureId: string,
  options: RenderOptions = {},
): Promise<HTMLElement> {
  useProjectStore.setState({ project })
  const calls: string[] = []
  const actions = options.actions ?? callRecordingActions(calls)
  const feature = resolveFeatureInstance(project, featureId)
  assert(feature, `fixture feature ${featureId} resolves`)

  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(createElement(
    I18nProvider,
    null,
    createElement(FeatureContextMenu, {
      menuRef: { current: null },
      position: { left: 0, top: 0 },
      menuFeature: feature,
      menuTab: null,
      menuClamp: null,
      menuHasMultipleSelection: options.multipleSelection ?? false,
      menuCanUseAsStock: false,
      menuHasLockedSelection: false,
      menuFeatureHasLinkedInstances: false,
      menuQuickOperations: options.quickOperations ?? [],
      menuFeatureTargetableFromFace: options.targetableFromFace ?? false,
      quickOpsSubmenu: options.quickOperations && options.quickOperations.length > 0
        ? { top: 0, left: 0, side: 'right' }
        : null,
      menuFeatureFolders: [],
      menuAddToOperationCandidates: options.addToOperationCandidates ?? [],
      menuRemoveFromOperationCandidates: options.removeFromOperationCandidates ?? [],
      addToOperationSubmenu: null,
      removeFromOperationSubmenu: null,
      addToFolderSubmenu: null,
      menuSelectionInGroupedFolder: false,
      menuSelectionSectionsMixed: false,
      menuSelectionIsGroup: false,
      tabletShell: false,
      primaryId: featureId,
      ids: options.ids ?? [featureId],
      actions,
      onOpenQuickOpsSubmenu: noop,
      onCloseQuickOpsSubmenu: noop,
      onOpenAddToFolderSubmenu: noop,
      onCloseAddToFolderSubmenu: noop,
      onOpenAddToOperationSubmenu: noop,
      onCloseAddToOperationSubmenu: noop,
      onOpenRemoveFromOperationSubmenu: noop,
      onCloseRemoveFromOperationSubmenu: noop,
    }),
  )))
  return host
}

function menuButtons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button'))
}

/** The button whose label (its first line) starts with `label`. */
function buttonByLabel(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return menuButtons(host).find((button) => {
    const text = (button.querySelector('.feature-context-menu__item-label')
      ?? button.querySelector('.feature-context-menu__item-text > span:first-child')
      ?? button).textContent ?? ''
    return text.trim() === label
  })
}

function textOf(host: HTMLElement): string {
  return host.textContent ?? ''
}

// ── Fixtures ─────────────────────────────────────────────────────

const OUTLINE_KINDS = ['ellipse', 'slot', 'ngon', 'roundrect', 'chamferrect', 'gear', 'thread', 'flutes'] as const
/** The two model kinds: a mesh is the output, so there is nothing to expand. */
const MODEL_KINDS = ['turn', 'polygon'] as const

function cannedRow(kind: string): SketchFeature {
  const model = MODEL_KINDS.includes(kind as (typeof MODEL_KINDS)[number])
  return {
    id: `canned-${kind}`,
    name: kind,
    kind: model ? 'stl' : 'composite',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    // The menu only reads the kind and the label, so empty parameters are
    // enough: a generator refuses them and the stored frame wins.
    canned: { kind, params: {} },
    stl: null,
    operation: model ? 'model' : 'add',
    authoringFace: 'top',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  } as SketchFeature
}

function cannedProject(kind: string): Project {
  return projectWithFeatures(newProject('canned menu', 'mm'), [cannedRow(kind)])
}

/**
 * The rotary fixture on a square blank's Around face (the face these tests are
 * about), carrying `rows` alongside its own two features.
 */
function squareRotaryProjectWith(rows: SketchFeature[]): Project {
  const base = rotaryOperationFixture('x')
  // The fixture is born on a round bar; these tests' claims are about a square
  // blank's Around face, where only the rotary rows belong. Set it explicitly
  // so the fixture cannot silently assert round-stock behaviour (#1112 F2
  // review).
  base.stock = squareStock(12, 30, 'x')
  return projectWithFeatures(base, [...base.features, ...rows])
}

/** A canned Turn/Polygon authored on Top, as the rotary commands store them. */
function cannedModelRow(id: string, kind: string, name: string): SketchFeature {
  return {
    ...cannedRow(kind),
    id,
    name,
    kind: 'stl',
    operation: 'model',
    authoringFace: 'top',
    z_top: 10,
    z_bottom: 2,
  }
}

/** A rotary project whose around setup is active, on a square blank. */
function squareRotaryProject(): { project: Project; featureId: string } {
  const row = cannedModelRow('hex', 'polygon', 'Hex')
  return { project: squareRotaryProjectWith([row]), featureId: row.id }
}

/**
 * The same square blank with an Around-authored feature in the primary slot and
 * a Top-authored model beside it in the selection: the mixed-face selection
 * that used to get its bulk actions through (issue #1112 F2 review).
 */
function mixedFaceSelection(): { project: Project; primaryId: string } {
  const { project } = squareRotaryProject()
  assert(project.features.some((feature) => feature.id === 'sketch' && feature.authoringFace === 'around'),
    'the fixture carries an Around-authored feature')
  assert(project.features.some((feature) => feature.id === 'model' && feature.authoringFace === 'top'),
    'and a Top-authored one')
  return { project, primaryId: 'sketch' }
}

// ── Items 5 and 6: the generated shape's own two entries ─────────

async function testCannedMenuItems(): Promise<void> {
  // The reason is the short sentence the cap was built for (item 4).
  assert(
    enMessages['sketch.canned.actionRefused'] === 'Expand to features first',
    `a generated shape's refusal is the short one, got "${enMessages['sketch.canned.actionRefused']}"`,
  )
  const refusal = enMessages['sketch.canned.actionRefused']

  for (const kind of [...OUTLINE_KINDS, ...MODEL_KINDS]) {
    const project = cannedProject(kind)
    const featureId = `canned-${kind}`
    const host = await renderMenu(project, featureId)
    const shapeName = enMessages[`canned.${kind}.name` as keyof typeof enMessages]
    const editLabel = enMessages['featureTree.properties.canned.edit'].replace('{shape}', shapeName)

    const edit = buttonByLabel(host, editLabel)
    assert(edit, `${kind}: the menu offers "${editLabel}"`)
    const expand = buttonByLabel(host, enMessages['featureTree.properties.canned.expand'])
    if (OUTLINE_KINDS.includes(kind as (typeof OUTLINE_KINDS)[number])) {
      assert(expand, `${kind}: an outline kind can be expanded`)
    } else {
      assert(!expand, `${kind}: a model kind has nothing to expand into, so the entry is absent`)
      assert(edit, `${kind}: a model kind is still editable through its parameters`)
    }

    // The refusals a generated shape carries are the short reason.
    for (const label of [
      enMessages['featureTree.contextMenu.editSketch'],
      enMessages['featureTree.contextMenu.addConstraint'],
      enMessages['featureTree.contextMenu.offset'],
      enMessages['featureTree.contextMenu.join'],
      enMessages['featureTree.contextMenu.cut'],
    ]) {
      const button = buttonByLabel(host, label)
      assert(button, `${kind}: ${label} is present`)
      assert(button.hasAttribute('disabled'), `${kind}: ${label} is refused for a generated shape`)
      assert(
        textOf(button).includes(refusal),
        `${kind}: ${label} shows the short reason as text, got "${textOf(button)}"`,
      )
      assert(button.getAttribute('title') === refusal, `${kind}: ${label} keeps the same reason as its tooltip`)
    }
  }
}

async function testCannedEntriesAct(): Promise<void> {
  const project = cannedProject('ellipse')
  const featureId = 'canned-ellipse'
  const shapeName = enMessages['canned.ellipse.name']
  const editLabel = enMessages['featureTree.properties.canned.edit'].replace('{shape}', shapeName)

  // No opener is registered for the kind in this process yet: the entry is
  // refused with the reason Properties shows in the same state, never a
  // control that silently does nothing.
  const unregistered = await renderMenu(project, featureId)
  const refused = buttonByLabel(unregistered, editLabel)
  assert(refused, 'the shape editor entry renders even before an opener exists')
  assert(refused.hasAttribute('disabled'), 'it is refused while no opener is registered')
  assert(
    textOf(refused).includes(enMessages['featureTree.properties.canned.editUnavailable']),
    `it says why, got "${textOf(refused)}"`,
  )

  // With the opener the app registers at boot, it opens that same editor.
  const opened: string[] = []
  registerCannedShapeEditor('ellipse', (openedId) => opened.push(openedId))
  const calls: string[] = []
  const host = await renderMenu(project, featureId, { actions: callRecordingActions(calls) })
  const edit = buttonByLabel(host, editLabel)
  const expand = buttonByLabel(host, enMessages['featureTree.properties.canned.expand'])
  assert(edit && expand, 'both generated-shape entries render')
  assert(!edit.hasAttribute('disabled'), 'the entry is offered once an opener exists')
  edit.click()
  expand.click()
  assert(
    calls.includes(`editCannedShape:${featureId}`),
    `"Edit ${shapeName}…" asks the menu action to open the editor, got ${JSON.stringify(calls)}`,
  )
  assert(
    calls.includes(`expandCannedFeature:${featureId}`),
    `"Expand to features" expands the shape, got ${JSON.stringify(calls)}`,
  )
}

// ── Item 10: a feature authored on another face ─────────────────

const SWITCH_REASON = enMessages['featureTree.face.switchToTopToEdit']
// Move, Resize, Rotate and Mirror are deliberately absent: Move of a rotary
// canned selection is the bar edit `rotaryMove.ts` owns (offered on every
// face), and the three transforms are refused for the shape's own reason rather
// than the face's (issue #1112 rt7-f). Every other bulk edit still refuses with
// the face's.
const EDITABLE_LABELS = [
  'featureTree.contextMenu.editSketch',
  'featureTree.contextMenu.addConstraint',
  'featureTree.contextMenu.offset',
  'featureTree.contextMenu.join',
  'featureTree.contextMenu.cut',
  'featureTree.contextMenu.delete',
] as const

async function testOtherFaceMenuIsTheNormalOne(): Promise<void> {
  const { project, featureId } = squareRotaryProject()
  // The fixture really is a square blank: the Add menu lists the wrapped rows
  // refused by the stock, so "the rotary rows alone" below is the square-blank
  // rule at work rather than a round bar's list (#1112 F2 review).
  assert(isSquareStock(project.stock), 'the fixture is a square blank, as its comments claim')
  const addRows = operationAddEntries(
    project,
    singleFeatureSelection(featureId),
    machineMode(project),
    'around',
  )
  const wrappedRow = addRows.find((entry) => entry.kind === 'pocket')
  assert(wrappedRow, 'the Add menu lists a wrapped row on this face')
  assert(
    wrappedRow.blockedInPlace && wrappedRow.hint === camT('cam.addMenu.squareBarUnavailable'),
    `the square blank refuses the wrapped row, got ${JSON.stringify(wrappedRow)}`,
  )
  const quickOperations = validQuickOperationsForFeatureOnActiveFace(project, featureId)
  const operation = project.operations[0]
  assert(operation, 'the fixture has an operation to add the feature to')
  const host = await renderMenu(project, featureId, {
    quickOperations,
    targetableFromFace: true,
    addToOperationCandidates: [operation],
    removeFromOperationCandidates: [{ operation, canRemove: true }],
  })

  // The normal menu, not the old hint-only ghost menu: it carries Copy and the
  // switch as its first action.
  assert(
    buttonByLabel(host, enMessages['featureTree.contextMenu.copy']),
    'the other-face menu is the normal one (Copy is offered)',
  )

  // ...and so is Move: a Turn's or Hex's band moves along the bar, which is the
  // same edit on Top and on Around, so the face does not refuse it (rt7-f).
  const moveButton = buttonByLabel(host, enMessages['featureTree.contextMenu.move'])
  assert(moveButton, 'Move is offered for a rotary canned shape on Around')
  assert(!moveButton.hasAttribute('disabled'),
    `Move of a rotary canned shape runs on Around, got "${textOf(moveButton)}"`)
  assert(!textOf(moveButton).includes(SWITCH_REASON),
    `Move no longer refuses with "${SWITCH_REASON}", got "${textOf(moveButton)}"`)
  const switchButton = buttonByLabel(host, SWITCH_REASON)
  assert(switchButton, 'the way to the feature’s own face leads the menu')
  assert(!switchButton.hasAttribute('disabled'), 'the switch is available')

  // Create operation offers exactly what the Add menu offers on this face and
  // stock: on a square blank's Around face, the rotary rows alone.
  const submenu = host.querySelector('.feature-context-menu__submenu')
  assert(submenu, 'the Create-operation submenu is open for the fixture')
  const submenuLabels = Array.from(submenu.querySelectorAll('button'))
    .map((button) => (button.textContent ?? '').trim())
  const expected = quickOperations.map((quickOp) => quickOp.label)
  assert(
    JSON.stringify(submenuLabels) === JSON.stringify(expected),
    `Create operation lists the Add menu's rows, got ${JSON.stringify(submenuLabels)} for ${JSON.stringify(expected)}`,
  )
  assert(
    submenuLabels.length === 2 && submenuLabels[0] === enMessages['cam.opLabel.rotaryRough'],
    `a model on a square blank's Around face is cut by rotary operations, got ${JSON.stringify(submenuLabels)}`,
  )

  // Add to / Remove from operation and Copy keep working: the feature can be
  // cut from here, it just cannot be edited here.
  for (const key of ['featureTree.contextMenu.addToOperation', 'featureTree.contextMenu.removeFromOperation'] as const) {
    const button = buttonByLabel(host, enMessages[key])
    assert(button, `${enMessages[key]} is offered for another face's feature`)
    assert(!button.hasAttribute('disabled'), `${enMessages[key]} works from here`)
  }

  // Every entry that edits the feature's geometry is refused, and says why.
  for (const key of EDITABLE_LABELS) {
    const label = enMessages[key]
    const button = buttonByLabel(host, label)
    assert(button, `${label} is present in the other-face menu`)
    assert(button.hasAttribute('disabled'), `${label} cannot edit another face's feature`)
    assert(
      textOf(button).includes(SWITCH_REASON),
      `${label} says "${SWITCH_REASON}", got "${textOf(button)}"`,
    )
    assert(button.getAttribute('title') === SWITCH_REASON, `${label} carries the reason as its tooltip too`)
  }

  // The three transforms are refused for the shape's reason, not the face's:
  // a face switch would not make a generated shape resizable, and the editor
  // Resize names is offered right here (issue #1112 rt7-f).
  const polyName = enMessages['canned.polygon.name']
  const resizeReason = enMessages['featureTree.contextMenu.resizeCannedTooltip']
    .replace('{edit}', enMessages['featureTree.properties.canned.edit'].replace('{shape}', polyName))
  const resize = buttonByLabel(host, enMessages['featureTree.contextMenu.resize'])
  assert(resize, 'Resize is present for another face\'s rotary shape')
  assert(resize.hasAttribute('disabled'), 'Resize is refused for a rotary shape')
  assert(textOf(resize).includes(resizeReason), `Resize says "${resizeReason}", got "${textOf(resize)}"`)
  assert(resize.getAttribute('title') === resizeReason, 'Resize carries the editor reason as its tooltip')
  for (const key of ['featureTree.contextMenu.rotate', 'featureTree.contextMenu.mirror'] as const) {
    const button = buttonByLabel(host, enMessages[key])
    assert(button, `${enMessages[key]} is present for another face's rotary shape`)
    assert(button.hasAttribute('disabled'), `${enMessages[key]} is refused for a rotary shape`)
    assert(textOf(button).includes(enMessages['sketch.canned.actionRefused']),
      `${enMessages[key]} says "${enMessages['sketch.canned.actionRefused']}", got "${textOf(button)}"`)
    assert(button.getAttribute('title') === enMessages['sketch.canned.actionRefused'],
      `${enMessages[key]} carries the same reason as its tooltip`)
  }

  // The generated shape's own editor is the exception the face does not gate:
  // its parameters belong to no face, so Properties offers it from Around and
  // the menu must too (issue #1112 rt7-c).
  const cannedEdit = buttonByLabel(
    host,
    enMessages['featureTree.properties.canned.edit'].replace('{shape}', enMessages['canned.polygon.name']),
  )
  assert(cannedEdit, 'the generated shape\'s editor is offered on Around')
  assert(!cannedEdit.hasAttribute('disabled'), 'and enabled, exactly as Properties offers it')
  assert(
    !textOf(cannedEdit).includes(SWITCH_REASON),
    `it no longer refuses with "${SWITCH_REASON}", got "${textOf(cannedEdit)}"`,
  )
  assert(cannedEdit.getAttribute('title') === null, 'and carries no refusal tooltip')

  // "Change authoring face…" is a bulk edit of the selection: on Around it is
  // normally left out (#395), but a feature from another face needs its
  // refusal readable, so it stays disabled with the switch-face reason
  // (item 10, issue #1112 F2 review).
  const changeFace = buttonByLabel(host, enMessages['featureTree.face.changeAuthoringFace'])
  assert(changeFace, 'the face change is present on Around for another face\'s feature')
  assert(changeFace.hasAttribute('disabled'), 'and refused, because the feature belongs to its own face')
  assert(
    textOf(changeFace).includes(SWITCH_REASON),
    `the face change says "${SWITCH_REASON}", got "${textOf(changeFace)}"`,
  )
  assert(changeFace.getAttribute('title') === SWITCH_REASON, 'and carries the reason as its tooltip too')
}

/** The bulk actions all act on every selected feature. */
const BULK_EDIT_LABELS = [
  'featureTree.contextMenu.moveSelected',
  'featureTree.contextMenu.resize',
  'featureTree.contextMenu.rotate',
  'featureTree.contextMenu.mirror',
  'featureTree.contextMenu.offset',
  'featureTree.contextMenu.join',
  'featureTree.contextMenu.cut',
  'featureTree.contextMenu.deleteSelected',
] as const

async function testMixedFaceSelectionRefusesBulkEditing(): Promise<void> {
  const { project, primaryId } = mixedFaceSelection()
  const host = await renderMenu(project, primaryId, {
    ids: ['sketch', 'model'],
    multipleSelection: true,
  })

  // One selected feature on Top refuses every action that would edit it, even
  // though the right-clicked feature is on this face.
  for (const key of BULK_EDIT_LABELS) {
    const label = enMessages[key]
    const button = buttonByLabel(host, label)
    assert(button, `${label} is present in a mixed-face selection menu`)
    assert(button.hasAttribute('disabled'), `${label} is refused: one selected feature is on Top`)
    assert(
      textOf(button).includes(SWITCH_REASON),
      `${label} says "${SWITCH_REASON}", got "${textOf(button)}"`,
    )
    assert(button.getAttribute('title') === SWITCH_REASON, `${label} carries the reason as its tooltip too`)
  }

  // The primary is on this face, so editing *it* stays available: the rule is
  // about the bulk actions, not a blanket freeze of the menu.
  const editSketch = buttonByLabel(host, enMessages['featureTree.contextMenu.editSketch'])
  assert(editSketch, 'Edit sketch is present for the own-face primary')
  assert(!editSketch.hasAttribute('disabled'), 'the own-face primary can still be edited from here')

  const changeFace = buttonByLabel(host, enMessages['featureTree.face.changeAuthoringFace'])
  assert(changeFace, 'the face change stays visible with its reason on Around')
  assert(changeFace.hasAttribute('disabled'), 'and is refused for the mixed selection')
  assert(
    textOf(changeFace).includes(SWITCH_REASON),
    `the face change says "${SWITCH_REASON}", got "${textOf(changeFace)}"`,
  )
}

async function testOtherFaceWithoutAnOperationKeepsTheGhostMenu(): Promise<void> {
  const { project, featureId } = squareRotaryProject()
  const host = await renderMenu(project, featureId, { targetableFromFace: false })
  const switchButton = buttonByLabel(host, SWITCH_REASON)
  assert(
    switchButton,
    'a feature this face cannot cut still offers the way to its own face',
  )
  assert(
    !buttonByLabel(host, enMessages['featureTree.contextMenu.copy']),
    'and it does not pretend to be a normal menu',
  )
  assert(
    !buttonByLabel(host, enMessages['featureTree.contextMenu.editSketch']),
    'no sketch edit is offered for it',
  )

  // ...except the generated shape's parameter editor, which belongs to no face:
  // Properties offers it from here, so the ghost menu does too, above the way
  // to the feature's own face (issue #1112 rt7-c).
  const cannedEdit = buttonByLabel(
    host,
    enMessages['featureTree.properties.canned.edit'].replace('{shape}', enMessages['canned.polygon.name']),
  )
  assert(cannedEdit, 'the ghost menu offers the generated shape\'s editor')
  assert(!cannedEdit.hasAttribute('disabled'), 'enabled, exactly as Properties offers it from this face')
  assert(
    menuButtons(host).indexOf(cannedEdit) < menuButtons(host).indexOf(switchButton),
    'and it leads the menu, above the switch-face entry',
  )
}

// ── Issue #1112 rt7-c: "Edit {shape}…" follows Properties on every face ──

/**
 * Frank's report: on Around, a Turn's and a Polygon's "Edit …" entries were
 * greyed out in the menu while Properties offered them. Their parameters are
 * the one edit a face does not own, so the menu offers exactly what Properties
 * offers — enabled, and wired to the same action.
 */
async function testAroundMenuOffersTheCannedEditor(): Promise<void> {
  const project = squareRotaryProjectWith([
    cannedModelRow('turn', 'turn', 'Turn'),
    cannedModelRow('hex', 'polygon', 'Hex'),
  ])

  for (const [id, labelKey] of [
    ['turn', 'canned.turn.name'],
    ['hex', 'canned.polygon.name'],
  ] as const) {
    // An Around operation can cut the model, so this is the normal menu — the
    // one the entry was greyed out in.
    const targetable = validQuickOperationsForFeatureOnActiveFace(project, id).length > 0
    assert(targetable, `${id}: an Around operation can cut it, so this is the normal menu`)
    const calls: string[] = []
    const host = await renderMenu(project, id, {
      targetableFromFace: targetable,
      actions: callRecordingActions(calls),
    })

    const editLabel = enMessages['featureTree.properties.canned.edit']
      .replace('{shape}', enMessages[labelKey])
    const edit = buttonByLabel(host, editLabel)
    assert(edit, `${id}: "${editLabel}" is offered on Around, as Properties offers it`)
    assert(!edit.hasAttribute('disabled'), `${id}: "${editLabel}" is enabled on Around, as in Properties`)
    assert(
      !textOf(edit).includes(SWITCH_REASON),
      `${id}: "${editLabel}" does not refuse with the switch-face reason, got "${textOf(edit)}"`,
    )
    assert(edit.getAttribute('title') === null, `${id}: "${editLabel}" carries no refusal tooltip`)

    edit.click()
    assert(
      calls.includes(`editCannedShape:${id}`),
      `${id}: clicking "${editLabel}" opens the shape editor with that feature, got ${JSON.stringify(calls)}`,
    )
  }
}

/**
 * The other half of the shared rule: a kind whose opener is not registered is
 * refused in the menu with the same sentence Properties shows, in both menus,
 * and never with the face's reason.
 */
async function testCannedKindWithoutAnEditorIsRefusedForItsOwnReason(): Promise<void> {
  assert(
    getCannedShapeEditor('slot') === null,
    'no opener is registered for the slot in this process, which is the state Properties refuses in',
  )
  const project = squareRotaryProjectWith([{
    ...cannedRow('slot'),
    id: 'slot',
    name: 'Slot',
    operation: 'subtract',
    authoringFace: 'top',
  }])
  const editLabel = enMessages['featureTree.properties.canned.edit']
    .replace('{shape}', enMessages['canned.slot.name'])
  const refusal = enMessages['featureTree.properties.canned.editUnavailable']

  for (const targetableFromFace of [false, true]) {
    const menu = targetableFromFace ? 'normal' : 'ghost'
    const host = await renderMenu(project, 'slot', { targetableFromFace })
    const edit = buttonByLabel(host, editLabel)
    assert(edit, `"${editLabel}" renders in the ${menu} menu, as Properties renders it`)
    assert(edit.hasAttribute('disabled'), `"${editLabel}" is refused in the ${menu} menu, as in Properties`)
    assert(
      textOf(edit).includes(refusal),
      `"${editLabel}" says "${refusal}" in the ${menu} menu, got "${textOf(edit)}"`,
    )
    assert(edit.getAttribute('title') === refusal, `"${editLabel}" carries the same reason as its tooltip`)
    assert(
      !textOf(edit).includes(SWITCH_REASON),
      `"${editLabel}" is refused for its own reason, never the face's`,
    )
  }
}

/**
 * The rule the change must not widen: a plain feature from Top is still refused
 * its sketch edit on Around, with the switch-face reason, and offers no shape
 * editor at all.
 */
async function testOtherFaceSketchEditingIsUnchanged(): Promise<void> {
  const { project } = squareRotaryProject()
  // The fixture's plain model is cut from Around, so this is the normal menu.
  const host = await renderMenu(project, 'model', { targetableFromFace: true })

  const editSketch = buttonByLabel(host, enMessages['featureTree.contextMenu.editSketch'])
  assert(editSketch, 'Edit sketch is present for the other face\'s plain model')
  assert(editSketch.hasAttribute('disabled'), 'and still refused here')
  assert(
    textOf(editSketch).includes(SWITCH_REASON),
    `Edit sketch says "${SWITCH_REASON}", got "${textOf(editSketch)}"`,
  )
  assert(editSketch.getAttribute('title') === SWITCH_REASON, 'and carries the reason as its tooltip')

  assert(
    !buttonByLabel(host, enMessages['featureTree.properties.canned.edit'].replace('{shape}', enMessages['canned.ellipse.name'])),
    'a plain feature offers no generated-shape editor',
  )
}

// ── Issue #1112 rt7-f: Move on Around ──────────────────────

/**
 * Frank: "copy is allowed in top and Around, but move is only in Top for all
 * rotary features. we should allow move in the Around". A Move of a Turn,
 * Polygon, Thread or Flutes moves its band along the bar, which is the same
 * edit on both sheets, so the other-face gate no longer refuses it — and the
 * entry still starts the move, rather than being offered and inert.
 */
async function testRotaryCannedMoveIsOfferedOnAround(): Promise<void> {
  const rows = [
    cannedModelRow('turn', 'turn', 'Turn'),
    cannedModelRow('hex', 'polygon', 'Hex'),
    { ...cannedRow('thread'), id: 'thread', name: 'Thread', operation: 'subtract' as const, authoringFace: 'around' as const },
    { ...cannedRow('flutes'), id: 'flutes', name: 'Flutes', operation: 'subtract' as const, authoringFace: 'around' as const },
  ]
  const project = squareRotaryProjectWith(rows)

  for (const row of rows) {
    const calls: string[] = []
    // A Turn or Hex is authored on Top, so it must be cuttable from Around for
    // the normal menu to render at all; a Thread or Flutes is authored here.
    const targetable = (row.authoringFace ?? 'top') !== 'around'
      ? validQuickOperationsForFeatureOnActiveFace(project, row.id).length > 0
      : false
    assert((row.authoringFace ?? 'top') === 'around' || targetable,
      `${row.id}: an Around operation can cut it, so the normal menu renders`)
    const host = await renderMenu(project, row.id, {
      targetableFromFace: targetable,
      actions: callRecordingActions(calls),
    })

    const move = buttonByLabel(host, enMessages['featureTree.contextMenu.move'])
    assert(move, `${row.id}: Move is present on Around`)
    assert(!move.hasAttribute('disabled'), `${row.id}: Move is offered on Around, got "${textOf(move)}"`)
    assert(!textOf(move).includes(SWITCH_REASON),
      `${row.id}: Move does not refuse with the face's reason, got "${textOf(move)}"`)
    assert(move.getAttribute('title') === null, `${row.id}: Move carries no refusal tooltip`)

    move.click()
    assert(calls.includes('moveFeature'),
      `${row.id}: clicking Move starts the move, got ${JSON.stringify(calls)}`)
  }
}

// ── Issue #1112 rt7-f: Rotate, Resize and Mirror are refused ──

/** The face the app authors a rotary canned kind on. */
const KIND_FACE: Record<string, 'top' | 'around'> = {
  turn: 'top',
  polygon: 'top',
  thread: 'around',
  flutes: 'around',
}

/** The same project seen from `face`. */
function projectOnFace(project: Project, face: 'top' | 'around'): Project {
  const setup = project.setups.find((entry) => (entry.kind === 'around' ? 'around' : 'top') === face)
  assert(setup, `the fixture has a ${face} setup`)
  return { ...project, activeSetupId: setup!.id }
}

/**
 * Frank: "the rotate, resize, mirror should probably not be allowed in the
 * context menu (resize should point to the edit, others not allowed)". A
 * rotary shape's size lives in its parameters, so Resize names that editor and
 * Rotate/Mirror say what Offset and Join already say.
 */
async function testRotaryCannedTransformsAreRefused(): Promise<void> {
  const rows = [
    cannedModelRow('turn', 'turn', 'Turn'),
    cannedModelRow('hex', 'polygon', 'Hex'),
    { ...cannedRow('thread'), id: 'thread', name: 'Thread', operation: 'subtract' as const, authoringFace: 'around' as const },
    { ...cannedRow('flutes'), id: 'flutes', name: 'Flutes', operation: 'subtract' as const, authoringFace: 'around' as const },
  ]
  const aroundProject = squareRotaryProjectWith(rows)

  for (const row of rows) {
    const face = KIND_FACE[row.canned!.kind]
    const project = face === 'top' ? projectOnFace(aroundProject, 'top') : aroundProject
    const targetable = face === 'around'
      ? false
      : validQuickOperationsForFeatureOnActiveFace(project, row.id).length > 0
    const host = await renderMenu(project, row.id, { targetableFromFace: targetable })
    const shapeName = enMessages[`canned.${row.canned!.kind}.name` as keyof typeof enMessages]
    const editorReason = enMessages['featureTree.contextMenu.resizeCannedTooltip']
      .replace('{edit}', enMessages['featureTree.properties.canned.edit'].replace('{shape}', shapeName))

    const resize = buttonByLabel(host, enMessages['featureTree.contextMenu.resize'])
    assert(resize, `${row.id}: Resize is present`)
    assert(resize.hasAttribute('disabled'), `${row.id}: Resize is refused for a rotary shape`)
    assert(textOf(resize).includes(editorReason),
      `${row.id}: Resize says "${editorReason}", got "${textOf(resize)}"`)
    assert(resize.getAttribute('title') === editorReason,
      `${row.id}: Resize carries the editor reason as its tooltip`)

    for (const key of ['featureTree.contextMenu.rotate', 'featureTree.contextMenu.mirror'] as const) {
      const button = buttonByLabel(host, enMessages[key])
      assert(button, `${row.id}: ${enMessages[key]} is present`)
      assert(button.hasAttribute('disabled'), `${row.id}: ${enMessages[key]} is refused for a rotary shape`)
      assert(textOf(button).includes(enMessages['sketch.canned.actionRefused']),
        `${row.id}: ${enMessages[key]} says "${enMessages['sketch.canned.actionRefused']}", got "${textOf(button)}"`)
      assert(button.getAttribute('title') === enMessages['sketch.canned.actionRefused'],
        `${row.id}: ${enMessages[key]} carries the same reason as its tooltip`)
    }

    // The way out the reason names is still offered on this face.
    const edit = buttonByLabel(host, enMessages['featureTree.properties.canned.edit']
      .replace('{shape}', shapeName))
    assert(edit && !edit.hasAttribute('disabled'),
      `${row.id}: the editor the Resize reason names is offered, as Properties offers it`)
  }
}

/**
 * The rule the change must not widen: the other canned kinds keep today's
 * behaviour. An ellipse's outline is a plain profile, so the three transforms
 * are offered for it exactly as they were — on Top and on Around.
 */
async function testOtherCannedKindsKeepTheirTransforms(): Promise<void> {
  const ellipse = { ...cannedRow('ellipse'), authoringFace: 'top' as const }
  const plain: SketchFeature = {
    id: 'plain',
    name: 'Plain',
    kind: 'rect',
    folderId: null,
    sketch: cannedRow('ellipse').sketch,
    operation: 'subtract',
    authoringFace: 'top',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  const project = projectWithFeatures(newProject('canned transforms', 'mm'), [ellipse, plain])

  for (const id of ['canned-ellipse', 'plain']) {
    const host = await renderMenu(project, id)
    for (const key of [
      'featureTree.contextMenu.resize',
      'featureTree.contextMenu.rotate',
      'featureTree.contextMenu.mirror',
    ] as const) {
      const button = buttonByLabel(host, enMessages[key])
      assert(button, `${id}: ${enMessages[key]} is present`)
      assert(!button.hasAttribute('disabled'),
        `${id}: ${enMessages[key]} is offered, as before, got "${textOf(button)}"`)
    }
  }
}

async function main(): Promise<void> {
  await testCannedMenuItems()
  await testCannedEntriesAct()
  await testOtherFaceMenuIsTheNormalOne()
  await testMixedFaceSelectionRefusesBulkEditing()
  await testOtherFaceWithoutAnOperationKeepsTheGhostMenu()
  await testAroundMenuOffersTheCannedEditor()
  await testCannedKindWithoutAnEditorIsRefusedForItsOwnReason()
  await testOtherFaceSketchEditingIsUnchanged()
  await testRotaryCannedMoveIsOfferedOnAround()
  await testRotaryCannedTransformsAreRefused()
  await testOtherCannedKindsKeepTheirTransforms()
  console.log('feature context menu tests passed')
}

// The canvas panel registers these openers when it mounts; the menu only reads
// the registry, so the tests register the two shapes the Around case is about
// up front — exactly what `testCannedEntriesAct` does for the ellipse before it
// asserts on it (issue #1112 rt7-c).
registerCannedShapeEditor('turn', noop)
registerCannedShapeEditor('polygon', noop)
// The two kinds the rt7-f Resize reason names on the Around face, where the app
// registers them from the rotary pattern panel.
registerCannedShapeEditor('thread', noop)
registerCannedShapeEditor('flutes', noop)

await main()
