import { useEffect, useRef, useState } from 'react'
import { AIPanel } from './components/ai/AIPanel'
import { SketchCanvas, type SketchCanvasHandle } from './components/canvas/SketchCanvas'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { Toolbar } from './components/layout/Toolbar'
import { Viewport3D, type Viewport3DHandle } from './components/viewport3d/Viewport3D'
import { useProjectStore } from './store/projectStore'

function App() {
  const [centerTab, setCenterTab] = useState<'sketch' | 'preview3d'>('sketch')
  const sketchCanvasRef = useRef<SketchCanvasHandle>(null)
  const viewport3dRef = useRef<Viewport3DHandle>(null)

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

  function handleZoomToModel() {
    if (centerTab === 'preview3d') {
      viewport3dRef.current?.zoomToModel()
      return
    }

    sketchCanvasRef.current?.zoomToModel()
  }

  return (
    <AppShell
      toolbar={<Toolbar onZoomToModel={handleZoomToModel} />}
      aiPanel={<AIPanel />}
      sketchCanvas={<SketchCanvas ref={sketchCanvasRef} />}
      viewport3d={<Viewport3D ref={viewport3dRef} />}
      featureTree={<FeatureTree />}
      propertiesPanel={<PropertiesPanel />}
      centerTab={centerTab}
      onCenterTabChange={setCenterTab}
    />
  )
}

export default App
