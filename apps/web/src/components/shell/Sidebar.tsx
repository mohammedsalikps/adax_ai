import { ROLE_LABELS, type Role } from '@adaxai/contracts'
import { X } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { isSyntheticName, plainName } from '../../lib/displayName.ts'
import { NAV } from '../../lib/nav.ts'
import { AdaxaiLockup } from '../brand/Brand.tsx'

// UI/UX redesign: the current page is the brand gradient (white text, at least 5.2:1); the others are quiet line icons and ink text.
const navClass = (active: boolean) =>
  [
    'flex min-h-12 items-center gap-3 rounded-xl px-3.5 text-[0.9375rem] font-medium transition-[background-color,color,box-shadow] duration-150',
    active ? 'bg-brand-gradient text-white shadow-[0_10px_24px_-12px_rgb(79_70_229/0.75)]' : 'text-ink/80 hover:bg-brand-soft/70 hover:text-ink',
  ].join(' ')

/** Whether `pathname` is `prefix` or a page under it. */
const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`)

/**
 * The left navigation: the product mark and the pages this role has, nothing else (the account's Change password is in the top bar's
 * account menu, beside Sign out). Only pages that exist are listed. Below the `lg` breakpoint it is a drawer (see AppShell), below `xl` on
 * a workspace page, at every width in focus mode; the links are the same. An item is shown as the current section on its own pages and on
 * the pages it lists in `also` (My consultations in a consultation, for example).
 */
export function Sidebar({ role, id, facilityName, className = '', onClose, onNavigate, closeRef, drawerUntil = 'lg', bottom }: { role: Role; id: string; facilityName?: string | undefined; className?: string; onClose: () => void; onNavigate: () => void; closeRef: Ref<HTMLButtonElement>; drawerUntil?: 'lg' | 'xl'; bottom?: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <aside className={`flex-col border-r border-line/70 bg-surface ${className}`}>
      <div className="flex min-h-topbar items-center justify-between gap-3 px-5 pt-1">
        <Link to="/" className="flex min-w-0 items-center rounded-md" aria-label="ADAXAI home">
          <AdaxaiLockup label="ADAXAI Clinical Intelligence" />
        </Link>
        {/* The drawer covers the top bar's menu button, so it has its own way out (phones only). */}
        <button ref={closeRef} type="button" onClick={onClose} className={`-mr-2 rounded-md p-2 text-ink-muted hover:bg-canvas ${drawerUntil === 'xl' ? 'inline-flex size-control items-center justify-center xl:hidden' : 'lg:hidden'}`}>
          <X aria-hidden="true" className="size-6" />
          <span className="sr-only">Close menu</span>
        </button>
      </div>
      {role !== 'doctor' && facilityName && <p className="truncate px-5 text-xs text-ink-muted">{plainName(facilityName)}</p>}
      <nav id={id} aria-label={`${ROLE_LABELS[role]} navigation`} className="flex-1 overflow-y-auto px-3 pt-4 pb-3">
        <ul className="space-y-1.5">
          {NAV[role].map(({ to, label, icon: Icon, end, also }) => (
            <li key={to}>
              <NavLink to={to} end={end} className={({ isActive }) => navClass(isActive || !!also?.some((p) => under(pathname, p)))} onClick={onNavigate}>
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      {/* The brand's line (decorative), as in the reference: soft ribbons of the logo's colours behind it. */}
      <div aria-hidden="true" className="relative mx-3 mb-3 hidden overflow-hidden rounded-2xl bg-gradient-to-br from-brand-soft via-indigo-50 to-violet-100/80 px-4 pt-14 pb-4 [@media(min-height:46rem)]:block">
        <span className="absolute -top-10 -right-8 size-36 rounded-full bg-gradient-to-br from-sky-300/50 via-indigo-300/40 to-violet-400/40 blur-xl" />
        <span className="absolute top-6 -left-10 h-16 w-48 -rotate-12 rounded-full bg-gradient-to-r from-brand/25 to-violet-400/25 blur-md" />
        <p className="relative text-lg leading-6 font-medium tracking-tight text-ink/75">
          Smarter Care.
          <br />
          Healthier Lives.
        </p>
      </div>
      {bottom && <div className="px-3 pb-3">{bottom}</div>}
      {(facilityName || isSyntheticName(facilityName)) && (
        <p className="border-t border-line/70 px-5 py-3 text-xs leading-5 text-ink-muted">
          <span className="block font-medium text-ink">{plainName(facilityName)}</span>
          {/* The one place the shell says the data is synthetic (names elsewhere are shown without the mark). */}
          {isSyntheticName(facilityName) && <span className="block" data-testid="demo-environment">Demo environment · Synthetic patient data</span>}
        </p>
      )}
    </aside>
  )
}
