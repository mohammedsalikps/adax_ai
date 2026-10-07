import { type Me, ROLE_LABELS } from '@adaxai/contracts'
import { ChevronDown, KeyRound, LogOut, Menu as MenuIcon, Search } from 'lucide-react'
import { type FormEvent, type Ref, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Menu } from '../ui/Menu.tsx'
import { plainName } from '../../lib/displayName.ts'
import { PatientAvatar } from '../ui/PatientAvatar.tsx'
import { AdaxaiMark } from '../brand/Brand.tsx'

/**
 * Find a patient from anywhere. Offered only to roles that may look patients
 * up (the server decides again on every search). Submitting opens the Patients
 * page with the search filled in: the term travels in the router state, never
 * in the address, so it is not in a shared link, the referrer or a server log, and
 * nothing is searched (or audited) until the person asks. Two characters at
 * least (the browser says so if fewer are typed). Enter submits: a single-field
 * form needs no hidden button.
 */
function PatientSearch({ base }: { base: string }) {
  const navigate = useNavigate()
  const here = useLocation().pathname
  const [q, setQ] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const term = q.trim()
    if (term.length < 2) return
    setQ('')
    // Already on the Patients page: replace that entry (a second one for the same address would make Back look dead).
    void navigate(`${base}/patients`, { state: { q: term }, replace: here === `${base}/patients` })
  }
  return (
    <form role="search" onSubmit={submit} className="relative w-full max-w-xl">
      <label htmlFor="global-patient-search" className="sr-only">
        Search patients by name, MRN or phone number
      </label>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-brand" />
      <input
        id="global-patient-search"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search patients by name, MRN or phone number"
        required
        minLength={2}
        pattern=".*\S.*\S.*"
        title="Type at least 2 characters (not spaces), then press Enter"
        className="block min-h-control w-full rounded-full border border-control bg-surface/90 pr-4 pl-11 text-sm shadow-card placeholder:text-ink-muted focus:border-brand focus:bg-surface"
      />
    </form>
  )
}

/**
 * The bar above every page: the menu button (while the sidebar is a drawer), patient search (doctors and nurses), who is signed in with
 * their role and clinic — a small account menu holding Change password — and Sign out, a quiet button that is always there (icon only on
 * phones, with its name for assistive technology). There is no notification bell: staff have no notifications to show yet.
 */
export function TopBar({ me, base, menuOpen, onMenu, menuRef, navId, onSignOut, drawerUntil = 'lg' }: { me: Me | null | undefined; base: string; menuOpen: boolean; onMenu: () => void; menuRef: Ref<HTMLButtonElement>; navId: string; onSignOut: () => void; drawerUntil?: 'lg' | 'xl' }) {
  const navigate = useNavigate()
  // The menu button and the product mark are there while the sidebar is a drawer (see AppShell).
  const drawerOnly = drawerUntil === 'xl' ? 'xl:hidden' : 'lg:hidden'
  // On a workspace the menu button is the way to the navigation on a tablet held sideways too: a full-size target there.
  const menuSize = drawerUntil === 'xl' ? 'inline-flex size-control items-center justify-center' : ''
  const canSearch = me?.role === 'doctor' || me?.role === 'nurse'
  // Jury polish: the doctor sees their department; names are shown without the data's "(synthetic)" mark (said once in the sidebar).
  const where = me?.role === 'doctor' ? (me?.departmentName ?? '') : [me?.departmentName, plainName(me?.facilityName)].filter(Boolean).join(' · ')
  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-surface/80 backdrop-blur-md print:hidden">
      <div className="flex min-h-topbar flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6 lg:px-8">
        <button ref={menuRef} type="button" className={`-ml-2 rounded-md p-2 text-ink-muted hover:bg-canvas ${menuSize} ${drawerOnly}`} aria-expanded={menuOpen} aria-controls={navId} onClick={onMenu}>
          <MenuIcon aria-hidden="true" className="size-6" />
          <span className="sr-only">Open menu</span>
        </button>
        <Link to="/" className={`flex items-center gap-2 rounded-md ${drawerOnly}`}>
          <AdaxaiMark size="sm" />
          <span className="font-semibold tracking-tight">ADAXAI</span>
        </Link>
        {canSearch && (
          <div className="order-last flex w-full basis-full lg:order-none lg:w-auto lg:flex-1 lg:basis-auto">
            <PatientSearch base={base} />
          </div>
        )}
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {me && (
            // Who is signed in, as the trigger of a small account menu (the account's one setting lives here, not in the navigation).
            <Menu
              label={`Account: ${me.fullName}`}
              align="end"
              triggerClassName="flex min-h-control min-w-0 items-center gap-3 rounded-xl px-1.5 text-left hover:bg-brand-soft/60 sm:px-2"
              trigger={
                <>
                  <PatientAvatar name={plainName(me.fullName).replace(/^Dr.?s+/i, '')} size="md" className="ring-2 ring-surface" />
                  <span className="hidden min-w-0 leading-tight sm:block">
                    <span className="block max-w-56 truncate text-sm font-semibold" data-testid="signed-in-user">
                      {plainName(me.fullName)}
                    </span>
                    <span className="block max-w-56 truncate text-xs text-ink-muted">
                      {me.role === 'doctor' ? where || ROLE_LABELS[me.role] : `${ROLE_LABELS[me.role]}${where ? ` · ${where}` : ''}`}
                    </span>
                  </span>
                  <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                </>
              }
              items={[{ label: 'Change password', icon: <KeyRound aria-hidden="true" className="size-4 text-ink-muted" />, onSelect: () => void navigate('/change-password') }]}
            />
          )}
          <button type="button" onClick={onSignOut} className="inline-flex min-h-control min-w-control items-center justify-center gap-2 rounded-lg px-2 text-sm font-medium whitespace-nowrap text-ink-muted hover:bg-canvas hover:text-ink sm:px-3">
            <LogOut aria-hidden="true" className="size-4" />
            <span className="max-sm:sr-only">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  )
}
