import { ROLE_LABELS, type Role } from '@adaxai/contracts'
import { KeyRound, X } from 'lucide-react'
import type { Ref } from 'react'
import { Link, NavLink } from 'react-router'
import { NAV } from '../../lib/nav.ts'

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex min-h-control items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
    isActive ? 'bg-brand-soft text-brand-strong' : 'text-ink-muted hover:bg-canvas hover:text-ink',
  ].join(' ')

/**
 * The left navigation: the product mark, the pages this role has, and the
 * account link. Only pages that exist are listed. Below the `lg` breakpoint it
 * is a drawer (see AppShell), below `xl` on a workspace page; the links are the same.
 */
export function Sidebar({ role, id, facilityName, className = '', onClose, onNavigate, closeRef, drawerUntil = 'lg' }: { role: Role; id: string; facilityName?: string | undefined; className?: string; onClose: () => void; onNavigate: () => void; closeRef: Ref<HTMLButtonElement>; drawerUntil?: 'lg' | 'xl' }) {
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
          {NAV[role].map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink to={to} end={end} className={navClass} onClick={onNavigate}>
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-line p-3">
        <Link to="/change-password" className="flex min-h-control items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink-muted hover:bg-canvas hover:text-ink">
          <KeyRound aria-hidden="true" className="size-5 shrink-0" />
          Change password
        </Link>
      </div>
    </aside>
  )
}
