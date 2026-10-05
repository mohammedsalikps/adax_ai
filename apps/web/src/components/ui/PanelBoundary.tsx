import { Component, createRef, type ReactNode } from 'react'
import { Button } from './Button.tsx'
import { Alert } from './Feedback.tsx'

/**
 * Keeps a fault in one part of a page inside that part. Without it, an error while drawing any panel beside the consultation note (the
 * transcript, the AI draft, Mana, the devices) would replace the whole page, the note being written included, with an error page. With it
 * that panel says it could not be shown and offers to try again; the note and the other panels keep working. Nothing about the error (it
 * may hold patient data) is shown on the screen or sent anywhere; the browser's console keeps React's own report of it, as for any error.
 * After "Try again" focus goes to the part that was drawn again, not back to the top of the page.
 */
export class PanelBoundary extends Component<{ label: string; className?: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  private box = createRef<HTMLDivElement>()
  private retried = false

  static getDerivedStateFromError() {
    return { failed: true }
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
            <p>Nothing in the consultation note was lost, and the rest of the page works.</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                this.retried = true
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
