import { ROLE_LABELS, type Role } from '@adaxai/contracts'
import { X } from 'lucide-react'
import type { Ref } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { NAV } from '../../lib/nav.ts'

const navClass = (active: boolean) =>
  [
    'flex min-h-control items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
    active ? 'bg-brand-soft text-brand-strong' : 'text-ink-muted hover:bg-canvas hover:text-ink',
  ].join(' ')

/** Whether `pathname` is `prefix` or a page under it. */
const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`)

/**
 * The left navigation: the product mark and the pages this role has, nothing else (the account's Change password is in the top bar's
 * account menu, beside Sign out). Only pages that exist are listed. Below the `lg` breakpoint it is a drawer (see AppShell), below `xl` on
 * a workspace page, at every width in focus mode; the links are the same. An item is shown as the current section on its own pages and on
 * the pages it lists in `also` (My consultations in a consultation, for example).
 */
export function Sidebar({ role, id, facilityName, className = '', onClose, onNavigate, closeRef, drawerUntil = 'lg' }: { role: Role; id: string; facilityName?: string | undefined; className?: string; onClose: () => void; onNavigate: () => void; closeRef: Ref<HTMLButtonElement>; drawerUntil?: 'lg' | 'xl' }) {
  const { pathname } = useLocation()
  return (
    <aside className={`flex-col border-r border-line bg-surface ${className}`}>
      <div className="flex min-h-topbar items-center justify-between gap-3 border-b border-line px-5">
        <Link to="/" className="flex items-center gap-2.5 rounded-md">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="leading-tight">
            <span className="block text-base font-semibold tracking-tight">ADAXAI</span>
            {facilityName && <span className="block max-w-40 truncate text-xs text-ink-muted">{facilityName}</span>}
          </span>
        </Link>
        {/* The drawer covers the top bar's menu button, so it has its own way out (phones only). */}
        <button ref={closeRef} type="button" onClick={onClose} className={`-mr-2 rounded-md p-2 text-ink-muted hover:bg-canvas ${drawerUntil === 'xl' ? 'inline-flex size-control items-center justify-center xl:hidden' : 'lg:hidden'}`}>
          <X aria-hidden="true" className="size-6" />
          <span className="sr-only">Close menu</span>
        </button>
      </div>
      <nav id={id} aria-label={`${ROLE_LABELS[role]} navigation`} className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-1">
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
    </aside>
  )
}
