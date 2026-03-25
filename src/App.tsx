import { useRef, useState } from 'react'
import { AIPanel } from './components/ai/AIPanel'
import { SketchCanvas, type SketchCanvasHandle } from './components/canvas/SketchCanvas'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { Toolbar } from './components/layout/Toolbar'
import { Viewport3D, type Viewport3DHandle } from './components/viewport3d/Viewport3D'

function App() {
  const [centerTab, setCenterTab] = useState<'sketch' | 'preview3d'>('sketch')
  const sketchCanvasRef = useRef<SketchCanvasHandle>(null)
  const viewport3dRef = useRef<Viewport3DHandle>(null)

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
