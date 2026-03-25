import { AIPanel } from './components/ai/AIPanel'
import { SketchCanvas } from './components/canvas/SketchCanvas'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { Toolbar } from './components/layout/Toolbar'
import { Viewport3D } from './components/viewport3d/Viewport3D'

function App() {
  return (
    <AppShell
      toolbar={<Toolbar />}
      aiPanel={<AIPanel />}
      sketchCanvas={<SketchCanvas />}
      viewport3d={<Viewport3D />}
      featureTree={<FeatureTree />}
      propertiesPanel={<PropertiesPanel />}
    />
  )
}

export default App
