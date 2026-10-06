import { Ellipsis } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: ReactNode
  /** Plain-text name when `label` is not text. */
  name?: string
  onSelect: () => void
  icon?: ReactNode
  tone?: 'default' | 'danger'
  disabled?: boolean
}

/**
 * An overflow ("more") menu: one button that opens a short list of actions.
 * Enter, Space or the Down arrow open it and focus the first action; arrows,
 * Home and End move; Escape closes it and returns to the button; Tab closes
 * it. The list is placed against the viewport and follows its button when the
 * page scrolls, so a table or card around it cannot clip or strand it, and it
 * is rendered at the end of the page for the same reason (or, when the button
 * is inside a modal dialog such as the profile sheet, inside that dialog:
 * everything outside a modal dialog is inert and drawn beneath it). For
 * commands that have no room of their own, not for navigation. By default
 * the button is an ellipsis; `trigger` and `triggerClassName` make it a
 * labelled control (the speaker of a transcript line, for example).
 */
export function Menu({ label, items, align = 'end', trigger, triggerClassName }: { label: string; items: MenuItem[]; align?: 'start' | 'end'; trigger?: ReactNode; triggerClassName?: string }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  // Where the list's own (0, 0) is on screen: the viewport's for the page; the sheet's for a sheet that is moved with a transform.
  const origin = useRef({ left: 0, top: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const menuId = useId()
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0)

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) button.current?.focus()
  }, [])
  // preventScroll: the list is fixed to the viewport, and focusing it must not scroll anything behind it.
  const focusItem = useCallback((index: number) => list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus({ preventScroll: true }), [])

  // Place the list under the button (above it if there is no room), inside the viewport.
  const place = useCallback(() => {
    if (!button.current) return
    const b = button.current.getBoundingClientRect()
    const width = list.current?.offsetWidth ?? 208
    const left = align === 'end' ? Math.max(8, Math.min(window.innerWidth - width - 8, b.right - width)) : Math.max(8, Math.min(window.innerWidth - width - 8, b.left))
    const height = list.current?.offsetHeight ?? 0
    const below = b.bottom + 4
    const top = below + height > window.innerHeight - 8 && b.top - 4 - height > 8 ? b.top - 4 - height : below
    const next = { top: top - origin.current.top, left: left - origin.current.left }
    setPos((p) => (p && p.top === next.top && p.left === next.left ? p : next))
  }, [align])
  useLayoutEffect(() => {
    if (!open || !host || !list.current) return
    // Unplaced, the list sits at its own (0, 0): that is the origin to measure from.
    if (pos === null) {
      const r = list.current.getBoundingClientRect()
      origin.current = { left: r.left, top: r.top }
    }
    place()
  }, [open, host, place])
  useEffect(() => {
    if (open && host && pos && enabled[0] !== undefined) focusItem(enabled[0])
    // Focus the first action once, when the list has been placed.
  }, [open, pos === null])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false)
    }
    // The page scrolled or the window changed size (also when the browser brings the button into view just after it was pressed): the list follows its button.
    const follow = () => place()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', follow)
      window.removeEventListener('scroll', follow, true)
    }
  }, [open, close, place])

  const openMenu = () => {
    setPos(null)
    setHost(button.current?.closest('dialog') ?? document.body)
    setOpen(true)
  }
  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault()
      openMenu()
    } else if (e.key === 'Escape' && open) {
      // Focus stays on the button when no item can take it (every item disabled, such as a menu that only says why it offers nothing).
      e.preventDefault()
      close(true)
    }
  }
  const onListKey = (e: KeyboardEvent) => {
    const at = enabled.indexOf(Number((document.activeElement as HTMLElement | null)?.dataset.index ?? -1))
    const go = (to: number) => {
      e.preventDefault()
      const target = enabled[(to + enabled.length) % enabled.length]
      if (target !== undefined) focusItem(target)
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(enabled.length - 1)
    else if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'Tab') close(false)
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) setOpen(false)
          else openMenu()
        }}
        onKeyDown={onButtonKey}
        className={triggerClassName ?? 'inline-flex size-control-sm items-center justify-center rounded-md border border-transparent text-ink-muted hover:bg-canvas hover:text-ink'}
      >
        {trigger ?? <Ellipsis aria-hidden="true" className="size-5" />}
      </button>
      {open &&
        host &&
        createPortal(
        <ul
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="z-50 min-w-52 rounded-xl border border-line bg-surface p-1 shadow-pop"
        >
          {items.map((it, i) => (
            <li key={it.name ?? (typeof it.label === 'string' ? it.label : i)} role="none">
              <button
                type="button"
                role="menuitem"
                data-index={i}
                tabIndex={-1}
                disabled={it.disabled}
                onClick={() => {
                  close(true)
                  it.onSelect()
                }}
                className={`flex min-h-control-sm w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 ${it.tone === 'danger' ? 'text-down' : 'text-ink'}`}
              >
                {it.icon}
                {it.label}
              </button>
            </li>
          ))}
        </ul>,
        host,
        )}
    </>
  )
}
