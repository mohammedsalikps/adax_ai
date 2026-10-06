import { Eye, LoaderCircle, Printer } from 'lucide-react'
import { type MouseEvent, useState } from 'react'
import { Link } from 'react-router'
import type { SaveState } from '../../lib/draftSaver.ts'
import { useToast } from '../ui/Toast.tsx'
import { printUrl } from './CompleteConsultation.tsx'
import { SECONDARY_CONTROL } from './RepeatMedicineMenu.tsx'

/** Opens a page in a new tab without giving it this window (a browser that blocks it is told so, with the way round it). */
export function openInNewTab(url: string, blocked: string, toast: ReturnType<typeof useToast>): boolean {
  const tab = window.open(url, '_blank')
  if (tab) tab.opener = null
  else toast('warning', blocked)
  return !!tab
}

/**
 * Preview of the printed prescription: the click saves what is pending first (`flushState`, the draft's save chain), then opens the print page
 * in a new tab, so the consultation goes on here; that page shows what the server holds, marked there as a draft that is not a valid
 * prescription. A click with a modifier (a new tab or window, chosen by the doctor) is left to the browser. data-testid "print-preview".
 */
export function PrintPreviewLink({ encounterId, flushState, label = 'Preview' }: { encounterId: string; flushState: () => Promise<SaveState>; label?: string }) {
  const toast = useToast()
  const [opening, setOpening] = useState(false)
  const url = printUrl(encounterId)
  const preview = async (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    if (opening) return
    setOpening(true)
    let saved: SaveState
    try {
      saved = await flushState()
    } catch {
      saved = 'error'
    } finally {
      setOpening(false)
    }
    openInNewTab(url, `The browser did not open the preview in a new tab. Use ${label} again, or allow pop-ups for this site.`, toast)
    if (saved === 'error' || saved === 'conflict' || saved === 'blocked') toast('warning', 'Your latest changes could not be saved: the preview shows what was saved before them.')
  }
  const Icon = label === 'Preview' ? Eye : Printer
  return (
    <Link to={url} target="_blank" rel="noopener" onClick={(e) => void preview(e)} aria-busy={opening || undefined} className={SECONDARY_CONTROL} data-testid="print-preview">
      {opening ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Icon aria-hidden="true" className="size-4" />}
      {label}
      <span className="sr-only"> the prescription (saves first, then opens in a new tab)</span>
    </Link>
  )
}
