import type { Role } from '@adaxai/contracts'
import {
  CalendarDays,
  ClipboardList,
  FileClock,
  FileText,
  HeartPulse,
  LayoutDashboard,
  type LucideIcon,
  ScanLine,
  ScrollText,
  ShieldCheck,
  Building2,
  BrainCircuit,
  Activity,
  UserRound,
  Stethoscope,
  UserPlus,
  Users,
  Watch,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  /** Other pages that belong to this item: it is shown as the current section there too (the link itself is not "the current page"). */
  also?: string[]
}

export const NAV: Record<Role, NavItem[]> = {
  admin: [
    { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/admin/appointments', label: 'Appointments', icon: CalendarDays },
    { to: '/admin/users', label: 'Users', icon: Users },
    { to: '/admin/departments', label: 'Departments', icon: Building2 },
    { to: '/admin/devices', label: 'Devices', icon: Watch },
    { to: '/admin/thermal-data', label: 'Thermal data', icon: ScanLine },
    { to: '/admin/ai', label: 'AI operations', icon: BrainCircuit },
    { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
  ],
  // Doctor HERO (DESIGN §4): exactly four places. Appointments, the drafts list (/doctor/consultations), AI review and registration are no
  // longer in the doctor's navigation; their routes stay (direct links, the queue's "Drafts and signed records" link, e2e).
  doctor: [
    { to: '/doctor', label: 'Home', icon: LayoutDashboard, end: true },
    { to: '/doctor/queue', label: 'My consultations', icon: Stethoscope, also: ['/doctor/consultations', '/doctor/encounters'] },
    { to: '/doctor/patients', label: 'Patients', icon: Users },
    { to: '/doctor/thermal', label: 'Thermal', icon: ScanLine },
  ],
  nurse: [
    { to: '/nurse', label: 'OPD queue', icon: ClipboardList, end: true },
    { to: '/nurse/appointments', label: 'Appointments', icon: CalendarDays },
    { to: '/nurse/register', label: 'Register patient', icon: UserPlus },
    { to: '/nurse/patients', label: 'Patients', icon: Users },
    { to: '/nurse/devices', label: 'Devices', icon: Watch },
  ],
  patient: [
    { to: '/patient', label: 'Home', icon: HeartPulse, end: true },
    { to: '/patient/records', label: 'Records', icon: FileText },
    { to: '/patient/appointments', label: 'Appointments', icon: CalendarDays },
    { to: '/patient/visits', label: 'Visits', icon: FileClock },
    { to: '/patient/vitals', label: 'Vital signs', icon: Activity },
    { to: '/patient/consents', label: 'Consents', icon: ShieldCheck },
    { to: '/patient/profile', label: 'My details', icon: UserRound },
  ],
}
