import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Last resort so a render-time crash shows something readable instead of a
 * blank page.
 *
 * This exists because of a real incident: Screen started calling useNavigate()
 * while being rendered outside Router context, which threw during render. React
 * unmounted the entire tree and the app became an empty dark rectangle with no
 * message anywhere -- indistinguishable from a network problem, and only
 * diagnosable from the dev server log. Anything that crashes the tree should at
 * least say so on screen.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('BetQuiz crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-full items-center justify-center px-4">
        <div className="w-full max-w-md rounded-3xl border border-ink-line bg-ink-soft/60 p-5">
          <h1 className="text-xl font-bold text-amber">Something broke</h1>
          <p className="mt-2 text-sm text-white/70">{this.state.error.message}</p>
          <button
            className="btn-primary mt-5"
            onClick={() => {
              // Full reload rather than clearing state: whatever crashed may
              // have left the room subscription in an unknown condition.
              window.location.hash = '#/'
              window.location.reload()
            }}
          >
            Back to start
          </button>
        </div>
      </div>
    )
  }
}
