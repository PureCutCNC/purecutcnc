import { useEffect, useMemo, useRef, useState } from 'react'
import { AIPanel } from './components/ai/AIPanel'
import { SketchCanvas, type SketchCanvasHandle } from './components/canvas/SketchCanvas'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { Toolbar } from './components/layout/Toolbar'
import { Viewport3D, type Viewport3DHandle } from './components/viewport3d/Viewport3D'
import { useProjectStore } from './store/projectStore'

interface FeatureContextMenuState {
  featureId: string
  x: number
  y: number
}

function App() {
  const [centerTab, setCenterTab] = useState<'sketch' | 'preview3d'>('sketch')
  const [featureContextMenu, setFeatureContextMenu] = useState<FeatureContextMenuState | null>(null)
  const sketchCanvasRef = useRef<SketchCanvasHandle>(null)
  const viewport3dRef = useRef<Viewport3DHandle>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { project, selectFeature, enterSketchEdit, deleteFeature } = useProjectStore()

  const menuFeature = useMemo(
    () =>
      featureContextMenu
        ? project.features.find((feature) => feature.id === featureContextMenu.featureId) ?? null
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
    selectFeature(featureId)
    setFeatureContextMenu({ featureId, x, y })
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

  function handleDeleteFeature(featureId: string) {
    deleteFeature(featureId)
    closeFeatureContextMenu()
  }

  const menuPosition = featureContextMenu
    ? {
        left: Math.min(featureContextMenu.x, window.innerWidth - 188),
        top: Math.min(featureContextMenu.y, window.innerHeight - 180),
      }
    : null

  return (
    <>
      <AppShell
        toolbar={<Toolbar onZoomToModel={handleZoomToModel} />}
        aiPanel={<AIPanel />}
        sketchCanvas={<SketchCanvas ref={sketchCanvasRef} onFeatureContextMenu={openFeatureContextMenu} />}
        viewport3d={<Viewport3D ref={viewport3dRef} />}
        featureTree={<FeatureTree onFeatureContextMenu={openFeatureContextMenu} />}
        propertiesPanel={<PropertiesPanel />}
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
          <button className="feature-context-menu__item" type="button" onClick={() => handleEditSketch(menuFeature.id)}>
            Edit Sketch
          </button>
          <button className="feature-context-menu__item" type="button" disabled title="Copy is not implemented yet">
            Copy
          </button>
          <button className="feature-context-menu__item" type="button" disabled title="Move is not implemented yet">
            Move
          </button>
          <button
            className="feature-context-menu__item feature-context-menu__item--danger"
            type="button"
            onClick={() => handleDeleteFeature(menuFeature.id)}
          >
            Delete
          </button>
        </div>
      ) : null}
    </>
  )
}

export default App
