import { useEffect, useMemo, useRef, useState } from 'react'
import { AIPanel } from './components/ai/AIPanel'
import { CAMPanel } from './components/cam/CAMPanel'
import { SketchCanvas, type SketchCanvasHandle } from './components/canvas/SketchCanvas'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { Toolbar } from './components/layout/Toolbar'
import { Viewport3D, type Viewport3DHandle } from './components/viewport3d/Viewport3D'
import { useProjectStore } from './store/projectStore'

interface FeatureContextMenuState {
  featureIds: string[]
  primaryFeatureId: string
  x: number
  y: number
}

function App() {
  const [centerTab, setCenterTab] = useState<'sketch' | 'preview3d'>('sketch')
  const [featureContextMenu, setFeatureContextMenu] = useState<FeatureContextMenuState | null>(null)
  const sketchCanvasRef = useRef<SketchCanvasHandle>(null)
  const viewport3dRef = useRef<Viewport3DHandle>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { project, selectFeature, enterSketchEdit, deleteFeatures, startMoveFeature, startCopyFeature } = useProjectStore()

  const menuFeature = useMemo(
    () =>
      featureContextMenu
        ? project.features.find((feature) => feature.id === featureContextMenu.primaryFeatureId) ?? null
        : null,
    [featureContextMenu, project.features]
  )

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target?.isContentEditable
      ) {
        return
      }

      const isPrimaryModifier = event.metaKey || event.ctrlKey
      if (!isPrimaryModifier) {
        return
      }

      if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault()
        useProjectStore.getState().undo()
        return
      }

      if (
        (event.key.toLowerCase() === 'z' && event.shiftKey)
        || (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'y')
      ) {
        event.preventDefault()
        useProjectStore.getState().redo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (!featureContextMenu) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null
      if (menuRef.current?.contains(target)) {
        return
      }
      setFeatureContextMenu(null)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setFeatureContextMenu(null)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [featureContextMenu])

  function handleZoomToModel() {
    if (centerTab === 'preview3d') {
      viewport3dRef.current?.zoomToModel()
      return
    }

    sketchCanvasRef.current?.zoomToModel()
  }

  function openFeatureContextMenu(featureId: string, x: number, y: number) {
    const nextSelection = useProjectStore.getState().selection
    const featureIds = nextSelection.selectedFeatureIds.includes(featureId)
      ? nextSelection.selectedFeatureIds
      : [featureId]
    setFeatureContextMenu({ featureIds, primaryFeatureId: featureId, x, y })
  }

  function closeFeatureContextMenu() {
    setFeatureContextMenu(null)
  }

  function handleEditSketch(featureId: string) {
    selectFeature(featureId)
    enterSketchEdit(featureId)
    setCenterTab('sketch')
    closeFeatureContextMenu()
  }

  function handleDeleteFeatures(featureIds: string[]) {
    deleteFeatures(featureIds)
    closeFeatureContextMenu()
  }

  function handleMoveFeature(featureId: string) {
    startMoveFeature(featureId)
    setCenterTab('sketch')
    closeFeatureContextMenu()
  }

  function handleCopyFeature(featureId: string) {
    startCopyFeature(featureId)
    setCenterTab('sketch')
    closeFeatureContextMenu()
  }

  const menuPosition = featureContextMenu
    ? {
        left: Math.min(featureContextMenu.x, window.innerWidth - 188),
        top: Math.min(featureContextMenu.y, window.innerHeight - 180),
      }
    : null

  const menuHasMultipleSelection = (featureContextMenu?.featureIds.length ?? 0) > 1
  const menuHasLockedSelection =
    featureContextMenu?.featureIds.some((featureId) =>
      project.features.some((feature) => feature.id === featureId && feature.locked)
    ) ?? false

  return (
    <>
      <AppShell
        toolbar={<Toolbar onZoomToModel={handleZoomToModel} />}
        aiPanel={<AIPanel />}
        sketchCanvas={<SketchCanvas ref={sketchCanvasRef} onFeatureContextMenu={openFeatureContextMenu} />}
        viewport3d={<Viewport3D ref={viewport3dRef} />}
        featureTree={<FeatureTree onFeatureContextMenu={openFeatureContextMenu} />}
        propertiesPanel={<PropertiesPanel />}
        operationsPanel={<CAMPanel />}
        centerTab={centerTab}
        onCenterTabChange={setCenterTab}
      />
      {featureContextMenu && menuFeature && menuPosition ? (
        <div
          ref={menuRef}
          className="feature-context-menu"
          style={menuPosition}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => handleEditSketch(menuFeature.id)}
            disabled={menuHasMultipleSelection}
            title={menuHasMultipleSelection ? 'Edit Sketch is only available for a single selected feature' : undefined}
          >
            Edit Sketch
          </button>
          <button className="feature-context-menu__item" type="button" onClick={() => handleCopyFeature(menuFeature.id)}>
            {menuHasMultipleSelection ? 'Copy Selected' : 'Copy'}
          </button>
          <button
            className="feature-context-menu__item"
            type="button"
            onClick={() => handleMoveFeature(menuFeature.id)}
            disabled={menuHasLockedSelection}
            title={menuHasLockedSelection ? 'Locked features cannot be moved as part of a selection' : undefined}
          >
            {menuHasMultipleSelection ? 'Move Selected' : 'Move'}
          </button>
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => handleDeleteFeatures(featureContextMenu.featureIds)}
          >
            {menuHasMultipleSelection ? 'Delete Selected' : 'Delete'}
          </button>
        </div>
      ) : null}
    </>
  )
}

export default App
