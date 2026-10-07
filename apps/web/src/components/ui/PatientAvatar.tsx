const SIZES = { sm: 'size-8 text-xs', md: 'size-10 text-sm', lg: 'size-14 text-lg', xl: 'size-20 text-2xl' } as const

/** UI/UX redesign: soft tints in the brand's family, chosen by the name (the same person always gets the same one). Text is 5:1 or more. */
const TINTS = [
  'from-blue-50 to-indigo-100 text-brand-strong',
  'from-sky-50 to-blue-100 text-blue-800',
  'from-violet-50 to-indigo-100 text-violet-800',
  'from-teal-50 to-cyan-100 text-teal-800',
] as const
const tintOf = (name: string) => TINTS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length]!

/** First and last initial of a name, ignoring a title ("Dr."), a suffix ("Jr.") and anything in brackets ("(synthetic)", "(not verified)"): "Dr. Meera Iyer (synthetic)" is MI; one word gives one letter. */
export function initialsOf(name: string): string {
  const parts = name
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^(dr|mr|mrs|ms|miss|prof|jr|sr|ii|iii)\.?$/i.test(w))
  if (!parts.length) return '?'
  const first = parts[0]!
  const last = parts.length > 1 ? parts[parts.length - 1]! : ''
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
}

/**
 * Initials on a soft tint. There are no patient photographs in the product,
 * and a name is always printed beside the avatar, so it is hidden from
 * assistive technology (it carries no information of its own).
 */
export function PatientAvatar({ name, size = 'md', className = '' }: { name: string; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold ring-1 ring-white/70 ${tintOf(initialsOf(name))} ${SIZES[size]} ${className}`}>
      {initialsOf(name)}
    </span>
  )
}
