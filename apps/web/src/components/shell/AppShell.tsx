import type { Role } from '@adaxai/contracts'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Outlet, ScrollRestoration, useLocation, useMatches, useNavigate } from 'react-router'
import { useLogout, useMe } from '../../lib/auth.tsx'
import { signOutProblem } from '../../lib/signInErrors.ts'
import { GlobalMana } from '../mana/GlobalMana.tsx'
import { useToast } from '../ui/Toast.tsx'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'

const NAV_ID = 'portal-nav'

/**
 * A page that marks itself `handle: { workspace: true }` (the doctor's consultation) needs the width of a tablet held sideways for its work.
 * `focus: true` also starts it in focus mode: the navigation is a drawer at every width, so the whole screen is the work's. The page can say
 * otherwise while it is shown (useFocusMode): the doctor's consultation is in focus mode while it is being written, and its read view is not.
 */
export interface RouteHandle {
  workspace?: boolean
  focus?: boolean
}

/**
 * Where the sidebar stops being a drawer, and the classes that differ with it (written out in full: Tailwind only sees whole class names).
 * A workspace keeps the drawer up to 1280px, so a tablet held sideways (1024 to 1279px) gives the whole screen to the work, and its page is
 * not held to the 80rem column that lists and forms are. Focus mode keeps the drawer at every width.
 */
const FRAME = {
  page: {
    desktop: '(min-width: 64rem)',
    grid: 'min-h-screen lg:grid lg:grid-cols-[var(--spacing-sidebar)_minmax(0,1fr)]',
    backdrop: 'fixed inset-0 z-30 bg-ink/40 lg:hidden print:hidden',
    sidebar: 'lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-dvh lg:w-auto lg:shadow-none print:hidden',
    bar: '',
    main: 'mx-auto w-full max-w-7xl min-w-0 flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8 print:p-0',
    drawerUntil: 'lg',
  },
  workspace: {
    desktop: '(min-width: 80rem)',
    grid: 'min-h-screen xl:grid xl:grid-cols-[var(--spacing-sidebar)_minmax(0,1fr)]',
    backdrop: 'fixed inset-0 z-30 bg-ink/40 xl:hidden print:hidden',
    sidebar: 'xl:sticky xl:top-0 xl:z-auto xl:flex xl:h-dvh xl:w-auto xl:shadow-none print:hidden',
    bar: '',
    main: 'mx-auto w-full max-w-[120rem] min-w-0 flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8 print:p-0',
    drawerUntil: 'xl',
  },
  focus: {
    // No width makes it the permanent sidebar, so the drawer is never closed for growing into one.
    desktop: 'not all',
    grid: 'min-h-screen',
    backdrop: 'fixed inset-0 z-30 bg-ink/40 print:hidden',
    // The sidebar and the top bar hide their drawer controls from xl when told the drawer ends there (drawerUntil 'xl'); here it never ends,
    // so the drawer's close button, the bar's menu button (aria-controls is NAV_ID) and the bar's product mark stay at every width.
    sidebar: 'print:hidden [&>div>button]:inline-flex',
    bar: '[&>header_[aria-controls=portal-nav]]:inline-flex [&>header>div>a]:flex',
    main: 'mx-auto w-full max-w-[120rem] min-w-0 flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8 print:p-0',
    drawerUntil: 'xl',
  },
} as const

/** How a page in a workspace says whether it is in focus mode now (null: as its route says). */
const FocusModeContext = createContext<((on: boolean | null) => void) | null>(null)

/**
 * Says, while the calling page is mounted, whether its workspace is in focus mode (the navigation a drawer at every width): true or false, or
 * null to leave it as the route says. Before paint, so the frame does not change under the person's eyes. Outside a workspace it does nothing.
 */
export function useFocusMode(on: boolean | null) {
  const set = useContext(FocusModeContext)
  useLayoutEffect(() => {
    if (!set || on === null) return
    set(on)
    return () => set(null)
  }, [set, on])
}

/**
 * The frame of every signed-in page: sidebar (a drawer on phones), top bar
 * and the page. One shell for every role, so the app looks and behaves the
 * same wherever you are; what differs is the pages the role has (lib/nav.ts),
 * whether patient search is offered, and, for doctors only, the global Mana
 * button (components/mana/GlobalMana.tsx: Mana needs `ai:use`, which only
 * doctors have). There is no application-wide development banner (Doctor
 * HERO, DESIGN §4): synthetic, simulated and unverified data are marked where
 * they appear (the patient's Synthetic badge, SIMULATED and UNVERIFIED tags,
 * the printed prescription's note), and the sign-in pages keep one small line.
 *
 * On phones the sidebar is a drawer: opening it moves focus into it and makes
 * the page behind inert; Escape, its close button, the dimmed backdrop and
 * choosing a page close it, and focus goes back to the menu button (or to the
 * new page). A workspace keeps it a drawer up to 1280px, and in focus mode at
 * every width (see RouteHandle and useFocusMode).
 */
