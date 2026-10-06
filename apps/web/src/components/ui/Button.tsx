import { LoaderCircle } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'ai' | 'subtle'
type Size = 'md' | 'sm' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white border border-brand shadow-card hover:border-brand-strong hover:bg-brand-strong',
  secondary: 'bg-surface text-ink border border-line-strong shadow-card hover:bg-canvas',
  danger: 'bg-down text-white border border-down shadow-card hover:brightness-95',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:bg-canvas hover:text-ink',
  // Only for asking the AI to do something (Analyze with Mana): violet is the AI's colour, never chrome. White on it is about 8.6:1. The
  // focus ring is the one every control has (styles.css), brand blue outside the button, so it shows against the violet and the page.
  ai: 'bg-ai text-white border border-ai shadow-card hover:brightness-90 disabled:hover:brightness-100',
  // The first choice in a dense row of choices (Accept beside Edit and Reject): the brand's tint, quieter than a primary button. Brand-strong
  // on brand-soft is about 6:1.
  subtle: 'bg-brand-soft text-brand-strong border border-brand/30 hover:bg-brand/15',
}
const SIZES: Record<Size, string> = {
  md: 'min-h-control px-4 text-sm',
  sm: 'min-h-control-sm px-3 text-sm',
  // The one main action of an area (56px), as the thermal workspace's CAPTURE.
  lg: 'min-h-14 px-5 text-base',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export function Button({ variant = 'primary', size = 'md', loading, icon, disabled, className = '', children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}
