import { useQueryClient } from '@tanstack/react-query'
import { MessageSquarePlus, Sparkles, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { manaConversationKey, useManaConversation, useNewManaConversation } from '../../lib/manaAssistant.ts'
import { manaScopeForPath, scopeKey } from '../../lib/manaGlobal.ts'
import { onCloseMana, onOpenMana } from '../../lib/manaLauncher.ts'
import { readSpeakAnswers, writeSpeakAnswers } from '../../lib/manaSpeech.ts'
import { Sheet } from '../hero/Sheet.tsx'
import { Menu } from '../ui/Menu.tsx'
import { ManaAssistant } from './ManaAssistant.tsx'

/**
 * The global Mana (DESIGN §5.8): a floating round button bottom-right on every doctor page (above any BottomBar: `--action-bar-h`; hidden in
 * print) that opens a right Sheet holding ManaAssistant (`data-testid="mana-assistant"`), scoped by the route (consultation or its prescription
 * → that consultation, patient page → that patient, elsewhere → the clinic). Nothing is requested from `/api/mana-assistant` until it is opened,
 * and what it loaded (patients' names) is dropped when it closes. Other pages open it through lib/manaLauncher (openMana({ask}) opens it and
 * asks); approved prescription actions reach the draft through lib/draftBridge. The header menu starts a new conversation and turns reading
 * answers aloud on or off (off by default; only a voice on this computer reads).
 *
 * Mounted by AppShell for the doctor role only (Mana needs `ai:use`, which only doctors have).
 */
export function GlobalMana() {
  const { pathname } = useLocation()
  const scope = manaScopeForPath(pathname)
  const key = scopeKey(scope)
  const [open, setOpen] = useState(false)
  const [ask, setAsk] = useState<string | null>(null)
  const [speak, setSpeak] = useState(readSpeakAnswers)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const qc = useQueryClient()
  // Never fetches here (disabled): it only reads the conversation the sheet opened, for the header ("About <patient>").
  const conv = useManaConversation(scope, false)
  const fresh = useNewManaConversation(scope)

  useEffect(
    () =>
      onOpenMana(({ ask: question }) => {
        setOpen(true)
        if (question) setAsk(question)
      }),
    [],
  )
  useEffect(() => onCloseMana(() => setOpen(false)), [])
  // Following a link out of Mana (a source's record) shows that page: Mana closes.
  const shownPath = useRef(pathname)
  useEffect(() => {
    if (shownPath.current === pathname) return
    shownPath.current = pathname
    setOpen(false)
    setAsk(null)
  }, [pathname])
  // Closed: what it loaded (the conversation, with the names of patients) is not kept; it is read again from the server when opened.
  useEffect(() => {
    if (!open) qc.removeQueries({ queryKey: manaConversationKey(scope) })
  }, [open, key])

  const sp = conv.data?.scopePatient
  const subtitle = sp ? `About ${sp.displayName} · MRN ${sp.mrn}` : conv.data ? 'Your clinic' : undefined

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="mana-launcher"
        style={{ bottom: 'calc(var(--action-bar-h, 0px) + 1rem)' }}
        className="fixed right-4 z-20 inline-flex h-14 min-w-14 items-center justify-center gap-2 rounded-full border border-brand bg-brand px-4 text-base font-semibold text-white shadow-pop hover:bg-brand-strong motion-safe:transition-colors motion-safe:duration-150 print:hidden sm:px-5"
      >
        <Sparkles aria-hidden="true" className="size-5 shrink-0" />
        <span className="sr-only sm:not-sr-only">Mana</span>
      </button>
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false)
          setAsk(null)
        }}
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-5 text-ai" />
            Mana
          </span>
        }
        subtitle={subtitle}
        actions={
          <Menu
            label="Mana options"
            items={[
              { label: 'New conversation', icon: <MessageSquarePlus aria-hidden="true" className="size-4" />, disabled: !conv.data || fresh.isPending, onSelect: () => fresh.mutate() },
              {
                label: speak ? 'Speak answers: on' : 'Speak answers: off',
                name: 'Speak answers',
                icon: speak ? <Volume2 aria-hidden="true" className="size-4" /> : <VolumeX aria-hidden="true" className="size-4" />,
                onSelect: () => {
                  writeSpeakAnswers(!speak)
                  setSpeak(!speak)
                },
              },
            ]}
          />
        }
        width="narrow"
        bodyClassName="flex flex-col"
        initialFocus={inputRef}
        closeLabel="Close Mana"
        testId="mana-sheet"
      >
        <ManaAssistant key={key} variant="sheet" {...scope} inputRef={inputRef} pendingAsk={ask} onAsked={() => setAsk(null)} speakAnswers={speak} />
      </Sheet>
    </>
  )
}