export function AppShell({ role }: { role: Role }) {
  const { data: me } = useMe()
  const logout = useLogout()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const handles = useMatches().map((m) => m.handle as RouteHandle | undefined)
  const [focusMode, setFocusMode] = useState<boolean | null>(null)
  const frame = FRAME[!handles.some((h) => h?.workspace) ? 'page' : (focusMode ?? handles.some((h) => h?.focus)) ? 'focus' : 'workspace']
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const openNow = useRef(false)
  openNow.current = menuOpen
  // Where focus goes when the drawer closes: back to the menu button, to the new page, or nowhere in particular.
  const leaveTo = useRef<'menu' | 'page' | 'none'>('menu')

  const closeMenu = useCallback((to: 'menu' | 'page' | 'none' = 'menu') => {
    leaveTo.current = to
    setMenuOpen(false)
  }, [])
  // Any navigation closes the drawer (choosing a page is handled by the sidebar's links too, for the page you are already on).
  useEffect(() => {
    if (openNow.current) closeMenu('page')
  }, [location.pathname, closeMenu])
  // Opening moves focus into the drawer. Closing hands it on once the page behind is no longer inert (a focus() on an inert page does nothing).
  useEffect(() => {
    if (menuOpen) {
      wasOpen.current = true
      closeButton.current?.focus()
      return
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    if (leaveTo.current === 'menu') menuButton.current?.focus()
    else if (leaveTo.current === 'page') document.getElementById('main')?.focus()
    leaveTo.current = 'menu'
  }, [menuOpen])
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu('menu')
    document.addEventListener('keydown', onKey)
    // The page behind the drawer does not scroll (it is inert, but wheel and touch scrolling would still move it).
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Growing to the desktop layout turns the drawer into the permanent sidebar: the menu button is gone, so focus is left alone.
    const mq = window.matchMedia(frame.desktop)
    const onChange = () => mq.matches && closeMenu('none')
    mq.addEventListener('change', onChange)
    return () => {
      document.removeEventListener('keydown', onKey)
      mq.removeEventListener('change', onChange)
      document.body.style.overflow = overflow
    }
  }, [menuOpen, closeMenu, frame.desktop])

  // To the front door once the server has ended the session; if it could not be reached the person stays, signed in, and is told.
  const signOut = () => logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }), onError: (e) => toast('error', signOutProblem(e)) })
  const base = `/${role}`

  return (
    <div className={frame.grid}>
      <a href="#main" inert={menuOpen} className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:shadow-pop">
        Skip to main content
      </a>
      {menuOpen && <div aria-hidden="true" className={frame.backdrop} onClick={() => closeMenu('menu')} />}
      <Sidebar
        role={role}
        id={NAV_ID}
        facilityName={me?.facilityName}
        onClose={() => closeMenu('menu')}
        onNavigate={() => closeMenu('page')}
        closeRef={closeButton}
        drawerUntil={frame.drawerUntil}
        className={`${menuOpen ? 'fixed inset-y-0 left-0 z-40 flex w-72 shadow-pop' : 'hidden'} ${frame.sidebar}`}
      />
      {/* While the drawer is open the page behind it cannot be reached by keyboard or screen reader. */}
      <div className={`flex min-w-0 flex-col ${frame.bar}`} inert={menuOpen}>
        <TopBar me={me} base={base} menuOpen={menuOpen} onMenu={() => setMenuOpen(true)} menuRef={menuButton} navId={NAV_ID} onSignOut={signOut} drawerUntil={frame.drawerUntil} />
        <main id="main" tabIndex={-1} className={frame.main}>
          <FocusModeContext.Provider value={setFocusMode}>
            <Outlet />
          </FocusModeContext.Provider>
        </main>
        {/* The doctor's Mana, floating above the page (and above a page's bottom bar); inert with the page while the drawer is open, never printed. */}
        {role === 'doctor' && (
          <div className="print:hidden">
            <GlobalMana />
          </div>
        )}
      </div>
      {/* A new page starts at the top (the browser would keep the old scroll position); going back restores it. A change of search parameters within a page opts out with preventScrollReset. */}
      <ScrollRestoration />
    </div>
  )
}
