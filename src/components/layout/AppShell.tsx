import { useState } from 'react'
import type { ReactNode } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { getStockBounds } from '../../types/project'
import { formatLength } from '../../utils/units'
import '../../styles/layout.css'

interface AppShellProps {
  toolbar: ReactNode
  sketchCanvas: ReactNode
  featureTree: ReactNode
  propertiesPanel: ReactNode
  viewport3d: ReactNode
  aiPanel: ReactNode
  operationsPanel?: ReactNode
  centerTab: 'sketch' | 'preview3d'
  onCenterTabChange: (tab: 'sketch' | 'preview3d') => void
}

export function AppShell({
  toolbar,
  sketchCanvas,
  featureTree,
  propertiesPanel,
  viewport3d,
  aiPanel,
  operationsPanel,
  centerTab,
  onCenterTabChange,
}: AppShellProps) {
  const { project } = useProjectStore()
  const [rightTab, setRightTab] = useState<'operations' | 'ai'>('operations')
  const stockBounds = getStockBounds(project.stock)
  const stockWidth = stockBounds.maxX - stockBounds.minX
  const stockHeight = stockBounds.maxY - stockBounds.minY

  return (
    <div className="app-shell">
      {/* ── Top toolbar ── */}
      <header className="app-toolbar">
        {toolbar}
      </header>

      {/* Main work area */}
      <div className="app-body">
        <aside className="panel-left">
          <section className="panel panel-tree">
            <div className="panel-header">
              Feature Tree
              <span className="feature-count">
                {project.features.length + 2}
              </span>
            </div>
            <div className="panel-content">{featureTree}</div>
          </section>
          <section className="panel panel-properties">
            <div className="panel-header">Properties</div>
            <div className="panel-content">{propertiesPanel}</div>
          </section>
        </aside>

        <main className="panel-centre">
          <div className="panel centre-workspace">
            <div className="panel-tabs-header">
              <button
                className={`panel-tab ${centerTab === 'sketch' ? 'panel-tab--active' : ''}`}
                onClick={() => onCenterTabChange('sketch')}
                type="button"
              >
                Sketch
              </button>
              <button
                className={`panel-tab ${centerTab === 'preview3d' ? 'panel-tab--active' : ''}`}
                onClick={() => onCenterTabChange('preview3d')}
                type="button"
              >
                3D View
              </button>
            </div>
            <div className="centre-stage">
              <div
                className={`centre-view ${centerTab === 'sketch' ? 'centre-view--active' : ''}`}
                aria-hidden={centerTab !== 'sketch'}
              >
                {sketchCanvas}
              </div>
              <div
                className={`centre-view ${centerTab === 'preview3d' ? 'centre-view--active' : ''}`}
                aria-hidden={centerTab !== 'preview3d'}
              >
                {viewport3d}
              </div>
            </div>
          </div>
        </main>

        <aside className="panel-right">
          <section className="panel panel-tabs">
            <div className="panel-tabs-header">
              <button
                className={`panel-tab ${rightTab === 'operations' ? 'panel-tab--active' : ''}`}
                onClick={() => setRightTab('operations')}
                type="button"
              >
                Operations
              </button>
              <button
                className={`panel-tab ${rightTab === 'ai' ? 'panel-tab--active' : ''}`}
                onClick={() => setRightTab('ai')}
                type="button"
              >
                AI Chat
              </button>
            </div>
            <div className="panel-content">
              {rightTab === 'operations' ? (
                operationsPanel ?? (
                  <div className="panel-empty">
                    CAM operations and toolpaths are scheduled for Phase 4.
                  </div>
                )
              ) : (
                aiPanel
              )}
            </div>
          </section>
        </aside>

      </div>

      <footer className="app-statusbar">
        <span>{project.meta.name}</span>
        <span>{project.meta.units.toUpperCase()}</span>
        <span>
          Stock: {formatLength(stockWidth, project.meta.units)} × {formatLength(stockHeight, project.meta.units)} × {formatLength(project.stock.thickness, project.meta.units)} {project.meta.units}
        </span>
        <span>{project.grid.visible ? 'Grid Visible' : 'Grid Hidden'}</span>
        <span>{project.stock.visible ? 'Stock Visible' : 'Stock Hidden'}</span>
      </footer>
    </div>
  )
}
