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

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { ErrorScreen } from './ErrorScreen'

interface State {
  error: unknown
  info: string | null
}

interface Props {
  children: ReactNode
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error, info: null }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ error, info: info.componentStack ?? null })
    console.error('App crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return <ErrorScreen error={this.state.error} info={this.state.info ?? undefined} />
    }
    return this.props.children
  }
}
