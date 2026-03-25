// AI panel is a placeholder for the POC.
// Full MCP tool call integration comes in Phase 1 post-POC.

export function AIPanel() {
  return (
    <div className="ai-panel">
      <div className="ai-placeholder">
        <div className="ai-placeholder-icon" aria-hidden="true">AI</div>
        <p>AI Assistant</p>
        <p className="ai-placeholder-sub">
          Coming in Phase 1 — will support Claude, OpenAI, and local models
          via MCP tool calls.
        </p>
        <div className="ai-placeholder-hint">
          For now, use the toolbar to add features and the feature tree to manage them.
        </div>
      </div>
    </div>
  )
}
