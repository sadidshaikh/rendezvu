import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { PhoneOff, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
  onLeave: () => void
}

interface State {
  hasError: boolean
}

/**
 * A crash while drawing the call shows this instead of a blank page. Leave
 * runs the normal leave path, so the camera and mic still turn off.
 */
export class CallErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[call] render failed', error, info.componentStack)
  }

  private handleReset = () => this.setState({ hasError: false })

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
        <p className="text-sm font-medium text-foreground">Something went wrong in the call</p>
        <div className="flex gap-3">
          <button type="button" onClick={this.handleReset} className="ctrl-btn ctrl-btn-on gap-2 px-4 py-2 text-sm">
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </button>
          <button type="button" onClick={this.props.onLeave} className="ctrl-btn ctrl-btn-off gap-2 px-4 py-2 text-sm">
            <PhoneOff className="size-4" aria-hidden="true" />
            Leave call
          </button>
        </div>
      </div>
    )
  }
}
