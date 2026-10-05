import { type Me, ROLE_LABELS } from '@adaxai/contracts'
import { LogOut, Menu, Search } from 'lucide-react'
import { type FormEvent, type Ref, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { PatientAvatar } from '../ui/PatientAvatar.tsx'

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
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-ink-muted" />
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
        className="block min-h-control w-full rounded-lg border border-control bg-canvas pr-3 pl-10 text-sm placeholder:text-ink-muted focus:bg-surface"
      />
    </form>
  )
}

/**
 * The bar above every page: the menu button (phones), patient search (doctors
 * and nurses), who is signed in with their role and clinic, and sign out.
 * There is no notification bell: staff have no notifications to show yet.
 */
export function TopBar({ me, base, menuOpen, onMenu, menuRef, navId, onSignOut, drawerUntil = 'lg' }: { me: Me | null | undefined; base: string; menuOpen: boolean; onMenu: () => void; menuRef: Ref<HTMLButtonElement>; navId: string; onSignOut: () => void; drawerUntil?: 'lg' | 'xl' }) {
  // The menu button and the product mark are there while the sidebar is a drawer (see AppShell).
  const drawerOnly = drawerUntil === 'xl' ? 'xl:hidden' : 'lg:hidden'
  // On a workspace the menu button is the way to the navigation on a tablet held sideways too: a full-size target there.
  const menuSize = drawerUntil === 'xl' ? 'inline-flex size-control items-center justify-center' : ''
  const canSearch = me?.role === 'doctor' || me?.role === 'nurse'
  const where = [me?.departmentName, me?.facilityName].filter(Boolean).join(' · ')
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur print:hidden">
      <div className="flex min-h-topbar flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6 lg:px-8">
        <button ref={menuRef} type="button" className={`-ml-2 rounded-md p-2 text-ink-muted hover:bg-canvas ${menuSize} ${drawerOnly}`} aria-expanded={menuOpen} aria-controls={navId} onClick={onMenu}>
          <Menu aria-hidden="true" className="size-6" />
          <span className="sr-only">Open menu</span>
        </button>
        <Link to="/" className={`flex items-center gap-2 rounded-md ${drawerOnly}`}>
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="font-semibold tracking-tight">ADAXAI</span>
        </Link>
        {canSearch && (
          <div className="order-last flex w-full basis-full lg:order-none lg:w-auto lg:flex-1 lg:basis-auto">
            <PatientSearch base={base} />
          </div>
        )}
        <div className="ml-auto flex items-center gap-3">
          {me && (
            <div className="flex items-center gap-3">
              <PatientAvatar name={me.fullName} size="md" />
              <div className="hidden min-w-0 leading-tight sm:block">
                <p className="max-w-56 truncate text-sm font-semibold" data-testid="signed-in-user">
                  {me.fullName}
                </p>
                <p className="max-w-56 truncate text-xs text-ink-muted">
                  {ROLE_LABELS[me.role]}
                  {where ? ` · ${where}` : ''}
                </p>
              </div>
            </div>
          )}
          <button type="button" onClick={onSignOut} className="inline-flex min-h-control items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap text-ink-muted hover:bg-canvas hover:text-ink">
            <LogOut aria-hidden="true" className="size-4" />
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
