import {
  LayoutDashboard,
  Building2,
  Users,
  ConciergeBell,
  Activity,
  Settings,
  ListChecks,
  CreditCard,
  ClipboardList,
  Bell,
  UserCircle,
  MessageSquareText,
  DoorClosed,
  UtensilsCrossed,
  Sparkles,
  BedDouble,
  BarChart3,
  type LucideIcon,
} from 'lucide-react'

export type MobileNavItem = { href: string; label: string; icon: LucideIcon; group?: string[] }

/**
 * Deliberately duplicated from sidebar.tsx's FULL_NAV_ITEMS/MANAGER_NAV_ITEMS/
 * STAFF_NAV_ITEMS/RECEPTION_NAV_ITEMS rather than imported from a shared
 * module — see the mobile-app plan's "Isolation mechanism": sidebar.tsx must
 * never be touched by mobile-app work, so it can't be refactored into a
 * shared source of truth. Update both lists in tandem when a role's pages
 * change.
 */
const HOTEL_ADMIN_ITEMS: MobileNavItem[] = [
  { href: '/hotel/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/hotel/onboarding', label: 'Onboarding', icon: ListChecks },
  {
    href: '/hotel/profile',
    label: 'Hotel',
    icon: Building2,
    group: ['/hotel/profile', '/hotel/legal', '/hotel/departments', '/hotel/rooms', '/hotel/qr-codes'],
  },
  { href: '/hotel/staff', label: 'People', icon: Users, group: ['/hotel/staff', '/hotel/managers', '/hotel/reception'] },
  {
    href: '/hotel/services',
    label: 'Guest Services',
    icon: ConciergeBell,
    group: ['/hotel/services', '/hotel/requests', '/hotel/menu'],
  },
  {
    href: '/hotel/activity',
    label: 'Operations',
    icon: Activity,
    group: ['/hotel/activity', '/hotel/notifications', '/hotel/guest-sessions'],
  },
  { href: '/hotel/reports', label: 'Reports', icon: BarChart3 },
  { href: '/hotel/subscription', label: 'Subscription', icon: CreditCard },
  { href: '/hotel/settings', label: 'Settings', icon: Settings },
]

const MANAGER_ITEMS: MobileNavItem[] = [
  { href: '/hotel/manager/queue', label: 'Dashboard / Queue', icon: LayoutDashboard },
  { href: '/hotel/requests', label: 'Requests', icon: ClipboardList },
  { href: '/hotel/manager/team', label: 'Team', icon: Users },
  { href: '/hotel/manager/activity', label: 'Activity', icon: Activity },
  { href: '/hotel/notifications', label: 'Notifications', icon: Bell },
]

const STAFF_ITEMS: MobileNavItem[] = [
  { href: '/hotel/staff/home', label: 'Home', icon: LayoutDashboard },
  { href: '/hotel/staff/tasks', label: 'Tasks', icon: ClipboardList },
  { href: '/hotel/notifications', label: 'Notifications', icon: Bell },
  { href: '/hotel/staff/profile', label: 'Profile', icon: UserCircle },
]

const RECEPTION_ITEMS: MobileNavItem[] = [
  { href: '/hotel/reception-desk/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/hotel/guest-sessions', label: 'Active Stays', icon: BedDouble },
  { href: '/hotel/requests', label: 'Requests', icon: ClipboardList },
  { href: '/hotel/reception-desk/conversations', label: 'Conversations', icon: MessageSquareText },
  { href: '/hotel/menu', label: 'Restaurant Menu', icon: ConciergeBell },
  { href: '/hotel/reception-desk/orders', label: 'Orders', icon: UtensilsCrossed },
  { href: '/hotel/reception-desk/rooms', label: 'Rooms', icon: DoorClosed },
  { href: '/hotel/reception-desk/staff', label: 'Departments & Staff', icon: Users },
  { href: '/hotel/services', label: 'Services', icon: Sparkles },
  { href: '/hotel/notifications', label: 'Notifications', icon: Bell },
]

export function mobileNavItemsForRole(roleName: string | null): MobileNavItem[] {
  if (roleName === 'Department Manager') return MANAGER_ITEMS
  if (roleName === 'Department Staff') return STAFF_ITEMS
  if (roleName === 'Reception') return RECEPTION_ITEMS
  return HOTEL_ADMIN_ITEMS
}
