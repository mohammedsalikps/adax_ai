import { ExternalLink, FileText, LoaderCircle, Printer, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Panel } from '../hero/Panel.tsx'
import { StatusPill } from '../hero/StatusPill.tsx'
import { useToast } from '../ui/Toast.tsx'
import { openInNewTab } from './PrintPreviewLink.tsx'
import { SECONDARY_CONTROL } from './RepeatMedicineMenu.tsx'

/** The prescription as a PDF, made by the server from the record (GET /api/encounters/:id/prescription.pdf; a draft is marked not signed). */
export const prescriptionPdfUrl = (encounterId: string) => `/api/encounters/${encounterId}/prescription.pdf`

/**
 * The PDF preview of the prescription page (jury design, screen 4): the real PDF the server makes from what is saved, shown in the page and
 * remade (after a short pause) whenever the saved record changes (`revision`). It is fetched and shown from a local copy (a blob), so the API's
 * "never frame" rule stays as it is. [Open PDF] opens the server's PDF in a new tab (what is pending is saved first); [Print] prints this copy
 * with the browser (or opens it to print when the browser cannot print it in place). Printing never signs or completes anything.
 */
export function PdfPreview({ encounterId, revision, signed, flush, className = '' }: { encounterId: string; revision: string; signed: boolean; flush?: () => Promise<unknown>; className?: string }) {
  const toast = useToast()
  const [url, setUrl] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    let cancelled = false
    let made: string | null = null
    // A short pause, so a burst of saves makes one PDF.
    const t = setTimeout(async () => {
      setState((s) => (s === 'ready' ? s : 'loading'))
      try {
        const res = await fetch(prescriptionPdfUrl(encounterId), { credentials: 'same-origin', cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        const blob = await res.blob()
        if (cancelled) return
        made = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old)
          return made
        })
        setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [encounterId, revision, attempt])
  // The last copy is let go with the page.
  const urlRef = useRef(url)
  urlRef.current = url
  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), [])

  const open = useCallback(async () => {
    if (flush) await flush().catch(() => undefined)
    openInNewTab(prescriptionPdfUrl(encounterId), 'The browser did not open the PDF in a new tab. Allow pop-ups for this site, or use Print.', toast)
  }, [encounterId, flush, toast])
  const print = () => {
    try {
      const w = frame.current?.contentWindow
      if (!w) throw new Error('no frame')
      w.focus()
      w.print()
    } catch {
      void open()
    }
  }
  return (
    <Panel
      label="Prescription preview"
      icon={FileText}
      testId="pdf-preview"
      className={className}
      actions={<StatusPill status={signed ? 'signed_to_complete' : 'draft'} label={signed ? 'Signed' : 'Draft — not signed'} />}
      bodyClassName="px-4 pb-4 xl:px-5"
    >
      <div className="relative overflow-hidden rounded-xl border border-line bg-canvas">
        {url && <iframe ref={frame} title="Prescription PDF" src={`${url}#toolbar=0&navpanes=0&view=FitH`} className="block h-[min(70vh,46rem)] w-full bg-white" data-testid="pdf-frame" />}
        {state === 'loading' && !url && (
          <p className="flex h-[min(70vh,46rem)] items-center justify-center gap-2 text-sm text-ink-muted" role="status">
            <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> Making the PDF…
          </p>
        )}
        {state === 'error' && (
          <div className={`flex flex-col items-center justify-center gap-2 p-6 text-center text-sm ${url ? 'absolute inset-x-0 bottom-0 bg-surface/95' : 'h-[min(70vh,46rem)]'}`} role="alert">
            <p className="text-ink-muted">The PDF could not be made just now.</p>
            <button type="button" className={SECONDARY_CONTROL} onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw aria-hidden="true" className="size-4" /> Try again
            </button>
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_CONTROL} onClick={() => void open()} data-testid="open-pdf">
          <ExternalLink aria-hidden="true" className="size-4" />
          Open PDF
          <span className="sr-only"> (opens in a new tab)</span>
        </button>
        <button type="button" className={SECONDARY_CONTROL} onClick={print} disabled={!url} data-testid="print-pdf">
          <Printer aria-hidden="true" className="size-4" />
          Print
        </button>
        <p className="ml-auto text-xs text-ink-muted">{signed ? 'The signed record, as stored.' : 'Shows what is saved. Marked as a draft until you sign.'}</p>
      </div>
    </Panel>
  )
}
