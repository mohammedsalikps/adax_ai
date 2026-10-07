import adaxaiMark from '../../assets/brand/adaxai-mark.png'
import adaxaiWordmark from '../../assets/brand/adaxai-wordmark.png'
import manaAvatar from '../../assets/brand/mana-avatar.webp'

/*
 * The brand as the owner supplied it (UI/UX redesign): the ADAXAI mark and wordmark are cut from the owner's logo, never redrawn or
 * re-proportioned (assets/brand), and Mana is shown with the owner's Mana image. Decorative everywhere: a name is always written beside them.
 */

const MARK_SIZES = { sm: 'size-7', md: 'size-9', lg: 'size-12', xl: 'size-20' } as const

/** The ADAXAI mark (the A with the cross), as in the owner's logo. */
export function AdaxaiMark({ size = 'md', className = '' }: { size?: keyof typeof MARK_SIZES; className?: string }) {
  return <img src={adaxaiMark} alt="" aria-hidden="true" draggable={false} className={`shrink-0 object-contain ${MARK_SIZES[size]} ${className}`} />
}

/** The mark beside the wordmark (ADAXAI · CLINICAL INTELLIGENCE), both from the owner's logo; `label` is the accessible name. */
export function AdaxaiLockup({ className = '', label = 'ADAXAI Clinical Intelligence' }: { className?: string; label?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <AdaxaiMark size="md" />
      <img src={adaxaiWordmark} alt={label} draggable={false} className="h-[2.4rem] w-auto max-w-[10.5rem] object-contain" />
    </span>
  )
}

const AVATAR_SIZES = { xs: 'size-6', sm: 'size-8', md: 'size-10', lg: 'size-12', xl: 'size-16' } as const

/** Mana, as the owner's Mana image: round, on a thin blue–violet ring (the AI accent). */
export function ManaAvatar({ size = 'md', className = '' }: { size?: keyof typeof AVATAR_SIZES; className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 rounded-full bg-gradient-to-br from-brand via-indigo-500 to-violet-500 p-[2px] shadow-[0_6px_16px_-6px_rgb(79_70_229/0.55)] ${AVATAR_SIZES[size]} ${className}`}>
      <img src={manaAvatar} alt="" draggable={false} className="size-full rounded-full bg-surface object-cover" />
    </span>
  )
}
