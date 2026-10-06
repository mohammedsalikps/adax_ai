import { Component, type ContextType, createContext, createRef, type ReactNode } from 'react'
import { Button } from './Button.tsx'
import { Alert } from './Feedback.tsx'

/**
 * Told when a panel inside fails to draw, whichever boundary caught it. An area that holds panels (a consultation module, whose full
 * panel may sit behind "Show") provides it, so that a panel's own boundary deep inside still lets the area open itself and show the failure.
 */
export const PanelFaultContext = createContext<(() => void) | null>(null)

/**
 * Keeps a fault in one part of a page inside that part. Without it, an error while drawing any panel beside the consultation note (the
 * transcript, the AI draft, Mana, the devices) would replace the whole page, the note being written included, with an error page. With it
 * that panel says it could not be shown and offers to try again; the note and the other panels keep working. Nothing about the error (it
 * may hold patient data) is shown on the screen or sent anywhere; the browser's console keeps React's own report of it, as for any error.
 * After "Try again" focus goes to the part that was drawn again, not back to the top of the page.
 *
 * `onFault` (and the PanelFaultContext around it) is called once each time the boundary catches, with nothing about the error. `neutral`
 * says only that the rest of the page works, for a panel where "nothing in the consultation note was lost" is not the point (a result, a
 * summary, the prescription's side lane).
 */
export class PanelBoundary extends Component<{ label: string; className?: string; neutral?: boolean; onFault?: () => void; children: ReactNode }, { failed: boolean }> {
  static override contextType = PanelFaultContext
  declare context: ContextType<typeof PanelFaultContext>
  override state = { failed: false }
  private box = createRef<HTMLDivElement>()
  private retried = false
  private reported = false

  static getDerivedStateFromError() {
    return { failed: true }
  }

  // Commit phase, so the callers may change state; the error itself is not passed on.
  override componentDidCatch() {
    if (this.reported) return
    this.reported = true
    this.props.onFault?.()
    this.context?.()
  }

  override componentDidUpdate() {
    if (!this.retried || this.state.failed) return
    this.retried = false
    this.box.current?.focus()
  }

  override render() {
    return (
      <div ref={this.box} tabIndex={-1} className={`focus:outline-none ${this.props.className ?? 'space-y-6'}`}>
        {this.state.failed ? (
          <Alert tone="error" title={`${this.props.label} could not be shown`}>
            <p>{this.props.neutral ? 'The rest of the page still works.' : 'Nothing in the consultation note was lost, and the rest of the page works.'}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                this.retried = true
                this.reported = false
                this.setState({ failed: false })
              }}
            >
              Try again
            </Button>
          </Alert>
        ) : (
          this.props.children
        )}
      </div>
    )
  }
}
