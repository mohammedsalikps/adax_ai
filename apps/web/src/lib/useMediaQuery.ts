import { useSyncExternalStore } from 'react'

/** Whether a CSS media query matches now, kept current as the window changes (false where there is no window). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => (typeof window !== 'undefined' && !!window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  )
}
