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
 *    menu (`menuFeatureTargetableFromFace` is the switch).
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
 *    fail.
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
const { validQuickOperationsForFeatureOnActiveFace } = await import('../cam/operationAddEntries')
const { registerCannedShapeEditor } = await import('../../cannedShapes')

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
      menuHasMultipleSelection: false,
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
      ids: [featureId],
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

/** A rotary project whose around setup is active, on a square blank. */
function squareRotaryProject(): { project: Project; featureId: string } {
  const base = rotaryOperationFixture('x')
  const row: SketchFeature = {
    ...cannedRow('polygon'),
    id: 'hex',
    name: 'Hex',
    kind: 'stl',
    operation: 'model',
    authoringFace: 'top',
    z_top: 10,
    z_bottom: 2,
  }
  const project = projectWithFeatures(base, [...base.features, row])
  return { project, featureId: row.id }
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
const EDITABLE_LABELS = [
  'featureTree.contextMenu.editSketch',
  'featureTree.contextMenu.addConstraint',
  'featureTree.contextMenu.move',
  'featureTree.contextMenu.resize',
  'featureTree.contextMenu.rotate',
  'featureTree.contextMenu.mirror',
  'featureTree.contextMenu.offset',
  'featureTree.contextMenu.join',
  'featureTree.contextMenu.cut',
  'featureTree.contextMenu.delete',
] as const

async function testOtherFaceMenuIsTheNormalOne(): Promise<void> {
  const { project, featureId } = squareRotaryProject()
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

  // Every editable item is refused, and says why.
  const editableLabels = [
    ...EDITABLE_LABELS,
    'featureTree.properties.canned.edit',
  ]
  for (const key of editableLabels) {
    const message = enMessages[key as keyof typeof enMessages]
    const label = key === 'featureTree.properties.canned.edit'
      ? message.replace('{shape}', enMessages['canned.polygon.name'])
      : message
    const button = buttonByLabel(host, label)
    assert(button, `${label} is present in the other-face menu`)
    assert(button.hasAttribute('disabled'), `${label} cannot edit another face's feature`)
    assert(
      textOf(button).includes(SWITCH_REASON),
      `${label} says "${SWITCH_REASON}", got "${textOf(button)}"`,
    )
    assert(button.getAttribute('title') === SWITCH_REASON, `${label} carries the reason as its tooltip too`)
  }
}

async function testOtherFaceWithoutAnOperationKeepsTheGhostMenu(): Promise<void> {
  const { project, featureId } = squareRotaryProject()
  const host = await renderMenu(project, featureId, { targetableFromFace: false })
  assert(
    buttonByLabel(host, SWITCH_REASON),
    'a feature this face cannot cut still offers the way to its own face',
  )
  assert(
    !buttonByLabel(host, enMessages['featureTree.contextMenu.copy']),
    'and it does not pretend to be a normal menu',
  )
  assert(
    !buttonByLabel(host, enMessages['featureTree.contextMenu.editSketch']),
    'no editable item is offered for it',
  )
}

async function main(): Promise<void> {
  await testCannedMenuItems()
  await testCannedEntriesAct()
  await testOtherFaceMenuIsTheNormalOne()
  await testOtherFaceWithoutAnOperationKeepsTheGhostMenu()
  console.log('feature context menu tests passed')
}

await main()
