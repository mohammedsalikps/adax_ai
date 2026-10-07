import { useQueryClient } from '@tanstack/react-query'
import { AudioLines, MessageSquarePlus, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation } from 'react-router'
import { manaConversationKey, useManaConversation, useNewManaConversation } from '../../lib/manaAssistant.ts'
import { manaScopeForPath, scopeKey } from '../../lib/manaGlobal.ts'
import { isManaOpen, onCloseMana, onOpenMana, openMana, publishManaOpen, subscribeManaOpen } from '../../lib/manaLauncher.ts'
import { readSpeakAnswers, writeSpeakAnswers } from '../../lib/manaSpeech.ts'
import { Sheet } from '../hero/Sheet.tsx'
import { Menu } from '../ui/Menu.tsx'
import { ManaAvatar } from '../brand/Brand.tsx'
import { ManaAssistant, ManaMark } from './ManaAssistant.tsx'

/**
 * The sidebar's Mana card (premium design: "Mana · AI Assistant" at the foot of the navigation), the launcher while the sidebar is docked;
 * GlobalMana's floating button is the launcher otherwise. One of the two exists at a time (data-testid mana-launcher).
 */
export function ManaSidebarCard() {
  const open = useSyncExternalStore(subscribeManaOpen, isManaOpen, () => false)
  return (
    <button
      type="button"
      onClick={() => openMana()}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="Mana"
      data-testid="mana-launcher"
      className="group flex w-full items-center gap-3 rounded-2xl border border-indigo-100 bg-gradient-to-br from-surface via-surface to-violet-50 px-3 py-2.5 text-left shadow-card transition-shadow hover:shadow-pop focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <ManaAvatar size="md" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-sm font-semibold text-ink">Mana</span>
        <span className="block text-xs text-ink-muted">Clinical AI assistant</span>
      </span>
      <AudioLines aria-hidden="true" className="size-4 text-ai/70 group-hover:text-ai" />
    </button>
  )
}

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
export function GlobalMana({ floating = true }: { floating?: boolean }) {
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
  useEffect(() => publishManaOpen(open), [open])
  useEffect(() => () => publishManaOpen(false), [])
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
  const about = sp ? `About ${sp.displayName} · MRN ${sp.mrn}` : conv.data ? 'Your clinic' : undefined

  return (
    <>
      {floating && (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="mana-launcher"
        style={{ bottom: 'calc(var(--action-bar-h, 0px) + 1rem)' }}
        className="fixed right-4 z-20 inline-flex size-14 items-center justify-center rounded-full bg-surface shadow-pop ring-4 ring-surface hover:scale-[1.03] motion-safe:transition-transform motion-safe:duration-150 print:hidden"
      >
        <ManaAvatar size="lg" />
        <span className="sr-only">Mana</span>
      </button>
      )}
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false)
          setAsk(null)
        }}
        title="Mana"
        header={
          <span className="flex items-center gap-3">
            <ManaMark size="lg" />
            <span className="leading-tight">
              <span className="block text-lg font-semibold tracking-tight">Mana</span>
              <span className="block text-sm text-ink-muted">Clinical Intelligence Assistant</span>
            </span>
          </span>
        }
        description={about}
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
        width="xl"
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
