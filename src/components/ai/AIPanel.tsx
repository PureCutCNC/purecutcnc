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
